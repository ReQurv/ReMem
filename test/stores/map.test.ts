import { describe, expect, test } from 'bun:test'

import { renderIndexMap } from '../../src/stores/index/map'
import type { FileEntry } from '../../src/stores/index/types'

function e(path: string, desc?: string, type: 'file' | 'dir' = 'dir'): FileEntry {
  const source = path.split('/')[0]
  return { path, source, type, description: desc }
}

describe('renderIndexMap', () => {
  test('groups by source and indents by depth', () => {
    const text = renderIndexMap({
      entries: [
        e('local/docs', 'documentazione'),
        e('local/docs/guide', 'guide operative'),
        e('local/readme.md', 'il readme', 'file'),
        e('s3:kb/data', 'dataset'),
      ],
    })
    const lines = text.split('\n')
    expect(lines).toContain('## local')
    expect(lines).toContain('- docs/ — documentazione')
    expect(lines).toContain('  - docs/guide/ — guide operative')
    expect(lines).toContain('- readme.md — il readme')
    expect(lines).toContain('## s3:kb')
    expect(lines).toContain('- data/ — dataset')
    // local group comes before s3:kb (first-appearance order)
    expect(lines.indexOf('## local')).toBeLessThan(lines.indexOf('## s3:kb'))
    // dir entries get a trailing slash, files don't
    expect(lines).toContain('- readme.md — il readme')
    expect(lines).not.toContain('- readme.md/')
  })

  test('entries without description render without an em-dash', () => {
    const text = renderIndexMap({ entries: [e('local/docs')] })
    expect(text).toContain('- docs/')
    expect(text).not.toContain('—')
  })

  test('truncates long descriptions', () => {
    const long = 'x'.repeat(200)
    const text = renderIndexMap({ entries: [e('local/docs', long)] })
    const line = text.split('\n').find((l) => l.includes('docs'))!
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(140)
  })

  test('counts omitted entries beyond maxDepth', () => {
    const text = renderIndexMap(
      {
        entries: [
          e('local/a'),
          e('local/a/b'),
          e('local/a/b/c'),
          e('local/a/b/c/d'),
          e('local/a/b/c/d/e'), // depth 5 → omitted
        ],
      },
      { maxDepth: 4 },
    )
    expect(text).not.toContain('a/b/c/d/e')
    expect(text).toContain('(… 1 omesse)')
  })

  test('truncates the whole block beyond maxChars', () => {
    const entries = Array.from({ length: 50 }, (_, i) => e(`local/d${String(i).padStart(2, '0')}`, `desc ${i}`))
    const text = renderIndexMap({ entries }, { maxChars: 200 })
    expect(text.length).toBeLessThanOrEqual(260) // block + omission note
    expect(text).toContain('righe omesse')
  })
})
