import { EmbeddingError } from '../../errors'
import type { Logger } from '../../logging'
import { httpJson } from '../http'
import type { Embedder } from './types'

interface OpenAIEmbedResponse {
  data: Array<{ index: number; embedding: number[] }>
}

export interface OpenAIEmbedderOpts {
  apiKey: string
  /** Any OpenAI-compatible base URL (default official API). */
  baseUrl: string
  model: string
  /** Explicit dimension; required for unknown/custom models. */
  dimensions?: number
  logger?: Logger
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

const DEFAULT_DIMENSIONS = 1536

/** Embedder for any OpenAI-compatible `/embeddings` endpoint. */
export class OpenAIEmbedder implements Embedder {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly logger?: Logger
  /** True when the size is certain (explicit config or known model table). */
  private readonly knownDimensions: boolean
  private resolvedDimensions: number | null = null

  constructor(opts: OpenAIEmbedderOpts) {
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.logger = opts.logger
    this.knownDimensions = opts.dimensions !== undefined || MODEL_DIMENSIONS[opts.model] !== undefined
    if (opts.dimensions !== undefined) this.resolvedDimensions = opts.dimensions
  }

  /** Declared size: explicit config, model table, or the 1536 default estimate. */
  get dimensions(): number {
    return this.resolvedDimensions ?? MODEL_DIMENSIONS[this.model] ?? DEFAULT_DIMENSIONS
  }

  /**
   * Actual size. When the model is unknown (custom endpoint) and no explicit
   * `dimensions` was given, embeds a probe text once and caches the result.
   */
  async resolveDimensions(): Promise<number> {
    if (this.resolvedDimensions !== null) return this.resolvedDimensions
    if (this.knownDimensions) {
      this.resolvedDimensions = this.dimensions
      return this.resolvedDimensions
    }
    const vec = await this.embedQuery('remem dimension probe')
    this.resolvedDimensions = vec.length
    this.logger?.debug('embedder: probed dimensions', { model: this.model, dimensions: vec.length })
    return vec.length
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await httpJson<OpenAIEmbedResponse>(
      `${this.baseUrl}/embeddings`,
      { model: this.model, input: texts },
      { token: this.apiKey, error: EmbeddingError, label: 'embed(openai)', logger: this.logger },
    )
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text])
    return vec
  }
}
