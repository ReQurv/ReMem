import type { FileEntry } from './types'

export interface ExistingEntry {
  id: string
  hash: string
  description?: string
}

export interface IndexDiff {
  /** Now present, not before. */
  added: FileEntry[]
  /** In both, hash changed. */
  modified: FileEntry[]
  /** In both, same hash → reuse stored description (no LLM). */
  unchanged: FileEntry[]
  /** Before, not now (paths) → DELETE (orphan cleanup). */
  removed: string[]
}

/** Incremental diff between a fresh scan and the previously indexed state. */
export function diffIndex(current: FileEntry[], existing: Map<string, ExistingEntry>): IndexDiff {
  const added: FileEntry[] = []
  const modified: FileEntry[] = []
  const unchanged: FileEntry[] = []
  const seen = new Set<string>()
  for (const e of current) {
    seen.add(e.path)
    const prev = existing.get(e.path)
    if (!prev) added.push(e)
    else if (prev.hash === e.hash) unchanged.push(e)
    else modified.push(e)
  }
  const removed: string[] = []
  for (const path of existing.keys()) {
    if (!seen.has(path)) removed.push(path)
  }
  return { added, modified, unchanged, removed }
}
