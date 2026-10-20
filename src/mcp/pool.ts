/**
 * Instance pool: one connected `ReMem` per tenant, created lazily.
 *
 * The base config (backends, providers, index sources, router) is shared;
 * only the `tenant` scope differs per instance. A failed `connect()` does
 * not poison the cache — the next call retries from scratch.
 */
import type { ReMemConfig } from '../config'
import { ReMem } from '../core/ReMem'

export type ReMemFactory = (config: ReMemConfig) => ReMem

export class InstancePool {
  private readonly instances = new Map<string, Promise<ReMem>>()

  /** The shared base config (backends, providers, router). */
  readonly base: ReMemConfig

  constructor(
    base: ReMemConfig,
    private readonly make: ReMemFactory = (config) => new ReMem(config),
  ) {
    this.base = base
  }

  /** Tenants with a live (or connecting) instance. */
  get tenants(): string[] {
    return [...this.instances.keys()]
  }

  get(tenant: string): Promise<ReMem> {
    let pending = this.instances.get(tenant)
    if (!pending) {
      const config = { ...this.base, tenant }
      pending = (async () => {
        const mem = this.make(config)
        await mem.connect()
        return mem
      })().catch((err) => {
        // Drop the failed promise so the next call retries cleanly.
        this.instances.delete(tenant)
        throw err
      })
      this.instances.set(tenant, pending)
    }
    return pending
  }

  /** Close every instance (best-effort; order does not matter). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((p) => p.then((m) => m.close())))
    this.instances.clear()
  }
}
