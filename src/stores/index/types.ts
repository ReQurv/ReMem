/**
 * Index store types. The index maps files/folders (from any FileSource: local,
 * S3, WebDAV) to short descriptions, surfaced to the agent as a compact map.
 *
 * `FileSource` / `SourceEntry` live in `./sources/types.ts` (M4/M4b).
 */
export interface FileEntry {
  /** Namespaced path: `${source.id}/${key}`. */
  path: string
  /** Id of the FileSource (e.g. 'local', 's3:kb', 'webdav:cloud'). */
  source: string
  type: 'file' | 'dir'
  ext?: string
  size?: number
  mtime?: number
  description?: string
  /** Cheap change signal (etag for S3, else mtime+size). */
  hash?: string
}

export interface IndexMap {
  updatedAt: number
  entries: FileEntry[]
  /** Render the compact, context-ready map (multi-source). */
  toPrompt(): string
}

export interface IndexHit {
  path: string
  source: string
  type: 'file' | 'dir'
  score: number
  description?: string
}
