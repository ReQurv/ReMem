/**
 * AccessGate: the multi-tenant policy (enterprise HTTP mode).
 *
 * - `mem_recall` reads BOTH tenants (personal + company) and fuses the two
 *   prompt blocks, labeled. Read-fusion is unconditional: it is the whole
 *   point of the company tenant.
 * - `mem_remember` / `mem_index` write to the principal's OWN tenant by
 *   default. `scope: 'company'` requires the `admin` role.
 * - There is no way to address a tenant other than your own or your company's.
 *
 * The single-tenant invariant of `ReMem` itself stays intact: the pool holds
 * one instance per tenant; the fusion happens HERE, above it.
 */
import type { IndexMap } from '../stores/index/types'
import type { Recall, RecallOptions, StoreInput, StoreResult } from '../types'
import { PermissionError } from '../errors'
import type { InstancePool } from './pool'
import type { Principal } from './tenants'
import type { McpBackend } from './tools'

function describe(recall: Recall): string {
  const degraded = recall.degraded?.length ? `\n(degraded: ${recall.degraded.join(', ')})` : ''
  return recall.toPrompt() + degraded
}

export class AccessGate implements McpBackend {
  constructor(
    private readonly pool: InstancePool,
    private readonly principal: Principal,
  ) {}

  /** Resolve the target tenant for a write, enforcing the scope policy. */
  private writeTenant(scope?: 'own' | 'company'): string {
    if (scope === 'company') {
      if (this.principal.role !== 'admin') {
        throw new PermissionError(`scope "company" requires the admin role (you are: ${this.principal.name}, ${this.principal.role})`)
      }
      return this.principal.company
    }
    return this.principal.tenant
  }

  async remember(input: StoreInput & { scope?: 'own' | 'company' }): Promise<StoreResult> {
    const tenant = this.writeTenant(input.scope)
    const { scope: _ignored, ...store } = input
    const mem = await this.pool.get(tenant)
    return mem.store(store)
  }

  async recall(query: string, opts?: RecallOptions): Promise<string> {
    const own = this.pool.get(this.principal.tenant)
    const company = this.pool.get(this.principal.company)
    const [ownR, companyR] = await Promise.allSettled([
      own.then((m) => m.recall(query, opts)),
      company.then((m) => m.recall(query, opts)),
    ])

    const failed = [ownR, companyR].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed.length === 2) {
      // Both tenants unreachable: surface the first reason (the tool layer renders it).
      throw failed[0].reason
    }

    const sections: string[] = []
    if (companyR.status === 'fulfilled') sections.push(`## Company memory\n\n${describe(companyR.value)}`)
    if (ownR.status === 'fulfilled') sections.push(`## Your memory\n\n${describe(ownR.value)}`)
    return sections.join('\n\n')
  }

  async index(opts?: { only?: string[]; scope?: 'own' | 'company' }): Promise<IndexMap> {
    const tenant = this.writeTenant(opts?.scope)
    const mem = await this.pool.get(tenant)
    return mem.index({ only: opts?.only })
  }

  status(): string {
    const cfg = this.pool.base
    return [
      'ReMem (enterprise HTTP, multi-tenant)',
      `  principal: ${this.principal.name} (${this.principal.role})`,
      `  your tenant:    ${this.principal.tenant}`,
      `  company tenant: ${this.principal.company}`,
      `  pool tenants: ${this.pool.tenants.join(', ') || '(none connected yet)'}`,
      `  router:   ${cfg.router}`,
      `  vector:   ${cfg.vector.url}`,
      `  graph:    ${cfg.graph.uri}`,
      `  embedder: ${cfg.embedder.provider} / ${cfg.embedder.model}`,
      `  chat:     ${cfg.chat.provider} / ${cfg.chat.model}`,
      `  index sources: ${cfg.index.sources.length > 0 ? cfg.index.sources.map((s) => s.id).join(', ') : '(none configured)'}`,
    ].join('\n')
  }
}
