import { describe, expect, test } from 'bun:test'

import { consoleLogger, noopLogger } from '../src/logging'

describe('logging', () => {
  test('noopLogger is silent and child returns the same logger', () => {
    expect(typeof noopLogger.debug).toBe('function')
    noopLogger.debug('d')
    noopLogger.info('i')
    noopLogger.warn('w')
    noopLogger.error('e')
    expect(noopLogger.child({ a: 1 })).toBe(noopLogger)
  })

  test('consoleLogger writes only at/above threshold', () => {
    const counts = { log: 0, info: 0, warn: 0, error: 0, debug: 0 }
    const mk = (k: keyof typeof counts) => (..._a: unknown[]): void => {
      counts[k]++
    }
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }
    console.log = mk('log')
    console.info = mk('info')
    console.warn = mk('warn')
    console.error = mk('error')
    console.debug = mk('debug')
    try {
      const log = consoleLogger('warn')
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e')
      expect(counts.warn).toBe(1)
      expect(counts.error).toBe(1)
      expect(counts.info).toBe(0)
      expect(counts.log).toBe(0)
      expect(counts.debug).toBe(0)
    } finally {
      console.log = orig.log
      console.info = orig.info
      console.warn = orig.warn
      console.error = orig.error
      console.debug = orig.debug
    }
  })

  test('child merges bindings into the meta', () => {
    let captured: unknown[] = []
    const orig = console.log
    const spy = (...a: unknown[]): void => {
      captured = a
    }
    console.log = spy
    try {
      const child = consoleLogger('info').child({ module: 'remem' })
      child.info('hello', { x: 1 })
      expect(captured[0]).toBe('[info] hello')
      expect(captured[1]).toEqual({ module: 'remem', x: 1 })
    } finally {
      console.log = orig
    }
  })
})
