import { describe, expect, test } from 'bun:test'

import { EmbeddingError } from '../../src/errors'
import { OpenAIEmbedder } from '../../src/providers/embedder/OpenAIEmbedder'
import { jsonResponse, mockFetch, type FetchInit } from '../helpers'

describe('OpenAIEmbedder', () => {
  test('embed returns vectors ordered by index', async () => {
    const restore = mockFetch(() =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0.2, 0.2] },
          { index: 0, embedding: [0.1, 0.1] },
        ],
      }),
    )
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'text-embedding-3-small' })
      const out = await e.embed(['a', 'b'])
      expect(out).toEqual([
        [0.1, 0.1],
        [0.2, 0.2],
      ])
    } finally {
      restore()
    }
  })

  test('knows model dimensions and honours explicit override', () => {
    expect(new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'text-embedding-3-small' }).dimensions).toBe(1536)
    expect(new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'text-embedding-3-large' }).dimensions).toBe(3072)
    expect(
      new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'custom-model', dimensions: 384 }).dimensions,
    ).toBe(384)
    // unknown model without explicit dimensions → safe default
    expect(new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'custom-model' }).dimensions).toBe(1536)
  })

  test('sends POST {baseUrl}/embeddings with Bearer token and model', async () => {
    let url = ''
    let init: FetchInit | undefined
    const restore = mockFetch((u, i) => {
      url = u
      init = i
      return jsonResponse({ data: [{ index: 0, embedding: [1] }] })
    })
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1/', model: 'm' })
      await e.embed(['a'])
      expect(url).toBe('http://x/v1/embeddings')
      expect(init?.method).toBe('POST')
      expect(init?.headers?.authorization).toBe('Bearer k')
      expect(JSON.parse(init?.body ?? '{}')).toEqual({ model: 'm', input: ['a'] })
    } finally {
      restore()
    }
  })

  test('401 → EmbeddingError', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      await expect(e.embed(['a'])).rejects.toThrow(EmbeddingError)
      await expect(e.embedQuery('a')).rejects.toThrow(EmbeddingError)
    } finally {
      restore()
    }
  })

  test('resolveDimensions: known model resolves without probing', async () => {
    const restore = mockFetch(() => {
      throw new Error('should not fetch')
    })
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'text-embedding-3-small' })
      await expect(e.resolveDimensions?.()).resolves.toBe(1536)
    } finally {
      restore()
    }
  })

  test('resolveDimensions: unknown model probes once and caches', async () => {
    let calls = 0
    const restore = mockFetch(() => {
      calls += 1
      return jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })
    })
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'requrv-embed' })
      expect(e.dimensions).toBe(1536) // declared estimate before probing
      await expect(e.resolveDimensions?.()).resolves.toBe(3)
      await expect(e.resolveDimensions?.()).resolves.toBe(3)
      expect(e.dimensions).toBe(3)
      expect(calls).toBe(1)
    } finally {
      restore()
    }
  })

  test('resolveDimensions: explicit dimensions never probe', async () => {
    const restore = mockFetch(() => {
      throw new Error('should not fetch')
    })
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', dimensions: 4096 })
      await expect(e.resolveDimensions?.()).resolves.toBe(4096)
    } finally {
      restore()
    }
  })

  test('embedQuery returns a single vector', async () => {
    const restore = mockFetch(() => jsonResponse({ data: [{ index: 0, embedding: [0.5, 0.5] }] }))
    try {
      const e = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' })
      await expect(e.embedQuery('a')).resolves.toEqual([0.5, 0.5])
    } finally {
      restore()
    }
  })
})
