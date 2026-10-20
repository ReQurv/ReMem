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
import type { RecallOptions, StoreInput, StoreResult } from '../types'
import { registerTools, type McpBackend } from './tools'

export const SERVER_INFO = {
  name: 'remem-mcp',
  /** Kept in sync with package.json at release time. */
  version: '0.1.0',
} as const

/** Build an MCP server exposing the four memory tools over a backend. */
export function createReMemMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer(SERVER_INFO)
  registerTools(server, backend)
  return server
}

/** Single-tenant backend: renders `ReMem` calls directly (stdio mode). */
export class ReMemBackend implements McpBackend {
  constructor(
    private readonly mem: ReMem,
    private readonly config: ReMemConfig,
  ) {}

  async remember(input: StoreInput & { scope?: 'own' | 'company' }): Promise<StoreResult> {
    // `scope` has no meaning in single-tenant mode: one instance, one tenant.
    const { scope: _ignored, ...store } = input
    await this.mem.connect()
    return this.mem.store(store)
  }

  async recall(query: string, opts?: RecallOptions): Promise<string> {
    await this.mem.connect()
    const r = await this.mem.recall(query, opts)
    return r.toPrompt()
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
