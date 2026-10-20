import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ReMem, buildDeps } from '../../src/core/ReMem'
import { ReMemConfigSchema } from '../../src/config'
import { noopLogger } from '../../src/logging'
import { createHttpServer } from '../../src/mcp/http-server'
import { InstancePool } from '../../src/mcp/pool'
import { TenantRegistry } from '../../src/mcp/tenants'
import { createExtractor } from '../../src/stores/graph/extractor'
import { Neo4jGraphStore } from '../../src/stores/graph/Neo4jGraphStore'
import { QdrantVectorStore } from '../../src/stores/vector/QdrantVectorStore'
import type { Embedder } from '../../src/providers/embedder/types'
import type { ChatModel } from '../../src/providers/chat/types'

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333'
const NEO4J_URI = process.env.NEO4J_URI ?? 'bolt://localhost:7687'
const MEM_COLLECTION = 'remem_mcp_e2e_mem'
const INDEX_COLLECTION = 'remem_mcp_e2e_idx'
const PORT = 43991

const qdrantUp = await (async () => {
  try {
    const res = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
})()

const t = qdrantUp ? test : test.skip

// Deterministic pseudo-embedder (same pattern as test/integration/remem.test.ts).
function fakeVec(text: string): number[] {
  const v = new Array<number>(8).fill(0)
  for (let i = 0; i < text.length; i += 1) v[i % 8] += (text.charCodeAt(i) % 7) + 1
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  return v.map((x) => x / norm)
}
const fakeEmbedder: Embedder = {
  dimensions: 8,
  embed: async (texts) => texts.map(fakeVec),
  embedQuery: async (text) => fakeVec(text),
}
const fakeChat: ChatModel = {
  complete: async (messages) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? ''
    if (sys.includes('knowledge-graph extractor')) {
      return JSON.stringify({ entities: [{ id: 'marco', label: 'Person', name: 'Marco' }], relations: [] })
    }
    return '{}'
  },
}

const MCP_USERS = JSON.stringify([
  { key: 'rk_alice', name: 'alice', tenant: 'acme-alice', company: 'acme-corp', role: 'user' },
  { key: 'rk_bob', name: 'bob', tenant: 'acme-bob', company: 'acme-corp', role: 'user' },
  { key: 'rk_ops', name: 'ops-bot', tenant: 'acme-ops', company: 'acme-corp', role: 'admin' },
])

interface Harness {
  clients: Map<string, Client>
  call(key: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>
}

describe('MCP HTTP server, multi-tenant (Qdrant live + fake LLM)', () => {
  let pool: InstancePool
  let app: ReturnType<typeof createHttpServer>
  let graph: Neo4jGraphStore
  let graphUp = false
  let vector: QdrantVectorStore | undefined
  let indexVector: QdrantVectorStore | undefined
  let h: Harness

  beforeAll(async () => {
    if (!qdrantUp) return

    const base = ReMemConfigSchema.parse({
      vector: { url: QDRANT_URL, memoryCollection: MEM_COLLECTION, indexCollection: INDEX_COLLECTION },
      graph: { uri: NEO4J_URI, username: 'neo4j', password: 'changeit' },
      embedder: { provider: 'ollama' },
      chat: { provider: 'ollama' },
    })

    graph = new Neo4jGraphStore({ ...base.graph, logger: noopLogger })
    try {
      await graph.ensureSchema()
      await graph.query('MATCH (n) DETACH DELETE n')
      graphUp = true
    } catch {
      graphUp = false
    }

    // One connected ReMem per tenant: real Qdrant/Neo4j, fake LLM providers.
    pool = new InstancePool(base, (config) => {
      const deps = buildDeps(config, noopLogger)
      deps.embedder = fakeEmbedder
      deps.extractor = createExtractor(fakeChat, noopLogger)
      vector = deps.vector as QdrantVectorStore
      indexVector = deps.indexVector as QdrantVectorStore
      return new ReMem(config, { deps, logger: noopLogger })
    })

    const registry = new TenantRegistry(MCP_USERS)
    app = createHttpServer({ registry, pool })
    app.listen({ port: PORT })

    h = {
      clients: new Map(),
      async call(key, tool, args) {
        let client = h.clients.get(key)
        if (!client) {
          const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          })
          client = new Client({ name: key, version: '0.0.0' })
          await client.connect(transport)
          h.clients.set(key, client)
        }
        const res = await client.callTool({ name: tool, arguments: args })
        const { content, isError } = res as { content: Array<{ type: string; text?: string }>; isError?: boolean }
        const first = content[0]
        return { text: first.type === 'text' ? (first.text ?? '') : '', isError: isError === true }
      },
    }
  })

  afterAll(async () => {
    if (!qdrantUp) return
    for (const client of h?.clients.values() ?? []) await client.close().catch(() => {})
    await app?.closeSessions().catch(() => {})
    ;(app as { stop?: () => void } | undefined)?.stop?.()
    await pool?.closeAll().catch(() => {})
    await vector?.drop().catch(() => {})
    await indexVector?.drop().catch(() => {})
    if (graphUp) await graph.query('MATCH (n) DETACH DELETE n').catch(() => {})
  })

  t('rejects a missing/invalid API key with 401', async () => {
    for (const auth of [undefined, 'Bearer wrong-key']) {
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
      expect(res.status).toBe(401)
    }
  })

  t('healthz reports mode and principals', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`)
    expect(res.ok).toBeTrue()
    const body = (await res.json()) as Record<string, unknown>
    expect(body.mode).toBe('http-multi-tenant')
    expect(body.principals).toBe(3)
  })

  t('alice stores a personal memory, bob cannot see it (tenant isolation)', async () => {
    const stored = await h.call('rk_alice', 'mem_remember', {
      content: 'Marco preferisce le riunioni la mattina presto',
      source: 'e2e',
    })
    expect(stored.isError).toBeFalsy()
    expect(stored.text).toContain('vector')

    const aliceRecall = await h.call('rk_alice', 'mem_recall', { query: 'che ore preferisce marco per le riunioni', only: ['vector'] })
    expect(aliceRecall.text).toContain('## Your memory')
    expect(aliceRecall.text).toContain('mattina')

    const bobRecall = await h.call('rk_bob', 'mem_recall', { query: 'che ore preferisce marco per le riunioni', only: ['vector'] })
    expect(bobRecall.text).not.toContain('mattina')
  })

  t('users cannot write to the company tenant; admins can', async () => {
    const denied = await h.call('rk_alice', 'mem_remember', {
      content: 'tento di scrivere in azienda',
      scope: 'company',
    })
    expect(denied.isError).toBeTrue()
    expect(denied.text).toContain('PermissionError')

    const stored = await h.call('rk_ops', 'mem_remember', {
      content: 'La policy aziendale richiede revisione biennale dei permessi',
      scope: 'company',
    })
    expect(stored.isError).toBeFalsy()
  })

  t('company memory is fused into recall for every member', async () => {
    for (const key of ['rk_alice', 'rk_bob']) {
      const r = await h.call(key, 'mem_recall', { query: 'quale policy c è sui permessi aziendali', only: ['vector'] })
      expect(r.text).toContain('## Company memory')
      expect(r.text).toContain('biennale')
    }
  })

  t('mem_status reports the principal and both tenants', async () => {
    const r = await h.call('rk_alice', 'mem_status', {})
    expect(r.text).toContain('alice (user)')
    expect(r.text).toContain('acme-alice')
    expect(r.text).toContain('acme-corp')
  })
})
