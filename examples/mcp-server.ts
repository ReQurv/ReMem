/**
 * @requrv/remem — MCP servers, run by hand.
 *
 * stdio (personal, single-tenant):
 *   bun run examples/mcp-server.ts            # speaks MCP over stdio (for an agent)
 *
 * HTTP (enterprise, multi-tenant; requires Bun + MCP_USERS):
 *   MCP_USERS='[{"key":"rk-alice","name":"alice","tenant":"acme-alice","company":"acme-corp","role":"user"}]' \
 *   bun run examples/mcp-server.ts http      # listens on :3100 (PORT to override)
 *
 * Requirements: Qdrant + Neo4j running and provider env set (see .env.example).
 */
import { loadConfigFromEnv } from '../src/index'

const mode = process.argv[2] ?? 'stdio'
const config = loadConfigFromEnv()

if (mode === 'http') {
  const { InstancePool } = await import('../src/mcp/pool')
  const { TenantRegistry } = await import('../src/mcp/tenants')
  const { createHttpServer } = await import('../src/mcp/http-server')
  const registry = TenantRegistry.fromEnv()
  const pool = new InstancePool(config)
  const app = createHttpServer({ registry, pool })
  const port = Number(process.env.PORT ?? 3100)
  app.listen({ port })
  console.log(`remem-mcp HTTP on :${port} (${registry.size} principals) — Ctrl-C to stop`)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
} else {
  const { ReMem } = await import('../src/core/ReMem')
  const { ReMemBackend, createReMemMcpServer } = await import('../src/mcp/server')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const mem = new ReMem(config)
  const server = createReMemMcpServer(new ReMemBackend(mem, config))
  await server.connect(new StdioServerTransport())
  console.error('remem-mcp stdio ready (agent protocol on stdout) — Ctrl-C to stop')
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
