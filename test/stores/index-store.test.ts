import { describe, expect, test } from 'bun:test'

import type { Embedder } from '../../src/providers/embedder/types'
import type { VectorHit, VectorSearchOpts, VectorStore } from '../../src/stores/vector/types'
import { IndexStore } from '../../src/stores/index/store'
import type { FileSource, SourceEntry } from '../../src/stores/index/sources/types'

/** In-memory VectorStore recording writes/deletes. */
class FakeVectorStore implements VectorStore {
  points = new Map<string, { vector: number[]; payload: Record<string, unknown> }>()
  upserts = 0
  deletes: string[][] = []

  async ensureCollection(): Promise<void> {}
  async upsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    this.points.set(id, { vector, payload })
    this.upserts += 1
  }
  private filterBy(p: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
    if (!filter) return true
    return Object.entries(filter).every(([k, v]) => p[k] === v)
  }
  async search(_v: number[], opts?: VectorSearchOpts): Promise<VectorHit[]> {
    return [...this.points.entries()]
      .filter(([, p]) => this.filterBy(p.payload, opts?.filter))
      .slice(0, opts?.limit ?? 10)
      .map(([id, p]) => ({ id, score: 1, payload: p.payload }))
  }
  async list(opts?: VectorSearchOpts): Promise<VectorHit[]> {
    return [...this.points.entries()]
      .filter(([, p]) => this.filterBy(p.payload, opts?.filter))
      .map(([id, p]) => ({ id, score: 0, payload: p.payload }))
  }
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    this.deletes.push([...ids])
    for (const id of ids) this.points.delete(id)
  }
}

const fakeEmbedder: Embedder = {
  dimensions: 4,
  embed: async (texts) => texts.map((_, i) => [i % 2, i % 3, 0, 1]),
  embedQuery: async () => [1, 0, 0, 1],
}

function memSource(id: string, initial: SourceEntry[]): { source: FileSource; set: (e: SourceEntry[]) => void } {
  let entries = initial
  return {
    source: {
      id,
      kind: 'local',
      root: '/tmp/x',
      list: async () => entries,
      readPreview: async () => null,
    },
    set: (e) => {
      entries = e
    },
  }
}

function makeStore(vector: VectorStore, sources: FileSource[], llmCalls: string[][]) {
  const describerFor = () => ({
    describe: async (entries: { path: string }[], opts?: { cache?: Map<string, string> }) => {
      // record only what actually would go to the LLM (non-cached)
      const pending = entries.filter((e) => !opts?.cache?.has(e.path)).map((e) => e.path)
      llmCalls.push(pending)
      const out = new Map<string, string>()
      for (const e of entries) out.set(e.path, opts?.cache?.get(e.path) ?? `desc: ${e.path}`)
      return out
    },
  })
  return new IndexStore(sources, { vector, embedder: fakeEmbedder, describerFor })
}

describe('IndexStore (unit, mocked vector/embedder/describer)', () => {
  test('first index() writes all entries, per source', async () => {
    const vector = new FakeVectorStore()
    const a = memSource('a', [
      { key: 'docs', type: 'dir' },
      { key: 'docs/readme.md', type: 'file', ext: 'md', mtime: 1, size: 10 },
    ])
    const b = memSource('b', [{ key: 'data', type: 'dir' }])
    const llmCalls: string[][] = []
    const store = makeStore(vector, [a.source, b.source], llmCalls)

    const map = await store.index()
    expect(map.entries).toHaveLength(3)
    expect(vector.points.size).toBe(3)
    expect(map.toPrompt()).toContain('## a')
    expect(map.toPrompt()).toContain('## b')
    // both sources described (order may vary: parallel)
    expect(llmCalls.flat().sort()).toEqual(['a/docs', 'a/docs/readme.md', 'b/data'])
  })

  test('index() without changes = idempotent (no LLM, no writes, no deletes)', async () => {
    const vector = new FakeVectorStore()
    const a = memSource('a', [
      { key: 'docs', type: 'dir' },
      { key: 'docs/readme.md', type: 'file', ext: 'md', mtime: 1, size: 10 },
    ])
    const llmCalls: string[][] = []
    const store = makeStore(vector, [a.source], llmCalls)

    await store.index()
    const upsertsAfterFirst = vector.upserts

    const map = await store.index()
    expect(vector.upserts).toBe(upsertsAfterFirst)
    expect(vector.deletes).toHaveLength(0)
    expect(llmCalls.at(-1)).toEqual([]) // nothing pending → no LLM
    expect(map.entries).toHaveLength(2)
    // descriptions are reused from the store
    expect(map.entries.find((e) => e.path === 'a/docs')?.description).toBe('desc: a/docs')
  })

  test('changed source: added+modified rewritten, orphans removed, other namespaces untouched', async () => {
    const vector = new FakeVectorStore()
    const a = memSource('a', [
      { key: 'docs', type: 'dir' },
      { key: 'docs/readme.md', type: 'file', ext: 'md', mtime: 1, size: 10 },
    ])
    const b = memSource('b', [{ key: 'data', type: 'dir', mtime: 1, size: 5 }])
    const llmCalls: string[][] = []
    const store = makeStore(vector, [a.source, b.source], llmCalls)

    await store.index()
    expect(vector.points.size).toBe(3)
    const bPointId = (await vector.list({ filter: { source: 'b' } }))[0].id

    // readme.md removed, new.md added; b untouched
    a.set([{ key: 'docs', type: 'dir' }, { key: 'docs/new.md', type: 'file', ext: 'md', mtime: 1, size: 10 }])
    await store.index({ only: ['a'] })

    // orphan removed from a (and only via a)
    expect(vector.points.size).toBe(3) // -1 readme.md +1 new.md
    expect(vector.deletes).toHaveLength(1)
    // b's point survived
    expect(vector.points.has(bPointId)).toBe(true)
    // LLM saw only the added entry (docs unchanged → cached)
    expect(llmCalls.at(-1)).toEqual(['a/docs/new.md'])
  })

  test('index({ only }) touches only the requested sources', async () => {
    const vector = new FakeVectorStore()
    const a = memSource('a', [{ key: 'x.md', type: 'file', ext: 'md', mtime: 1, size: 1 }])
    const b = memSource('b', [{ key: 'y.md', type: 'file', ext: 'md', mtime: 1, size: 1 }])
    const store = makeStore(vector, [a.source, b.source], [])

    const map = await store.index({ only: ['b'] })
    expect(vector.points.size).toBe(1)
    expect(map.entries.map((e) => e.source)).toEqual(['b'])
  })

  test('search returns hits with path/source/type/description', async () => {
    const vector = new FakeVectorStore()
    const a = memSource('a', [{ key: 'docs', type: 'dir' }])
    const store = makeStore(vector, [a.source], [])
    await store.index()

    const hits = await store.search([1, 0, 0, 1])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'a/docs', source: 'a', type: 'dir', description: 'desc: a/docs' })
  })
})
