/**
 * Enterprise HTTP server (Elysia + Streamable HTTP transport, Web APIs —
 * requires Bun).
 *
 * One MCP *session* (client connection) = one authenticated principal =
 * one `McpServer` wired to the `AccessGate`. Session routing:
 * - POST /mcp WITHOUT `Mcp-Session-Id` → initialize: bearer auth, then a
 *   dedicated stateful transport.
 * - Subsequent POST/GET/DELETE carry the session id → routed to that
 *   session's transport; DELETE closes and discards it.
 */
import { Elysia } from 'elysia'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import type { InstancePool } from './pool'
import { AccessGate } from './gate'
import { createReMemMcpServer, SERVER_INFO } from './server'
import type { TenantRegistry } from './tenants'

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  principalName: string
}

function bearerKey(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() ?? null
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export interface HttpServerOptions {
  registry: TenantRegistry
  pool: InstancePool
  /** Optional hook for observability (called on every new session). */
  onSession?: (sessionId: string, principalName: string) => void
}

export interface ReMemHttpServer extends Elysia {
  /** Close every open MCP session (test/ops hook). */
  closeSessions(): Promise<void>
}

export function createHttpServer(opts: HttpServerOptions): ReMemHttpServer {
  const sessions = new Map<string, Session>()

  const app = new Elysia() as ReMemHttpServer

  app.get('/healthz', () => ({
    ok: true,
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    mode: 'http-multi-tenant',
    principals: opts.registry.size,
    sessions: sessions.size,
  }))

  app.all('/mcp', async ({ request }) => {
    const sessionId = request.headers.get('mcp-session-id')

    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) return jsonError(404, 'unknown or expired MCP session')
      if (request.method === 'DELETE') {
        sessions.delete(sessionId)
        await session.transport.close().catch(() => {})
      }
      return session.transport.handleRequest(request)
    }

    // New session: authenticate, then build a dedicated stateful transport.
    const principal = opts.registry.resolve(bearerKey(request.headers.get('authorization')))
    if (!principal) return jsonError(401, 'missing or invalid API key (Authorization: Bearer <key>)')
    if (request.method !== 'POST') return jsonError(405, 'new MCP sessions start with a POST initialize')

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    })
    const server = createReMemMcpServer(new AccessGate(opts.pool, principal))
    await server.connect(transport)

    const response = await transport.handleRequest(request)
    const newSessionId = response.headers.get('mcp-session-id')
    if (newSessionId) {
      sessions.set(newSessionId, { transport, principalName: principal.name })
      opts.onSession?.(newSessionId, principal.name)
    }
    return response
  })

  /** Test/ops hook: close every open MCP session. */
  app.closeSessions = async () => {
    await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()))
    sessions.clear()
  }

  return app
}
