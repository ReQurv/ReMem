import { describe, expect, test } from 'bun:test'

import * as remem from '../src/index'

describe('remem scaffold (M0)', () => {
  test('package entry is importable', () => {
    expect(remem).toBeDefined()
  })

  test('module is an object (barrel placeholder)', () => {
    expect(typeof remem).toBe('object')
  })
})
