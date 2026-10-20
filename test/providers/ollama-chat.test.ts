import { describe, expect, test } from 'bun:test'

import { LLMError } from '../../src/errors'
import { OllamaChat } from '../../src/providers/chat/OllamaChat'
import { jsonResponse, mockFetch, type FetchInit } from '../helpers'

describe('OllamaChat', () => {
  test('parses message.content from /api/chat', async () => {
    let url = ''
    let init: FetchInit | undefined
    const restore = mockFetch((u, i) => {
      url = u
      init = i
      return jsonResponse({ message: { role: 'assistant', content: 'ciao' } })
    })
    try {
      const c = new OllamaChat({ baseUrl: 'http://x', model: 'llama3.1' })
      const out = await c.complete([{ role: 'user', content: 'hi' }])
      expect(url).toBe('http://x/api/chat')
      expect(out).toBe('ciao')
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({ model: 'llama3.1', stream: false })
    } finally {
      restore()
    }
  })

  test('completeJson appends a JSON-only system message', async () => {
    let body: Record<string, unknown> = {}
    const restore = mockFetch((_u, i) => {
      body = JSON.parse(i?.body ?? '{}') as Record<string, unknown>
      return jsonResponse({ message: { content: '{"ok":true}' } })
    })
    try {
      const c = new OllamaChat({ baseUrl: 'http://x', model: 'm' })
      const out = await c.completeJson!([{ role: 'user', content: 'x' }])
      expect(out).toBe('{"ok":true}')
      const messages = body.messages as Array<{ role: string; content: string }>
      expect(messages.at(-1)?.role).toBe('system')
      expect(messages.at(-1)?.content).toContain('JSON')
    } finally {
      restore()
    }
  })

  test('missing message → empty string', async () => {
    const restore = mockFetch(() => jsonResponse({}))
    try {
      const c = new OllamaChat({ baseUrl: 'http://x', model: 'm' })
      await expect(c.complete([{ role: 'user', content: 'x' }])).resolves.toBe('')
    } finally {
      restore()
    }
  })

  test('500 → LLMError', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'boom' }, 500))
    try {
      const c = new OllamaChat({ baseUrl: 'http://x', model: 'm' })
      await expect(c.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(LLMError)
    } finally {
      restore()
    }
  })
})
