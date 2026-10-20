import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { LocalFileSource } from '../../src/stores/index/sources/local'

let fixture: string

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'remem-local-'))
  await mkdir(path.join(fixture, 'docs/guide'), { recursive: true })
  await mkdir(path.join(fixture, 'node_modules/junk'), { recursive: true })
  await mkdir(path.join(fixture, '.git'), { recursive: true })
  await writeFile(path.join(fixture, 'docs/readme.md'), '# Docs\n\nBenvenuti.')
  await writeFile(path.join(fixture, 'docs/guide/a.md'), 'guida a')
  await writeFile(path.join(fixture, 'notes.txt'), 'note')
  await writeFile(path.join(fixture, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  await writeFile(path.join(fixture, 'node_modules/junk/x.js'), 'x')
  await writeFile(path.join(fixture, '.git/config'), 'x')
})

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe('LocalFileSource (unit, real fs fixture)', () => {
  test('list walks the tree with relative keys, types and ext', async () => {
    const src = new LocalFileSource('local', fixture)
    const entries = await src.list()
    const byKey = new Map(entries.map((e) => [e.key, e]))

    expect(byKey.get('docs')?.type).toBe('dir')
    expect(byKey.get('docs/guide')?.type).toBe('dir')
    expect(byKey.get('docs/readme.md')).toMatchObject({ type: 'file', ext: 'md' })
    expect(byKey.get('docs/readme.md')?.size).toBeGreaterThan(0)
    expect(typeof byKey.get('notes.txt')?.mtime).toBe('number')

    // ignored segments are pruned (not just hidden)
    expect([...byKey.keys()]).not.toContain('node_modules')
    expect([...byKey.keys()]).not.toContain('.git')
    expect([...byKey.keys()]).not.toContain('node_modules/junk')
  })

  test('custom ignore and maxEntries', async () => {
    const src = new LocalFileSource('local', fixture, { ignore: ['docs'], maxEntries: 3 })
    const entries = await src.list()
    expect(entries.length).toBeLessThanOrEqual(3)
    expect(entries.some((e) => e.key.startsWith('docs'))).toBe(false)
  })

  test('readPreview returns text for files', async () => {
    const src = new LocalFileSource('local', fixture)
    const preview = await src.readPreview('docs/readme.md')
    expect(preview).toContain('# Docs')
  })

  test('readPreview returns null for binary files', async () => {
    const src = new LocalFileSource('local', fixture)
    await expect(src.readPreview('binary.bin')).resolves.toBeNull()
  })

  test('readPreview returns null for missing files and directories', async () => {
    const src = new LocalFileSource('local', fixture)
    await expect(src.readPreview('nope.md')).resolves.toBeNull()
    await expect(src.readPreview('docs')).resolves.toBeNull()
  })

  test('readPreview blocks path traversal outside the root', async () => {
    const src = new LocalFileSource('local', fixture)
    await expect(src.readPreview('../outside.txt')).resolves.toBeNull()
    await expect(src.readPreview('docs/../../outside.txt')).resolves.toBeNull()
  })

  test('readPreview honours maxBytes', async () => {
    const src = new LocalFileSource('local', fixture)
    const preview = await src.readPreview('notes.txt', { maxBytes: 3 })
    expect(preview).toBe('not')
  })
})
