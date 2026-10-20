import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ReMem } from '../../src/core/ReMem'
import { ReMemConfigSchema } from '../../src/config'
import { HeuristicRouter } from '../../src/router/HeuristicRouter'
import type { ChatModel } from '../../src/providers/chat/types'
import { createExtractor } from '../../src/stores/graph/extractor'
import { Neo4jGraphStore } from '../../src/stores/graph/Neo4jGraphStore'
import { createDescriber } from '../../src/stores/index/describer'
import { IndexStore } from '../../src/stores/index/store'
import type { FileSource } from '../../src/stores/index/sources/types'
import { LocalFileSource } from '../../src/stores/index/sources/local'
import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import type { Embedder } from '../../src/providers/embedder/types'
import { noopLogger } from '../../src/logging'

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const NEO4J_URI = process.env.NEO4J_URI ?? 'bolt://localhost:7687'
const MEM_COLLECTION = 'remem_test_mt_mem'
const INDEX_COLLECTION = 'remem_test_mt_idx'

const available = await (async () => {
  try {
    const res = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
})()

// Deterministic pseudo-embedder.
function fakeVec(text: string): number[] {
  const v = new Array<number>(8).fill(0)
  for (let i = 0; i < text.length; i += 1) v[i % 8] += (text.charCodeAt(i) % 7) + 1
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}
const fakeEmbedder: Embedder = {
  dimensions: 8,
  embed: async (texts) => texts.map(fakeVec),
  embedQuery: async (text) => fakeVec(text),
}

// Deterministic "LLM":
// - extractor prompt → entities for capitalized words (id = lowercased word)
// - describer prompt → one description per listed path
const fakeChat: ChatModel = {
  complete: async (messages) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    if (sys.includes('knowledge-graph extractor')) {
      const words = user.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []
      const seen = new Set<string>()
      const entities = []
      for (const w of words) {
        if (seen.has(w)) continue
        seen.add(w)
        entities.push({ id: w.toLowerCase(), label: 'Person', name: w })
      }
      return JSON.stringify({ entities, relations: [] })
    }
    if (sys.includes('filesystem indexer')) {
      const map: Record<string, string> = {}
      for (const line of user.split('\n')) {
        const path = line.trim().split(' ')[0]
        if (path && !path.startsWith('Entries:')) map[path] = 'voce di test'
      }
      return JSON.stringify(map)
    }
    return '{}'
  },
}

function buildTenant(tenant: string, sources: FileSource[] = []) {
  const graph = new Neo4jGraphStore({
    uri: NEO4J_URI,
    username: 'neo4j',
    password: 'changeit',
    logger: noopLogger,
    tenant,
  })
  const vector = new QdrantVectorStore({ url: QDRANT_URL, collection: MEM_COLLECTION, logger: noopLogger })
  const indexVector = new QdrantVectorStore({ url: QDRANT_URL, collection: INDEX_COLLECTION, logger: noopLogger })
  const indexStore = new IndexStore(sources, {
    vector: indexVector,
    embedder: fakeEmbedder,
    describerFor: (s) =>
      createDescriber(fakeChat, (k, o) => s.readPreview(k, o), { describeFiles: true, logger: noopLogger }),
    scope: { tenant },
    logger: noopLogger,
  })
  const config = ReMemConfigSchema.parse({
    embedder: { provider: 'ollama' },
    chat: { provider: 'ollama' },
    tenant,
    vector: { memoryCollection: MEM_COLLECTION, indexCollection: INDEX_COLLECTION },
  })
  const deps = {
    logger: noopLogger,
    embedder: fakeEmbedder,
    router: new HeuristicRouter(),
    vector,
    indexVector,
    graph,
    extractor: createExtractor(fakeChat, noopLogger),
    indexStore,
  }
  const mem = new ReMem(config, { deps })
  return { mem, deps, graph, vector, indexVector }
}

describe('ReMem multi-tenant + multi-collection (integration)', () => {
  let acme: ReturnType<typeof buildTenant>
  let globex: ReturnType<typeof buildTenant>
  let graphUp = false
  const t = available ? test : test.skip

  let fixture: string

  beforeAll(async () => {
    if (!available) return
    fixture = await mkdtemp(path.join(tmpdir(), 'remem-mt-'))
    await mkdir(path.join(fixture, 'docs'), { recursive: true })
    await writeFile(path.join(fixture, 'docs/guide.md'), '# guida')
    const sources = () => [new LocalFileSource('local', fixture)]
    acme = buildTenant('acme', sources())
    globex = buildTenant('globex', sources())
    for (const { vector, indexVector } of [acme, globex]) {
      try {
        await vector.drop()
      } catch {
        /* first run */
      }
      try {
        await indexVector.drop()
      } catch {
        /* first run */
      }
      await vector.ensureCollection(8)
      await indexVector.ensureCollection(8)
    }
    const graph = new Neo4jGraphStore({ uri: NEO4J_URI, username: 'neo4j', password: 'changeit', logger: noopLogger })
    try {
      await graph.ensureSchema()
      // clean only the tenant-scoped ids of these two tenants
      await graph.query(
        "MATCH (n:Entity) WHERE n.id STARTS WITH 'acme/' OR n.id STARTS WITH 'globex/' DETACH DELETE n",
      )
      await graph.close()
      graphUp = true
    } catch {
      graphUp = false
    }
    await acme.mem.connect()
    await globex.mem.connect()
  })

  afterAll(async () => {
    if (!available) return
    await acme.mem.close().catch(() => {})
    await globex.mem.close().catch(() => {})
    await acme.vector.drop().catch(() => {})
    await acme.indexVector.drop().catch(() => {})
    await rm(fixture, { recursive: true, force: true }).catch(() => {})
    if (graphUp) {
      const graph = new Neo4jGraphStore({ uri: NEO4J_URI, username: 'neo4j', password: 'changeit', logger: noopLogger })
      await graph
        .query("MATCH (n:Entity) WHERE n.id STARTS WITH 'acme/' OR n.id STARTS WITH 'globex/' DETACH DELETE n")
        .catch(() => {})
      await graph.close().catch(() => {})
    }
  })

  t('two tenants store: each sees only its own memories', async () => {
    await acme.mem.store({ content: 'ACME: Marco preferisce i gatti' })
    await globex.mem.store({ content: 'GLOBEX: Luca preferisce i cani' })

    const rA = await acme.mem.recall('qual è la preferenza?', { only: ['vector'] })
    expect(rA.memories.length).toBe(1)
    expect(String(rA.memories[0].payload.content)).toContain('ACME')

    const rB = await globex.mem.recall('qual è la preferenza?', { only: ['vector'] })
    expect(rB.memories.length).toBe(1)
    expect(String(rB.memories[0].payload.content)).toContain('GLOBEX')
  })

  t('graph is tenant-scoped: same entity name, no cross-tenant leak', async () => {
    if (!graphUp) return
    await acme.mem.store({ content: 'Marco collabora con il team ACME sul progetto Zeta' })
    await globex.mem.store({ content: 'Marco collabora con il team GLOBEX sul progetto Omega' })

    const rA = await acme.mem.recall('di cosa parla Marco?', { only: ['graph'] })
    const rB = await globex.mem.recall('di cosa parla Marco?', { only: ['graph'] })
    // each tenant has its own 'marco' node (ids namespaced acme/marco, globex/marco)
    const namesA = (rA.graph?.entities ?? []).map((e) => e.name)
    const namesB = (rB.graph?.entities ?? []).map((e) => e.name)
    expect(namesA).toContain('Marco')
    expect(namesB).toContain('Marco')
    // the ACME graph must not mention GLOBEX and vice versa
    const promptA = rA.toPrompt()
    const promptB = rB.toPrompt()
    expect(promptA).not.toContain('GLOBEX')
    expect(promptB).not.toContain('ACME')
  })

  t('multi-collection: store into named collections, query one or many', async () => {
    await acme.mem.store({ content: 'nota per il progetto alpha', collection: 'alpha' })
    await acme.mem.store({ content: 'nota per il progetto beta', collection: 'beta' })

    const onlyAlpha = await acme.mem.recall('nota progetto', { only: ['vector'], collections: 'alpha' })
    expect(onlyAlpha.memories.length).toBe(1)
    expect(String(onlyAlpha.memories[0].payload.content)).toContain('alpha')

    const both = await acme.mem.recall('nota progetto', { only: ['vector'], collections: ['alpha', 'beta'], limit: 5 })
    const contents = both.memories.map((m) => String(m.payload.content)).join(' | ')
    expect(contents).toContain('alpha')
    expect(contents).toContain('beta')

    // no collection filter → everything of the tenant (alpha+beta+earlier ones)
    const all = await acme.mem.recall('nota progetto', { only: ['vector'], limit: 10 })
    expect(all.memories.length).toBeGreaterThanOrEqual(2)
  })

  t('index() is tenant-scoped: same source, isolated points (no overwrite)', async () => {
    // both tenants index the SAME fixture under the SAME source id
    const mapA = await acme.mem.index()
    const mapB = await globex.mem.index()
    // fixture has a dir + a file → ≥2 entries each
    expect(mapA.entries.length).toBeGreaterThanOrEqual(2)
    expect(mapB.entries.length).toBeGreaterThanOrEqual(2)

    // two separate points per path (scoped point ids): acme's upsert must not
    // have clobbered globex's and vice versa
    const allLocal = await acme.indexVector.list({ filter: { source: 'local' } })
    expect(allLocal.length).toBe(4)
    const tenants = allLocal.map((h) => String(h.payload.tenant)).sort()
    expect(tenants).toEqual(['acme', 'acme', 'globex', 'globex'])

    // each tenant's scoped view sees only its own points
    const acmeOnly = await acme.indexVector.list({ filter: { source: 'local', tenant: 'acme' } })
    expect(acmeOnly.length).toBe(2)
    for (const hit of acmeOnly) expect(hit.payload.tenant).toBe('acme')
  })
})
