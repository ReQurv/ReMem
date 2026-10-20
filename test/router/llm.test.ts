import { describe, expect, test } from 'bun:test'

import type { ChatMessage, ChatModel } from '../../src/providers/chat/types'
import { LLMRouter } from '../../src/router/LLMRouter'

/** ChatModel stub: completeJson returns `response` (or throws if it's an Error). */
function chatWith(response: string | Error): ChatModel {
  return {
    complete: async (_m: ChatMessage[]) => {
      if (response instanceof Error) throw response
      return response
    },
    completeJson: async (_m: ChatMessage[]) => {
      if (response instanceof Error) throw response
      return response
    },
  }
}

describe('LLMRouter (unit, mocked ChatModel)', () => {
  test('valid JSON → parsed decision (read)', async () => {
    const router = new LLMRouter(chatWith('{"targets":["vector","graph"],"confidence":0.7}'))
    const d = await router.routeRead({ query: 'come è collegato Marco al team?' })
    expect(d.targets).toEqual(['vector', 'graph'])
    expect(d.confidence).toBe(0.7)
    expect(d.reasoning).toContain('llm router')
  })

  test('valid JSON wrapped in a code fence → still parsed (write)', async () => {
    const router = new LLMRouter(chatWith('```json\n{"targets":["vector"],"confidence":1}\n```'))
    const d = await router.routeWrite({ content: 'qualche contenuto' })
    expect(d.targets).toEqual(['vector'])
    expect(d.confidence).toBe(1)
  })

  test('write: LLM-returned "index" is filtered out (never a write target)', async () => {
    const router = new LLMRouter(chatWith('{"targets":["vector","index"],"confidence":0.9}'))
    const d = await router.routeWrite({ content: 'ciao' })
    expect(d.targets).toEqual(['vector'])
  })

  test('invalid JSON → fallback to heuristic (no throw)', async () => {
    const router = new LLMRouter(chatWith('Mi dispiace, non so rispondere.'))
    const d = await router.routeRead({ query: 'in quale file è definito login?' })
    // heuristic fallback: file query → index
    expect(d.targets).toContain('vector')
    expect(d.targets).toContain('index')
  })

  test('schema violation (empty targets) → fallback (no throw)', async () => {
    const router = new LLMRouter(chatWith('{"targets":[],"confidence":0.5}'))
    const d = await router.routeRead({ query: 'ciao' })
    expect(d.targets.length).toBeGreaterThan(0)
  })

  test('schema violation (bad confidence) → fallback (no throw)', async () => {
    const router = new LLMRouter(chatWith('{"targets":["vector"],"confidence":42}'))
    const d = await router.routeWrite({ content: 'x'.repeat(60) })
    expect(d.targets).toContain('vector')
    expect(d.confidence).toBeGreaterThanOrEqual(0)
    expect(d.confidence).toBeLessThanOrEqual(1)
  })

  test('completeJson throws → fallback (no throw)', async () => {
    const router = new LLMRouter(chatWith(new Error('boom')))
    const d = await router.routeRead({ query: 'chi collabora con Marco?' })
    expect(d.targets.length).toBeGreaterThan(0)
  })

  test('no completeJson → uses complete()', async () => {
    const chat: ChatModel = {
      complete: async () => '{"targets":["vector","index"],"confidence":0.6}',
    }
    const router = new LLMRouter(chat)
    const d = await router.routeRead({ query: 'dove sta il file?' })
    expect(d.targets).toEqual(['vector', 'index'])
  })

  test('chat is actually called with the state text', async () => {
    const seen: string[] = []
    const chat: ChatModel = {
      complete: async (m) => {
        seen.push(m.map((x) => x.content).join('|'))
        return '{"targets":["vector"],"confidence":0.8}'
      },
    }
    const router = new LLMRouter(chat)
    await router.routeRead({ query: 'la mia query' })
    expect(seen[0]).toContain('la mia query')
    expect(seen[0]).toContain('memory router')
  })
})
