import type { ReMemConfig } from '../../../config'
import { ConfigError } from '../../../errors'
import { LocalFileSource } from './local'
import { S3Source } from './s3'
import { WebDAVSource } from './webdav'
import type { FileSource, SourceEntry } from './types'
import type { IndexSourceConfig } from './config'

export { LocalFileSource, S3Source, WebDAVSource }
export type { FileSource, SourceEntry }

/** Build a FileSource from a validated config entry. */
export function createFileSource(cfg: IndexSourceConfig): FileSource {
  switch (cfg.kind) {
    case 'local':
      return new LocalFileSource(cfg.id, cfg.root)
    case 's3':
      return new S3Source({
        id: cfg.id,
        bucket: cfg.bucket,
        prefix: cfg.prefix,
        region: cfg.region,
        accessKey: cfg.accessKey,
        secretKey: cfg.secretKey,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
      })
    case 'webdav':
      return new WebDAVSource({
        id: cfg.id,
        url: cfg.url,
        user: cfg.user,
        password: cfg.password,
        prefix: cfg.prefix,
      })
    default: {
      const _exhaustive: never = cfg
      throw new ConfigError(`Unknown index source kind: ${String(_exhaustive)}`)
    }
  }
}

/** Build all configured sources (unified view: local + remotes). */
export function createSources(cfg: ReMemConfig['index']): FileSource[] {
  return cfg.sources.map((s) => createFileSource(s))
}
