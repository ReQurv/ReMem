import type { ReMemConfig } from '../config'
import type { ChatModel } from '../providers/chat/types'
import { ConfigError } from '../errors'
import { HeuristicRouter } from './HeuristicRouter'
import { LLMRouter } from './LLMRouter'
import { LayaRouter } from './LayaRouter'
import type { Router } from './types'

export { HeuristicRouter, LLMRouter, LayaRouter }
export type { Router, RouteState, RouteDecision } from './types'
export type { LayaRouterConfig } from './LayaRouter'

/** Build the configured router. */
export function createRouter(cfg: ReMemConfig, chat?: ChatModel): Router {
  switch (cfg.router) {
    case 'heuristic':
      return new HeuristicRouter()
    case 'llm':
      if (!chat) throw new ConfigError("router 'llm' requires a ChatModel")
      return new LLMRouter(chat)
    case 'laya':
      if (!cfg.laya) throw new ConfigError("router 'laya' requires the `laya` config block (endpoint, …)")
      return new LayaRouter(cfg.laya)
    default: {
      const _exhaustive: never = cfg.router
      throw new ConfigError(`Unknown router: ${String(_exhaustive)}`)
    }
  }
}
