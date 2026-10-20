import type { Subsystem } from '../types'

/**
 * The System-1 decision model. Decides where to WRITE (store) and where to READ
 * (recall) across the internal stores.
 *
 * Methods are async to unify the instant `HeuristicRouter` with async engines
 * (LLMRouter, LayaRouter). The default must stay fast and side-effect free.
 */

/** Input state for a routing decision. */
export interface RouteState {
  content?: string
  query?: string
  source?: string
}

export interface RouteDecision {
  targets: Subsystem[]
  /** 0..1 */
  confidence: number
  reasoning?: string
}

export interface Router {
  routeWrite(state: RouteState): Promise<RouteDecision>
  routeRead(state: RouteState): Promise<RouteDecision>
}
