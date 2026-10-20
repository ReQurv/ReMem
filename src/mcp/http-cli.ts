/**
 * HTTP entry point — `remem-mcp-http` bin (enterprise multi-tenant server).
 *
 * Requires Bun (Elysia). Reads the ReMem config from env (same variables as
 * the stdio server) plus:
 *   MCP_USERS — JSON array of principals (required)
 *   PORT      — listen port (default 3100)
 */
import { loadConfigFromEnv } from '../config'
import { InstancePool } from './pool'
import { TenantRegistry } from './tenants'
import { createHttpServer } from './http-server'

async function main(): Promise<void> {
  const config = loadConfigFromEnv()
  const registry = TenantRegistry.fromEnv()
  const pool = new InstancePool(config)
  const port = Number(process.env.PORT ?? 3100)

  const app = createHttpServer({
    registry,
    pool,
    onSession: (sessionId, principal) => console.error(`[session] ${principal} → ${sessionId}`),
  })
  app.listen({ port })
  console.log(`remem-mcp HTTP server listening on :${port} (${registry.size} principals)`)

  const shutdown = (signal: string): void => {
    void (async () => {
      console.error(`[shutdown] ${signal} received`)
      await app.closeSessions().catch(() => {})
      app.stop()
      await pool.closeAll().catch(() => {})
      process.exit(0)
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
