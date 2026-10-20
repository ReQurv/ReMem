import { describe, expect, test } from 'bun:test'

import { sanitizeId, sanitizeLabel, sanitizeType } from '../../src/stores/graph/sanitize'

describe('sanitize', () => {
  test('sanitizeLabel keeps alphanumerics + underscore', () => {
    expect(sanitizeLabel('Person')).toBe('Person')
    expect(sanitizeLabel('Foo Bar')).toBe('Foo_Bar')
    expect(sanitizeLabel('Person}; DROP //')).toMatch(/^[A-Za-z0-9_]+$/)
  })

  test('sanitizeLabel fixes leading digit and empty', () => {
    expect(sanitizeLabel('1abc')).toBe('_1abc')
    expect(sanitizeLabel('!')).toBe('Entity')
    expect(sanitizeLabel('')).toBe('Entity')
  })

  test('sanitizeType produces UPPER_SNAKE', () => {
    expect(sanitizeType('knows person')).toBe('KNOWS_PERSON')
    expect(sanitizeType('works-for')).toBe('WORKS_FOR')
    expect(sanitizeType('')).toBe('RELATED_TO')
  })

  test('sanitizeId produces kebab-case with fallback', () => {
    expect(sanitizeId('  User 1 ')).toBe('user-1')
    expect(sanitizeId('John--Doe')).toBe('john-doe')
    expect(sanitizeId('', 'John Doe')).toBe('john-doe')
    expect(sanitizeId('!!!', '')).toBe('node')
  })
})
