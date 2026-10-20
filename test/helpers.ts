/** Test helpers: fake global fetch + canned JSON responses. */

export type FetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export type FetchImpl = (url: string, init?: FetchInit) => Response | Promise<Response>

/** Replace `globalThis.fetch` with `impl`; returns a restore function. */
export function mockFetch(impl: FetchImpl): () => void {
  const orig = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
