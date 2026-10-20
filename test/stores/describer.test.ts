import { describe, expect, test } from 'bun:test'

import { createDescriber } from '../../src/stores/index/describer'
import type { ChatMessage, ChatModel } from '../../src/providers/chat/types'
import type { FileEntry } from '../../src/stores/index/types'

function dir(path: string): FileEntry {
  return { path, source: path.split('/')[0], type: 'dir', hash: 'h' }
}
function file(source: string, key: string, ext?: string): FileEntry {
  const path = `${source}/${key}`
  return { path, source, type: 'file', ext, hash: 'h' }
}

describe('describer (unit, mocked ChatModel + readPreview)', () => {
  test('describes dirs in a batch and returns path→desc map', async () => {
    const entries = [dir('local/docs'), dir('local/src')]
    const calls: ChatMessage[][] = []
    const chat: ChatModel = {
      complete: async (m) => {
        calls.push(m)
        return JSON.stringify({ 'local/docs': 'documentazione', 'local/src': 'codice' })
      },
    }
    const d = createDescriber(chat, async () => null)
    const out = await d.describe(entries)
    expect(out.get('local/docs')).toBe('documentazione')
    expect(out.get('local/src')).toBe('codice')
    expect(calls).toHaveLength(1) // single batch
  })

  test('sends children names for dirs in the prompt', async () => {
    const entries = [dir('local/docs'), file('local', 'docs/guide.md', 'md')]
    let userMsg = ''
    const chat: ChatModel = {
      complete: async (m) => {
        userMsg = m.find((x) => x.role === 'user')?.content ?? ''
        return '{"local/docs":"guide"}'
      },
    }
    const d = createDescriber(chat, async () => null)
    await d.describe(entries)
    expect(userMsg).toContain('local/docs [dir]')
    expect(userMsg).toContain('guide.md')
  })

  test('cache hits skip the LLM', async () => {
    let calls = 0
    const chat: ChatModel = {
      complete: async () => {
        calls += 1
        return '{}'
      },
    }
    const d = createDescriber(chat, async () => null)
    const cache = new Map([['local/docs', 'cached']])
    const out = await d.describe([dir('local/docs'), dir('local/src')], { cache })
    expect(out.get('local/docs')).toBe('cached')
    expect(out.get('local/src')).toBeUndefined() // LLM returned empty
    expect(calls).toBe(1) // only the uncached dir went to the LLM
  })

  test('invalid JSON → missing descriptions, no throw', async () => {
    const chat: ChatModel = { complete: async () => 'sorry, I cannot do that' }
    const d = createDescriber(chat, async () => null)
    const out = await d.describe([dir('local/docs')])
    expect(out.size).toBe(0)
  })

  test('describeFiles=false: files are not described (no LLM for them)', async () => {
    const entries = [dir('local/docs'), file('local', 'docs/a.md', 'md')]
    const chat: ChatModel = { complete: async () => '{"local/docs":"doc"}' }
    const d = createDescriber(chat, async () => null, { describeFiles: false })
    const out = await d.describe(entries)
    expect(out.get('local/docs')).toBe('doc')
    expect(out.has('local/docs/a.md')).toBe(false)
  })

  test('describeFiles=true: preview is included in the prompt', async () => {
    const entries = [file('local', 'notes.txt', 'txt')]
    let userMsg = ''
    const chat: ChatModel = {
      complete: async (m) => {
        userMsg = m.find((x) => x.role === 'user')?.content ?? ''
        return '{"local/notes.txt":"note personali"}'
      },
    }
    const readPreview = async (key: string) => (key === 'notes.txt' ? 'content note' : null)
    const d = createDescriber(chat, readPreview, { describeFiles: true })
    const out = await d.describe(entries)
    expect(out.get('local/notes.txt')).toBe('note personali')
    expect(userMsg).toContain('content note')
  })

  test('readPreview failure degrades to name-only (no throw)', async () => {
    const entries = [file('local', 'broken.txt', 'txt')]
    const chat: ChatModel = { complete: async () => '{"local/broken.txt":"x"}' }
    const readPreview = async () => {
      throw new Error('network down')
    }
    const d = createDescriber(chat, readPreview, { describeFiles: true })
    const out = await d.describe(entries)
    expect(out.get('local/broken.txt')).toBe('x')
  })

  test('honours batchSize (multiple calls)', async () => {
    const entries = [dir('local/a'), dir('local/b'), dir('local/c')]
    let calls = 0
    const chat: ChatModel = {
      complete: async () => {
        calls += 1
        return '{}'
      },
    }
    const d = createDescriber(chat, async () => null, { batchSize: 2 })
    await d.describe(entries)
    expect(calls).toBe(2)
  })
})
