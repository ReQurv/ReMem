/**
 * @requrv/remem — public barrel.
 *
 * Public surface: the `ReMem` facade (`store`/`recall`/`index`), config,
 * errors, logging, the decision-model types (Subsystem/Router/…) and the
 * `HeuristicRouter` for custom router injection. Providers and stores stay
 * internal.
 */

// Errors
export {
  ReMemError,
  ConfigError,
  ConnectionError,
  EmbeddingError,
  LLMError,
  VectorStoreError,
  GraphStoreError,
  IndexStoreError,
  RouterError,
} from './errors'

// Logging
export { noopLogger, consoleLogger } from './logging'
export type { Logger, LogLevel } from './logging'

// Config
export { ReMemConfigSchema, loadConfigFromEnv } from './config'
export type { ReMemConfig } from './config'

// Domain types
export type { Subsystem, StoreInput, StoreResult, RecallOptions, Recall } from './types'

// Router (decision model)
export type { Router, RouteState, RouteDecision } from './router/types'
export { HeuristicRouter } from './router'

// Facade
export { ReMem, createReMem } from './core/ReMem'
export type { ReMemOpts, ReMemDeps } from './core/ReMem'

// Store interfaces
export type { VectorStore, VectorHit, VectorSearchOpts } from './stores/vector/types'
export type { GraphStore, Entity, Relation, GraphInsight } from './stores/graph/types'
export type { FileEntry, IndexMap, IndexHit } from './stores/index/types'
export { IndexSourceSchema } from './stores/index/sources/config'
export type { IndexSourceConfig } from './stores/index/sources/config'
