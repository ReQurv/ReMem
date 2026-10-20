import { describe, expect, test } from 'bun:test'

import { createExtractor } from '../../src/stores/graph/extractor'
import type { ChatMessage, ChatModel } from '../../src/providers/chat/types'

const VALID = JSON.stringify({
  entities: [
    { id: 'ada', label: 'Person', name: 'Ada Lovelace' },
    { id: 'babbage', label: 'Person', name: 'Charles Babbage' },
  ],
  relations: [{ from: 'ada', to: 'babbage', type: 'collaborated_with' }],
})

function makeChat(overrides: Partial<ChatModel> = {}): ChatModel {
  return {
    complete: async (_m: ChatMessage[]) => VALID,
    ...overrides,
  }
}

describe('extractor (unit, mocked ChatModel)', () => {
  test('parses valid JSON from complete()', async () => {
    const ex = createExtractor(makeChat())
    const out = await ex.extract('Ada and Babbage worked together.')
    expect(out.entities).toHaveLength(2)
    expect(out.entities[0]).toMatchObject({ id: 'ada', label: 'Person', name: 'Ada Lovelace' })
    expect(out.relations).toHaveLength(1)
    expect(out.relations[0]).toEqual({ from: 'ada', to: 'babbage', type: 'COLLABORATED_WITH' })
  })

  test('strips code fences', async () => {
    const ex = createExtractor(makeChat({ complete: async () => `Sure!\n\`\`\`json\n${VALID}\n\`\`\`` }))
    const out = await ex.extract('x')
    expect(out.entities).toHaveLength(2)
  })

  test('invalid JSON → empty result (no throw)', async () => {
    const ex = createExtractor(makeChat({ complete: async () => 'I cannot do that.' }))
    await expect(ex.extract('x')).resolves.toEqual({ entities: [], relations: [] })
  })

  test('invalid JSON shape → empty result (no throw)', async () => {
    const ex = createExtractor(makeChat({ complete: async () => '{"entities":"oops"}' }))
    await expect(ex.extract('x')).resolves.toEqual({ entities: [], relations: [] })
  })

  test('prefers completeJson when available', async () => {
    let jsonCalls = 0
    let plainCalls = 0
    const chat: ChatModel = {
      complete: async () => {
        plainCalls += 1
        return VALID
      },
      completeJson: async () => {
        jsonCalls += 1
        return VALID
      },
    }
    const out = await createExtractor(chat).extract('x')
    expect(jsonCalls).toBe(1)
    expect(plainCalls).toBe(0)
    expect(out.entities).toHaveLength(2)
  })

  test('falls back to complete() when completeJson fails', async () => {
    const chat: ChatModel = {
      complete: async () => VALID,
      completeJson: async () => {
        throw new Error('provider does not support json mode')
      },
    }
    const out = await createExtractor(chat).extract('x')
    expect(out.entities).toHaveLength(2)
  })

  test('discards orphan relations', async () => {
    const json = JSON.stringify({
      entities: [{ id: 'ada', label: 'Person', name: 'Ada' }],
      relations: [
        { from: 'ada', to: 'ghost', type: 'LINKED_TO' },
        { from: 'ada', to: 'ada', type: 'SELF' },
      ],
    })
    const ex = createExtractor(makeChat({ complete: async () => json }))
    const out = await ex.extract('x')
    expect(out.entities).toHaveLength(1)
    expect(out.relations).toHaveLength(1)
    expect(out.relations[0]).toMatchObject({ from: 'ada', to: 'ada' })
  })

  test('honours maxEntities', async () => {
    const json = JSON.stringify({
      entities: [1, 2, 3].map((i) => ({ id: `e${i}`, label: 'Person', name: `E${i}` })),
      relations: [],
    })
    const ex = createExtractor(makeChat({ complete: async () => json }))
    const out = await ex.extract('x', { maxEntities: 2 })
    expect(out.entities).toHaveLength(2)
  })

  test('sanitizes ids, labels and types', async () => {
    const json = JSON.stringify({
      entities: [{ id: '  Ada! ', label: 'Person X', name: 'Ada' }],
      relations: [],
    })
    const ex = createExtractor(makeChat({ complete: async () => json }))
    const out = await ex.extract('x')
    expect(out.entities[0]).toMatchObject({ id: 'ada', label: 'Person_X' })
  })

  test('deduplicates entities by sanitized id', async () => {
    const json = JSON.stringify({
      entities: [
        { id: 'ada', label: 'Person', name: 'Ada' },
        { id: 'Ada', label: 'Person', name: 'Ada' },
      ],
      relations: [],
    })
    const ex = createExtractor(makeChat({ complete: async () => json }))
    const out = await ex.extract('x')
    expect(out.entities).toHaveLength(1)
  })
})
