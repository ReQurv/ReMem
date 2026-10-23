/**
 * Graph store abstraction (Neo4j). Stores the knowledge graph:
 * entities (nodes) and relations (edges), extracted by an LLM.
 */
export interface Entity {
  id: string
  label: string
  name: string
  properties?: Record<string, unknown>
}

export interface Relation {
  from: string
  to: string
  type: string
  properties?: Record<string, unknown>
}

export interface GraphInsight {
  entities: Entity[]
  relations: Relation[]
  summary?: string
}

/** What `forgetMemory` actually removed from the graph. */
export interface GraphForgetCounts {
  entities: number
  relations: number
}

export interface GraphStore {
  /** Create constraints/indices if missing. Idempotent. */
  ensureSchema(): Promise<void>
  /**
   * Write/replace an entity. `memoryId`, when given, is recorded as
   * provenance (`sourceMemories` list) so `forgetMemory` can later tell
   * which memories depend on this entity.
   */
  upsertEntity(e: Entity, memoryId?: string): Promise<void>
  /** Same provenance semantics as `upsertEntity`. */
  upsertRelation(r: Relation, memoryId?: string): Promise<void>
  query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  /** Subgraph around an entity, up to `depth`. */
  neighbors(entityId: string, opts?: { depth?: number; limit?: number }): Promise<GraphInsight>
  /**
   * Remove `memoryId` from the provenance of every entity/relation that
   * references it, and delete the ones it was the LAST source of (relations
   * first, then entities left with no provenance and no remaining edges).
   * Idempotent: forgetting an unknown id is a no-op.
   */
  forgetMemory(memoryId: string): Promise<GraphForgetCounts>
  /** Release connections (best-effort; not every backend has them). */
  close?(): Promise<void>
}
