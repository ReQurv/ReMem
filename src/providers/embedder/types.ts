/**
 * Pluggable embedding backend.
 */
export interface Embedder {
  /**
   * Vector size (used to size the Qdrant collection). For backends with
   * unknown/custom models this may be a declared estimate: call
   * `resolveDimensions()` first (when available) to get the real size.
   */
  readonly dimensions: number
  /** Resolve the actual vector size, probing the API once if needed. */
  resolveDimensions?(): Promise<number>
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>
  /** Embed a single query text. */
  embedQuery(text: string): Promise<number[]>
}
