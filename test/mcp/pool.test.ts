import { describe, expect, test } from 'bun:test'

import { ReMemConfigSchema } from '../../src/config'
import { ConnectionError } from '../../src/errors'
import type { ReMem } from '../../src/core/ReMem'
import { InstancePool, type ReMemFactory } from '../../src/mcp/pool'

interface FakeMem {
  config: unknown
  connectCalls: number
  close: () => Promise<void>
  closed: boolean
}

/** Factory that counts creations and can fail the first connect. */
function makeFactory(failFirst = false) {
  const created: FakeMem[] = []
  const make: ReMemFactory = (config) => {
    const fake: FakeMem = { config, connectCalls: 0, closed: false, close: async () => void (fake.closed = true) }
    created.push(fake)
    return {
      connect: async () => {
        fake.connectCalls += 1
        if (failFirst && created.length === 1 && fake.connectCalls === 1) throw new ConnectionError('backend down')
      },
      close: fake.close,
    } as unknown as ReMem
  }
  return { make, created }
}

const base = ReMemConfigSchema.parse({ embedder: { provider: 'ollama' }, chat: { provider: 'ollama' } })

describe('InstancePool', () => {
  test('creates one instance per tenant, lazily and cached', async () => {
    const { make, created } = makeFactory()
    const pool = new InstancePool(base, make)
    expect(created.length).toBe(0)

    const a1 = pool.get('alice')
    const a2 = pool.get('alice')
    const b = pool.get('bob')
    await Promise.all([a1, a2, b])

    expect(a1).toBe(a2) // cached, same instance
    expect(created.length).toBe(2)
    expect(created[0].config).toMatchObject({ tenant: 'alice' })
    expect(created[1].config).toMatchObject({ tenant: 'bob' })
    expect(pool.tenants.sort()).toEqual(['alice', 'bob'])
  })

  test('the base config is shared, only tenant differs', async () => {
    const { make, created } = makeFactory()
    const pool = new InstancePool(base, make)
    await pool.get('alice')
    expect(pool.base).toBe(base)
    expect(created[0].config).toMatchObject({ vector: base.vector, router: base.router, tenant: 'alice' })
  })

  test('a failed connect does not poison the cache: next call retries', async () => {
    const { make, created } = makeFactory(true)
    const pool = new InstancePool(base, make)

    await expect(pool.get('alice')).rejects.toThrow(ConnectionError)
    expect(created.length).toBe(1) // dropped, not cached

    const mem = await pool.get('alice') // retry
    expect(created.length).toBe(2)
    expect(mem).toBeDefined()
  })

  test('concurrent gets share one in-flight connect', async () => {
    const created: FakeMem[] = []
    let resolveConnect: (() => void) | undefined
    const slowMake: ReMemFactory = (config) => {
      const fake: FakeMem = { config, connectCalls: 0, closed: false, close: async () => void (fake.closed = true) }
      created.push(fake)
      return {
        connect: () => new Promise<void>((res) => (resolveConnect = res)),
        close: fake.close,
      } as unknown as ReMem
    }
    const pool = new InstancePool(base, slowMake)
    const p1 = pool.get('x')
    const p2 = pool.get('x')
    expect(created.length).toBe(1)
    resolveConnect?.()
    await Promise.all([p1, p2])
    expect(created.length).toBe(1)
  })

  test('closeAll closes every instance and clears the pool', async () => {
    const { make, created } = makeFactory()
    const pool = new InstancePool(base, make)
    await Promise.all([pool.get('a'), pool.get('b')])
    await pool.closeAll()
    expect(created.every((m) => m.closed)).toBeTrue()
    expect(pool.tenants).toEqual([])
  })

  test('enqueue runs jobs FIFO per tenant, isolates failures', async () => {
    const { make } = makeFactory()
    const errors: unknown[] = []
    const pool = new InstancePool(base, make, { onStoreError: (tenant, err) => errors.push(`${tenant}:${String(err)}`) })

    const order: string[] = []
    let release: (() => void) | undefined
    pool.enqueue('a', async () => {
      order.push('a1-start')
      await new Promise<void>((r) => (release = r))
      order.push('a1-end')
    })
    pool.enqueue('a', async () => order.push('a2'))
    pool.enqueue('b', async () => order.push('b1'))
    pool.enqueue('a', async () => {
      throw new Error('boom')
    })
    pool.enqueue('a', async () => order.push('a3'))

    await new Promise((r) => setTimeout(r, 20))
    // a2 waits for a1; b1 (other tenant) already ran; a3 waits for a2.
    expect(order).toEqual(['a1-start', 'b1'])
    release?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2', 'a3'])
    expect(errors).toEqual(['a:Error: boom']) // failure did not kill the chain
  })
})
