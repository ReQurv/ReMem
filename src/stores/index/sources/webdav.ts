import type { Logger } from '../../../logging'
import { IndexStoreError } from '../../../errors'
import type { FileSource, SourceEntry } from './types'

export interface WebDAVSourceConfig {
  id: string
  /** e.g. https://cloud.example.com/remote.php/dav/files/<user> (Nextcloud). */
  url: string
  user: string
  password: string
  prefix?: string
  maxEntries?: number
  /** Max recursion depth into collections. */
  maxDepth?: number
  timeoutMs?: number
  logger?: Logger
}

const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_PREVIEW_BYTES = 4096

const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getetag/>
  </d:prop>
</d:propfind>`

function extOf(name: string): string | undefined {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : undefined
}

/** Extract the first `<d:name>value</d:name>` text from a <d:response> chunk. */
function field(chunk: string, name: string): string | undefined {
  const m = chunk.match(new RegExp(`<d:${name}[^>]*>([^<]*)</d:${name}>`))
  return m?.[1]?.trim() || undefined
}

/**
 * Lightweight parse of a DAV multistatus document. Hrefs are absolute (server
 * base + path); `skipHref` is the href of the collection being listed (to
 * skip it) and `walkRel` the walk path relative to the source prefix (to
 * qualify child keys). Tolerant: missing fields fall back to mtime/size/etag
 * undefined.
 */
function parseMultiStatus(xml: string, walkRel: string, skipHref: string, baseUrl: string): SourceEntry[] {
  const out: SourceEntry[] = []
  const norm = (s: string) => s.replace(/\/+$/, '')
  const skip = norm(skipHref.startsWith(baseUrl) ? skipHref.slice(baseUrl.length) : skipHref)
  const chunks = xml.match(/<d:response>[\s\S]*?<\/d:response>/g) ?? []
  for (const chunk of chunks) {
    const href = field(chunk, 'href')
    if (!href) continue
    let decoded: string
    try {
      decoded = decodeURIComponent(href)
    } catch {
      decoded = href
    }
    let p = decoded
    if (p.startsWith(baseUrl)) p = p.slice(baseUrl.length)
    if (norm(p) === skip) continue // the collection being listed itself
    const isChild = p === skip || p.startsWith(`${skip}/`)
    const name = (isChild ? p.slice(skip.length) : p).replace(/^\/+/, '')
    const key = name ? (walkRel ? `${walkRel}/${name}` : name) : ''
    if (!key) continue
    const isDir = /<d:resourcetype>\s*<d:collection/.test(chunk)
    const entry: SourceEntry = {
      key,
      type: isDir ? 'dir' : 'file',
      etag: field(chunk, 'getetag')?.replace(/^"|"$/g, ''),
    }
    if (!isDir) {
      const lm = field(chunk, 'getlastmodified')
      entry.mtime = lm ? Date.parse(lm) || undefined : undefined
      const len = field(chunk, 'getcontentlength')
      entry.size = len ? Number.parseInt(len, 10) || undefined : undefined
      entry.ext = extOf(key)
    }
    out.push(entry)
  }
  return out
}

function encodePath(segments: string[]): string {
  return segments
    .join('/')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/**
 * FileSource over WebDAV (Nextcloud/ownCloud): PROPFIND (Depth 1) recursion for
 * `list`, ranged GET for `readPreview`. No heavy dependency — plain `fetch`.
 */
export class WebDAVSource implements FileSource {
  readonly kind = 'webdav'
  readonly id: string
  readonly root: string
  private readonly base: string
  private readonly prefix: string
  private readonly auth: string
  private readonly maxEntries: number
  private readonly maxDepth: number
  private readonly timeoutMs: number
  private readonly logger?: Logger

  constructor(cfg: WebDAVSourceConfig) {
    this.id = cfg.id
    this.base = cfg.url.replace(/\/+$/, '')
    this.prefix = (cfg.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.root = `${this.base}/${encodePath([this.prefix])}`
    this.auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`
    this.maxEntries = cfg.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxDepth = cfg.maxDepth ?? DEFAULT_MAX_DEPTH
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.logger = cfg.logger
  }

  async list(): Promise<SourceEntry[]> {
    const entries: SourceEntry[] = []
    // walk paths are relative to the source prefix, so entry keys are too.
    const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }]
    while (queue.length > 0 && entries.length < this.maxEntries) {
      const { path, depth } = queue.shift()!
      const xml = await this.propfind(path)
      const skipHref = `${this.base}/${encodePath([this.prefix, path])}`
      for (const e of parseMultiStatus(xml, path, skipHref, this.base)) {
        if (entries.length >= this.maxEntries) break
        entries.push(e)
        if (e.type === 'dir' && depth + 1 <= this.maxDepth) {
          queue.push({ path: path ? `${path}/${e.key}` : e.key, depth: depth + 1 })
        }
      }
    }
    return entries
  }

  async readPreview(key: string, opts?: { maxBytes?: number }): Promise<string | null> {
    const max = opts?.maxBytes ?? DEFAULT_PREVIEW_BYTES
    const url = `${this.base}/${encodePath([this.prefix, key])}`
    // Promise.resolve: tolerate sync-mocked fetch in tests (real fetch is async).
    const res = await Promise.resolve(
      fetch(url, {
        headers: { authorization: this.auth, range: `bytes=0-${max - 1}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    ).catch(() => null)
    if (!res || !res.ok) {
      this.logger?.debug('webdav readPreview failed', { key, status: res?.status ?? 'network' })
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.includes(0)) return null
    const text = buf.toString('utf8')
    return text.includes('\uFFFD') ? null : text
  }

  private async propfind(walk: string): Promise<string> {
    const url = `${this.base}/${encodePath([this.prefix, walk])}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'PROPFIND',
        headers: {
          authorization: this.auth,
          depth: '1',
          accept: 'application/xml',
          'content-type': 'application/xml',
        },
        body: PROPFIND_BODY,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      throw new IndexStoreError(`WebDAV PROPFIND '${walk}' failed: ${String(err)}`, err)
    }
    if (!res.ok) {
      throw new IndexStoreError(`WebDAV PROPFIND '${walk}' failed: HTTP ${res.status}`)
    }
    return res.text()
  }
}
