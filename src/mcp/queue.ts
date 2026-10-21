/**
 * FIFO store queue for the async `mem_remember` contract.
 *
 * Store jobs are LLM-heavy (embedding + graph extraction) and can take
 * tens of seconds. The MCP call must NOT wait for them: the tool acks
 * immediately and the job runs in the background, strictly one at a time
 * per queue (no LLM hammering). Failures are logged, never propagated —
 * a failed background store degrades like any other subsystem failure.
 */
export type StoreRun = () => Promise<unknown>

export type Enqueue = (run: StoreRun) => void

export function createFifoQueue(onError?: (err: unknown) => void): Enqueue {
  let chain: Promise<unknown> = Promise.resolve()
  return (run: StoreRun) => {
    chain = chain
      .then(() => run())
      .catch((err: unknown) => {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
        if (onError) onError(err)
        else console.error('[remem-mcp] background store failed:', message)
      })
  }
}
