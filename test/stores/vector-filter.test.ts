import { describe, expect, test } from 'bun:test'

import { toFilter } from '../../src/stores/vector/QdrantVectorStore'

describe('toFilter', () => {
  test('undefined → undefined', () => {
    expect(toFilter()).toBeUndefined()
    expect(toFilter({})).toBeUndefined()
  })

  test('scalars → must equality', () => {
    expect(toFilter({ tenant: 'acme', collection: 'a' })).toEqual({
      must: [
        { key: 'tenant', match: { value: 'acme' } },
        { key: 'collection', match: { value: 'a' } },
      ],
    })
  })

  test('array → OR (should)', () => {
    expect(toFilter({ collection: ['a', 'b'] })).toEqual({
      should: [{ key: 'collection', match: { value: 'a' } }, { key: 'collection', match: { value: 'b' } }],
    })
  })

  test('single-element array → single should condition', () => {
    expect(toFilter({ collection: ['a'] })).toEqual({
      should: { key: 'collection', match: { value: 'a' } },
    })
  })

  test('mixed scalars + array → must AND nested should', () => {
    expect(toFilter({ tenant: 'acme', collection: ['a', 'b'] })).toEqual({
      must: [
        { key: 'tenant', match: { value: 'acme' } },
        {
          should: [
            { key: 'collection', match: { value: 'a' } },
            { key: 'collection', match: { value: 'b' } },
          ],
        },
      ],
    })
  })

  test('empty array → ignored (no condition)', () => {
    expect(toFilter({ collection: [] })).toBeUndefined()
  })
})
