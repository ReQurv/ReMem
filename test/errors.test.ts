import { describe, expect, test } from 'bun:test'

import {
  ConfigError,
  ConnectionError,
  EmbeddingError,
  GraphStoreError,
  IndexStoreError,
  LLMError,
  ReMemError,
  RouterError,
  VectorStoreError,
} from '../src/errors'

const cases: Array<[string, ReMemError]> = [
  ['ReMemError', new ReMemError('x')],
  ['ConfigError', new ConfigError('x')],
  ['ConnectionError', new ConnectionError('x')],
  ['EmbeddingError', new EmbeddingError('x')],
  ['LLMError', new LLMError('x')],
  ['VectorStoreError', new VectorStoreError('x')],
  ['GraphStoreError', new GraphStoreError('x')],
  ['IndexStoreError', new IndexStoreError('x')],
  ['RouterError', new RouterError('x')],
]

describe('errors', () => {
  for (const [name, err] of cases) {
    test(`${name} is an Error and a ReMemError`, () => {
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ReMemError)
      expect(err.name).toBe(name)
      expect(err.message).toBe('x')
    })
  }

  test('carries the cause', () => {
    const cause = new Error('root')
    const err = new ConfigError('bad', cause)
    expect(err.cause).toBe(cause)
  })
})
