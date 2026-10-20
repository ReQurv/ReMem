import neo4j, {
  auth,
  type Driver,
  type Node as Neo4jNode,
  type Record as Neo4jRecord,
  type Relationship as Neo4jRelationship,
} from 'neo4j-driver'

import { ConnectionError, GraphStoreError } from '../../errors'
import type { Logger } from '../../logging'
import { isStorableValue, sanitizeLabel, sanitizePropertyKey, sanitizeType } from './sanitize'
import type { Entity, GraphInsight, GraphStore, Relation } from './types'

export interface Neo4jGraphStoreOpts {
  uri: string
  username: string
  password: string
  database?: string
  logger?: Logger
  /**
   * Tenant scope: when set, every entity id is namespaced to
   * `${tenant}/${id}` — tenants share one database but cannot see each
   * other (no cross-tenant edges possible).
   */
  tenant?: string
}

/**
 * GraphStore backed by Neo4j. The constructor performs no I/O; call
 * `ensureSchema` (e.g. in `connect()`) before writing/reading. Each operation
 * runs in its own session.
 */
export class Neo4jGraphStore implements GraphStore {
  private readonly driver: Driver
  private readonly database: string
  private readonly logger?: Logger
  private readonly tenant?: string

  constructor(opts: Neo4jGraphStoreOpts) {
    this.database = opts.database ?? 'neo4j'
    this.logger = opts.logger
    this.tenant = opts.tenant
    this.driver = neo4j.driver(opts.uri, auth.basic(opts.username, opts.password))
  }

  /** Tenant-scoped id (the isolation boundary). */
  private scopedId(id: string): string {
    return this.tenant ? `${this.tenant}/${id}` : id
  }

  private unscopedId(id: string): string {
    return this.tenant && id.startsWith(`${this.tenant}/`) ? id.slice(this.tenant.length + 1) : id
  }

  /** Create the constraint/index if missing. Idempotent. */
  async ensureSchema(): Promise<void> {
    await this.run('CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE')
    await this.run('CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)')
  }

  async upsertEntity(e: Entity): Promise<void> {
    const label = sanitizeLabel(e.label)
    // Neo4j properties must be primitives (or arrays thereof): set them one by
    // one under sanitized keys; nested values are dropped.
    const sets: string[] = []
    const params: Record<string, unknown> = { id: this.scopedId(e.id), name: e.name }
    for (const [key, value] of Object.entries(e.properties ?? {})) {
      if (!isStorableValue(value)) continue
      const k = sanitizePropertyKey(key)
      sets.push(`n.${k} = $p_${k}`)
      params[`p_${k}`] = value
    }
    await this.run(
      `MERGE (n:Entity {id: $id})
       SET n.name = $name${sets.length ? `, ${sets.join(', ')}` : ''}
       SET n:${label}`,
      params,
    )
  }

  async upsertRelation(r: Relation): Promise<void> {
    const type = sanitizeType(r.type)
    const sets: string[] = []
    const params: Record<string, unknown> = { from: this.scopedId(r.from), to: this.scopedId(r.to) }
    for (const [key, value] of Object.entries(r.properties ?? {})) {
      if (!isStorableValue(value)) continue
      const k = sanitizePropertyKey(key)
      sets.push(`rel.${k} = $p_${k}`)
      params[`p_${k}`] = value
    }
    await this.run(
      `MERGE (a:Entity {id: $from})
       MERGE (b:Entity {id: $to})
       MERGE (a)-[rel:${type}]->(b)${sets.length ? `\nSET ${sets.join(', ')}` : ''}`,
      params,
    )
  }

  async query(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const records = await this.run(cypher, params)
    return records.map((r) => r.toObject())
  }

  /** Subgraph (entities + relations) around `entityId`, up to `depth` hops. */
  async neighbors(entityId: string, opts?: { depth?: number; limit?: number }): Promise<GraphInsight> {
    // depth/limit are validated integers, safe to interpolate.
    const depth = Math.max(1, Math.min(5, Math.trunc(opts?.depth ?? 1)))
    const limit = Math.max(1, Math.min(500, Math.trunc(opts?.limit ?? 100)))

    const nodeRecords = await this.run(
      `MATCH p = (c:Entity {id: $id})-[*0..${depth}]-(n:Entity)
       RETURN DISTINCT n AS n
       LIMIT ${limit + 1}`,
      { id: this.scopedId(entityId) },
    )
    const entities = nodeRecords.map((r) => toEntity(r.get('n') as Neo4jNode, (id) => this.unscopedId(id)))

    const relRecords = await this.run(
      `MATCH p = (c:Entity {id: $id})-[*1..${depth}]-(n:Entity)
       UNWIND relationships(p) AS rel
       WITH DISTINCT rel
       RETURN rel AS rel, startNode(rel) AS a, endNode(rel) AS b`,
      { id: this.scopedId(entityId) },
    )
    const relations = relRecords.map((r) =>
      toRelation(r.get('rel') as Neo4jRelationship, r.get('a') as Neo4jNode, r.get('b') as Neo4jNode, (id) =>
        this.unscopedId(id),
      ),
    )

    return { entities, relations }
  }

  /** Close the underlying driver. */
  async close(): Promise<void> {
    await this.driver.close()
  }

  /** One operation = one session. */
  private async run(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
    const session = this.driver.session({ database: this.database })
    try {
      const result = await session.run(cypher, params)
      return result.records
    } catch (err) {
      this.logger?.debug('neo4j query failed', { cypher: cypher.replace(/\s+/g, ' ').slice(0, 120), err: String(err) })
      wrapNeo4jError(cypher, err)
    } finally {
      await session.close().catch(() => {})
    }
  }
}

function toEntity(node: Neo4jNode, unscope: (id: string) => string): Entity {
  const props = (node.properties ?? {}) as Record<string, unknown>
  const label = (node.labels ?? []).find((l) => l !== 'Entity') ?? 'Entity'
  const rawId = typeof props.id === 'string' ? props.id : String(node.identity)
  const id = unscope(rawId)
  return {
    id,
    label,
    name: typeof props.name === 'string' ? props.name : id,
    properties: props,
  }
}

function toRelation(rel: Neo4jRelationship, a: Neo4jNode, b: Neo4jNode, unscope: (id: string) => string): Relation {
  const idOf = (n: Neo4jNode): string => {
    const p = (n.properties ?? {}) as Record<string, unknown>
    const raw = typeof p.id === 'string' ? p.id : String(n.identity)
    return unscope(raw)
  }
  return {
    from: idOf(a),
    to: idOf(b),
    type: rel.type,
    properties: rel.properties as Record<string, unknown>,
  }
}

/** Connection-level failures surface as ConnectionError, the rest as GraphStoreError. */
function wrapNeo4jError(cypher: string, err: unknown): never {
  const e = err as { message?: string; code?: string } | null
  const msg = e?.message ?? String(err)
  const isNetwork = /could not connect|Neo4j\.Error\.Connection|fetch failed|econnrefused/i.test(msg)
  const Ctor = isNetwork ? ConnectionError : GraphStoreError
  const short = cypher.replace(/\s+/g, ' ').slice(0, 80)
  throw new Ctor(`Neo4j query failed: ${short}… — ${msg}`, err)
}
