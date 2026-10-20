import { EmbeddingError } from '../../errors'
import type { Logger } from '../../logging'
import { httpJson } from '../http'
import type { Embedder } from './types'

interface OllamaEmbedBatchResponse {
  embeddings: number[][]
}

interface OllamaEmbedSingleResponse {
  embedding: number[]
}

export interface OllamaEmbedderOpts {
  /** Ollama base URL (e.g. http://localhost:11434). */
  baseUrl: string
  model: string
  /** Vector size (nomic-embed-text = 768). */
  dimensions: number
  logger?: Logger
}

/**
 * Embedder for a local Ollama server. Uses the batch `/api/embed` endpoint;
 * falls back to the legacy per-text `/api/embeddings` on 404 (old Ollama).
 */
export class OllamaEmbedder implements Embedder {
  readonly dimensions: number
  private readonly baseUrl: string
  private readonly model: string
  private readonly logger?: Logger

  constructor(opts: OllamaEmbedderOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.dimensions = opts.dimensions
    this.logger = opts.logger
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const res = await httpJson<OllamaEmbedBatchResponse>(
        `${this.baseUrl}/api/embed`,
        { model: this.model, input: texts },
        { error: EmbeddingError, label: 'embed(ollama)', logger: this.logger },
      )
      return res.embeddings
    } catch (err) {
      if (err instanceof EmbeddingError && err.message.includes('HTTP 404')) {
        return this.embedLegacy(texts)
      }
      throw err
    }
  }

  /** Legacy endpoint: one request per text. */
  private async embedLegacy(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (const text of texts) {
      const res = await httpJson<OllamaEmbedSingleResponse>(
        `${this.baseUrl}/api/embeddings`,
        { model: this.model, prompt: text },
        { error: EmbeddingError, label: 'embed(ollama)', logger: this.logger },
      )
      out.push(res.embedding)
    }
    return out
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text])
    return vec
  }
}
