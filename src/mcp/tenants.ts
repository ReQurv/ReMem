/**
 * Static tenant registry for the enterprise HTTP server.
 *
 * `MCP_USERS` is a JSON array of principals:
 *
 *   MCP_USERS='[{"key":"rk_alice","name":"alice","tenant":"acme-alice","company":"acme-corp","role":"user"}]'
 *
 * One API key = one principal = one personal tenant + a shared company
 * tenant. Keys are static (rotation = redeploy): this is step-2 simplicity,
 * OIDC/SSO is a follow-up.
 */
import { ConfigError } from '../errors'

export type PrincipalRole = 'user' | 'admin'

export interface Principal {
  /** Display name (surfaced in `mem_status`, never secrets). */
  name: string
  /** The principal's personal tenant. */
  tenant: string
  /** The shared company tenant this principal belongs to. */
  company: string
  role: PrincipalRole
}

interface PrincipalEntry extends Principal {
  key: string
}

function parseEntry(raw: unknown, i: number): PrincipalEntry {
  const e = raw as Record<string, unknown>
  const get = (field: 'key' | 'name' | 'tenant' | 'company') => {
    const v = e?.[field]
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new ConfigError(`MCP_USERS[${i}]: "${field}" must be a non-empty string`)
    }
    return v
  }
  const role = e?.role
  if (role !== 'user' && role !== 'admin') {
    throw new ConfigError(`MCP_USERS[${i}]: "role" must be "user" or "admin"`)
  }
  return { key: get('key'), name: get('name'), tenant: get('tenant'), company: get('company'), role }
}

export class TenantRegistry {
  private readonly byKey = new Map<string, Principal>()

  constructor(json: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new ConfigError(`MCP_USERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, err)
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ConfigError('MCP_USERS must be a non-empty JSON array of principals')
    }
    for (const [i, raw] of parsed.entries()) {
      const entry = parseEntry(raw, i)
      if (this.byKey.has(entry.key)) {
        throw new ConfigError(`MCP_USERS: duplicate API key (entry ${i})`)
      }
      this.byKey.set(entry.key, { name: entry.name, tenant: entry.tenant, company: entry.company, role: entry.role })
    }
  }

  /** Number of registered principals. */
  get size(): number {
    return this.byKey.size
  }

  /** Resolve a bearer key to its principal, or null (→ 401). */
  resolve(key: string | undefined | null): Principal | null {
    if (!key) return null
    return this.byKey.get(key) ?? null
  }

  /** Build from `process.env.MCP_USERS`; throws `ConfigError` when missing/invalid. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TenantRegistry {
    const raw = env.MCP_USERS?.trim()
    if (!raw) throw new ConfigError('MCP_USERS is required for the enterprise HTTP server (JSON array of principals)')
    return new TenantRegistry(raw)
  }
}
