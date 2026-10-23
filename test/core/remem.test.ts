import { describe, expect, test } from 'bun:test'

import { ReMem, type ReMemDeps } from '../../src/core/ReMem'
import { ReMemConfigSchema } from '../../src/config'
import { ConnectionError } from '../../src/errors'
import { noopLogger } from '../../src/logging'
import type { Router } from '../../src/router/types'
import type { Entity, GraphForgetCounts, GraphInsight } from '../../src/stores/graph/types'
import type { IndexHit, IndexMap } from '../../src/stores/index/types'
import type { VectorHit } from '../../src/stores/vector/types'

const CONFIG = ReMemConfigSchema.parse({ embedder: { provider: 'ollama' }, chat: { provider: 'ollama' } })

const VEC = [1, 0, 0, 0, 0, 0, 0, 0]

interface Call {
  name: string
  args: unknown[]
}

interface DepsOverrides extends Partial<ReMemDeps> {
  calls?: Call[]
  vectorSearch?: () => Promise<VectorHit[]>
  upsertEntity?: (e: Entity, memoryId?: string) => Promise<void>
  forgetMemory?: (id: string) => Promise<GraphForgetCounts>
  vectorDelete?: (ids: string[]) => Promise<void>
  neighbors?: (id: string, opts?: { depth?: number; limit?: number }) => Promise<GraphInsight>
}

function makeDeps(overrides: DepsOverrides = {}): ReMemDeps {
  const { calls = [], vectorSearch, upsertEntity, forgetMemory, vectorDelete, neighbors, ...rest } = overrides
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args })
  }

  const vector: VectorStoreLike = {
    ensureCollection: async (d) => {
      calls.push({ name: 'vector.ensureCollection', args: [d] })
    },
    upsert: (id, v, p) => Promise.resolve(rec('vector.upsert')(id, v, p)),
    search:
      vectorSearch ??
      (async (_v, o) => {
        calls.push({ name: 'vector.search', args: [o] })
        return [{ id: 'm1', score: 0.91, payload: { content: 'memoria' } }]
      }),
    list: async () => [],
    delete: vectorDelete ?? (async (ids) => {
      calls.push({ name: 'vector.delete', args: [ids] })
    }),
  }
  const indexVector: VectorStoreLike = {
    ensureCollection: async (d) => {
      calls.push({ name: 'indexVector.ensureCollection', args: [d] })
    },
    upsert: async () => {},
    search: async () => [],
    list: async () => [],
    delete: async () => {},
  }
  const graph: ReMemDeps['graph'] = {
    ensureSchema: async () => {
      calls.push({ name: 'graph.ensureSchema', args: [] })
    },
    upsertEntity: upsertEntity ?? ((e, mid) => Promise.resolve(rec('graph.upsertEntity')(e, mid))),
    upsertRelation: (r, mid) => Promise.resolve(rec('graph.upsertRelation')(r, mid)),
    query: async () => [],
    forgetMemory:
      forgetMemory ??
      (async (id) => {
        calls.push({ name: 'graph.forgetMemory', args: [id] })
        return { entities: 2, relations: 1 }
      }),
    neighbors: neighbors ?? (async () => ({ entities: [], relations: [] })),
    close: async () => {
      calls.push({ name: 'graph.close', args: [] })
    },
  }
  const router: Router =
    overrides.router ?? {
      routeWrite: async () => ({ targets: ['vector', 'graph'], confidence: 1 }),
      routeRead: async () => ({ targets: ['vector', 'graph', 'index'], confidence: 1 }),
    }

  return {
    logger: noopLogger,
    embedder: {
      dimensions: 8,
      embed: async (texts) => texts.map(() => VEC),
      embedQuery: async () => VEC,
    },
    router,
    vector,
    indexVector,
    graph,
    extractor: {
      extract: async () => ({
        entities: [{ id: 'marco', label: 'Person', name: 'Marco' }],
        relations: [{ from: 'marco', to: 'luca', type: 'COLLABORATES_WITH' }],
      }),
    },
    indexStore: {
      index: async () => ({ updatedAt: 1, entries: [], toPrompt: () => '(idx)' }) as IndexMap,
      search: async () => [{ path: 'local/a.md', source: 'local', type: 'file', score: 0.8 }] as IndexHit[],
    },
    ...rest,
  }
}

type VectorStoreLike = ReMemDeps['vector']

describe('ReMem (unit, mocked deps)', () => {
  test('connect() bootstraps both collections and the graph schema', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, { deps: makeDeps({ calls }) })
    await mem.connect()
    const names = calls.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['vector.ensureCollection', 'indexVector.ensureCollection', 'graph.ensureSchema']),
    )
  })

  test('connect() uses resolved dimensions when the embedder can probe', async () => {
    const calls: Call[] = []
    const base = makeDeps({ calls })
    const mem = new ReMem(CONFIG, {
      deps: {
        ...base,
        embedder: { ...base.embedder, dimensions: 1536, resolveDimensions: async () => 4096 },
      },
    })
    await mem.connect()
    const v = calls.find((c) => c.name === 'vector.ensureCollection')!
    expect(v.args[0]).toBe(4096)
  })

  test('store() before connect() → ConnectionError', async () => {
    const mem = new ReMem(CONFIG, { deps: makeDeps() })
    await expect(mem.store({ content: 'ciao' })).rejects.toThrow(ConnectionError)
  })

  test('recall() before connect() → ConnectionError', async () => {
    const mem = new ReMem(CONFIG, { deps: makeDeps() })
    await expect(mem.recall('ciao')).rejects.toThrow(ConnectionError)
  })

  test('store() writes to the router targets and returns writtenTo', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, { deps: makeDeps({ calls }) })
    await mem.connect()
    const res = await mem.store({ content: 'Marco collabora con Luca', source: 'local' })

    expect(typeof res.id).toBe('string')
    expect(new Set(res.writtenTo)).toEqual(new Set(['vector', 'graph']))
    const names = calls.map((c) => c.name)
    expect(names).toContain('vector.upsert')
    expect(names).toContain('graph.upsertEntity')
    expect(names).toContain('graph.upsertRelation')
    // provenance metadata
    const upsert = calls.find((c) => c.name === 'vector.upsert')!
    const payload = upsert.args[2] as { content: string; metadata: Record<string, unknown> }
    expect(payload.content).toBe('Marco collabora con Luca')
    expect(payload.metadata.source).toBe('local')
    // graph provenance: the memory id is tagged on every node/edge
    const ent = calls.find((c) => c.name === 'graph.upsertEntity')!
    expect(ent.args).toEqual([{ id: 'marco', label: 'Person', name: 'Marco' }, res.id])
    const rel = calls.find((c) => c.name === 'graph.upsertRelation')!
    expect(rel.args[1]).toBe(res.id)
  })

  test('store() scopes the payload with config tenant + input collection', async () => {
    const calls: Call[] = []
    const tenantCfg = ReMemConfigSchema.parse({
      embedder: { provider: 'ollama' },
      chat: { provider: 'ollama' },
      tenant: 'acme',
    })
    const mem = new ReMem(tenantCfg, { deps: makeDeps({ calls }) })
    await mem.connect()
    await mem.store({ content: 'ciao', collection: 'proj-a' })
    const upsert = calls.find((c) => c.name === 'vector.upsert')!
    const payload = upsert.args[2] as Record<string, unknown>
    expect(payload.tenant).toBe('acme')
    expect(payload.collection).toBe('proj-a')

    // default collection when omitted
    await mem.store({ content: 'altro' })
    const upsert2 = calls.filter((c) => c.name === 'vector.upsert')[1]!
    expect((upsert2.args[2] as Record<string, unknown>).collection).toBe('default')
  })

  test('recall() passes tenant + collections filter to the vector search', async () => {
    const calls: Call[] = []
    const tenantCfg = ReMemConfigSchema.parse({
      embedder: { provider: 'ollama' },
      chat: { provider: 'ollama' },
      tenant: 'acme',
    })
    const mem = new ReMem(tenantCfg, {
      deps: makeDeps({
        calls,
        router: {
          routeWrite: async () => ({ targets: ['vector'], confidence: 1 }),
          routeRead: async () => ({ targets: ['vector'], confidence: 1 }),
        },
      }),
    })
    await mem.connect()
    await mem.recall('q', { collections: ['a', 'b'] })
    await mem.recall('q')

    const opts1 = calls.find((c) => c.name === 'vector.search')!.args[0] as { filter?: Record<string, unknown> }
    expect(opts1.filter).toEqual({ tenant: 'acme', collection: ['a', 'b'] })
    const opts2 = calls.filter((c) => c.name === 'vector.search')[1]!.args[0] as { filter?: Record<string, unknown> }
    expect(opts2.filter).toEqual({ tenant: 'acme' })
  })

  test('store() with vector-only routing skips the graph', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        calls,
        router: {
          routeWrite: async () => ({ targets: ['vector'], confidence: 1 }),
          routeRead: async () => ({ targets: ['vector'], confidence: 1 }),
        },
      }),
    })
    await mem.connect()
    const res = await mem.store({ content: 'ciao' })
    expect(res.writtenTo).toEqual(['vector'])
    expect(calls.map((c) => c.name)).not.toContain('graph.upsertEntity')
  })

  test('store(): a failing target degrades — partial writtenTo, no throw', async () => {
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        upsertEntity: async () => {
          throw new Error('neo4j down')
        },
      }),
    })
    await mem.connect()
    const res = await mem.store({ content: 'Marco collabora con Luca' })
    expect(res.writtenTo).toEqual(['vector'])
  })

  test('recall() uses router.routeRead and composes sources', async () => {
    let routeReadCalls = 0
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        router: {
          routeWrite: async () => ({ targets: ['vector'], confidence: 1 }),
          routeRead: async () => {
            routeReadCalls += 1
            return { targets: ['vector', 'index'], confidence: 1 }
          },
        },
      }),
    })
    await mem.connect()
    const r = await mem.recall('ciao')

    expect(routeReadCalls).toBe(1)
    expect(r.sources).toEqual(expect.arrayContaining(['vector', 'index']))
    expect(r.degraded).toBeUndefined()
    expect(r.memories).toHaveLength(1)
    expect(r.index).toHaveLength(1)
    const p = r.toPrompt()
    expect(p).toContain('## Memory')
    expect(p).toContain('## Index')
    expect(p).not.toContain('## Knowledge')
    // each memory line carries its id, so the caller can target it with forget()
    expect(p).toContain('[m1]')
  })

  test('recall() opts.only bypasses the router', async () => {
    let routeReadCalls = 0
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        router: {
          routeWrite: async () => ({ targets: ['vector'], confidence: 1 }),
          routeRead: async () => {
            routeReadCalls += 1
            return { targets: ['vector'], confidence: 1 }
          },
        },
      }),
    })
    await mem.connect()
    const r = await mem.recall('ciao', { only: ['index'] })
    expect(routeReadCalls).toBe(0)
    expect(r.sources).toEqual(['index'])
    expect(r.memories).toEqual([])
  })

  test('recall(): a failing store lands in degraded, others survive', async () => {
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        vectorSearch: async () => {
          throw new Error('qdrant down')
        },
      }),
    })
    await mem.connect()
    const r = await mem.recall('ciao')
    expect(r.degraded).toEqual(['vector'])
    expect(r.sources).toEqual(expect.arrayContaining(['graph', 'index']))
    expect(r.toPrompt()).toContain('_degraded: vector_')
  })

  test('index() delegates to the index store', async () => {
    const mem = new ReMem(CONFIG, { deps: makeDeps() })
    await mem.connect()
    const map = await mem.index()
    expect(map.toPrompt()).toBe('(idx)')
  })

  test('close() releases the graph; store() afterwards → ConnectionError', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, { deps: makeDeps({ calls }) })
    await mem.connect()
    await mem.close()
    expect(calls.map((c) => c.name)).toContain('graph.close')
    await expect(mem.store({ content: 'x' })).rejects.toThrow(ConnectionError)
  })

  test('forget() before connect() → ConnectionError', async () => {
    const mem = new ReMem(CONFIG, { deps: makeDeps() })
    await expect(mem.forget('5b3f0c0e-1234-7654-89ab-cdef01234567')).rejects.toThrow(ConnectionError)
  })

  test('forget() deletes the vector point + graph provenance, returns counts', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, { deps: makeDeps({ calls }) })
    await mem.connect()
    const res = await mem.forget('5b3f0c0e-1234-7654-89ab-cdef01234567')

    expect(res.deletedFrom).toEqual(['vector', 'graph'])
    expect(res.graph).toEqual({ entities: 2, relations: 1 })
    expect(res.degraded).toBeUndefined()
    expect(calls.find((c) => c.name === 'vector.delete')?.args).toEqual([
      ['5b3f0c0e-1234-7654-89ab-cdef01234567'],
    ])
    expect(calls.find((c) => c.name === 'graph.forgetMemory')?.args).toEqual(['5b3f0c0e-1234-7654-89ab-cdef01234567'])
  })

  test('forget({ only: ["vector"] }) skips the graph', async () => {
    const calls: Call[] = []
    const mem = new ReMem(CONFIG, { deps: makeDeps({ calls }) })
    await mem.connect()
    const res = await mem.forget('5b3f0c0e-1234-7654-89ab-cdef01234567', { only: ['vector'] })
    expect(res.deletedFrom).toEqual(['vector'])
    expect(res.graph).toBeUndefined()
    expect(calls.map((c) => c.name)).not.toContain('graph.forgetMemory')
  })

  test('forget(): a failing subsystem degrades — partial deletedFrom, no throw', async () => {
    const mem = new ReMem(CONFIG, {
      deps: makeDeps({
        vectorDelete: async () => {
          throw new Error('qdrant down')
        },
      }),
    })
    await mem.connect()
    const res = await mem.forget('5b3f0c0e-1234-7654-89ab-cdef01234567')
    expect(res.deletedFrom).toEqual(['graph'])
    expect(res.degraded).toEqual(['vector'])
    expect(res.graph).toEqual({ entities: 2, relations: 1 })
  })
})
