import { describe, expect, test } from 'bun:test'

import { HeuristicRouter } from '../../src/router/HeuristicRouter'

const router = new HeuristicRouter()

describe('HeuristicRouter.routeWrite', () => {
  test('short plain text → vector only, no graph', async () => {
    const d = await router.routeWrite({ content: 'preferenza: blu' })
    expect(d.targets).toEqual(['vector'])
    expect(d.confidence).toBeGreaterThanOrEqual(0)
    expect(d.confidence).toBeLessThanOrEqual(1)
  })

  test('long text (≥ threshold) → vector + graph, lower confidence', async () => {
    const d = await router.routeWrite({ content: 'x'.repeat(60) })
    expect(d.targets).toContain('vector')
    expect(d.targets).toContain('graph')
    expect(d.confidence).toBeLessThan(1)
  })

  test('relational markers → vector + graph even when short', async () => {
    const d = await router.routeWrite({ content: 'Marco collabora con Luca.' })
    expect(d.targets).toContain('graph')
    expect(d.reasoning).toBeDefined()
  })

  test('index is NEVER a write target', async () => {
    for (const content of [
      'ciao',
      'Marco usa la libreria remem e collabora con il team per il progetto X, che è importante',
      '',
      'x'.repeat(200),
    ]) {
      const d = await router.routeWrite({ content, source: 'local' })
      expect(d.targets).not.toContain('index')
      expect(d.targets.length).toBeGreaterThan(0)
    }
  })

  test('source is provenance only: it does not add targets', async () => {
    const a = await router.routeWrite({ content: 'ciao' })
    const b = await router.routeWrite({ content: 'ciao', source: 'local' })
    expect(b.targets).toEqual(a.targets)
  })
})

describe('HeuristicRouter.routeRead', () => {
  test('plain factual query → always includes vector, targets non-empty', async () => {
    const d = await router.routeRead({ query: 'che lingua preferisce Marco?' })
    expect(d.targets).toContain('vector')
    expect(d.targets.length).toBeGreaterThan(0)
    expect(d.confidence).toBeGreaterThanOrEqual(0)
    expect(d.confidence).toBeLessThanOrEqual(1)
  })

  test('file query → includes index', async () => {
    const d = await router.routeRead({ query: 'in quale file è definito login?' })
    expect(d.targets).toContain('index')
  })

  test('extension mention → includes index', async () => {
    const d = await router.routeRead({ query: 'cosa contiene il file readme.md?' })
    expect(d.targets).toContain('index')
  })

  test('path-like token → includes index', async () => {
    const d = await router.routeRead({ query: "cos'è in src/auth/login.ts?" })
    expect(d.targets).toContain('index')
  })

  test('relational query → includes graph', async () => {
    const d = await router.routeRead({ query: 'come è collegato Marco al team?' })
    expect(d.targets).toContain('graph')
  })

  test('never returns empty targets; confidence in [0,1]', async () => {
    for (const query of ['', 'ciao', 'x y z', 'chi fa cosa?', 'dove sta il file a.md?']) {
      const d = await router.routeRead({ query })
      expect(d.targets.length).toBeGreaterThan(0)
      expect(d.confidence).toBeGreaterThanOrEqual(0)
      expect(d.confidence).toBeLessThanOrEqual(1)
    }
  })
})
