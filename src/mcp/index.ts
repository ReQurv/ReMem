/**
 * @requrv/remem/mcp — MCP server surface.
 *
 * - `createReMemMcpServer` + `ReMemBackend` — single-tenant server (stdio)
 * - `createHttpServer` — enterprise multi-tenant server (Elysia, Bun)
 * - `TenantRegistry`, `InstancePool`, `AccessGate` — the multi-tenant core
 */
export { createReMemMcpServer, ReMemBackend, SERVER_INFO } from './server'
export { registerTools, TOOL_NAMES, type McpBackend } from './tools'
export { TenantRegistry, type Principal, type PrincipalRole } from './tenants'
export { InstancePool, type ReMemFactory } from './pool'
export { AccessGate } from './gate'
export { createHttpServer, type HttpServerOptions, type ReMemHttpServer } from './http-server'
