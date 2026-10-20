import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import type { Embedder } from '../../src/providers/embedder/types'
import { IndexStore } from '../../src/stores/index/store'
import type { FileSource, SourceEntry } from '../../src/stores/index/sources/types'

const URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const COLLECTION = 'remem_test_remote_m4b'

const available = await (async () => {
  try {
    const res = await fetch(`${URL}/collections`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
})()

// Deterministic pseudo-embedder: identical text → identical (unit) vector.
function fakeVec(text: string): number[] {
  const v = new Array<number>(8).fill(0)
  for (let i = 0; i < text.length; i += 1) v[i % 8] += (text.charCodeAt(i) % 7) + 1
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}
const fakeEmbedder: Embedder = {
  dimensions: 8,
  embed: async (texts) => texts.map(fakeVec),
  embedQuery: async (text) => fakeVec(text),
}

/** A source that behaves like a remote one (S3-style): etag as change signal. */
function fakeRemote(files: Record<string, { size: number; mtime: number; etag: string; text?: string }>): FileSource {
  return {
    id: 's3:fake',
    kind: 's3',
    root: 's3://fake',
    list: async (): Promise<SourceEntry[]> =>
      Object.entries(files).map(([key, f]) => ({
        key,
        type: 'file',
        size: f.size,
        mtime: f.mtime,
        etag: f.etag,
        ext: key.includes('.') ? key.split('.').pop() : undefined,
      })),
    readPreview: async (key) => files[key]?.text ?? null,
  }
}

describe('IndexStore (integration, Qdrant + fake remote source)', () => {
  let vector: QdrantVectorStore
  let files: Record<string, { size: number; mtime: number; etag: string; text?: string }>
  let store: IndexStore
  const described: string[] = []
  const t = available ? test : test.skip

  // Mirrors createDescriber semantics: cache hits are served without LLM.
  const fakeDescriber = () => ({
    describe: async (entries: { path: string }[], opts?: { cache?: Map<string, string> }) => {
      const out = new Map<string, string>()
      for (const e of entries) {
        const cached = opts?.cache?.get(e.path)
        if (cached) out.set(e.path, cached)
        else {
          described.push(e.path)
          out.set(e.path, `d:${e.path.split('/').pop()}`)
        }
      }
      return out
    },
  })

  beforeAll(async () => {
    if (!available) return
    files = {
      'kb/a.md': { size: 10, mtime: 1_700_000_000, etag: 'v1', text: 'hello' },
    }
    vector = new QdrantVectorStore({ url: URL, collection: COLLECTION })
    try {
      await vector.drop()
    } catch {
      /* first run */
    }
    await vector.ensureCollection(8)
    store = new IndexStore([fakeRemote(files)], { vector, embedder: fakeEmbedder, describerFor: fakeDescriber })
  })

  afterAll(async () => {
    if (!available) return
    await vector.drop().catch(() => {})
  })

  t('initial index() writes one point with etag-based hash', async () => {
    const map = await store.index()
    expect(map.entries.map((e) => e.path)).toEqual(['s3:fake/kb/a.md'])
    const points = await vector.list({ filter: { source: 's3:fake' } })
    expect(points).toHaveLength(1)
    expect(points[0].payload.hash).toBe('etag:v1')
  })

  t('etag change with same mtime+size triggers re-description and new hash', async () => {
    files = { 'kb/a.md': { size: 10, mtime: 1_700_000_000, etag: 'v2', text: 'world' } }
    store = new IndexStore([fakeRemote(files)], { vector, embedder: fakeEmbedder, describerFor: fakeDescriber })
    await store.index()

    const points = await vector.list({ filter: { source: 's3:fake' } })
    expect(points).toHaveLength(1)
    expect(points[0].payload.hash).toBe('etag:v2')
    // the entry was described again (hash changed → not served from cache)
    expect(described.filter((p) => p === 's3:fake/kb/a.md')).toHaveLength(2)
  })

  t('unchanged etag → no new LLM call (cache hit)', async () => {
    const before = described.filter((p) => p === 's3:fake/kb/a.md').length
    await store.index()
    expect(described.filter((p) => p === 's3:fake/kb/a.md')).toHaveLength(before)
  })

  t('file removed from the remote → orphan deleted per namespace', async () => {
    files = {}
    store = new IndexStore([fakeRemote(files)], { vector, embedder: fakeEmbedder, describerFor: fakeDescriber })
    await store.index()
    const points = await vector.list({ filter: { source: 's3:fake' } })
    expect(points).toHaveLength(0)
  })
})
