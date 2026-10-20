import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import type { Embedder } from '../../src/providers/embedder/types'
import { IndexStore } from '../../src/stores/index/store'
import { LocalFileSource } from '../../src/stores/index/sources/local'

const URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const COLLECTION = 'remem_test_index_m4'

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
const fakeDescriber = () => ({
  describe: async (entries: { path: string }[]) =>
    new Map(entries.map((e) => [e.path, `desc: ${e.path.split('/').pop()}`])),
})

describe('IndexStore (integration, Qdrant + local source)', () => {
  let fixture: string
  let vector: QdrantVectorStore
  let source: LocalFileSource
  let store: IndexStore
  const t = available ? test : test.skip

  beforeAll(async () => {
    if (!available) return
    fixture = await mkdtemp(path.join(tmpdir(), 'remem-index-'))
    await mkdir(path.join(fixture, 'docs'), { recursive: true })
    await writeFile(path.join(fixture, 'docs/guide.md'), '# guida')
    await writeFile(path.join(fixture, 'notes.txt'), 'note')

    vector = new QdrantVectorStore({ url: URL, collection: COLLECTION })
    try {
      await vector.drop()
    } catch {
      /* first run */
    }
    await vector.ensureCollection(8)

    source = new LocalFileSource('local', fixture)
    store = new IndexStore([source], { vector, embedder: fakeEmbedder, describerFor: fakeDescriber })
  })

  afterAll(async () => {
    if (!available) return
    await vector.drop().catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  })

  t('index() populates the index collection', async () => {
    const map = await store.index()
    // docs/ + docs/guide.md + notes.txt
    expect(map.entries.map((e) => e.path).sort()).toEqual(['local/docs', 'local/docs/guide.md', 'local/notes.txt'])

    const points = await vector.list({ filter: { source: 'local' } })
    expect(points).toHaveLength(3)
    const guide = points.find((p) => p.payload.path === 'local/docs/guide.md')
    expect(guide?.payload.description).toBe('desc: guide.md')
    expect(typeof guide?.payload.hash).toBe('string')

    expect(map.toPrompt()).toContain('## local')
    expect(map.toPrompt()).toContain('- docs/ — desc: docs')
    expect(map.toPrompt()).toContain('  - docs/guide.md — desc: guide.md')
  })

  t('search() is pertinent: query text for one entry ranks it first', async () => {
    await store.index()
    const hits = await store.search(fakeVec('local/docs/guide.md — desc: guide.md'), { limit: 3 })
    expect(hits[0]).toMatchObject({ path: 'local/docs/guide.md', description: 'desc: guide.md' })
    expect(hits[0].score).toBeGreaterThan(0.99)
  })

  t('re-index after removing a file drops the orphan', async () => {
    await rm(path.join(fixture, 'notes.txt'))
    const map = await store.index()
    expect(map.entries.map((e) => e.path)).not.toContain('local/notes.txt')

    const points = await vector.list({ filter: { source: 'local' } })
    expect(points.map((p) => p.payload.path)).not.toContain('local/notes.txt')
    expect(points).toHaveLength(2)
  })
})
