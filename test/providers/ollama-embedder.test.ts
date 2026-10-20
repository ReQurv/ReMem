import { describe, expect, test } from 'bun:test'

import { EmbeddingError } from '../../src/errors'
import { OllamaEmbedder } from '../../src/providers/embedder/OllamaEmbedder'
import { jsonResponse, mockFetch } from '../helpers'

describe('OllamaEmbedder', () => {
  test('parses batch embeddings[] from /api/embed', async () => {
    let url = ''
    const restore = mockFetch((u) => {
      url = u
      return jsonResponse({ embeddings: [[1, 2], [3, 4]] })
    })
    try {
      const e = new OllamaEmbedder({ baseUrl: 'http://x', model: 'nomic-embed-text', dimensions: 2 })
      const out = await e.embed(['a', 'b'])
      expect(url).toBe('http://x/api/embed')
      expect(out).toEqual([
        [1, 2],
        [3, 4],
      ])
      expect(e.dimensions).toBe(2)
    } finally {
      restore()
    }
  })

  test('500 → EmbeddingError (no fallback)', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'boom' }, 500))
    try {
      const e = new OllamaEmbedder({ baseUrl: 'http://x', model: 'm', dimensions: 1 })
      await expect(e.embed(['a'])).rejects.toThrow(EmbeddingError)
    } finally {
      restore()
    }
  })

  test('404 on /api/embed falls back to legacy /api/embeddings per text', async () => {
    const calls: string[] = []
    const restore = mockFetch((url) => {
      calls.push(url)
      if (url.endsWith('/api/embed')) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse({ embedding: [0.5] })
    })
    try {
      const e = new OllamaEmbedder({ baseUrl: 'http://x', model: 'm', dimensions: 1 })
      const out = await e.embed(['a', 'b'])
      expect(out).toEqual([
        [0.5],
        [0.5],
      ])
      expect(calls).toEqual(['http://x/api/embed', 'http://x/api/embeddings', 'http://x/api/embeddings'])
    } finally {
      restore()
    }
  })

  test('embedQuery returns a single vector', async () => {
    const restore = mockFetch(() => jsonResponse({ embeddings: [[0.1]] }))
    try {
      const e = new OllamaEmbedder({ baseUrl: 'http://x', model: 'm', dimensions: 1 })
      await expect(e.embedQuery('a')).resolves.toEqual([0.1])
    } finally {
      restore()
    }
  })
})
