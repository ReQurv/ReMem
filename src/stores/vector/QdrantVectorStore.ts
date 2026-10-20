import { QdrantClient } from '@qdrant/js-client-rest'

import { ConnectionError, VectorStoreError } from '../../errors'
import type { Logger } from '../../logging'
import type { VectorHit, VectorSearchOpts, VectorStore } from './types'

export interface QdrantVectorStoreOpts {
  url: string
  apiKey?: string
  collection: string
  logger?: Logger
  /** Payload fields to create keyword indexes for (idempotent; speeds up filters). */
  indexedFields?: string[]
}

/**
 * VectorStore backed by a remote Qdrant (REST). The constructor performs no
 * I/O; call `ensureCollection` (e.g. in `connect()`) before writing/reading.
 */
export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient
  private readonly collection: string
  private readonly logger?: Logger

  constructor(private readonly opts: QdrantVectorStoreOpts) {
    this.collection = opts.collection
    this.logger = opts.logger
    this.client = new QdrantClient({ url: opts.url, apiKey: opts.apiKey })
  }

  async ensureCollection(dimensions: number): Promise<void> {
    try {
      // Note: in @qdrant/js-client-rest 1.x this returns `{ exists: boolean }`, not a boolean.
      const { exists } = await this.client.collectionExists(this.collection)
      if (!exists) {
        this.logger?.info(`creating collection '${this.collection}' (${dimensions}d, Cosine)`)
        await this.client.createCollection(this.collection, {
          vectors: { size: dimensions, distance: 'Cosine' },
        })
      }
      for (const field of this.opts.indexedFields ?? []) {
        try {
          await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: 'keyword' })
        } catch {
          /* already exists — idempotent */
        }
      }
    } catch (err) {
      wrapQdrantError('ensureCollection', this.collection, err)
    }
  }

  async upsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    assertPointIds([id])
    try {
      await this.client.upsert(this.collection, { points: [{ id, vector, payload }] })
    } catch (err) {
      wrapQdrantError('upsert', this.collection, err)
    }
  }

  async search(vector: number[], opts?: VectorSearchOpts): Promise<VectorHit[]> {
    const filter = toFilter(opts?.filter)
    try {
      const res = await this.client.query(this.collection, {
        query: vector,
        limit: opts?.limit ?? 10,
        score_threshold: opts?.scoreThreshold,
        filter,
        with_payload: true,
      })
      return res.points.map((p) => ({
        id: String(p.id),
        score: p.score,
        payload: (p.payload ?? {}) as Record<string, unknown>,
      }))
    } catch (err) {
      wrapQdrantError('search', this.collection, err)
    }
  }

  async list(opts?: VectorSearchOpts): Promise<VectorHit[]> {
    const filter = toFilter(opts?.filter)
    try {
      const hits: VectorHit[] = []
      let offset: string | number | null | undefined
      do {
        const res = await this.client.scroll(this.collection, {
          limit: 1000,
          filter,
          with_payload: true,
          offset: offset ?? undefined,
        })
        for (const p of res.points) {
          hits.push({ id: String(p.id), score: 0, payload: (p.payload ?? {}) as Record<string, unknown> })
        }
        // next_page_offset can be a shard-key object too; we only follow scalar offsets (single shard, MVP).
        const npx = res.next_page_offset
        offset = typeof npx === 'string' || typeof npx === 'number' ? npx : undefined
      } while (offset !== undefined && offset !== null)
      return hits
    } catch (err) {
      wrapQdrantError('list', this.collection, err)
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    assertPointIds(ids)
    try {
      await this.client.delete(this.collection, { points: ids })
    } catch (err) {
      wrapQdrantError('delete', this.collection, err)
    }
  }

  /** Remove the whole collection (idempotent; used by tests/maintenance). */
  async drop(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collection)
    } catch (err) {
      wrapQdrantError('drop', this.collection, err)
    }
  }
}

/**
 * Simple payload filter: scalar value → equality (`must`); array of values →
 * OR (`should`). Mixed: all equalities AND-ed with the OR group.
 */
export function toFilter(filter?: Record<string, unknown>) {
  if (!filter) return undefined
  const must: Array<{ key: string; match: { value: string | number | boolean } }> = []
  const should: Array<{ key: string; match: { value: string | number | boolean } }> = []
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      for (const v of value) should.push({ key, match: { value: v as string | number | boolean } })
    } else {
      must.push({ key, match: { value: value as string | number | boolean } })
    }
  }
  if (must.length === 0 && should.length === 0) return undefined
  if (should.length === 0) return { must }
  const or = should.length > 1 ? should : should[0]
  if (must.length === 0) return { should: or }
  return { must: [...must, { should: or }] }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Qdrant point ids must be UUIDs (unsigned integers are supported by the server
 * but numeric strings are rejected by it) — fail fast with a clear error.
 */
function assertPointIds(ids: string[]): void {
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new VectorStoreError(`Invalid Qdrant point id '${id}': must be a UUID`)
    }
  }
}

/** Network-level failures surface as ConnectionError, the rest as VectorStoreError. */
function wrapQdrantError(op: string, collection: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  const isNetwork =
    err instanceof TypeError || /fetch failed|econnrefused|econnreset|enotfound|etimedout|socket hang up/i.test(msg)
  const Ctor = isNetwork ? ConnectionError : VectorStoreError
  throw new Ctor(`Qdrant ${op} on '${collection}' failed: ${msg}`, err)
}
