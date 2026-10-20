import { describe, expect, test } from 'bun:test'

import { LLMError } from '../../src/errors'
import { OpenAIChat } from '../../src/providers/chat/OpenAIChat'
import { jsonResponse, mockFetch, type FetchInit } from '../helpers'

describe('OpenAIChat', () => {
  test('complete extracts choices[0].message.content', async () => {
    const restore = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'hello' } }] }))
    try {
      const c = new OpenAIChat({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'gpt-4o-mini' })
      await expect(c.complete([{ role: 'user', content: 'hi' }])).resolves.toBe('hello')
    } finally {
      restore()
    }
  })

  test('completeJson sends response_format json_object', async () => {
    let init: FetchInit | undefined
    const restore = mockFetch((_u, i) => {
      init = i
      return jsonResponse({ choices: [{ message: { content: '{"a":1}' } }] })
    })
    try {
      const c = new OpenAIChat({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      const out = await c.completeJson!([{ role: 'user', content: 'x' }])
      expect(out).toBe('{"a":1}')
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      expect(body.response_format).toEqual({ type: 'json_object' })
    } finally {
      restore()
    }
  })

  test('complete (non-json) does not send response_format', async () => {
    let init: FetchInit | undefined
    const restore = mockFetch((_u, i) => {
      init = i
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] })
    })
    try {
      const c = new OpenAIChat({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      await c.complete([{ role: 'user', content: 'x' }])
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      expect(body.response_format).toBeUndefined()
      expect(init?.headers?.authorization).toBe('Bearer k')
    } finally {
      restore()
    }
  })

  test('null content → empty string', async () => {
    const restore = mockFetch(() => jsonResponse({ choices: [{ message: { content: null } }] }))
    try {
      const c = new OpenAIChat({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      await expect(c.complete([{ role: 'user', content: 'x' }])).resolves.toBe('')
    } finally {
      restore()
    }
  })

  test('500 → LLMError', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'server error' }, 500))
    try {
      const c = new OpenAIChat({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      await expect(c.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(LLMError)
    } finally {
      restore()
    }
  })
})
