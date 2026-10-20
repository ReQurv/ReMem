import { describe, expect, test } from 'bun:test'

import { IndexStoreError } from '../../src/errors'
import { WebDAVSource } from '../../src/stores/index/sources/webdav'
import { mockFetch } from '../helpers'

const BASE = 'http://cloud/dav'

function resp(href: string, isDir: boolean, f: { lm?: string; len?: number; etag?: string } = {}): string {
  return [
    '<d:response>',
    `<d:href>${href}</d:href>`,
    '<d:propstat><d:prop>',
    `<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>`,
    f.lm ? `<d:getlastmodified>${f.lm}</d:getlastmodified>` : '',
    f.len !== undefined ? `<d:getcontentlength>${f.len}</d:getcontentlength>` : '',
    f.etag ? `<d:getetag>${f.etag}</d:getetag>` : '',
    '</d:prop></d:propstat>',
    '</d:response>',
  ].join('')
}

function multistatus(...responses: string[]): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`
}

const TREE: Record<string, string> = {
  'docs': multistatus(
    resp(`${BASE}/docs`, true),
    resp(`${BASE}/docs/a.md`, false, { lm: 'Wed, 21 Oct 2015 07:28:00 GMT', len: 12, etag: '"e1"' }),
    resp(`${BASE}/docs/sub`, true, { etag: '"e2"' }),
  ),
  'docs/sub': multistatus(
    resp(`${BASE}/docs/sub`, true),
    resp(`${BASE}/docs/sub/b.txt`, false, { lm: 'Thu, 22 Oct 2015 07:28:00 GMT', len: 7, etag: '"e3"' }),
  ),
}

function makeSource(overrides: Partial<ConstructorParameters<typeof WebDAVSource>[0]> = {}): WebDAVSource {
  return new WebDAVSource({ id: 'webdav:cloud', url: BASE, user: 'u', password: 'p', prefix: 'docs', ...overrides })
}

describe('WebDAVSource (unit, mocked fetch)', () => {
  test('list parses multistatus and recurses into collections', async () => {
    const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
    const restore = mockFetch((url, init) => {
      calls.push({ url, init })
      const rel = url.replace(`${BASE}/`, '')
      const xml = TREE[rel]
      if (!xml) return new Response('not found', { status: 404 })
      return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml' } })
    })
    try {
      const entries = await makeSource().list()
      expect(entries).toEqual([
        { key: 'a.md', type: 'file', size: 12, mtime: Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'), etag: 'e1', ext: 'md' },
        { key: 'sub', type: 'dir', etag: 'e2' },
        { key: 'sub/b.txt', type: 'file', size: 7, mtime: Date.parse('Thu, 22 Oct 2015 07:28:00 GMT'), etag: 'e3', ext: 'txt' },
      ])
      // PROPFIND with Depth: 1 + Basic auth
      expect(calls[0].init?.method).toBe('PROPFIND')
      expect(calls[0].init?.headers?.depth).toBe('1')
      expect(calls[0].init?.headers?.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
      expect(calls[0].init?.body).toContain('<d:resourcetype/>')
      // recursion happened (two PROPFINDs)
      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe(`${BASE}/docs/sub`)
    } finally {
      restore()
    }
  })

  test('list honours maxDepth (no recursion beyond it)', async () => {
    const restore = mockFetch((url) => {
      const rel = url.replace(`${BASE}/`, '')
      return new Response(TREE[rel] ?? '', { status: 207 })
    })
    try {
      const entries = await makeSource({ maxDepth: 0 }).list()
      expect(entries.map((e) => e.key)).toEqual(['a.md', 'sub'])
    } finally {
      restore()
    }
  })

  test('list honours maxEntries', async () => {
    const many = multistatus(
      resp(`${BASE}/docs`, true),
      ...Array.from({ length: 10 }, (_, i) => resp(`${BASE}/docs/f${i}.txt`, false, { len: 1 })),
    )
    const restore = mockFetch(() => new Response(many, { status: 207 }))
    try {
      const entries = await makeSource({ maxEntries: 4 }).list()
      expect(entries).toHaveLength(4)
    } finally {
      restore()
    }
  })

  test('PROPFIND non-2xx → IndexStoreError', async () => {
    const restore = mockFetch(() => new Response('boom', { status: 500 }))
    try {
      await expect(makeSource().list()).rejects.toThrow(IndexStoreError)
    } finally {
      restore()
    }
  })

  test('readPreview returns ranged text', async () => {
    let range: string | undefined
    const restore = mockFetch((_url, init) => {
      range = init?.headers?.range
      return new Response('ciao mondo', { status: 206, headers: { 'content-type': 'text/plain' } })
    })
    try {
      await expect(makeSource().readPreview('a.md')).resolves.toBe('ciao mondo')
      expect(range).toBe('bytes=0-4095')
    } finally {
      restore()
    }
  })

  test('readPreview → null for binary and for 404', async () => {
    const restore = mockFetch((url) => {
      if (url.endsWith('bin.dat')) return new Response(new Uint8Array([0, 1, 2]), { status: 206 })
      return new Response('nope', { status: 404 })
    })
    try {
      const src = makeSource()
      await expect(src.readPreview('bin.dat')).resolves.toBeNull()
      await expect(src.readPreview('missing.md')).resolves.toBeNull()
    } finally {
      restore()
    }
  })
})
