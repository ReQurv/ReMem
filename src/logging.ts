/**
 * Minimal structured logging. The library ships a zero-dependency `noopLogger`
 * (default) and a `consoleLogger` for development. Consumers can inject any
 * object implementing `Logger`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** A logger that discards everything. Zero side effects (default). */
export const noopLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): Logger {
    return noopLogger
  },
}

function pickSink(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'error':
      return console.error
    case 'warn':
      return console.warn
    case 'debug':
      return console.debug
    default:
      return console.log
  }
}

/** A console-backed logger that only writes at or above `level`. */
export function consoleLogger(level: LogLevel = 'info'): Logger {
  const threshold = WEIGHT[level]

  function build(bindings: Record<string, unknown>): Logger {
    const write = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
      if (WEIGHT[lvl] < threshold) return
      const merged = { ...bindings, ...meta }
      const line = `[${lvl}] ${msg}`
      const sink = pickSink(lvl)
      if (Object.keys(merged).length > 0) sink(line, merged)
      else sink(line)
    }

    return {
      debug: (msg, meta) => write('debug', msg, meta),
      info: (msg, meta) => write('info', msg, meta),
      warn: (msg, meta) => write('warn', msg, meta),
      error: (msg, meta) => write('error', msg, meta),
      child: (b: Record<string, unknown>) => build({ ...bindings, ...b }),
    }
  }

  return build({})
}
