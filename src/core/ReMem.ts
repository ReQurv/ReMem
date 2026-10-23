import { v7 as uuidv7 } from 'uuid'

import type { ReMemConfig } from '../config'
import { ConnectionError } from '../errors'
import { consoleLogger, type Logger } from '../logging'
import { createChatModel } from '../providers/chat'
import { createEmbedder, type Embedder } from '../providers/embedder'
import { createRouter, type Router } from '../router'
import { createExtractor, type Extractor } from '../stores/graph/extractor'
import { Neo4jGraphStore } from '../stores/graph/Neo4jGraphStore'
import type { Entity, GraphForgetCounts, GraphInsight, GraphStore, Relation } from '../stores/graph/types'
import { createDescriber } from '../stores/index/describer'
import { IndexStore } from '../stores/index/store'
import type { IndexHit, IndexMap } from '../stores/index/types'
import { createSources, type FileSource } from '../stores/index/sources/factory'
import { QdrantVectorStore } from '../stores/vector/QdrantVectorStore'
import type { VectorStore } from '../stores/vector/types'
import type { ForgetResult, Recall, RecallOptions, StoreInput, StoreResult, Subsystem } from '../types'
import { buildContext } from './context'

/**
 * ReMem facade: the single entry (`store`) and single exit (`recall`), plus
 * explicit `index()` maintenance. The Router decides the targets; the stores
 * execute. Every subsystem call is `allSettled`: one store down degrades the
 * result (`degraded`), it never throws.
 */

export interface ReMemDeps {
  logger: Logger
  embedder: Embedder
  router: Router
  /** Memory collection. */
  vector: VectorStore
  /** Index collection (separate, maintained by `index()` only). */
  indexVector: VectorStore
  graph: GraphStore
  extractor: Extractor
  indexStore: {
    index(opts?: { only?: string[] }): Promise<IndexMap>
    search(queryVec: number[], opts?: { limit?: number }): Promise<IndexHit[]>
  }
}

export interface ReMemOpts {
  /** Inject a custom Router (overrides `config.router`). */
  router?: Router
  logger?: Logger
  /** Test hook: fully built deps — `connect()` skips construction. */
  deps?: ReMemDeps
}

/**
 * Minimal structural view of the index store, so tests can fake it without
 * importing the concrete class.
 */
export function buildDeps(config: ReMemConfig, logger: Logger, router?: Router): ReMemDeps {
  const embedder = createEmbedder(config.embedder, logger)
  const chat = createChatModel(config.chat, logger)
  const effectiveRouter = router ?? createRouter(config, chat)

  const scope = config.tenant ? { tenant: config.tenant } : undefined
  const vector = new QdrantVectorStore({
    url: config.vector.url,
    apiKey: config.vector.apiKey,
    collection: config.vector.memoryCollection,
    logger,
    indexedFields: config.tenant ? ['tenant', 'collection'] : ['collection'],
  })
  const indexVector = new QdrantVectorStore({
    url: config.vector.url,
    apiKey: config.vector.apiKey,
    collection: config.vector.indexCollection,
    logger,
    indexedFields: config.tenant ? ['tenant', 'source'] : ['source'],
  })
  const graph = new Neo4jGraphStore({ ...config.graph, logger, tenant: config.tenant })
  const extractor = createExtractor(chat, logger)
  const sources: FileSource[] = createSources(config.index)
  const indexStore = new IndexStore(sources, {
    vector: indexVector,
    embedder,
    describerFor: (s) =>
      createDescriber(chat, (key, opts) => s.readPreview(key, opts), {
        describeFiles: config.index.describeFiles,
        logger,
      }),
    scanOpts: { ignore: config.index.ignore, maxEntries: config.index.maxEntries },
    scope,
    logger,
  })

  return { logger, embedder, router: effectiveRouter, vector, indexVector, graph, extractor, indexStore }
}

export class ReMem {
  private deps?: ReMemDeps
  private connected = false

  constructor(
    private readonly config: ReMemConfig,
    private readonly opts: ReMemOpts = {},
  ) {}

  /** Build providers/stores (if not injected) and bootstrap schemas/collections. Idempotent. */
  async connect(): Promise<void> {
    if (this.connected) return
    const logger = this.opts.logger ?? consoleLogger(this.config.logLevel)
    const deps = this.opts.deps ?? buildDeps(this.config, logger, this.opts.router)
    // Resolve the real vector size first (probes once for unknown models).
    const dimensions = await deps.embedder.resolveDimensions?.() ?? deps.embedder.dimensions
    // Idempotent bootstrap, in parallel.
    await Promise.all([
      deps.vector.ensureCollection(dimensions),
      deps.indexVector.ensureCollection(dimensions),
      deps.graph.ensureSchema(),
    ])
    this.deps = deps
    this.connected = true
  }

  /** UNICO entry point: write a memory. Targets come from the router (never `index`). */
  async store(input: StoreInput): Promise<StoreResult> {
    this.assertConnected()
    const { logger, embedder, router, vector, graph, extractor } = this.deps!
    const d = await router.routeWrite({ content: input.content, source: input.source })
    const id = uuidv7()
    const written: Subsystem[] = []
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }
    if (input.source) metadata.source = input.source
    const collection = input.collection ?? 'default'

    const jobs: Array<{ target: Subsystem; run: () => Promise<void> }> = []
    if (d.targets.includes('vector')) {
      jobs.push({
        target: 'vector',
        run: async () => {
          const [v] = await embedder.embed([input.content])
          await vector.upsert(id, v, {
            content: input.content,
            metadata,
            storedAt: new Date().toISOString(),
            collection,
            ...(this.config.tenant ? { tenant: this.config.tenant } : {}),
          })
          written.push('vector')
        },
      })
    }
    if (d.targets.includes('graph')) {
      jobs.push({
        target: 'graph',
        run: async () => {
          const { entities, relations } = await extractor.extract(input.content)
          // Tag every node/edge with this memory's id so `forget(id)` can
          // later determine which graph data to remove.
          await Promise.all([
            ...entities.map((e) => graph.upsertEntity(e, id)),
            ...relations.map((r) => graph.upsertRelation(r, id)),
          ])
          written.push('graph')
        },
      })
    }

    const settled = await Promise.allSettled(jobs.map((j) => j.run()))
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        logger.warn('store: subsystem write failed (degraded)', { target: jobs[i].target, err: String(s.reason) })
      }
    })

    return { id, writtenTo: written }
  }

  /** UNICO exit point: read across the stores the router picks (or `opts.only`). */
  async recall(query: string, opts?: RecallOptions): Promise<Recall> {
    this.assertConnected()
    const { logger, embedder, router, vector, indexStore } = this.deps!
    const targets: Subsystem[] = opts?.only ?? (await router.routeRead({ query })).targets
    const limit = opts?.limit ?? 5
    const filter = this.recallFilter(opts?.collections)

    const [mem, gr, idx] = await Promise.allSettled([
      targets.includes('vector')
        ? embedder.embedQuery(query).then((v) => vector.search(v, { limit, filter }))
        : Promise.resolve(undefined),
      targets.includes('graph') ? this.graphInsight(query, limit) : Promise.resolve(undefined),
      targets.includes('index')
        ? embedder.embedQuery(query).then((v) => indexStore.search(v, { limit }))
        : Promise.resolve(undefined),
    ])

    const sources: Subsystem[] = []
    const degraded: Subsystem[] = []
    const track = (sub: Subsystem, result: PromiseSettledResult<unknown>): void => {
      if (result.status === 'fulfilled') sources.push(sub)
      else {
        degraded.push(sub)
        logger.warn('recall: subsystem degraded', { target: sub, err: String(result.reason) })
      }
    }
    if (targets.includes('vector')) track('vector', mem)
    if (targets.includes('graph')) track('graph', gr)
    if (targets.includes('index')) track('index', idx)

    return buildContext({
      query,
      memories: targets.includes('vector') && mem.status === 'fulfilled' ? (mem.value ?? []) : undefined,
      graph: targets.includes('graph') && gr.status === 'fulfilled' ? (gr.value ?? undefined) : undefined,
      index: targets.includes('index') && idx.status === 'fulfilled' ? (idx.value ?? undefined) : undefined,
      sources,
      degraded: degraded.length > 0 ? degraded : undefined,
    })
  }

  /**
   * Delete a stored memory: removes its vector point and — via provenance —
   * the graph entities/relations it was the last source of. `opts.only`
   * restricts the targets (default: both `vector` and `graph`; `index` is
   * never a forget target). Idempotent: forgetting an unknown id is a no-op.
   * Each subsystem call is allSettled: one store down degrades the result,
   * it never throws.
   */
  async forget(memoryId: string, opts?: { only?: Subsystem[] }): Promise<ForgetResult> {
    this.assertConnected()
    const { logger, vector, graph } = this.deps!
    // `index` is never a forget target: it is maintained by `index()` only.
    const targets: Subsystem[] = (opts?.only ?? ['vector', 'graph']).filter((t) => t !== 'index')

    let graphCounts: GraphForgetCounts | undefined
    const jobs: Array<{ target: Subsystem; run: () => Promise<void> }> = []
    if (targets.includes('vector')) {
      jobs.push({ target: 'vector', run: () => vector.delete([memoryId]) })
    }
    if (targets.includes('graph')) {
      jobs.push({
        target: 'graph',
        run: async () => {
          graphCounts = await graph.forgetMemory(memoryId)
        },
      })
    }

    const settled = await Promise.allSettled(jobs.map((j) => j.run()))
    const deletedFrom: Subsystem[] = []
    const degraded: Subsystem[] = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') deletedFrom.push(jobs[i].target)
      else {
        degraded.push(jobs[i].target)
        logger.warn('forget: subsystem delete failed (degraded)', { target: jobs[i].target, err: String(s.reason) })
      }
    })

    return {
      deletedFrom,
      graph: graphCounts,
      degraded: degraded.length > 0 ? degraded : undefined,
    }
  }

  /** Explicit-only index maintenance (scan + describe the configured FileSources). */
  async index(opts?: { only?: string[] }): Promise<IndexMap> {
    this.assertConnected()
    return this.deps!.indexStore.index(opts)
  }

  /** Release resources (best-effort). */
  async close(): Promise<void> {
    if (!this.deps) return
    await this.deps.graph.close?.().catch(() => {})
    this.connected = false
  }

  /**
   * Graph insight for a recall: extract the salient entities of the query
   * (max 3) and union their 1-hop neighborhoods. Resilient: any failure →
   * empty insight (the recall itself stays alive).
   */
  private async graphInsight(query: string, limit: number): Promise<GraphInsight> {
    const { graph, extractor, logger } = this.deps!
    try {
      const { entities } = await extractor.extract(query, { maxEntities: 3 })
      const insights = await Promise.all(entities.map((e) => graph.neighbors(e.id, { depth: 1, limit })))
      const ents = new Map<string, Entity>()
      const rels = new Map<string, Relation>()
      for (const ins of insights) {
        for (const e of ins.entities) if (!ents.has(e.id)) ents.set(e.id, e)
        for (const r of ins.relations) rels.set(`${r.from}|${r.type}|${r.to}`, r)
      }
      return { entities: [...ents.values()], relations: [...rels.values()] }
    } catch (err) {
      logger.warn('recall: graph insight unavailable, returning empty', { err: String(err) })
      return { entities: [], relations: [] }
    }
  }

  /** Tenant (always, from config) + logical collection scope (scalar or OR list). */
  private recallFilter(collections?: string | string[]): Record<string, unknown> | undefined {
    const f: Record<string, unknown> = {}
    if (this.config.tenant) f.tenant = this.config.tenant
    if (typeof collections === 'string') f.collection = collections
    else if (collections && collections.length > 0) f.collection = collections
    return Object.keys(f).length > 0 ? f : undefined
  }

  private assertConnected(): void {
    if (!this.connected) throw new ConnectionError('ReMem is not connected — call connect() before store/recall/forget/index')
  }
}

/** Convenience factory. */
export function createReMem(config: ReMemConfig, opts?: ReMemOpts): ReMem {
  return new ReMem(config, opts)
}
