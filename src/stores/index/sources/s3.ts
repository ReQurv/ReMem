import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import type { Logger } from '../../../logging'
import { IndexStoreError } from '../../../errors'
import type { FileSource, SourceEntry } from './types'

export interface S3SourceConfig {
  id: string
  bucket: string
  prefix?: string
  region: string
  /** Custom endpoint (MinIO, etc.). */
  endpoint?: string
  accessKey?: string
  secretKey?: string
  /** MinIO: set true with a custom endpoint. */
  forcePathStyle?: boolean
  maxEntries?: number
  timeoutMs?: number
  logger?: Logger
  /** Test hook: inject a mock client. */
  client?: S3Client
}

const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_PREVIEW_BYTES = 4096

function extOf(name: string): string | undefined {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : undefined
}

/** Drain an S3 GetObject body (Stream / ReadableStream / Blob) into a Buffer. */
async function bodyToBuffer(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | Blob | null | undefined,
  max: number,
): Promise<Buffer | null> {
  if (!body) return null
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
        if (total >= max) break
      }
    }
    return Buffer.concat(chunks).subarray(0, max)
  }
  if (typeof (body as Blob).arrayBuffer === 'function') {
    return Buffer.from(await (body as Blob).arrayBuffer()).subarray(0, max)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body as NodeJS.ReadableStream) {
    chunks.push(chunk as Uint8Array)
    total += (chunk as Uint8Array).length
    if (total >= max) break
  }
  return Buffer.concat(chunks).subarray(0, max)
}

/**
 * FileSource over S3 / MinIO (via `endpoint` + `forcePathStyle`).
 * `list` = paginated ListObjectsV2 under `prefix`; `readPreview` = ranged GetObject.
 */
export class S3Source implements FileSource {
  readonly kind = 's3'
  readonly id: string
  readonly root: string
  private readonly bucket: string
  private readonly prefix: string
  private readonly maxEntries: number
  private readonly timeoutMs: number
  private readonly logger?: Logger
  private readonly client: S3Client

  constructor(cfg: S3SourceConfig) {
    this.id = cfg.id
    this.bucket = cfg.bucket
    this.prefix = (cfg.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.root = `s3://${cfg.bucket}${this.prefix ? `/${this.prefix}` : ''}`
    this.maxEntries = cfg.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.timeoutMs = cfg.timeoutMs ?? 30_000
    this.logger = cfg.logger

    this.client = cfg.client ?? new S3Client(this.buildConfig(cfg))
  }

  private buildConfig(cfg: S3SourceConfig): S3ClientConfig {
    const conf: S3ClientConfig = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      requestHandler: { requestTimeout: this.timeoutMs },
    }
    if (cfg.endpoint) conf.endpoint = cfg.endpoint
    if (cfg.accessKey && cfg.secretKey) {
      conf.credentials = { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey }
    }
    return conf
  }

  async list(): Promise<SourceEntry[]> {
    const entries: SourceEntry[] = []
    let token: string | undefined
    try {
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.prefix || undefined,
            ContinuationToken: token,
          }),
        )
        for (const cp of res.CommonPrefixes ?? []) {
          if (entries.length >= this.maxEntries) break
          if (!cp.Prefix) continue
          const key = cp.Prefix.slice(this.prefix.length).replace(/^\/+|\/+$/g, '')
          if (key) entries.push({ key, type: 'dir' })
        }
        for (const obj of res.Contents ?? []) {
          if (entries.length >= this.maxEntries) break
          if (!obj.Key) continue
          const key = obj.Key.slice(this.prefix.length).replace(/^\/+/, '')
          if (!key || key.endsWith('/')) continue // folder markers
          entries.push({
            key,
            type: 'file',
            size: obj.Size ?? 0,
            mtime: obj.LastModified ? Math.round(obj.LastModified.getTime()) : undefined,
            etag: obj.ETag?.replace(/^"|"$/g, ''),
            ext: extOf(key),
          })
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token && entries.length < this.maxEntries)
    } catch (err) {
      throw new IndexStoreError(`S3 list on '${this.root}' failed: ${String(err)}`, err)
    }
    return entries
  }

  async readPreview(key: string, opts?: { maxBytes?: number }): Promise<string | null> {
    const max = opts?.maxBytes ?? DEFAULT_PREVIEW_BYTES
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix ? `${this.prefix}/${key}` : key,
          Range: `bytes=0-${max - 1}`,
        }),
      )
      if (res.ContentType && /pdf|zip|png|jpe?g|gif|webp|parquet|avro|wasm|mp[34]|ogg|wav|sqlite|tar|gz/.test(res.ContentType)) {
        return null
      }
      const buf = await bodyToBuffer(res.Body, max)
      if (!buf || buf.includes(0)) return null
      const text = buf.toString('utf8')
      return text.includes('\uFFFD') ? null : text
    } catch (err) {
      this.logger?.debug('s3 readPreview failed', { key, err: String(err) })
      return null
    }
  }
}
