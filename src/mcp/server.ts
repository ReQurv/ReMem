/**
 * MCP server factory + the single-tenant backend (stdio mode).
 *
 * The stdio server wraps ONE connected `ReMem` instance: the agent process
 * spawns it, one process = one tenant (the `TENANT` env var, if set).
 * `connect()` is lazy — it runs on the first tool call, so the server starts
 * even when Qdrant/Neo4j are not up yet.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ReMemConfig } from '../config'
import type { ReMem } from '../core/ReMem'
import type { IndexMap } from '../stores/index/types'
import type { ForgetResult, RecallOptions, StoreInput } from '../types'
import { createFifoQueue } from './queue'
import { registerTools, type McpBackend, type RememberOutcome } from './tools'

export const SERVER_INFO = {
  name: 'remem-mcp',
  /** Kept in sync with package.json at release time. */
  version: '0.3.0',
} as const

/** Build an MCP server exposing the four memory tools over a backend. */
export function createReMemMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer(SERVER_INFO)
  registerTools(server, backend)
  return server
}

/** Single-tenant backend: renders `ReMem` calls directly (stdio mode). */
export class ReMemBackend implements McpBackend {
  private readonly enqueue = createFifoQueue()

  constructor(
    private readonly mem: ReMem,
    private readonly config: ReMemConfig,
  ) {}

  /**
   * Async by contract (same rationale as `AccessGate.remember`): connect
   * lazily (a downed backend is surfaced now), then queue the LLM-heavy
   * write in the background.
   */
  async remember(input: StoreInput & { scope?: 'own' | 'company' }): Promise<RememberOutcome> {
    // `scope` has no meaning in single-tenant mode: one instance, one tenant.
    const { scope: _ignored, ...store } = input
    await this.mem.connect()
    this.enqueue(() => this.mem.store(store))
    return { queued: true }
  }

  async recall(query: string, opts?: RecallOptions): Promise<string> {
    await this.mem.connect()
    const r = await this.mem.recall(query, opts)
    return r.toPrompt()
  }

  /**
   * Synchronous (unlike `remember`): forgetting is cheap (no LLM), so the
   * caller gets the real delete result, not a queue ack. `scope` has no
   * meaning in single-tenant mode: one instance, one tenant.
   */
  async forget(id: string, scope?: 'own' | 'company'): Promise<ForgetResult> {
    void scope
    await this.mem.connect()
    return this.mem.forget(id)
  }

  async index(opts?: { only?: string[]; scope?: 'own' | 'company' }): Promise<IndexMap> {
    await this.mem.connect()
    return this.mem.index({ only: opts?.only })
  }

  status(): string {
    return [
      'ReMem (stdio, single-tenant)',
      `  tenant:  ${this.config.tenant ?? '(none — single-tenant mode)'}`,
      `  router:  ${this.config.router}`,
      `  vector:  ${this.config.vector.url} (memories: ${this.config.vector.memoryCollection}, index: ${this.config.vector.indexCollection})`,
      `  graph:   ${this.config.graph.uri}`,
      `  embedder: ${this.config.embedder.provider} / ${this.config.embedder.model}`,
      `  chat:    ${this.config.chat.provider} / ${this.config.chat.model}`,
      `  index sources: ${this.config.index.sources.length > 0 ? this.config.index.sources.map((s) => s.id).join(', ') : '(none configured)'}`,
    ].join('\n')
  }
}
