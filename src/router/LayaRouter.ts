import type { Subsystem } from '../types'
import type { Logger } from '../logging'
import { RouterError } from '../errors'
import { fromLayaResponse, noul, toLayaRequest, type Noul } from './laya-http'
import { HeuristicRouter } from './HeuristicRouter'
import type { RouteDecision, RouteState, Router } from './types'

/**
 * Optional router backed by an EXTERNAL Laya runtime over HTTP (no ML deps in
 * the library). Routing is multi-label, so each store is asked as a `noul`
 * question — P(true) of a proposition — and a store enters `targets` when
 * `P ≥ threshold`.
 *
 * Resilience: unreachable runtime / timeout / invalid response → fallback to
 * the deterministic `HeuristicRouter`. Never throws. `index` is never a write
 * target (the index is maintained only by explicit `mem.index()`).
 */

export interface LayaRouterConfig {
  /** e.g. http://localhost:8080/predict */
  endpoint: string
  /** Optional, when the runtime serves multiple checkpoints. */
  checkpoint?: string
  /** P(true) threshold for a store to enter targets. Default 0.5. */
  threshold?: number
  /** HTTP timeout in ms. Default 800. */
  timeoutMs?: number
  /** Extra headers (auth, etc.). */
  headers?: Record<string, string>
}

const DEFAULT_THRESHOLD = 0.5
const DEFAULT_TIMEOUT_MS = 800

const WRITE_QUESTIONS: Record<string, Noul> = {
  write_vector: noul('È un fatto, preferenza o ricordo discreto da memorizzare semanticamente?'),
  write_graph: noul('Contiene entità e relazioni adatte a una knowledge graph?'),
}

const READ_QUESTIONS: Record<string, Noul> = {
  read_vector: noul('La richiesta chiede un fatto o ricordo memorizzato (recall fattuale)?'),
  read_graph: noul('La richiesta riguarda entità, relazioni o collegamenti?'),
  read_index: noul('La richiesta riguarda file, cartelle o dove qualcosa è conservato?'),
}

export class LayaRouter implements Router {
  private readonly fallback = new HeuristicRouter()

  constructor(
    private readonly cfg: LayaRouterConfig,
    private readonly logger?: Logger,
  ) {}

  async routeWrite(state: RouteState): Promise<RouteDecision> {
    return this.decide('write', state)
  }

  async routeRead(state: RouteState): Promise<RouteDecision> {
    return this.decide('read', state)
  }

  private async decide(dir: 'write' | 'read', state: RouteState): Promise<RouteDecision> {
    const text = (dir === 'write' ? state.content : state.query) ?? ''
    const questions = dir === 'write' ? WRITE_QUESTIONS : READ_QUESTIONS
    try {
      const probs = await this.predict(text, questions)
      const threshold = this.cfg.threshold ?? DEFAULT_THRESHOLD
      const targets: Subsystem[] = []
      for (const [key, p] of Object.entries(probs)) {
        const sub = key.split('_')[1] as Subsystem | undefined
        if (sub && p >= threshold) targets.push(sub)
      }
      // Minimum guarantee: never an empty route — vector is the default recall.
      if (targets.length === 0) targets.push('vector')
      const selected = Object.entries(probs)
        .filter(([k]) => targets.includes(k.split('_')[1] as Subsystem))
        .map(([, p]) => p)
      const confidence = selected.reduce((a, b) => a + b, 0) / selected.length
      return {
        targets,
        confidence,
        reasoning: `laya ${dir} noul probs: ${JSON.stringify(probs)} (threshold ${threshold})`,
      }
    } catch (err) {
      this.logger?.warn('laya router: falling back to heuristic', { dir, err: String(err) })
      return dir === 'write' ? this.fallback.routeWrite(state) : this.fallback.routeRead(state)
    }
  }

  private async predict(text: string, questions: Record<string, Noul>): Promise<Record<string, number>> {
    const init = toLayaRequest(text, questions, this.cfg)
    // Promise.resolve: tolerate sync-mocked fetch in tests (real fetch is async).
    const res = await Promise.resolve(
      fetch(this.cfg.endpoint, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) }),
    )
    if (!res.ok) throw new RouterError(`Laya runtime responded HTTP ${res.status}`)
    const body: unknown = await res.json()
    return fromLayaResponse(body)
  }
}
