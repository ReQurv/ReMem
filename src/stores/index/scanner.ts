import type { FileEntry } from './types'
import type { FileSource, SourceEntry } from './sources/types'

export interface ScanOpts {
  /** Base names (or path segments) to skip. */
  ignore?: string[]
  maxEntries?: number
  /** Whether to include file entries (default true; false = dirs only). */
  includeFiles?: boolean
}

const DEFAULT_MAX_ENTRIES = 2000

/**
 * Cheap change signal: O(1), no content reads.
 * S3: ETag when present (catches in-place overwrites even if mtime/size are
 * unchanged); otherwise mtime+size.
 */
export function hashFor(entry: SourceEntry): string {
  if (entry.etag) return `etag:${entry.etag}`
  return `mtime:${entry.mtime ?? 0}|size:${entry.size ?? 0}`
}

/**
 * Scan a source into namespaced `FileEntry`s: `path = ${source.id}/${key}`.
 * Applies ignore + maxEntries + includeFiles.
 */
export async function scan(source: FileSource, root: string, opts?: ScanOpts): Promise<FileEntry[]> {
  const ignore = new Set(opts?.ignore ?? [])
  const max = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const includeFiles = opts?.includeFiles ?? true

  const entries = await source.list(root)
  const out: FileEntry[] = []
  for (const e of entries) {
    if (out.length >= max) break
    if (!includeFiles && e.type === 'file') continue
    const segments = e.key.split('/')
    if (segments.some((s) => ignore.has(s))) continue
    out.push({
      path: `${source.id}/${e.key}`,
      source: source.id,
      type: e.type,
      ext: e.ext,
      size: e.size,
      mtime: e.mtime,
      hash: hashFor(e),
    })
  }
  return out
}
