import { z } from 'zod'

import { RouterError } from '../errors'

/**
 * The single point of contact with the external Laya runtime (HTTP).
 *
 * Contract (Jev-compatible HTTP server):
 * - POST `endpoint`, JSON body: `{ text, checkpoint?, outputs }` where
 *   `outputs` maps question-key → noul instruction
 *   `{ type: 'noul', instructions }`.
 * - Response JSON: `{ outputs: { [key]: P(true) } }` (a flat
 *   `{ [key]: P(true) }` object is also accepted — runtimes differ).
 *
 * If the runtime you use differs, adjust ONLY this file.
 */

/** One `noul` question: P(true) of a proposition. */
export interface Noul {
  type: 'noul'
  instructions: string
}

export function noul(instructions: string): Noul {
  return { type: 'noul', instructions }
}

export interface LayaRequestConfig {
  checkpoint?: string
  headers?: Record<string, string>
}

/** Build the HTTP request for a Laya predict call. */
export function toLayaRequest(
  text: string,
  questions: Record<string, Noul>,
  cfg: LayaRequestConfig = {},
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cfg.headers },
    body: JSON.stringify({
      text,
      checkpoint: cfg.checkpoint,
      outputs: questions,
    }),
  }
}

/** Validate a Laya response body into `{ [questionKey]: probability }`. */
export function fromLayaResponse(body: unknown): Record<string, number> {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  // Accept `{ outputs: {...} }` or flat `{ ... }`.
  const candidate =
    obj && obj.outputs && typeof obj.outputs === 'object' && !Array.isArray(obj.outputs)
      ? obj.outputs
      : obj
  const parsed = z.record(z.string(), z.number().min(0).max(1)).safeParse(candidate)
  if (!parsed.success) {
    throw new RouterError(`Invalid Laya response: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  return parsed.data
}
