/**
 * Vector store abstraction (Qdrant). Stores embedded memories / index entries.
 */
export interface VectorHit {
  id: string
  score: number
  payload: Record<string, unknown>
}

export interface VectorSearchOpts {
  limit?: number
  scoreThreshold?: number
  /**
   * Simple equality filter on payload fields: a scalar value means "equals",
   * an array of values means OR (any of them).
   */
  filter?: Record<string, unknown>
}

export interface VectorStore {
  /** Create the collection if missing. Idempotent. */
  ensureCollection(dimensions: number): Promise<void>
  /**
   * Write/replace a point. `id` must be a UUID (Qdrant constraint) — callers
   * should generate UUIDs.
   */
  upsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<void>
  search(vector: number[], opts?: VectorSearchOpts): Promise<VectorHit[]>
  /**
   * List points (no query vector), e.g. for state recovery / orphan cleanup.
   * `filter` is the same simple equality filter as in `search`.
   */
  list(opts?: VectorSearchOpts): Promise<VectorHit[]>
  delete(ids: string[]): Promise<void>
}
