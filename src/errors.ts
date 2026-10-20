/**
 * Error hierarchy for ReMem. Every library error extends `ReMemError` so callers
 * can catch a single base type. `name` reflects the concrete class.
 */
export class ReMemError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = new.target.name
  }
}

/** Invalid configuration (schema or provider setup). */
export class ConfigError extends ReMemError {}

/** A backend (Qdrant/Neo4j) is unreachable or failed to connect. */
export class ConnectionError extends ReMemError {}

/** Embedding provider failed. */
export class EmbeddingError extends ReMemError {}

/** Chat / LLM call or parsing failed. */
export class LLMError extends ReMemError {}

/** Vector store (Qdrant) operation failed. */
export class VectorStoreError extends ReMemError {}

/** Graph store (Neo4j) operation failed. */
export class GraphStoreError extends ReMemError {}

/** Index store / FileSource operation failed. */
export class IndexStoreError extends ReMemError {}

/** Router (decision model) failed. */
export class RouterError extends ReMemError {}

/** The principal lacks permission for the requested scope (MCP enterprise mode). */
export class PermissionError extends ReMemError {}
