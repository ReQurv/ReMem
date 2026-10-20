import { describe, expect, test } from 'bun:test'

import {
  createFileSource,
  createSources,
  LocalFileSource,
  S3Source,
  WebDAVSource,
} from '../../src/stores/index/sources/factory'

describe('sources factory', () => {
  test('createFileSource picks the right class per kind', () => {
    expect(createFileSource({ kind: 'local', id: 'local', root: './docs' })).toBeInstanceOf(LocalFileSource)
    expect(
      createFileSource({
        kind: 's3',
        id: 's3:kb',
        bucket: 'kb',
        prefix: 'docs',
        region: 'us-east-1',
        endpoint: 'http://minio:9000',
        forcePathStyle: true,
      }),
    ).toBeInstanceOf(S3Source)
    expect(
      createFileSource({
        kind: 'webdav',
        id: 'webdav:cloud',
        url: 'https://cloud/remote.php/dav/files/u',
        user: 'u',
        password: 'p',
        prefix: '',
      }),
    ).toBeInstanceOf(WebDAVSource)
  })

  test('createSources maps the configured sources in order', () => {
    const sources = createSources({
      sources: [
        { kind: 'local', id: 'local', root: './docs' },
        { kind: 's3', id: 's3:kb', bucket: 'kb', prefix: '', region: 'us-east-1' },
        { kind: 'webdav', id: 'webdav:cloud', url: 'https://c/dav/files/u', user: 'u', password: 'p', prefix: 'docs' },
      ],
      ignore: [],
      describeFiles: false,
      maxEntries: 2000,
    })
    expect(sources).toHaveLength(3)
    expect(sources[0]).toBeInstanceOf(LocalFileSource)
    expect(sources[1]).toBeInstanceOf(S3Source)
    expect(sources[2]).toBeInstanceOf(WebDAVSource)
    expect(sources.map((s) => s.id)).toEqual(['local', 's3:kb', 'webdav:cloud'])
    expect(sources.map((s) => s.kind)).toEqual(['local', 's3', 'webdav'])
  })
})
