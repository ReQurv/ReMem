import { describe, expect, test } from 'bun:test'

import { createChatModel } from '../../src/providers/chat'
import { createEmbedder } from '../../src/providers/embedder'
import { OllamaChat, OpenAIChat } from '../../src/providers/chat'
import { OllamaEmbedder, OpenAIEmbedder } from '../../src/providers/embedder'

describe('provider factories', () => {
  test('createEmbedder picks the configured provider', () => {
    const o = createEmbedder({ provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
    expect(o).toBeInstanceOf(OpenAIEmbedder)
    expect(o.dimensions).toBe(1536)

    const l = createEmbedder({ provider: 'ollama', baseUrl: 'http://x', model: 'nomic-embed-text', dimensions: 768 })
    expect(l).toBeInstanceOf(OllamaEmbedder)
    expect(l.dimensions).toBe(768)
  })

  test('createEmbedder propagates OpenAI baseUrl (compatible endpoint)', () => {
    const o = createEmbedder({ provider: 'openai', apiKey: 'k', baseUrl: 'http://vllm:8000/v1', model: 'm' })
    expect(o).toBeInstanceOf(OpenAIEmbedder)
  })

  test('createChatModel picks the configured provider', () => {
    const o = createChatModel({ provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1', model: 'gpt-4o-mini' })
    expect(o).toBeInstanceOf(OpenAIChat)

    const l = createChatModel({ provider: 'ollama', baseUrl: 'http://x', model: 'llama3.1' })
    expect(l).toBeInstanceOf(OllamaChat)
  })
})
