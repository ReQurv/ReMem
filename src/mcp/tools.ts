/**
 * MCP tool layer: the four tools (`mem_remember`, `mem_recall`, `mem_index`,
 * `mem_status`) as a thin adapter over a `McpBackend`. The backend decides
 * HOW memories are read/written (single-tenant `ReMem` for stdio mode, the
 * `AccessGate` fusion for the multi-tenant HTTP server) — the tool surface
 * and its error handling stay identical in both.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ReMemError } from '../errors'
import type { IndexMap } from '../stores/index/types'
import type { RecallOptions, StoreInput, StoreResult } from '../types'

/**
 * `remember` is ASYNC by design: storing is LLM-heavy (embedding + graph
 * extraction, tens of seconds for heavy content) and must never block the
 * agent's conversation. The backend acks `{ queued: true }` immediately and
 * processes the write in a per-tenant background queue.
 */
export type RememberOutcome = StoreResult | { queued: true }

/**
 * The narrow surface the tools need. `recall` returns rendered prompt text
 * (the backend owns rendering/fusion); `remember`/`index` return raw values.
 * Throwing `ReMemError`s is fine — the handler converts them.
 */
export interface McpBackend {
  remember(input: StoreInput & { scope?: 'own' | 'company' }): Promise<RememberOutcome>
  recall(query: string, opts?: RecallOptions): Promise<string>
  index(opts?: { only?: string[]; scope?: 'own' | 'company' }): Promise<IndexMap>
  status(): string
}

export const TOOL_NAMES = {
  remember: 'mem_remember',
  recall: 'mem_recall',
  index: 'mem_index',
  status: 'mem_status',
} as const

const scopeEnum = z
  .enum(['own', 'company'])
  .optional()
  .describe(
    'Enterprise HTTP mode only: which tenant to write to. "company" requires the admin role. Ignored in single-tenant mode.',
  )

const rememberShape = {
  content: z.string().min(1).describe('The memory to store (a fact, decision or note).'),
  source: z.string().optional().describe('Provenance label (e.g. "meeting-2026-10-20").'),
  collection: z.string().optional().describe('Logical collection (default "default").'),
  metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata attached to the memory.'),
  scope: scopeEnum,
}

const recallShape = {
  query: z.string().min(1).describe('Natural-language question or topic to retrieve memories for.'),
  only: z
    .array(z.enum(['vector', 'graph', 'index']))
    .optional()
    .describe('Restrict retrieval to specific subsystems (default: router decides).'),
  collections: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Restrict to logical collections (OR semantics).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max memories per subsystem (default 5).'),
}

const indexShape = {
  only: z.array(z.string()).optional().describe('Restrict the (re)scan to specific source ids.'),
  scope: scopeEnum,
}

/** Wrap a tool handler: render the value, convert ReMem errors to isError results. */
function handler(fn: (input: Record<string, unknown>) => Promise<string>) {
  return async (input: Record<string, unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: await fn(input) }] }
    } catch (err) {
      const name = err instanceof ReMemError ? err.name : 'Error'
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `${name}: ${message}` }], isError: true }
    }
  }
}

export function registerTools(server: McpServer, backend: McpBackend): void {
  server.tool(
    TOOL_NAMES.remember,
    'Store a memory. The ReMem router decides where it is written (vector store, knowledge graph). Use it for facts, decisions, agreements, preferences — anything worth remembering between conversations. Returns immediately; the write is processed in the background.',
    rememberShape,
    handler(async (input) => {
      const { content, source, collection, metadata, scope } = input as {
        content: string
        source?: string
        collection?: string
        metadata?: Record<string, unknown>
        scope?: 'own' | 'company'
      }
      const r: RememberOutcome = await backend.remember({ content, source, collection, metadata, scope })
      if ('queued' in r) {
        return (
          'Memory queued — being stored in the background (embedding + graph ' +
          'extraction can take a few seconds, more for heavy content). Recall it ' +
          'again in a moment if you need to confirm it landed.'
        )
      }
      return `Stored memory ${r.id} → ${r.writtenTo.join(', ') || '(no target wrote — degraded)'}`
    }),
  )

  server.tool(
    TOOL_NAMES.recall,
    'Retrieve relevant memories (semantic search + knowledge graph + file index). Returns a compact, prompt-ready block. In enterprise mode it fuses your personal memory with the company memory.',
    recallShape,
    handler(async (input) => {
      const { query, only, collections, limit } = input as {
        query: string
        only?: RecallOptions['only']
        collections?: RecallOptions['collections']
        limit?: number
      }
      return backend.recall(query, { only, collections, limit })
    }),
  )

  server.tool(
    TOOL_NAMES.index,
    'Scan and describe the configured file/folder sources (incremental). Returns the index map. Use it after files change, or when the agent should know what documents exist.',
    indexShape,
    handler(async (input) => {
      const { only, scope } = input as { only?: string[]; scope?: 'own' | 'company' }
      const map: IndexMap = await backend.index({ only, scope })
      return map.toPrompt()
    }),
  )

  server.tool(
    TOOL_NAMES.status,
    'Report ReMem status: tenant(s), router and configured scope. Use it to diagnose connectivity problems.',
    {},
    handler(async () => backend.status()),
  )
}
