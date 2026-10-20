/**
 * Index List example: point the index at a local folder, run `mem.index()`,
 * then recall an index-relevant query and print the rendered prompt block.
 *
 * Requirements: Qdrant + Neo4j up (`bun run infra:up`), provider in `.env`.
 * Run: `bun examples/recall-index.ts`
 */
import { createReMem, loadConfigFromEnv } from '../src/index'

const config = loadConfigFromEnv()

// Add a local source (point INDEX_LOCAL_ROOT at any folder you want indexed).
config.index.sources.push({
  kind: 'local',
  id: 'local',
  root: process.env.INDEX_LOCAL_ROOT ?? new URL('..', import.meta.url).pathname,
})
config.index.describeFiles = true

const mem = createReMem(config)
await mem.connect()

// Explicit-only maintenance: scan + incremental diff + LLM descriptions.
const map = await mem.index()
console.log('index map:')
console.log(map.toPrompt())

// The router routes file/path-like queries to the index.
const r = await mem.recall('dove sta la documentazione?')
console.log('\nrecall:')
console.log(r.toPrompt())
console.log('sources:', r.sources, '| degraded:', r.degraded ?? [])

await mem.close()
