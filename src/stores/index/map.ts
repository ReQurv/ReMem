import type { FileEntry } from './types'

export interface RenderOpts {
  /** Hard cap on the rendered block (chars). */
  maxChars?: number
  /** Per-description cap (chars). */
  maxDescChars?: number
  /** Max relative depth rendered; deeper entries are counted as omitted. */
  maxDepth?: number
}

const DEFAULT_MAX_CHARS = 4000
const DEFAULT_MAX_DESC = 120
const DEFAULT_MAX_DEPTH = 4

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Render a compact, context-ready map grouped by source, indented by depth:
 *
 *   ## local
 *   - docs — documentazione
 *     - docs/guide — guide operative
 *   ## s3:kb
 *   - data — dataset
 */
export function renderIndexMap(map: { entries: FileEntry[] }, opts?: RenderOpts): string {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
  const maxDesc = opts?.maxDescChars ?? DEFAULT_MAX_DESC
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH

  // group by source (first-appearance order), sorted by path within a group
  const groups = new Map<string, FileEntry[]>()
  for (const e of map.entries) {
    const arr = groups.get(e.source) ?? []
    arr.push(e)
    groups.set(e.source, arr)
  }

  const lines: string[] = []
  let omitted = 0
  for (const [source, entries] of groups) {
    lines.push(`## ${source}`)
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
    for (const e of sorted) {
      const rel = e.path.slice(source.length + 1)
      const depth = rel.split('/').length
      if (depth > maxDepth) {
        omitted += 1
        continue
      }
      const indent = '  '.repeat(depth - 1)
      const desc = e.description ? ` — ${truncate(e.description, maxDesc)}` : ''
      lines.push(`${indent}- ${rel}${e.type === 'dir' ? '/' : ''}${desc}`)
    }
  }

  let text = lines.join('\n')
  if (omitted > 0) text += `\n(… ${omitted} omesse)`

  if (text.length > maxChars) {
    const kept: string[] = []
    let total = 0
    for (const l of lines) {
      if (total + l.length + 1 > maxChars) break
      kept.push(l)
      total += l.length + 1
    }
    const dropped = lines.length - kept.length
    text = kept.join('\n') + (dropped > 0 ? `\n(… ${dropped} righe omesse)` : '')
  }
  return text
}
