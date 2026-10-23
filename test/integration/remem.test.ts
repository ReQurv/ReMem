import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ReMem } from '../../src/core/ReMem'
import type { ReMemDeps } from '../../src/core/ReMem'
import { ReMemConfigSchema } from '../../src/config'
import { HeuristicRouter } from '../../src/router/HeuristicRouter'
import type { ChatModel } from '../../src/providers/chat/types'
import { createExtractor } from '../../src/stores/graph/extractor'
import { Neo4jGraphStore } from '../../src/stores/graph/Neo4jGraphStore'
import { createDescriber } from '../../src/stores/index/describer'
import { IndexStore } from '../../src/stores/index/store'
import { LocalFileSource } from '../../src/stores/index/sources/local'
import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import type { Embedder } from '../../src/providers/embedder/types'
import { noopLogger } from '../../src/logging'

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const NEO4J_URI = process.env.NEO4J_URI ?? 'bolt://localhost:7687'
const MEM_COLLECTION = 'remem_test_e2e_mem'
const INDEX_COLLECTION = 'remem_test_e2e_idx'

const qdrantUp = await (async () => {
  try {
    const res = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
})()

const available = qdrantUp // Neo4j checked inside beforeAll (bolt probe via the store itself)

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

/** Fake chat: deterministic extraction + deterministic index descriptions. */
const fakeChat: ChatModel = {
  complete: async (messages) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? ''
    if (sys.includes('knowledge-graph extractor')) {
      return JSON.stringify({
        entities: [
          { id: 'marco', label: 'Person', name: 'Marco' },
          { id: 'lucia', label: 'Person', name: 'Lucia' },
        ],
        relations: [{ from: 'marco', to: 'lucia', type: 'COLLABORATES_WITH' }],
      })
    }
    if (sys.includes('filesystem indexer')) {
      // Map every "path [dir|file]" line from the user prompt.
      const user = messages.find((m) => m.role === 'user')?.content ?? ''
      const map: Record<string, string> = {}
      for (const line of user.split('\n')) {
        const m = line.match(/^(\S+) \[(dir|file)\]/)
        if (m) map[m[1]] = `desc ${m[1].split('/').pop()}`
      }
      return JSON.stringify(map)
    }
    return '{}'
  },
}

describe('ReMem end-to-end (Qdrant + Neo4j + local index)', () => {
  let fixture: string
  let deps: ReMemDeps
  let mem: ReMem
  let vector!: QdrantVectorStore
  let indexVector!: QdrantVectorStore
  let graphUp = false
  let storedId = ''
  const t = available ? test : test.skip

  beforeAll(async () => {
    if (!available) return
    fixture = await mkdtemp(path.join(tmpdir(), 'remem-e2e-'))
    await mkdir(path.join(fixture, 'docs'), { recursive: true })
    await writeFile(path.join(fixture, 'docs/guide.md'), '# guida del progetto')

    vector = new QdrantVectorStore({ url: QDRANT_URL, collection: MEM_COLLECTION, logger: noopLogger })
    indexVector = new QdrantVectorStore({ url: QDRANT_URL, collection: INDEX_COLLECTION, logger: noopLogger })
    for (const v of [vector, indexVector]) {
      try {
        await v.drop()
      } catch {
        /* first run */
      }
      await v.ensureCollection(8)
    }

    const graph = new Neo4jGraphStore({
      uri: NEO4J_URI,
      username: 'neo4j',
      password: 'changeit',
      logger: noopLogger,
    })
    try {
      await graph.ensureSchema()
      await graph.query('MATCH (n) DETACH DELETE n')
      graphUp = true
    } catch {
      graphUp = false
    }

    const sources = [new LocalFileSource('local', fixture)]
    deps = {
      logger: noopLogger,
      embedder: fakeEmbedder,
      router: new HeuristicRouter(),
      vector,
      indexVector,
      graph,
      extractor: createExtractor(fakeChat, noopLogger),
      indexStore: new IndexStore(sources, {
        vector: indexVector,
        embedder: fakeEmbedder,
        describerFor: (s) =>
          createDescriber(fakeChat, (k, o) => s.readPreview(k, o), { describeFiles: true, logger: noopLogger }),
        logger: noopLogger,
      }),
    }
    mem = new ReMem(ReMemConfigSchema.parse({ embedder: { provider: 'ollama' }, chat: { provider: 'ollama' } }), {
      deps,
    })
    await mem.connect()
  })

  afterAll(async () => {
    if (!available) return
    await mem.close().catch(() => {})
    await vector.drop().catch(() => {})
    await indexVector.drop().catch(() => {})
    if (graphUp) await deps.graph.query('MATCH (n) DETACH DELETE n').catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  })

  t('store() writes to vector (+graph when available)', async () => {
    const res = await mem.store({ content: 'Marco collabora con Lucia sul progetto Remem' })
    expect(res.writtenTo).toContain('vector')
    if (graphUp) expect(res.writtenTo).toContain('graph')
    storedId = res.id
  })

  t('recall() finds the stored memory via vector', async () => {
    const r = await mem.recall('cosa ricorda il sistema su Marco?', { only: ['vector'] })
    expect(r.sources).toEqual(['vector'])
    expect(r.memories.length).toBeGreaterThan(0)
    expect(String(r.memories[0].payload.content)).toContain('Marco')
    expect(r.toPrompt()).toContain('## Memory')
  })

  t('store() before graph extraction: graph insight on recall', async () => {
    if (!graphUp) return
    const r = await mem.recall('chi collabora con Marco?', { only: ['graph'] })
    expect(r.sources).toEqual(['graph'])
    expect(r.graph).toBeDefined()
    const names = (r.graph?.entities ?? []).map((e) => e.name)
    expect(names).toContain('Marco')
    expect(r.toPrompt()).toContain('## Knowledge')
  })

  t('index() populates the local source map', async () => {
    const map = await mem.index()
    expect(map.entries.map((e) => e.path)).toEqual(expect.arrayContaining(['local/docs', 'local/docs/guide.md']))
    expect(map.toPrompt()).toContain('## local')
    expect(map.toPrompt()).toContain('desc guide.md')
  })

  t('recall() with index target finds the indexed file', async () => {
    const r = await mem.recall('in quale file c\'è la guida?', { only: ['index'] })
    expect(r.sources).toEqual(['index'])
    expect(r.index).toBeDefined()
    const hits = Array.isArray(r.index) ? r.index : []
    expect(hits.map((h) => h.path)).toContain('local/docs/guide.md')
    expect(r.toPrompt()).toContain('## Index')
  })

  t('forget() deletes the memory (vector + graph) and is idempotent', async () => {
    expect(storedId).toBeTruthy()
    const res = await mem.forget(storedId)
    expect(res.deletedFrom).toContain('vector')
    if (graphUp) {
      expect(res.deletedFrom).toContain('graph')
      // single memory → the fake extractor's 2 entities + 1 relation, all last-source
      expect(res.graph).toEqual({ entities: 2, relations: 1 })
    }
    // vector point is gone
    const r = await mem.recall('cosa ricorda il sistema su Marco?', { only: ['vector'] })
    expect(r.memories).toHaveLength(0)

    // idempotent: a second forget is a no-op, no throw
    const again = await mem.forget(storedId)
    expect(again.deletedFrom).toContain('vector')
    if (graphUp) expect(again.graph).toEqual({ entities: 0, relations: 0 })
  })

  t('full recall (router) degrades gracefully, never throws', async () => {
    const r = await mem.recall('come è collegato Marco alla guida del progetto?')
    expect(r.sources.length).toBeGreaterThan(0)
    expect(r.toPrompt().length).toBeGreaterThan(0)
  })
})
