import { describe, expect, test } from 'bun:test'

import { LayaRouter } from '../../src/router/LayaRouter'
import { mockFetch, type FetchInit } from '../helpers'

const ENDPOINT = 'http://laya:8080/predict'

function makeRouter(
  overrides: Partial<ConstructorParameters<typeof LayaRouter>[0]> = {},
  impl?: Parameters<typeof mockFetch>[0],
) {
  const calls: Array<{ url: string; init?: FetchInit }> = []
  const restore = mockFetch((url, init) => {
    calls.push({ url, init })
    if (impl) return impl(url, init)
    return new Response('{"outputs":{}}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const r = new LayaRouter({ endpoint: ENDPOINT, ...overrides })
  return { r, calls, restore }
}

describe('LayaRouter (unit, mocked fetch)', () => {
  test('routeRead: stores above threshold enter targets; confidence = their average', async () => {
    const { r, restore } = makeRouter(
      { threshold: 0.5 },
      () => new Response('{"outputs":{"read_vector":0.9,"read_graph":0.1,"read_index":0.7}}', { status: 200 }),
    )
    try {
      const d = await r.routeRead({ query: 'qualcosa' })
      expect(d.targets).toContain('vector')
      expect(d.targets).toContain('index')
      expect(d.targets).not.toContain('graph')
      expect(d.confidence).toBeCloseTo(0.8)
      expect(d.reasoning).toContain('laya read')
    } finally {
      restore()
    }
  })

  test('all below threshold → minimum guarantee [vector]', async () => {
    const { r, restore } = makeRouter(
      { threshold: 0.5 },
      () => new Response('{"outputs":{"read_vector":0.1,"read_graph":0.2,"read_index":0.3}}', { status: 200 }),
    )
    try {
      const d = await r.routeRead({ query: 'qualcosa' })
      expect(d.targets).toEqual(['vector'])
    } finally {
      restore()
    }
  })

  test('routeWrite: targets ⊆ {vector, graph} — never index', async () => {
    const { r, restore } = makeRouter(
      { threshold: 0.3 },
      () => new Response('{"outputs":{"write_vector":0.9,"write_graph":0.8}}', { status: 200 }),
    )
    try {
      const d = await r.routeWrite({ content: 'Marco collabora con Luca' })
      expect(d.targets).toContain('vector')
      expect(d.targets).toContain('graph')
      expect(d.targets).not.toContain('index')
    } finally {
      restore()
    }
  })

  test('timeout / network error → HeuristicRouter fallback (no throw)', async () => {
    const { r, restore } = makeRouter(
      {},
      () => {
        throw new Error('aborted (timeout)')
      },
    )
    try {
      const d = await r.routeRead({ query: 'in quale file è definito login?' })
      // heuristic fallback: file query → vector + index
      expect(d.targets).toContain('vector')
      expect(d.targets).toContain('index')
    } finally {
      restore()
    }
  })

  test('HTTP 500 → fallback (no throw)', async () => {
    const { r, restore } = makeRouter({}, () => new Response('boom', { status: 500 }))
    try {
      const d = await r.routeWrite({ content: 'x'.repeat(60) })
      expect(d.targets).toContain('vector')
    } finally {
      restore()
    }
  })

  test('invalid probabilities (out of [0,1]) → fallback (no throw)', async () => {
    const { r, restore } = makeRouter(
      {},
      () => new Response('{"outputs":{"read_vector":1.4}}', { status: 200 }),
    )
    try {
      const d = await r.routeRead({ query: 'ciao' })
      expect(d.targets.length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('checkpoint and custom headers are sent', async () => {
    const { r, calls, restore } = makeRouter(
      { checkpoint: 'ckpt-7', headers: { authorization: 'Bearer tok' } },
      () => new Response('{"outputs":{"read_vector":0.9}}', { status: 200 }),
    )
    try {
      await r.routeRead({ query: 'ciao' })
      expect(calls[0].url).toBe(ENDPOINT)
      expect(calls[0].init?.headers).toMatchObject({
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      })
      const body = JSON.parse(calls[0].init?.body as string)
      expect(body.checkpoint).toBe('ckpt-7')
      expect(body.outputs.read_vector).toMatchObject({ type: 'noul' })
    } finally {
      restore()
    }
  })
})
