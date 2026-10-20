import { v5 as uuidv5 } from 'uuid'

import type { Logger } from '../../logging'
import type { Embedder } from '../../providers/embedder/types'
import type { VectorStore } from '../vector/types'
import { diffIndex } from './diff'
import type { Describer } from './describer'
import { renderIndexMap } from './map'
import type { FileSource } from './sources/types'
import { scan, type ScanOpts } from './scanner'
import type { FileEntry, IndexHit, IndexMap } from './types'

/** Fixed namespace for deriving deterministic point ids from paths. */
const NS_REMEM_INDEX = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/** Deterministic UUID (v5) per path → idempotent upserts across index() runs. */
export function pointId(path: string): string {
  return uuidv5(path, NS_REMEM_INDEX)
}

const EMBED_CHUNK = 16

function describeText(e: FileEntry): string {
  return e.description ? `${e.path} — ${e.description}` : e.path
}

export interface IndexStoreOpts {
  /** Vector store on the index collection (separate from memories). */
  vector: VectorStore
  embedder: Embedder
  /** Build a describer bound to a source's `readPreview`. */
  describerFor: (s: FileSource) => Describer
  scanOpts?: ScanOpts
  /**
   * Extra equality scope stored on every point and applied to every
   * search/list (e.g. `{ tenant }` for multi-tenancy).
   */
  scope?: Record<string, unknown>
  logger?: Logger
}

/**
 * Index store: keeps a compact, LLM-described map of the configured
 * FileSources in the index collection.
 *
 * The ONLY trigger is explicit: `index()` (exposed as `mem.index()`).
 * Incremental: diff by cheap hash → LLM only for added/modified, stored
 * description reused for unchanged, orphans deleted **per namespace**.
 */
export class IndexStore {
  constructor(
    private readonly sources: FileSource[],
    private readonly opts: IndexStoreOpts,
  ) {}

  async index(indexOpts?: { only?: string[] }): Promise<IndexMap> {
    const sources = this.sources.filter((s) => !indexOpts?.only || indexOpts.only.includes(s.id))
    const perSource = await Promise.all(sources.map((s) => this.indexSource(s)))
    return createIndexMap(perSource.flat())
  }

  /** Semantic search over indexed entries. */
  async search(queryVec: number[], opts?: { limit?: number; only?: string[] }): Promise<IndexHit[]> {
    const limit = opts?.limit ?? 10
    const hits = await this.opts.vector.search(queryVec, {
      limit: limit * 3, // headroom for client-side `only` filtering
      filter: this.searchFilter(opts?.only),
    })
    const filtered = opts?.only ? hits.filter((h) => opts.only!.includes(String(h.payload.source))) : hits
    return filtered
      .filter((h) => typeof h.payload.path === 'string')
      .slice(0, limit)
      .map((h) => ({
        path: String(h.payload.path),
        source: String(h.payload.source ?? ''),
        type: h.payload.type === 'dir' ? 'dir' : 'file',
        score: h.score,
        description: typeof h.payload.description === 'string' ? h.payload.description : undefined,
      }))
  }

  /** Scope fields + optional single-source narrowing (arrays would be OR — `only` filters client-side). */
  private searchFilter(only?: string[]): Record<string, unknown> | undefined {
    const f: Record<string, unknown> = { ...(this.opts.scope ?? {}) }
    if (only?.length === 1) f.source = only[0]
    return Object.keys(f).length > 0 ? f : undefined
  }

  /**
   * Deterministic point id, scoped when a tenant/scope is configured: without
   * this, two tenants indexing the same path would share a point id and
   * overwrite each other.
   */
  private scopedPath(path: string): string {
    const scope = this.opts.scope
    if (scope && Object.keys(scope).length > 0) {
      const prefix = Object.entries(scope)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
      return `${prefix}:${path}`
    }
    return path
  }

  private async indexSource(s: FileSource): Promise<FileEntry[]> {
    const { vector, embedder, describerFor, scanOpts, logger } = this.opts

    const current = await scan(s, s.root, scanOpts)
    const existing = await this.loadExisting(s.id)
    const diff = diffIndex(current, existing)
    logger?.info('index source', { source: s.id, ...counts(diff) })

    // unchanged entries keep their stored description (no LLM)
    const cache = new Map<string, string>()
    for (const e of diff.unchanged) {
      const prev = existing.get(e.path)
      if (prev?.description) cache.set(e.path, prev.description)
    }

    const descriptions =
      current.length > 0 ? await describerFor(s).describe(current, { cache }) : new Map<string, string>()

    const result: FileEntry[] = current.map((e) => ({ ...e, description: descriptions.get(e.path) }))

    // write added + modified only
    const toWrite = [...diff.added, ...diff.modified].map((e) => ({ ...e, description: descriptions.get(e.path) }))
    if (toWrite.length > 0) {
      await this.upsertEntries(toWrite, embedder, vector)
    }

    // orphans: only within this source's namespace
    if (diff.removed.length > 0) {
      const ids = diff.removed.map((p) => existing.get(p)?.id ?? pointId(this.scopedPath(p)))
      await vector.delete(ids)
    }

    return result
  }

  private async upsertEntries(entries: FileEntry[], embedder: Embedder, vector: VectorStore): Promise<void> {
    for (let i = 0; i < entries.length; i += EMBED_CHUNK) {
      const chunk = entries.slice(i, i + EMBED_CHUNK)
      const vectors = await embedder.embed(chunk.map(describeText))
      for (let j = 0; j < chunk.length; j += 1) {
        const e = chunk[j]
        await vector.upsert(pointId(this.scopedPath(e.path)), vectors[j], {
          path: e.path,
          source: e.source,
          type: e.type,
          ext: e.ext ?? '',
          hash: e.hash ?? '',
          description: e.description ?? '',
          ...(this.opts.scope ?? {}),
        })
      }
    }
  }

  private async loadExisting(
    namespace: string,
  ): Promise<Map<string, { id: string; hash: string; description?: string }>> {
    const hits = await this.opts.vector.list({ filter: { ...(this.opts.scope ?? {}), source: namespace } })
    const m = new Map<string, { id: string; hash: string; description?: string }>()
    for (const h of hits) {
      const p = h.payload
      const path = typeof p.path === 'string' ? p.path : null
      if (!path) continue
      m.set(path, {
        id: h.id,
        hash: typeof p.hash === 'string' ? p.hash : '',
        description: typeof p.description === 'string' && p.description ? p.description : undefined,
      })
    }
    return m
  }
}

function counts(diff: { added: FileEntry[]; modified: FileEntry[]; unchanged: FileEntry[]; removed: string[] }) {
  return {
    added: diff.added.length,
    modified: diff.modified.length,
    unchanged: diff.unchanged.length,
    removed: diff.removed.length,
  }
}

/** Concrete `IndexMap` whose `toPrompt()` delegates to `renderIndexMap`. */
export function createIndexMap(entries: FileEntry[]): IndexMap {
  return {
    updatedAt: Date.now(),
    entries,
    toPrompt: () => renderIndexMap({ entries }),
  }
}
