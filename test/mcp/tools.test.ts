import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'

import { ConnectionError } from '../../src/errors'
import { createReMemMcpServer } from '../../src/mcp/server'
import { TOOL_NAMES, type McpBackend } from '../../src/mcp/tools'
import type { IndexMap } from '../../src/stores/index/types'

/** Backend spy: records calls, returns canned values, mergeable with overrides. */
function makeBackend(overrides: Partial<McpBackend> = {}) {
  const calls: Array<[string, unknown]> = []
  const base: McpBackend = {
    remember: async (input) => {
      calls.push(['remember', input])
      return { id: 'mem-1', writtenTo: ['vector'] }
    },
    recall: async (query, opts) => {
      calls.push(['recall', { query, opts }])
      return `RECALL[${query}]`
    },
    index: async (opts) => {
      calls.push(['index', opts])
      return { toPrompt: () => 'INDEX-MAP' } as unknown as IndexMap
    },
    status: () => {
      calls.push(['status', undefined])
      return 'STATUS-OK'
    },
  }
  const backend: McpBackend = { ...base, ...overrides }
  return { backend, calls }
}

async function connectClient(backend: McpBackend) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createReMemMcpServer(backend)
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** callTool returns a success/error union; normalize to the success shape. */
function asResult(result: unknown): ToolResult {
  const r = result as ToolResult & { toolResult?: unknown }
  if (!r.content) throw new Error('tool call returned an error result, not content')
  return r
}

function text(result: unknown): string {
  const first = asResult(result).content[0]
  if (first.type !== 'text' || !first.text) throw new Error('expected text content')
  return first.text
}

function isError(result: unknown): boolean {
  return asResult(result).isError === true
}

describe('MCP tools (client over in-memory transport)', () => {
  test('exposes the four tools', async () => {
    const { client } = await connectClient(makeBackend().backend)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [TOOL_NAMES.remember, TOOL_NAMES.recall, TOOL_NAMES.index, TOOL_NAMES.status].sort(),
    )
  })

  test('mem_recall renders backend text and forwards options', async () => {
    const { backend, calls } = makeBackend()
    const { client } = await connectClient(backend)

    const r1 = await client.callTool({ name: TOOL_NAMES.recall, arguments: { query: 'chi è Marco?' } })
    expect(text(r1)).toBe('RECALL[chi è Marco?]')

    const r2 = await client.callTool({
      name: TOOL_NAMES.recall,
      arguments: { query: 'q', only: ['vector'], collections: ['a', 'b'], limit: 3 },
    })
    expect(text(r2)).toBe('RECALL[q]')
    const last = calls[calls.length - 1][1] as { query: string; opts: Record<string, unknown> | undefined }
    expect(last.opts).toEqual({ only: ['vector'], collections: ['a', 'b'], limit: 3 })
  })

  test('mem_remember reports the stored id and targets', async () => {
    const { backend, calls } = makeBackend()
    const { client } = await connectClient(backend)

    const r = await client.callTool({
      name: TOOL_NAMES.remember,
      arguments: { content: 'fatto importante', source: 'test', scope: 'company' },
    })
    expect(isError(r)).toBeFalse()
    expect(text(r)).toContain('mem-1')
    expect(text(r)).toContain('vector')
    const input = calls.find(([n]) => n === 'remember')?.[1] as Record<string, unknown>
    expect(input).toMatchObject({ content: 'fatto importante', source: 'test', scope: 'company' })
  })

  test('mem_remember renders the async queued ack', async () => {
    const { backend } = makeBackend({
      remember: async () => ({ queued: true }),
    })
    const { client } = await connectClient(backend)
    const r = await client.callTool({ name: TOOL_NAMES.remember, arguments: { content: 'x' } })
    expect(isError(r)).toBeFalse()
    expect(text(r)).toContain('queued')
    expect(text(r)).toContain('background')
  })

  test('mem_index renders the map', async () => {
    const { backend } = makeBackend()
    const { client } = await connectClient(backend)
    const r = await client.callTool({ name: TOOL_NAMES.index, arguments: {} })
    expect(text(r)).toBe('INDEX-MAP')
  })

  test('mem_status renders the backend status', async () => {
    const { backend } = makeBackend()
    const { client } = await connectClient(backend)
    const r = await client.callTool({ name: TOOL_NAMES.status, arguments: {} })
    expect(text(r)).toBe('STATUS-OK')
  })

  test('ReMem errors become isError results with the error name', async () => {
    const { backend } = makeBackend({
      remember: async () => {
        throw new ConnectionError('qdrant unreachable')
      },
    })
    const { client } = await connectClient(backend)
    const r = await client.callTool({ name: TOOL_NAMES.remember, arguments: { content: 'x' } })
    expect(isError(r)).toBeTrue()
    expect(text(r)).toBe('ConnectionError: qdrant unreachable')
  })
})
