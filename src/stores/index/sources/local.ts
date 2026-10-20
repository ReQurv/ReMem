import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import type { FileSource, SourceEntry } from './types'

export interface LocalScanOpts {
  /** Base names (or path segments) to skip. Default: ['.git', 'node_modules', 'dist']. */
  ignore?: string[]
  maxEntries?: number
}

const DEFAULT_IGNORE = ['.git', 'node_modules', 'dist']
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_PREVIEW_BYTES = 2000

function extOf(name: string): string | undefined {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : undefined
}

/** FileSource over the local filesystem (BFS walk of `root`). */
export class LocalFileSource implements FileSource {
  readonly kind = 'local'

  constructor(
    public readonly id: string,
    public readonly root: string,
    private readonly opts: LocalScanOpts = {},
  ) {}

  async list(root?: string): Promise<SourceEntry[]> {
    const base = root ?? this.root
    const ignore = new Set(this.opts.ignore ?? DEFAULT_IGNORE)
    const max = this.opts.maxEntries ?? DEFAULT_MAX_ENTRIES

    const entries: SourceEntry[] = []
    const queue: string[] = [base]
    while (queue.length > 0 && entries.length < max) {
      const dir = queue.shift()!
      let items: Dirent[]
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue // unreadable dir: skip, don't fail the whole scan
      }
      for (const item of items) {
        if (entries.length >= max) break
        if (ignore.has(item.name)) continue
        const abs = path.join(dir, item.name)
        const rel = path.relative(base, abs).split(path.sep).join('/')
        if (item.isDirectory()) {
          entries.push({ key: rel, type: 'dir' })
          queue.push(abs)
        } else if (item.isFile()) {
          const st = await fs.stat(abs).catch(() => null)
          entries.push({
            key: rel,
            type: 'file',
            size: st?.size,
            mtime: st ? Math.round(st.mtimeMs) : undefined,
            ext: extOf(item.name),
          })
        }
      }
    }
    return entries
  }

  async readPreview(key: string, opts?: { maxBytes?: number }): Promise<string | null> {
    const max = opts?.maxBytes ?? DEFAULT_PREVIEW_BYTES
    const abs = path.resolve(this.root, key)
    const base = path.resolve(this.root)
    // no path traversal outside the root
    if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return null

    const fd = await fs.open(abs, 'r').catch(() => null)
    if (!fd) return null
    try {
      const buf = Buffer.alloc(max)
      let bytesRead = 0
      try {
        // directories open on macOS but fail on read (EISDIR) → null
        bytesRead = (await fd.read(buf, 0, max, 0)).bytesRead
      } catch {
        return null
      }
      const slice = buf.subarray(0, bytesRead)
      if (slice.includes(0)) return null // NUL byte → treat as binary
      return slice.toString('utf8')
    } finally {
      await fd.close()
    }
  }
}
