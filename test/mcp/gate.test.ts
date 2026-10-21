import { describe, expect, test } from 'bun:test'

import { ReMemConfigSchema } from '../../src/config'
import type { ReMem } from '../../src/core/ReMem'
import { ConnectionError, PermissionError } from '../../src/errors'
import { AccessGate } from '../../src/mcp/gate'
import type { InstancePool } from '../../src/mcp/pool'
import { createFifoQueue, type Enqueue, type StoreRun } from '../../src/mcp/queue'
import type { Principal } from '../../src/mcp/tenants'
import type { IndexMap } from '../../src/stores/index/types'
import type { Recall, StoreResult, Subsystem } from '../../src/types'

const base = ReMemConfigSchema.parse({ embedder: { provider: 'ollama' }, chat: { provider: 'ollama' } })

function fakeRecall(text: string, degraded?: Subsystem[]): Recall {
  return {
    memories: [],
    sources: ['vector'],
    degraded,
    toPrompt: () => text,
  }
}

interface FakeMem {
  name: string
  stores: string[]
  indexCalls: number
  fail: boolean
  store(input: unknown): Promise<StoreResult>
  recall(q: string): Promise<Recall>
  index(): Promise<IndexMap>
}

function memFor(name: string, fail = false): FakeMem {
  const mem: FakeMem = {
    name,
    stores: [],
    indexCalls: 0,
    fail,
    store: async (input) => {
      mem.stores.push(JSON.stringify(input))
      return { id: `${name}-1`, writtenTo: ['vector'] }
    },
    recall: async (q) => {
      if (mem.fail) throw new ConnectionError(`${name} down`)
      return fakeRecall(`${name}: ${q}`)
    },
    index: async () => {
      mem.indexCalls += 1
      return { toPrompt: () => `INDEX-${name}` } as unknown as IndexMap
    },
  }
  return mem
}

function makePool(mems: Record<string, FakeMem>): InstancePool {
  const queues = new Map<string, Enqueue>()
  return {
    base,
    tenants: Object.keys(mems),
    get: (tenant: string) => {
      const mem = mems[tenant]
      if (!mem) return Promise.reject(new ConnectionError(`tenant ${tenant} unreachable`))
      return Promise.resolve(mem as unknown as ReMem)
    },
    enqueue: (tenant: string, run: StoreRun) => {
      let q = queues.get(tenant)
      if (!q) {
        q = createFifoQueue()
        queues.set(tenant, q)
      }
      q(run)
    },
  } as unknown as InstancePool
}

/** Let the background store queue drain. */
const flush = () => new Promise((r) => setTimeout(r, 20))

const alice: Principal = { name: 'alice', tenant: 'acme-alice', company: 'acme-corp', role: 'user' }
const ops: Principal = { name: 'ops-bot', tenant: 'acme-ops', company: 'acme-corp', role: 'admin' }

const mems = {
  'acme-alice': memFor('alice'),
  'acme-corp': memFor('corp'),
}
const pool = makePool(mems)

describe('AccessGate', () => {
  test('remember acks queued immediately, writes to the own tenant in the background', async () => {
    const gate = new AccessGate(pool, alice)
    const t0 = Date.now()
    const res = await gate.remember({ content: 'fatto mio' })
    // The ack must not wait for the (LLM-heavy) store.
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(res).toEqual({ queued: true })

    await flush()
    expect(mems['acme-alice'].stores).toHaveLength(1)
    expect(mems['acme-corp'].stores).toHaveLength(0)
    expect(JSON.parse(mems['acme-alice'].stores[0])).toMatchObject({ content: 'fatto mio' })
  })

  test('remember with scope "company" is denied for users', async () => {
    const gate = new AccessGate(pool, alice)
    await expect(gate.remember({ content: 'x', scope: 'company' })).rejects.toThrow(PermissionError)
  })

  test('remember with scope "company" works for admins and strips scope', async () => {
    const gate = new AccessGate(pool, ops)
    await gate.remember({ content: 'decisione aziendale', scope: 'company' })
    await flush()
    expect(mems['acme-corp'].stores).toHaveLength(1)
    const stored = JSON.parse(mems['acme-corp'].stores[0])
    expect(stored).toMatchObject({ content: 'decisione aziendale' })
    expect(stored).not.toHaveProperty('scope')
  })

  test('a slow (LLM-heavy) store never blocks the ack or the next ack', async () => {
    const slow = memFor('slow')
    const originalStore = slow.store
    slow.store = async (input) => {
      await new Promise((r) => setTimeout(r, 50))
      return originalStore(input)
    }
    const gate = new AccessGate(makePool({ 'acme-alice': slow, 'acme-corp': memFor('corp') }), alice)

    const t0 = Date.now()
    const r1 = await gate.remember({ content: 'uno' })
    const r2 = await gate.remember({ content: 'due' })
    expect(Date.now() - t0).toBeLessThan(20) // both acks before the first store ran
    expect(r1).toEqual({ queued: true })
    expect(r2).toEqual({ queued: true })

    // 2 stores × 50ms each, FIFO — wait for both to land.
    await new Promise((r) => setTimeout(r, 150))
    expect(slow.stores).toHaveLength(2) // FIFO: uno before due
    expect(JSON.parse(slow.stores[0])).toMatchObject({ content: 'uno' })
    expect(JSON.parse(slow.stores[1])).toMatchObject({ content: 'due' })
  })

  test('recall fuses company and personal memory, labeled', async () => {
    const gate = new AccessGate(pool, alice)
    const text = await gate.recall('chi è marco?')
    expect(text).toContain('## Company memory')
    expect(text).toContain('## Your memory')
    expect(text).toContain('corp: chi è marco?')
    expect(text).toContain('alice: chi è marco?')
    // Company section comes first (shared context before personal).
    expect(text.indexOf('## Company memory')).toBeLessThan(text.indexOf('## Your memory'))
  })

  test('recall survives one tenant being down', async () => {
    const broken = { 'acme-alice': memFor('alice', true), 'acme-corp': memFor('corp') }
    const gate = new AccessGate(makePool(broken), alice)
    const text = await gate.recall('q')
    expect(text).toContain('corp: q')
    expect(text).not.toContain('alice: q')
    expect(text).not.toContain('## Your memory')
  })

  test('recall throws when both tenants fail', async () => {
    const broken = { 'acme-alice': memFor('alice', true), 'acme-corp': memFor('corp', true) }
    const gate = new AccessGate(makePool(broken), alice)
    await expect(gate.recall('q')).rejects.toThrow(ConnectionError)
  })

  test('index scope "company" is admin-only', async () => {
    await expect(new AccessGate(pool, alice).index({ scope: 'company' })).rejects.toThrow(PermissionError)

    const map = await new AccessGate(pool, ops).index({ scope: 'company' })
    expect(map.toPrompt()).toBe('INDEX-corp')
    expect(mems['acme-corp'].indexCalls).toBe(1)
  })

  test('status reports principal, tenants and pool state', () => {
    const text = new AccessGate(pool, alice).status()
    expect(text).toContain('alice (user)')
    expect(text).toContain('your tenant:    acme-alice')
    expect(text).toContain('company tenant: acme-corp')
    expect(text).toContain('pool tenants: acme-alice, acme-corp')
  })
})
