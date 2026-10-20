/**
 * stdio entry point — `remem-mcp` bin.
 *
 * Single-tenant MCP server over stdio: the agent (OpenCode, Claude Code, …)
 * spawns it per session. Config comes from the environment (`.env` / the
 * agent's mcp block). `connect()` is lazy (first tool call), so the process
 * starts even with backends down.
 *
 * NOTE: stdout is the MCP protocol channel — all logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadConfigFromEnv } from '../config'
import { ReMem } from '../core/ReMem'
import type { Logger } from '../logging'
import { createReMemMcpServer, ReMemBackend } from './server'

/** Stderr-backed logger: stdout must stay clean for the MCP protocol. */
function buildStderrLogger(bindings: Record<string, unknown>): Logger {
  const write = (lvl: string, msg: string, meta?: Record<string, unknown>): void => {
    const merged = { ...bindings, ...meta }
    if (Object.keys(merged).length > 0) console.error(`[${lvl}]`, msg, merged)
    else console.error(`[${lvl}]`, msg)
  }
  return {
    debug: (msg, meta) => {
      if (process.env.LOG_LEVEL === 'debug') write('debug', msg, meta)
    },
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (b) => buildStderrLogger({ ...bindings, ...b }),
  }
}
const stderrLogger = buildStderrLogger({})

async function main(): Promise<void> {
  const config = loadConfigFromEnv()
  const mem = new ReMem(config, { logger: stderrLogger })
  const server = createReMemMcpServer(new ReMemBackend(mem, config))
  const transport = new StdioServerTransport()
  await server.connect(transport)
  stderrLogger.info('remem-mcp (stdio) ready')

  const shutdown = (): void => {
    void (async () => {
      await server.close().catch(() => {})
      await mem.close().catch(() => {})
      process.exit(0)
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
