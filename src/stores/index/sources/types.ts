/**
 * FileSource abstraction: a read-only view over a tree of files/dirs, from any
 * backend (local FS in M4, S3/MinIO and WebDAV in M4b). The index core is
 * filesystem-agnostic: it only sees `SourceEntry` lists + text previews.
 */

/** One entry relative to the source root (e.g. `docs/guide/a.md`). */
export interface SourceEntry {
  key: string
  type: 'file' | 'dir'
  size?: number
  /** ms epoch */
  mtime?: number
  /** Optional strong change signal (S3 ETag) — stronger than mtime+size. */
  etag?: string
  ext?: string
}

export interface FileSource {
  /** Stable namespace (e.g. 'local', 's3:kb', 'webdav:cloud'). No '/' in it. */
  readonly id: string
  /** 'local' | 's3' | 'webdav' */
  readonly kind: string
  /** Root the source lists from. */
  readonly root: string
  /** Walk/list the entries under `root` (defaults to `this.root`). */
  list(root?: string): Promise<SourceEntry[]>
  /**
   * Text preview of a file (relative `key`), at most `maxBytes`.
   * Returns `null` for binary / unreadable / missing files.
   */
  readPreview(key: string, opts?: { maxBytes?: number }): Promise<string | null>
}
