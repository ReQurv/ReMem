import { z } from 'zod'

import type { ChatMessage, ChatModel } from '../../providers/chat/types'
import type { Logger } from '../../logging'
import { parseJsonLoose } from '../../util/parse-json'
import { sanitizeId, sanitizeLabel, sanitizeType } from './sanitize'
import type { Entity, Relation } from './types'

const ExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        name: z.string(),
        properties: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.string(),
        properties: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
})

export interface ExtractionResult {
  entities: Entity[]
  relations: Relation[]
}

export interface Extractor {
  /** Extract entities/relations from free text. Never throws: on failure returns an empty result. */
  extract(text: string, opts?: { maxEntities?: number }): Promise<ExtractionResult>
}

const systemPrompt = (max: number): string =>
  `You are a knowledge-graph extractor.
Extract the most relevant entities (people, concepts, objects, places, organizations) and the relations between them from the given text.
Respond ONLY with a JSON object of exactly this shape:
{"entities":[{"id":"kebab-case","label":"Person","name":"Full Name"}],"relations":[{"from":"entity-id","to":"entity-id","type":"UPPER_SNAKE"}]}
Rules:
- "id" is a short kebab-case identifier (unique per entity).
- "label" is a single word (Person, Concept, Object, Place, Organization).
- "type" is UPPER_SNAKE (e.g. WORKS_FOR, LOCATED_IN).
- Every relation "from"/"to" must reference an existing entity "id".
- Extract at most ${max} entities.
- No prose, no markdown: JSON only.`

const EMPTY: ExtractionResult = { entities: [], relations: [] }

/**
 * LLM-based extractor: text → entities/relations. Built on a pluggable
 * `ChatModel`. Uses `completeJson` when available, falls back to `complete`
 * (+ fence stripping), retries once, and degrades to an empty result on
 * any failure (a bad extraction must never break `store()`).
 */
export function createExtractor(chat: ChatModel, logger?: Logger): Extractor {
  return {
    async extract(text: string, opts?: { maxEntities?: number }): Promise<ExtractionResult> {
      const max = Math.max(1, Math.min(50, Math.trunc(opts?.maxEntities ?? 20)))
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt(max) },
        { role: 'user', content: text },
      ]

      const attempts: Array<() => Promise<string>> = []
      if (chat.completeJson) attempts.push(() => chat.completeJson!(messages))
      attempts.push(() => chat.complete(messages))

      let parsed: unknown = null
      for (let i = 0; i < attempts.length; i += 1) {
        try {
          const raw = await attempts[i]()
          parsed = parseJsonLoose(raw)
          if (parsed !== null) break
          logger?.debug('extraction: attempt produced no JSON', { attempt: i + 1 })
        } catch (err) {
          logger?.debug('extraction: attempt failed', { attempt: i + 1, err: String(err) })
        }
      }

      if (parsed === null) {
        logger?.warn('extraction: no valid JSON from model, returning empty result')
        return EMPTY
      }

      try {
        const data = ExtractionSchema.parse(parsed)

        const entities: Entity[] = data.entities.slice(0, max).map((e) => ({
          id: sanitizeId(e.id, e.name),
          label: sanitizeLabel(e.label),
          name: e.name.trim() || e.id,
          properties: e.properties,
        }))

        // de-duplicate by (sanitized) id
        const seen = new Set<string>()
        const deduped: Entity[] = []
        for (const e of entities) {
          if (!seen.has(e.id)) {
            seen.add(e.id)
            deduped.push(e)
          }
        }

        // drop orphan relations (endpoints not among the kept entities)
        const ids = new Set(deduped.map((e) => e.id))
        const relations: Relation[] = data.relations
          .filter((r) => ids.has(sanitizeId(r.from)) && ids.has(sanitizeId(r.to)))
          .map((r) => ({
            from: sanitizeId(r.from),
            to: sanitizeId(r.to),
            type: sanitizeType(r.type),
            properties: r.properties,
          }))

        return { entities: deduped, relations }
      } catch (err) {
        logger?.warn('extraction: invalid JSON shape, returning empty result', { err: String(err) })
        return EMPTY
      }
    },
  }
}
