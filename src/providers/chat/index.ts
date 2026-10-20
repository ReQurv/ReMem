import type { ReMemConfig } from '../../config'
import { ConfigError } from '../../errors'
import type { Logger } from '../../logging'
import { OllamaChat } from './OllamaChat'
import { OpenAIChat } from './OpenAIChat'
import type { ChatMessage, ChatModel } from './types'

export { OllamaChat, OpenAIChat }
export type { ChatMessage, ChatModel }

/** Build the configured chat model. */
export function createChatModel(cfg: ReMemConfig['chat'], logger?: Logger): ChatModel {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIChat({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, logger })
    case 'ollama':
      return new OllamaChat({ baseUrl: cfg.baseUrl, model: cfg.model, logger })
    default: {
      const _exhaustive: never = cfg
      throw new ConfigError(`Unknown chat provider: ${String(_exhaustive)}`)
    }
  }
}
