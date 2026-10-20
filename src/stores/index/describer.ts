import type { ChatMessage, ChatModel } from '../../providers/chat/types'
import type { Logger } from '../../logging'
import { parseJsonLoose } from '../../util/parse-json'
import type { FileEntry } from './types'
import type { FileSource } from './sources/types'

export interface Describer {
  /**
   * Describe entries; returns `path → description` for what it could produce.
   * Cache hits (pre-seeded by the caller) are returned without any LLM call.
   * Never throws: failed batches simply yield no descriptions.
   */
  describe(entries: FileEntry[], opts?: { cache?: Map<string, string> }): Promise<Map<string, string>>
}

export interface DescriberOpts {
  /** When true, files get an LLM description from a text preview; otherwise only dirs are described. */
  describeFiles?: boolean
  /** Entries per LLM call. */
  batchSize?: number
  logger?: Logger
}

const PREVIEW_CHARS = 1500
const MAX_CHILD_NAMES = 40

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Source-relative key from a namespaced path. */
function relativeKey(e: FileEntry): string {
  return e.path.slice(e.source.length + 1)
}

/** Children (by name) of a dir entry, from the full entry list. */
function childNames(dirPath: string, all: FileEntry[]): string {
  const prefix = `${dirPath}/`
  const names: string[] = []
  for (const e of all) {
    if (!e.path.startsWith(prefix)) continue
    const rest = e.path.slice(prefix.length)
    if (!rest.includes('/')) names.push(rest)
  }
  return names.slice(0, MAX_CHILD_NAMES).join(', ')
}

const systemPrompt = (batchSize: number): string =>
  `You are a filesystem indexer. For each entry listed by the user, write ONE very short phrase (max ~10 words, in the same language as the names) describing what it is or contains.
Respond ONLY with a JSON object mapping each entry path to its description, e.g. {"local/docs": "progettazione API"}.
Include exactly the ${batchSize} given paths as keys. No prose, no markdown: JSON only.`

/**
 * LLM describer for index entries. Directories are described from their
 * children's names; files (only when `describeFiles`) from a text preview via
 * `readPreview`. Batches entries per LLM call; defensive JSON parsing; failures
 * degrade to "no description", never throw.
 */
export function createDescriber(
  chat: ChatModel,
  readPreview: FileSource['readPreview'],
  opts?: DescriberOpts,
): Describer {
  const describeFiles = opts?.describeFiles ?? false
  const batchSize = Math.max(1, opts?.batchSize ?? 10)
  const logger = opts?.logger

  return {
    async describe(entries, describeOpts): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      const cache = describeOpts?.cache
      const pending: FileEntry[] = []
      for (const e of entries) {
        const cached = cache?.get(e.path)
        if (cached) {
          out.set(e.path, cached)
        } else if (e.type === 'dir' || describeFiles) {
          pending.push(e)
        }
        // files with describeFiles=false: name only, no description
      }

      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize)
        const batchResult = await describeBatch(batch, entries)
        for (const [p, d] of batchResult) out.set(p, d)
      }
      return out
    },
  }

  async function describeBatch(batch: FileEntry[], all: FileEntry[]): Promise<Map<string, string>> {
    const res = new Map<string, string>()
    const valid = new Set(batch.map((e) => e.path))
    const lines: string[] = []
    for (const e of batch) {
      if (e.type === 'dir') {
        lines.push(`${e.path} [dir] children: ${childNames(e.path, all) || '(empty)'}`)
      } else {
        let preview: string | null = null
        try {
          preview = await readPreview(relativeKey(e)).catch(() => null)
        } catch {
          preview = null
        }
        lines.push(
          `${e.path} [file] name=${e.path.split('/').pop()}${preview ? `\npreview: ${truncate(preview, PREVIEW_CHARS)}` : ''}`,
        )
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(batch.length) },
      { role: 'user', content: `Entries:\n${lines.join('\n')}` },
    ]

    try {
      const raw = chat.completeJson ? await chat.completeJson(messages) : await chat.complete(messages)
      const parsed = parseJsonLoose(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim() && valid.has(k)) res.set(k, v.trim())
        }
      } else {
        logger?.debug('describe batch: unparseable JSON', { batch: batch.length })
      }
    } catch (err) {
      logger?.debug('describe batch failed', { batch: batch.length, err: String(err) })
    }
    return res
  }
}
