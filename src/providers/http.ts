import type { Logger } from '../logging'
import type { ReMemError } from '../errors'

/** Constructor signature shared by all ReMem error classes. */
type ErrorCtor = new (message: string, cause?: unknown) => ReMemError

export interface HttpJsonOpts {
  /** Error class to instantiate on non-2xx or network failure. */
  error: ErrorCtor
  /** Short label used in log/error messages (e.g. 'embed(openai)'). */
  label?: string
  /** Optional Bearer token (Authorization header). */
  token?: string
  timeoutMs?: number
  logger?: Logger
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * POST a JSON body and parse a JSON response. Uses the standard `fetch`
 * (Node >= 18 / Bun). Non-2xx and network failures throw the configured error.
 */
export async function httpJson<T>(url: string, body: unknown, opts: HttpJsonOpts): Promise<T> {
  const { error, label = 'http', token, timeoutMs = 30_000, logger } = opts

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    logger?.error(`${label}: request failed`, { url, err: String(err) })
    throw new error(`${label}: request failed: ${String(err)}`, err)
  }

  const text = await res.text()
  if (!res.ok) {
    logger?.warn(`${label}: non-2xx response`, { url, status: res.status })
    throw new error(`${label}: HTTP ${res.status}: ${truncate(text)}`)
  }

  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new error(`${label}: invalid JSON response: ${truncate(text)}`, err)
  }
}
