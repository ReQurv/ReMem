import { describe, expect, test } from 'bun:test'

import { loadConfigFromEnv, ReMemConfigSchema } from '../src/config'
import { ConfigError } from '../src/errors'

describe('config', () => {
  test('parses a valid config with defaults', () => {
    const cfg = ReMemConfigSchema.parse({
      embedder: { provider: 'ollama' },
      chat: { provider: 'ollama' },
    })
    expect(cfg.vector.url).toBe('http://localhost:6333')
    expect(cfg.vector.memoryCollection).toBe('remem_memories')
    expect(cfg.vector.indexCollection).toBe('remem_index')
    expect(cfg.router).toBe('heuristic')
    expect(cfg.index.sources).toEqual([])
    expect(cfg.logLevel).toBe('info')
    expect(cfg.embedder).toMatchObject({ provider: 'ollama', dimensions: 768 })
  })

  test('rejects an invalid vector url', () => {
    const res = ReMemConfigSchema.safeParse({
      vector: { url: 'not-a-url' },
      embedder: { provider: 'ollama' },
      chat: { provider: 'ollama' },
    })
    expect(res.success).toBe(false)
  })

  test('loadConfigFromEnv picks OpenAI when a key is present', () => {
    const cfg = loadConfigFromEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_EMBED_MODEL: 'text-embedding-3-small',
      OPENAI_CHAT_MODEL: 'gpt-4o-mini',
    } as NodeJS.ProcessEnv)
    expect(cfg.vector.url).toBe('http://localhost:6333')
    expect(cfg.embedder).toMatchObject({ provider: 'openai', apiKey: 'sk-test' })
    expect(cfg.chat).toMatchObject({ provider: 'openai', apiKey: 'sk-test' })
    // OpenAI is OpenAI-compatible: defaults to the official base URL
    expect(cfg.embedder.baseUrl).toBe('https://hive.requrv.ai/api/v1')
    expect(cfg.chat.baseUrl).toBe('https://hive.requrv.ai/api/v1')
  })

  test('loadConfigFromEnv honours OPENAI_BASE_URL (compatible endpoint)', () => {
    const cfg = loadConfigFromEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'http://localhost:8080/v1',
    } as NodeJS.ProcessEnv)
    expect(cfg.embedder.baseUrl).toBe('http://localhost:8080/v1')
    expect(cfg.chat.baseUrl).toBe('http://localhost:8080/v1')
  })

  test('loadConfigFromEnv defaults to Ollama without a key', () => {
    const cfg = loadConfigFromEnv({} as NodeJS.ProcessEnv)
    expect(cfg.embedder).toMatchObject({ provider: 'ollama' })
    expect(cfg.chat).toMatchObject({ provider: 'ollama' })
  })

  test('loadConfigFromEnv throws ConfigError when OpenAI is forced but the key is missing', () => {
    expect(() =>
      loadConfigFromEnv({ EMBEDDER_PROVIDER: 'openai', CHAT_PROVIDER: 'ollama' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError)
  })
})
