import type { ReMemConfig } from '../../config'
import { ConfigError } from '../../errors'
import type { Logger } from '../../logging'
import { OllamaEmbedder } from './OllamaEmbedder'
import { OpenAIEmbedder } from './OpenAIEmbedder'
import type { Embedder } from './types'

export { OllamaEmbedder, OpenAIEmbedder }
export type { Embedder }

/** Build the configured embedder. */
export function createEmbedder(cfg: ReMemConfig['embedder'], logger?: Logger): Embedder {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIEmbedder({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        dimensions: cfg.dimensions,
        logger,
      })
    case 'ollama':
      return new OllamaEmbedder({ baseUrl: cfg.baseUrl, model: cfg.model, dimensions: cfg.dimensions, logger })
    default: {
      const _exhaustive: never = cfg
      throw new ConfigError(`Unknown embedder provider: ${String(_exhaustive)}`)
    }
  }
}
