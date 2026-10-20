import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import { VectorStoreError } from '../../src/errors'

const URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const COLLECTION = 'remem_test_m3'

// Probe Qdrant once; when the infra is absent the whole suite is skipped (no crash).
const available = await (async () => {
  try {
    const res = await fetch(`${URL}/collections`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
})()

describe('QdrantVectorStore (integration)', () => {
  let store: QdrantVectorStore
  // Register as skipped (not failed) when the infra is absent.
  const t = available ? test : test.skip

  beforeAll(async () => {
    store = new QdrantVectorStore({ url: URL, collection: COLLECTION })
    if (!available) return
    try {
      await store.drop()
    } catch {
      /* first run: collection does not exist yet */
    }
    await store.ensureCollection(3)
  })

  afterAll(async () => {
    if (available) await store.drop().catch(() => {})
  })

  t('ensureCollection is idempotent', async () => {
    await expect(store.ensureCollection(3)).resolves.toBeUndefined()
    await expect(store.ensureCollection(3)).resolves.toBeUndefined()
  })

  t('upsert + search retrieves the item with payload and score', async () => {
    const idA = randomUUID()
    const idB = randomUUID()
    await store.upsert(idA, [1, 0, 0], { kind: 'a' })
    await store.upsert(idB, [0, 1, 0], { kind: 'b' })

    const hits = await store.search([1, 0, 0], { limit: 10 })
    const top = hits[0]
    expect(top).toBeDefined()
    expect(top.id).toBe(idA)
    expect(top.score).toBeGreaterThan(0.99)
    expect(top.payload).toEqual({ kind: 'a' })
  })

  t('upsert rejects non-UUID point ids', async () => {
    await expect(store.upsert('not-a-uuid', [1, 0, 0], {})).rejects.toThrow(VectorStoreError)
  })

  t('search honours limit and scoreThreshold', async () => {
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()
    await store.upsert(id1, [1, 0, 0], {})
    await store.upsert(id2, [0.9, 0.1, 0], {})
    await store.upsert(id3, [0, 0, 1], {})

    const limited = await store.search([1, 0, 0], { limit: 2 })
    expect(limited.length).toBeLessThanOrEqual(2)

    const thresholded = await store.search([1, 0, 0], { scoreThreshold: 0.99 })
    expect(thresholded.every((h) => h.score >= 0.99)).toBe(true)
    expect(thresholded.map((h) => h.id)).not.toContain(id3)
  })

  t('search with payload filter matches exactly', async () => {
    const idX = randomUUID()
    const idY = randomUUID()
    await store.upsert(idX, [0.5, 0.5, 0], { tag: 'alpha' })
    await store.upsert(idY, [0.5, 0.5, 0.01], { tag: 'beta' })

    const hits = await store.search([0.5, 0.5, 0], { filter: { tag: 'alpha' } })
    expect(hits.map((h) => h.id)).toContain(idX)
    expect(hits.map((h) => h.id)).not.toContain(idY)
  })

  t('delete removes points', async () => {
    const id = randomUUID()
    await store.upsert(id, [1, 1, 0], {})
    await store.delete([id])

    const hits = await store.search([1, 1, 0], { limit: 50 })
    expect(hits.map((h) => h.id)).not.toContain(id)
  })
})
