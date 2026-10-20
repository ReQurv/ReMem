import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import neo4j from 'neo4j-driver'

import { Neo4jGraphStore } from '../../src/stores/graph/Neo4jGraphStore'

const URI = process.env.NEO4J_URI ?? 'bolt://localhost:7687'
const USER = process.env.NEO4J_USER ?? 'neo4j'
const PASSWORD = process.env.NEO4J_PASSWORD ?? 'changeit'

// Probe Neo4j once (bounded); when the infra is absent the suite is skipped (no crash).
const ping = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD))
const available = await Promise.race([
  ping.verifyConnectivity().then(
    () => true,
    () => false,
  ),
  new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), 4000)
  }),
])

describe('Neo4jGraphStore (integration)', () => {
  // Constructor is no-I/O, so it is safe to build unconditionally.
  const store = new Neo4jGraphStore({ uri: URI, username: USER, password: PASSWORD })
  // Register as skipped (not failed) when the infra is absent.
  const t = available ? test : test.skip

  beforeAll(async () => {
    if (!available) return
    await store.ensureSchema()
    await store.query('MATCH (n) DETACH DELETE n') // clean slate (local test DB)
  })

  afterAll(async () => {
    await store.close().catch(() => {})
    await ping.close().catch(() => {})
  })

  t('ensureSchema is idempotent', async () => {
    await expect(store.ensureSchema()).resolves.toBeUndefined()
    await expect(store.ensureSchema()).resolves.toBeUndefined()
  })

  t('upsertEntity + query finds the node', async () => {
    await store.upsertEntity({ id: 'ada', label: 'Person', name: 'Ada Lovelace' })
    const rows = await store.query('MATCH (n:Entity {id: $id}) RETURN n.name AS name', { id: 'ada' })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Ada Lovelace')
  })

  t('upsertRelation creates a typed edge (type sanitized to UPPER_SNAKE)', async () => {
    await store.upsertEntity({ id: 'babbage', label: 'Person', name: 'Charles Babbage' })
    await store.upsertRelation({ from: 'ada', to: 'babbage', type: 'collaborated_with' })
    const rows = await store.query(
      "MATCH (a:Entity {id: 'ada'})-[r]->(b:Entity {id: 'babbage'}) RETURN type(r) AS type",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('COLLABORATED_WITH')
  })

  t('neighbors returns the subgraph at depth N', async () => {
    await store.upsertEntity({ id: 'analytical-engine', label: 'Object', name: 'Analytical Engine' })
    await store.upsertRelation({ from: 'babbage', to: 'analytical-engine', type: 'designed' })

    const g = await store.neighbors('ada', { depth: 2 })
    const ids = g.entities.map((e) => e.id).sort()
    expect(ids).toEqual(['ada', 'analytical-engine', 'babbage'])
    expect(g.relations).toHaveLength(2)
    expect(g.entities.find((e) => e.id === 'ada')).toMatchObject({ label: 'Person', name: 'Ada Lovelace' })
  })

  t('label injection is neutralized by sanitization', async () => {
    await store.upsertEntity({
      id: 'weird',
      label: 'Person}; MATCH (x) DETACH DELETE x //',
      name: 'Weird',
    })
    const rows = await store.query('MATCH (n:Entity {id: "weird"}) RETURN labels(n) AS labels')
    expect(rows).toHaveLength(1)
    const label = (rows[0].labels as string[]).find((l) => l !== 'Entity')
    expect(label).toMatch(/^[A-Za-z0-9_]+$/)

    // The injected DETACH DELETE never ran: the graph is still intact.
    const count = await store.query('MATCH (n:Entity) RETURN count(n) AS c')
    expect(Number(count[0].c)).toBeGreaterThanOrEqual(4)
  })
})
