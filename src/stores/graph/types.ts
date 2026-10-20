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

export interface GraphStore {
  /** Create constraints/indices if missing. Idempotent. */
  ensureSchema(): Promise<void>
  upsertEntity(e: Entity): Promise<void>
  upsertRelation(r: Relation): Promise<void>
  query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  /** Subgraph around an entity, up to `depth`. */
  neighbors(entityId: string, opts?: { depth?: number; limit?: number }): Promise<GraphInsight>
  /** Release connections (best-effort; not every backend has them). */
  close?(): Promise<void>
}
