import { describe, expect, test } from 'bun:test'

import { ReMemConfigSchema } from '../../src/config'
import { ConfigError } from '../../src/errors'
import type { ChatModel } from '../../src/providers/chat/types'
import { createRouter, HeuristicRouter, LLMRouter, LayaRouter } from '../../src/router'

const base = { embedder: { provider: 'ollama' as const }, chat: { provider: 'ollama' as const } }
const noopChat: ChatModel = { complete: async () => '{}' }

describe('createRouter', () => {
  test("default / 'heuristic' → HeuristicRouter", () => {
    const defaultCfg = ReMemConfigSchema.parse(base)
    expect(defaultCfg.router).toBe('heuristic')
    expect(createRouter(defaultCfg)).toBeInstanceOf(HeuristicRouter)
    expect(createRouter(ReMemConfigSchema.parse({ ...base, router: 'heuristic' }))).toBeInstanceOf(
      HeuristicRouter,
    )
  })

  test("'llm' with ChatModel → LLMRouter", () => {
    expect(createRouter(ReMemConfigSchema.parse({ ...base, router: 'llm' }), noopChat)).toBeInstanceOf(
      LLMRouter,
    )
  })

  test("'llm' without ChatModel → ConfigError", () => {
    expect(() => createRouter(ReMemConfigSchema.parse({ ...base, router: 'llm' }))).toThrow(ConfigError)
  })

  test("'laya' with laya config → LayaRouter", () => {
    const cfg = ReMemConfigSchema.parse({
      ...base,
      router: 'laya',
      laya: { endpoint: 'http://localhost:8080/predict' },
    })
    expect(createRouter(cfg)).toBeInstanceOf(LayaRouter)
  })

  test("'laya' without laya config → ConfigError", () => {
    expect(() => createRouter(ReMemConfigSchema.parse({ ...base, router: 'laya' }))).toThrow(ConfigError)
  })
})
