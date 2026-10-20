import { describe, expect, test } from 'bun:test'

import { RouterError } from '../../src/errors'
import { fromLayaResponse, noul, toLayaRequest } from '../../src/router/laya-http'

describe('toLayaRequest', () => {
  test('builds a POST JSON request with text/checkpoint/outputs', () => {
    const init = toLayaRequest('il contenuto', { read_vector: noul('è un fatto?') }, {
      checkpoint: 'ckpt-1',
    })
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    const body = JSON.parse(init.body as string)
    expect(body.text).toBe('il contenuto')
    expect(body.checkpoint).toBe('ckpt-1')
    expect(body.outputs).toEqual({ read_vector: { type: 'noul', instructions: 'è un fatto?' } })
  })

  test('merges custom headers (auth)', () => {
    const init = toLayaRequest('x', {}, { headers: { authorization: 'Bearer tok' } })
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    })
  })
})

describe('fromLayaResponse', () => {
  test('accepts { outputs: {...} }', () => {
    expect(fromLayaResponse({ outputs: { read_vector: 0.9, read_graph: 0.1 } })).toEqual({
      read_vector: 0.9,
      read_graph: 0.1,
    })
  })

  test('accepts flat { ... }', () => {
    expect(fromLayaResponse({ read_vector: 1 })).toEqual({ read_vector: 1 })
  })

  test('rejects probabilities out of [0,1] → RouterError', () => {
    expect(() => fromLayaResponse({ outputs: { read_vector: 1.4 } })).toThrow(RouterError)
  })

  test('rejects non-numeric values → RouterError', () => {
    expect(() => fromLayaResponse({ outputs: { read_vector: 'alto' } })).toThrow(RouterError)
  })

  test('rejects non-object bodies → RouterError', () => {
    expect(() => fromLayaResponse(null)).toThrow(RouterError)
    expect(() => fromLayaResponse('ok')).toThrow(RouterError)
  })
})
