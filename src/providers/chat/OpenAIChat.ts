import { LLMError } from '../../errors'
import type { Logger } from '../../logging'
import { httpJson } from '../http'
import type { ChatMessage, ChatModel } from './types'

interface OpenAIChatResponse {
  choices: Array<{ message: { role?: string; content: string | null } }>
}

export interface OpenAIChatOpts {
  apiKey: string
  /** Any OpenAI-compatible base URL (default official API). */
  baseUrl: string
  model: string
  logger?: Logger
}

/** Chat model for any OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAIChat implements ChatModel {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly logger?: Logger

  constructor(opts: OpenAIChatOpts) {
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.logger = opts.logger
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.call(messages, false)
  }

  async completeJson(messages: ChatMessage[]): Promise<string> {
    return this.call(messages, true)
  }

  private async call(messages: ChatMessage[], json: boolean): Promise<string> {
    const body: Record<string, unknown> = { model: this.model, messages }
    if (json) body.response_format = { type: 'json_object' }
    const res = await httpJson<OpenAIChatResponse>(
      `${this.baseUrl}/chat/completions`,
      body,
      { token: this.apiKey, error: LLMError, label: 'chat(openai)', logger: this.logger },
    )
    return res.choices[0]?.message.content ?? ''
  }
}
