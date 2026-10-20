import { LLMError } from '../../errors'
import type { Logger } from '../../logging'
import { httpJson } from '../http'
import type { ChatMessage, ChatModel } from './types'

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
}

export interface OllamaChatOpts {
  /** Ollama base URL (e.g. http://localhost:11434). */
  baseUrl: string
  model: string
  logger?: Logger
}

/** Chat model for a local Ollama server (`/api/chat`). */
export class OllamaChat implements ChatModel {
  private readonly baseUrl: string
  private readonly model: string
  private readonly logger?: Logger

  constructor(opts: OllamaChatOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.logger = opts.logger
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await httpJson<OllamaChatResponse>(
      `${this.baseUrl}/api/chat`,
      { model: this.model, messages, stream: false },
      { error: LLMError, label: 'chat(ollama)', logger: this.logger },
    )
    return res.message?.content ?? ''
  }

  /**
   * Ollama has no universal `response_format`; nudge the model to emit JSON
   * only. Callers should still parse defensively.
   */
  async completeJson(messages: ChatMessage[]): Promise<string> {
    return this.complete([...messages, { role: 'system', content: 'Respond ONLY with a valid JSON object.' }])
  }
}
