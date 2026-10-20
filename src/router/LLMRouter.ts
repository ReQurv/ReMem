import { z } from 'zod'

import type { ChatMessage, ChatModel } from '../providers/chat/types'
import type { Logger } from '../logging'
import { parseJsonLoose } from '../util/parse-json'
import { HeuristicRouter } from './HeuristicRouter'
import type { RouteDecision, RouteState, Router } from './types'

/**
 * Optional LLM-backed router: asks the ChatModel which stores to use and
 * validates the answer with zod. ANY failure (network, non-JSON, invalid
 * schema) degrades to the deterministic `HeuristicRouter` — never throws.
 */

const RouteDecisionSchema = z.object({
  targets: z.array(z.enum(['vector', 'graph', 'index'])).min(1),
  confidence: z.number().min(0).max(1),
})

const systemWrite =
  'You are a memory router. Given content that will be stored in an agent memory system, decide which stores it should be written to. ' +
  'Available targets: "vector" (semantic search over embedded text), "graph" (knowledge graph of entities and relations). ' +
  'NEVER include "index" (the file index is maintained separately). ' +
  'Respond ONLY with a JSON object: {"targets":["vector"],"confidence":0.9}. "targets" must be a non-empty array; "confidence" is a number between 0 and 1.'

const systemRead =
  'You are a memory router. Given a user query over an agent memory system, decide which stores should be searched. ' +
  'Available targets: "vector" (semantic recall of stored memories), "graph" (entity/relation lookups), "index" (map of files and folders). ' +
  'Respond ONLY with a JSON object: {"targets":["vector"],"confidence":0.9}. "targets" must be a non-empty array; "confidence" is a number between 0 and 1.'

export class LLMRouter implements Router {
  private readonly fallback = new HeuristicRouter()

  constructor(
    private readonly chat: ChatModel,
    private readonly logger?: Logger,
  ) {}

  async routeWrite(state: RouteState): Promise<RouteDecision> {
    return this.decide('write', state)
  }

  async routeRead(state: RouteState): Promise<RouteDecision> {
    return this.decide('read', state)
  }

  private async decide(mode: 'write' | 'read', state: RouteState): Promise<RouteDecision> {
    const text = (mode === 'write' ? state.content : state.query) ?? ''
    const messages: ChatMessage[] = [
      { role: 'system', content: mode === 'write' ? systemWrite : systemRead },
      { role: 'user', content: text },
    ]
    try {
      const raw = this.chat.completeJson ? await this.chat.completeJson(messages) : await this.chat.complete(messages)
      const parsed = RouteDecisionSchema.safeParse(parseJsonLoose(raw))
      if (!parsed.success) {
        this.logger?.debug('llm router: invalid decision, falling back', {
          mode,
          issues: parsed.error.issues.map((i) => i.message),
        })
        return this.fallbackDecide(mode, state)
      }
      // Defensive: `index` is never a write target (explicit mem.index() only).
      const targets =
        mode === 'write' ? parsed.data.targets.filter((t) => t !== 'index') : parsed.data.targets
      if (targets.length === 0) return this.fallbackDecide(mode, state)
      return { targets, confidence: parsed.data.confidence, reasoning: `llm router (${mode})` }
    } catch (err) {
      this.logger?.debug('llm router failed, falling back', { mode, err: String(err) })
      return this.fallbackDecide(mode, state)
    }
  }

  private fallbackDecide(mode: 'write' | 'read', state: RouteState): Promise<RouteDecision> {
    return mode === 'write' ? this.fallback.routeWrite(state) : this.fallback.routeRead(state)
  }
}
