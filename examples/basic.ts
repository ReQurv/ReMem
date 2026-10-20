/**
 * @requrv/remem — minimal example (ESM, top-level await).
 *
 * Requirements: Qdrant + Neo4j running (`podman compose up -d`) and a provider
 * configured via env (see .env.example). Run: `bun run dev`.
 */
import { createReMem, loadConfigFromEnv } from '../src/index'

const mem = createReMem(loadConfigFromEnv())
await mem.connect()

// Store: one entry point. The router decides where (vector, graph, …).
const res = await mem.store({
  content: 'Marco collabora con Lucia sul progetto Remem',
  source: 'example',
})
console.log('stored →', res)

// Recall: one exit point. The router picks the stores; each answers or degrades.
const r = await mem.recall('chi collabora con Marco?')
console.log(r.toPrompt())
console.log('sources:', r.sources, '| degraded:', r.degraded ?? [])

// Index maintenance is explicit-only (scan + describe the configured sources).
// const map = await mem.index()
// console.log(map.toPrompt())

await mem.close()
