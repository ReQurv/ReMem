import type { VectorHit } from './stores/vector/types'
import type { GraphForgetCounts, GraphInsight } from './stores/graph/types'
import type { IndexMap, IndexHit } from './stores/index/types'

/** Internal memory subsystems the router routes between. */
export type Subsystem = 'vector' | 'graph' | 'index'

/** UNICO entry point. */
export interface StoreInput {
  content: string
  /** Provenance (e.g. which file this came from). Does NOT trigger an FS scan. */
  source?: string
  /**
   * Logical collection this memory belongs to (default `"default"`). Used to
   * scope/group queries; unrelated to the tenant (which comes from config).
   */
  collection?: string
  metadata?: Record<string, unknown>
}

export interface StoreResult {
  id: string
  writtenTo: Subsystem[]
}

/** Result of `forget()`: which subsystems deleted, and what the graph removed. */
export interface ForgetResult {
  /** Subsystems that confirmed the delete. */
  deletedFrom: Subsystem[]
  /** Graph entities/relations removed (undefined when the graph was not a target or degraded). */
  graph?: GraphForgetCounts
  /** Subsystems that were requested but failed to delete (degraded, non-fatal). */
  degraded?: Subsystem[]
}

/** UNICO exit point options. */
export interface RecallOptions {
  limit?: number
  /** Override the router: force reading only these subsystems. */
  only?: Subsystem[]
  /**
   * Restrict the vector search to one or more logical collections
   * (OR semantics). Omitted/absent → all collections of this tenant.
   */
  collections?: string | string[]
}

export interface Recall {
  /** Filled when 'vector' answered. */
  memories: VectorHit[]
  /** Filled when 'graph' answered. */
  graph?: GraphInsight
  /** Filled when 'index' answered: full map or semantic hits. */
  index?: IndexMap | IndexHit[]
  /** Which stores produced results. */
  sources: Subsystem[]
  /** Stores that were requested but degraded (non-fatal). */
  degraded?: Subsystem[]
  /** Render a compact, context-ready prompt block. */
  toPrompt(): string
}
