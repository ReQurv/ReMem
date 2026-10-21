/**
 * Instance pool: one connected `ReMem` per tenant, created lazily.
 *
 * The base config (backends, providers, index sources, router) is shared;
 * only the `tenant` scope differs per instance. A failed `connect()` does
 * not poison the cache — the next call retries from scratch.
 */
import type { ReMemConfig } from '../config'
import { ReMem } from '../core/ReMem'
import { createFifoQueue, type Enqueue, type StoreRun } from './queue'

export type ReMemFactory = (config: ReMemConfig) => ReMem

export interface InstancePoolOptions {
  /** Called for background store jobs that fail (logged, never thrown). */
  onStoreError?: (tenant: string, err: unknown) => void
}

export class InstancePool {
  private readonly instances = new Map<string, Promise<ReMem>>()
  private readonly queues = new Map<string, Enqueue>()

  /** The shared base config (backends, providers, router). */
  readonly base: ReMemConfig

  private readonly onStoreError?: (tenant: string, err: unknown) => void

  constructor(
    base: ReMemConfig,
    private readonly make: ReMemFactory = (config) => new ReMem(config),
    opts: InstancePoolOptions = {},
  ) {
    this.base = base
    this.onStoreError = opts.onStoreError
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

  /**
   * Queue a background store job for a tenant. Jobs run strictly one at a
   * time per tenant (LLM-heavy) and NEVER reject the caller — failures go
   * to `onStoreError` (default: console.error).
   */
  enqueue(tenant: string, run: StoreRun): void {
    let queue = this.queues.get(tenant)
    if (!queue) {
      queue = createFifoQueue(
        this.onStoreError ? (err) => this.onStoreError!(tenant, err) : undefined,
      )
      this.queues.set(tenant, queue)
    }
    queue(run)
  }

  /** Close every instance (best-effort; order does not matter). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((p) => p.then((m) => m.close())))
    this.instances.clear()
    this.queues.clear()
  }
}
