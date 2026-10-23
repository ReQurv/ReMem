import { describe, expect, test } from 'bun:test'

import { buildContext } from '../../src/core/context'

describe('buildContext', () => {
  test('renders only the sections that have data', () => {
    const r = buildContext({
      query: 'q',
      memories: [{ id: '1', score: 0.9, payload: { content: 'ciao' } }],
      sources: ['vector'],
    })
    const p = r.toPrompt()
    expect(p).toContain('## Memory')
    // the memory id is rendered so the caller can target it with forget()
    expect(p).toContain('(0.90) [1] ciao')
    expect(p).not.toContain('## Knowledge')
    expect(p).not.toContain('## Index')
  })

  test('renders empty memories as no Memory section', () => {
    const p = buildContext({ query: 'q', memories: [], sources: ['vector'] }).toPrompt()
    expect(p).not.toContain('## Memory')
    expect(p).toContain('(no results)')
  })

  test('Knowledge section: entities + relations', () => {
    const p = buildContext({
      query: 'q',
      graph: {
        entities: [{ id: 'marco', label: 'Person', name: 'Marco' }],
        relations: [{ from: 'marco', to: 'luca', type: 'COLLABORATES_WITH' }],
      },
      sources: ['graph'],
    }).toPrompt()
    expect(p).toContain('## Knowledge')
    expect(p).toContain('- [Person] Marco')
    expect(p).toContain('- marco —COLLABORATES_WITH→ luca')
  })

  test('Index section: map via toPrompt', () => {
    const p = buildContext({
      query: 'q',
      index: { updatedAt: 0, entries: [], toPrompt: () => '## local\n- a.md — guida' },
      sources: ['index'],
    }).toPrompt()
    expect(p).toContain('## Index')
    expect(p).toContain('- a.md — guida')
  })

  test('Index section: hit list', () => {
    const p = buildContext({
      query: 'q',
      index: [{ path: 'local/a.md', source: 'local', type: 'file', score: 0.8, description: 'la guida' }],
      sources: ['index'],
    }).toPrompt()
    expect(p).toContain('## Index')
    expect(p).toContain('- local/a.md — la guida')
  })

  test('truncates long snippets to ~300 chars', () => {
    const r = buildContext({
      query: 'q',
      memories: [{ id: '1', score: 1, payload: { content: 'x'.repeat(1000) } }],
      sources: ['vector'],
    })
    expect(r.toPrompt().length).toBeLessThan(400)
  })

  test('degraded stores are annotated', () => {
    const p = buildContext({ query: 'q', memories: [], sources: ['vector'], degraded: ['graph'] }).toPrompt()
    expect(p).toContain('_degraded: graph_')
  })

  test('Recall shape: memories default to []', () => {
    const r = buildContext({ query: 'q', sources: [] })
    expect(r.memories).toEqual([])
    expect(r.graph).toBeUndefined()
    expect(r.index).toBeUndefined()
    expect(r.sources).toEqual([])
  })
})
