import { describe, expect, test } from 'bun:test'

import { hashFor, scan } from '../../src/stores/index/scanner'
import type { FileSource, SourceEntry } from '../../src/stores/index/sources/types'

function fakeSource(entries: SourceEntry[], id = 's3:kb'): FileSource {
  return {
    id,
    kind: 's3',
    root: 'kb',
    list: async () => entries,
    readPreview: async () => null,
  }
}

describe('scanner', () => {
  test('maps SourceEntry → FileEntry with namespaced path and hash', async () => {
    const source = fakeSource([
      { key: 'data', type: 'dir' },
      { key: 'data/fixtures.csv', type: 'file', size: 10, mtime: 5, etag: '"abc"', ext: 'csv' },
    ])
    const entries = await scan(source, source.root)
    expect(entries).toEqual([
      { path: 's3:kb/data', source: 's3:kb', type: 'dir', ext: undefined, size: undefined, mtime: undefined, hash: 'mtime:0|size:0' },
      { path: 's3:kb/data/fixtures.csv', source: 's3:kb', type: 'file', ext: 'csv', size: 10, mtime: 5, hash: 'etag:"abc"' },
    ])
  })

  test('applies ignore on path segments', async () => {
    const source = fakeSource([
      { key: 'node_modules/x.js', type: 'file', size: 1, mtime: 1 },
      { key: 'src/node_modules/y.js', type: 'file', size: 1, mtime: 1 },
      { key: 'src/a.ts', type: 'file', size: 1, mtime: 1 },
    ])
    const entries = await scan(source, source.root, { ignore: ['node_modules'] })
    expect(entries.map((e) => e.path)).toEqual(['s3:kb/src/a.ts'])
  })

  test('applies maxEntries cap', async () => {
    const entries: SourceEntry[] = Array.from({ length: 10 }, (_, i) => ({ key: `f${i}`, type: 'file' as const }))
    const source = fakeSource(entries)
    const out = await scan(source, source.root, { maxEntries: 3 })
    expect(out).toHaveLength(3)
  })

  test('includeFiles=false keeps only dirs', async () => {
    const source = fakeSource([
      { key: 'a', type: 'dir' },
      { key: 'a/b.txt', type: 'file' },
    ])
    const out = await scan(source, source.root, { includeFiles: false })
    expect(out.map((e) => e.path)).toEqual(['s3:kb/a'])
  })
})

describe('hashFor', () => {
  test('uses etag when present (S3)', () => {
    expect(hashFor({ key: 'x', type: 'file', etag: '"abc"', mtime: 1, size: 2 })).toBe('etag:"abc"')
  })

  test('falls back to mtime+size', () => {
    expect(hashFor({ key: 'x', type: 'file', mtime: 100, size: 5 })).toBe('mtime:100|size:5')
    expect(hashFor({ key: 'x', type: 'dir' })).toBe('mtime:0|size:0')
  })

  test('is deterministic and O(1)', () => {
    const a = { key: 'x', type: 'file' as const, mtime: 1, size: 2 }
    expect(hashFor(a)).toBe(hashFor({ ...a }))
  })
})
