import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'

import { describe, expect, test } from 'bun:test'

import { IndexStoreError } from '../../src/errors'
import { S3Source } from '../../src/stores/index/sources/s3'

function fakeClient(handler: (cmd: unknown) => unknown | Promise<unknown>): S3Client {
  return { send: (cmd: unknown) => Promise.resolve(handler(cmd)) } as unknown as S3Client
}

function textStream(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(s))
      c.close()
    },
  })
}

describe('S3Source (unit, mocked S3Client)', () => {
  test('list paginates and maps entries (relative keys, unquoted etag, dirs from CommonPrefixes)', async () => {
    const pages = [
      {
        Contents: [
          { Key: 'docs/readme.md', Size: 10, LastModified: new Date(1000), ETag: '"abc"' },
          { Key: 'docs/guide/x.md', Size: 4, LastModified: new Date(2000), ETag: '"d1"' },
        ],
        CommonPrefixes: [{ Prefix: 'docs/guide/' }],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      {
        Contents: [{ Key: 'docs/b.txt', Size: 5, LastModified: new Date(3000), ETag: 'def' }],
        CommonPrefixes: [],
        IsTruncated: false,
      },
    ]
    const calls: unknown[] = []
    let page = 0
    const client = fakeClient((cmd) => {
      calls.push(cmd)
      if (cmd instanceof ListObjectsV2Command) return pages[page++]
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', prefix: 'docs', region: 'us-east-1', client })
    const entries = await src.list()

    expect(entries).toEqual([
      { key: 'guide', type: 'dir' },
      { key: 'readme.md', type: 'file', size: 10, mtime: 1000, etag: 'abc', ext: 'md' },
      { key: 'guide/x.md', type: 'file', size: 4, mtime: 2000, etag: 'd1', ext: 'md' },
      { key: 'b.txt', type: 'file', size: 5, mtime: 3000, etag: 'def', ext: 'txt' },
    ])
    // second page requested with the continuation token
    const second = calls[1] as InstanceType<typeof ListObjectsV2Command>
    expect(second.input.ContinuationToken).toBe('t1')
    expect(second.input.Prefix).toBe('docs')
  })

  test('list applies maxEntries cap', async () => {
    const contents = Array.from({ length: 10 }, (_, i) => ({ Key: `f${i}`, Size: 1 }))
    const client = fakeClient((cmd) => {
      if (cmd instanceof ListObjectsV2Command) return { Contents: contents, CommonPrefixes: [], IsTruncated: false }
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', maxEntries: 3, client })
    expect(await src.list()).toHaveLength(3)
  })

  test('list failure → IndexStoreError', async () => {
    const client = fakeClient(() => {
      throw new Error('Access Denied')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', client })
    await expect(src.list()).rejects.toThrow(IndexStoreError)
  })

  test('readPreview returns ranged text', async () => {
    let seen: { key?: string; range?: string } = {}
    const client = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) {
        seen = { key: cmd.input.Key, range: cmd.input.Range }
        return { Body: textStream('hello world'), ContentType: 'text/markdown' }
      }
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', prefix: 'docs', region: 'us-east-1', client })
    await expect(src.readPreview('a.md')).resolves.toBe('hello world')
    expect(seen.key).toBe('docs/a.md')
    expect(seen.range).toBe('bytes=0-4095')
  })

  test('readPreview → null for binary content-type', async () => {
    const client = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) return { Body: textStream('%PDF-1.4'), ContentType: 'application/pdf' }
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', client })
    await expect(src.readPreview('doc.pdf')).resolves.toBeNull()
  })

  test('readPreview → null for binary bytes', async () => {
    const bin = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))
        c.close()
      },
    })
    const client = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) return { Body: bin, ContentType: 'application/zip' }
      throw new Error('unexpected command')
    })
    // content-type regex may or may not catch it; NUL byte must
    const bin2 = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x00, 0x01, 0x02]))
        c.close()
      },
    })
    const client2 = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) return { Body: bin2, ContentType: 'application/octet-stream' }
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', client })
    await expect(src.readPreview('x')).resolves.toBeNull()
    const src2 = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', client: client2 })
    await expect(src2.readPreview('x')).resolves.toBeNull()
    void bin
  })

  test('readPreview → null on error (e.g. 404)', async () => {
    const client = fakeClient((cmd) => {
      if (cmd instanceof GetObjectCommand) throw new Error('NoSuchKey')
      throw new Error('unexpected command')
    })
    const src = new S3Source({ id: 's3:kb', bucket: 'kb', region: 'us-east-1', client })
    await expect(src.readPreview('missing.md')).resolves.toBeNull()
  })
})
