# ReMem

Decisional memory for AI agents, in TypeScript.

One **entry point** — `store()` — and one **exit point** — `recall()`. In between
sits a **System-1 router** that decides, in a fast typed pass, *where to write* and
*where to read* across three internal stores:

| Store | Backend | Purpose |
|-------|---------|---------|
| `vector` | Qdrant (remote REST) | Embeddings for semantic memory / lookup |
| `graph` | Neo4j | Knowledge graph, populated by LLM entity/relation extraction |
| `index` | Qdrant (separate collection) | File/folder index with short LLM descriptions — local, S3/MinIO, Nextcloud/WebDAV |

The agent only ever sees two methods. The router routes; the stores execute. Every
subsystem call degrades gracefully: one store down yields a `degraded` result, never
an exception.

## Install

```bash
bun add @requrv/remem    # or: npm i @requrv/remem
```

Requires a reachable **Qdrant** and **Neo4j** (local, Podman/Docker, or remote).

## Quick start

```ts
import { ReMem } from '@requrv/remem'

const mem = new ReMem({
  vector: { url: 'http://localhost:6333' },
  graph: { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'changeit' },
  embedder: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  chat: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
})
await mem.connect()

// One entry point — the router decides where (vector, graph, …).
await mem.store({ content: 'Marco collabora con Lucia sul progetto Remem' })

// One exit point — the router picks the stores; each answers or degrades.
const ctx = await mem.recall('chi collabora con Marco?')
console.log(ctx.toPrompt())   // compact, context-ready block for your agent

await mem.close()
```

### From environment

`loadConfigFromEnv()` builds the config from `.env` — it picks **OpenAI when
`OPENAI_API_KEY` is set, otherwise local Ollama**:

```ts
import { createReMem, loadConfigFromEnv } from '@requrv/remem'

const mem = createReMem(loadConfigFromEnv())
```

Key variables (see `.env.example`): `QDRANT_URL`, `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`,
`OPENAI_API_KEY` / `OPENAI_BASE_URL` (any OpenAI-compatible endpoint),
`OLLAMA_BASE_URL`, optional `ROUTER`, `TENANT`, `EMBEDDING_DIMENSIONS`.

### Local Ollama

```ts
const mem = new ReMem({
  vector: { url: 'http://localhost:6333' },
  graph: { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'changeit' },
  embedder: { provider: 'ollama', model: 'nomic-embed-text' },
  chat: { provider: 'ollama', model: 'llama3.1' },
})
```

## The router

`routeWrite` picks a subset of `{ vector, graph }` (the index is **never** a write
target); `routeRead` picks a subset of `{ vector, graph, index }`.

- **`heuristic`** (default) — rule-based, fast, free, deterministic: relational
  content goes to the graph, file/path-like queries go to the index, vector always.
- **`llm`** — your `ChatModel` answers a routing question; any failure falls back
  to the heuristic, it never throws.
- **`laya`** — the same decision is delegated to an external **Laya** runtime over
  HTTP (`laya.endpoint`, `threshold`, `timeoutMs`); same fail-safe fallback.

Choose it in the config (`router: 'heuristic' | 'llm' | 'laya'`), or inject your
own implementation:

```ts
const mem = new ReMem({ ...config, router: 'llm' })
const mem = new ReMem(config, { router: myRouter })   // custom Router
```

`Router` is a small async interface (`routeWrite`, `routeRead` → `Promise<RouteDecision>`).

## Multi-collection

Memories live in **logical collections** (not physical ones). Tag at write, filter
at read — a multi-collection query is a single Qdrant OR filter:

```ts
await mem.store({ content: '…', collection: 'project-a' })   // default: 'default'
await mem.recall('query', { collections: 'project-a' })        // one
await mem.recall('query', { collections: ['a', 'b'] })         // many (OR)
await mem.recall('query')                                       // all collections
```

## Multi-tenant

Set `tenant` in the config — **one `ReMem` instance = one tenant** — and all data
(memories, index, graph) is scoped to it, enforced at query time (no per-call
tenant argument, no way to address another tenant):

```ts
const tenantA = new ReMem({ ...config, tenant: 'acme' })
const tenantB = new ReMem({ ...config, tenant: 'globex' })
// same Qdrant + Neo4j, zero cross-tenant visibility
```

Isolation is payload-based (vector/index) plus entity-id namespacing (graph).
Note: enabling a tenant on pre-existing data makes unscoped points invisible —
treat it as a fresh namespace.

## Index List

The index turns **file/folder trees into a compact map** your agent can read: each
entry gets a short LLM description (dirs from their children's names, files from a
text preview). Update is **explicit only** — `store()` never touches the index:

```ts
const mem = new ReMem({
  ...config,
  index: {
    describeFiles: true,   // default: dirs only
    sources: [
      { kind: 'local', id: 'repo', root: '/path/to/project' },
      { kind: 's3', id: 'docs', bucket: 'my-bucket', prefix: 'docs/', region: 'eu-west-1' },
      { kind: 'webdav', id: 'nc', url: 'https://cloud.example.com/remote.php/dav/files/u', user: 'u', password: 'p', prefix: 'Docs' },
    ],
  },
})
const map = await mem.index()          // scan + diff + describe (incremental, cached)
await mem.index({ only: ['repo'] })    // or a single source
```

`recall()` with an index-relevant query returns the matching entries; `toPrompt()`
renders the map. Rescans are incremental (ETag/mtime|size aware) with per-source
orphan cleanup — unchanged files are not re-described.

## API reference

```ts
new ReMem(config: ReMemConfig, opts?: { router?: Router; logger?: Logger })

await mem.connect()                  // idempotent bootstrap (collections + schema)
await mem.store({ content, source?, collection?, metadata? })  // → { id, writtenTo }
await mem.recall(query, opts?)       // → Recall
  // opts: { limit?, only?: Subsystem[], collections?: string | string[] }
await mem.index(opts?)               // → IndexMap   (opts: { only?: sourceId[] })
await mem.close()
```

`Recall` — `{ memories, graph?, index?, sources, degraded?, toPrompt() }`:
`toPrompt()` renders a compact block (`## Memory` / `## Knowledge` / `## Index`)
ready to inject into your agent's context; degrades are annotated, empty sections
read `(no results)`.

Also exported: `createReMem`, `loadConfigFromEnv`, `ReMemConfigSchema`,
`HeuristicRouter`, error hierarchy (`ReMemError`, `ConfigError`, `ConnectionError`, …),
`noopLogger`/`consoleLogger`, and the domain types (`Subsystem`, `StoreInput`,
`RecallOptions`, `Recall`, `Router`, `RouteDecision`, …).

## Cost model

The default router is **free** (no LLM calls). LLM usage comes only from:
knowledge-graph extraction on `store()`, index descriptions on `index()`, and — if
you enable it — the `llm` router.

## Usage modes

| Mode | For | How | License |
|------|-----|-----|---------|
| **Library** | Developers wiring memory into their own agent/framework | `bun add @requrv/remem` → `store()` / `recall()` in your code | GPL-3.0 (or commercial) |
| **MCP stdio** | Local agents (OpenCode, Claude Code, …) | declare the `remem-mcp` bin in the agent config; the agent spawns it per session | GPL-3.0 (or commercial) |
| **MCP HTTP (enterprise)** | Companies: one hosted service, one tenant per user + a shared company tenant | `docker compose` (Qdrant + Neo4j + `remem-mcp`) | commercial license for production use — [licensing@requrv.io](mailto:licensing@requrv.io) |

## MCP server

ReMem ships two MCP servers exposing four tools — `mem_remember`, `mem_recall`,
`mem_index`, `mem_status` — so an agent decides *by itself* when to remember
and when to retrieve.

### stdio (personal / single-tenant)

The agent spawns the server; one process = one tenant (`TENANT` env, optional).
Same env config as the library (`.env.example`). **OpenCode**
(`opencode.json`):

```jsonc
{
  "mcp": {
    "remem": {
      "type": "local",
      "command": ["npx", "-y", "-p", "@requrv/remem", "remem-mcp"],
      "environment": {
        "QDRANT_URL": "http://localhost:6333",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "changeit",
        "OPENAI_API_KEY": "sk-…"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add remem --env QDRANT_URL=http://localhost:6333 --env OPENAI_API_KEY=… \
  -- npx -y -p @requrv/remem remem-mcp
```

### HTTP (enterprise / multi-tenant)

One service, one API key per user. Each recall **fuses personal memory with
company memory** (labeled sections); writes go to the user's own tenant, and
`scope: "company"` requires the `admin` role.

```bash
cd deploy && cp .env.example .env   # fill OPENAI_API_KEY + MCP_USERS (one entry per user)
docker compose -f compose.yaml up -d
```

Agents then point at `http://<host>:3100/mcp` with their bearer key
(`Authorization: Bearer <key>`). `GET /healthz` is the liveness probe.
The HTTP server requires **Bun** (included in the Docker image; for manual
runs: `bun remem-mcp-http`).

Single machine? The repo-root `docker-compose.yaml` runs this same
`remem-mcp` server together with the backends in one command — see
[Self-hosting](#self-hosting).

## Self-hosting

One command starts the whole stack — Qdrant + Neo4j + the `remem-mcp` HTTP
server — with persistent volumes:

```bash
cp .env.example .env     # fill OPENAI_API_KEY; edit MCP_USERS for >1 user
docker compose up -d
```

- **LLM**: an OpenAI-compatible key (`OPENAI_API_KEY`, default base URL is
  AI Hive) — or 100% local with Ollama (`EMBEDDER_PROVIDER=ollama`,
  `CHAT_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://host.docker.internal:11434`):
  no content leaves your network.
- **Connect**: agents point at `http://localhost:3100/mcp` with
  `Authorization: Bearer <key>` (the key is in `MCP_USERS`, `rk-local` by
  default); `GET /healthz` is the liveness probe.
- **Teams**: for multi-user deployments on a shared host, see the enterprise
  stack in `deploy/` — same services, team-oriented `MCP_USERS`.
- **Library**: wire ReMem into your own agent (Quick start above) — it talks
  to the same Qdrant/Neo4j, also reachable on `localhost` while this stack
  runs.

## Production & Enterprise

For company deployments (hosted multi-tenant service, production use in
commercial products, support): ReMem is **dual-licensed** (GPL-3.0 only or
[ReQurv Commercial License](./LICENSE-COMMERCIAL.md)) — contact
[licensing@requrv.io](mailto:licensing@requrv.io).

## Development

```bash
bun install
bun run infra:up            # backends only: Qdrant (6333) + Neo4j (7474/7687)
cp .env.example .env        # then fill in your keys

bun run typecheck
bun test                    # unit + integration (integration self-skips without infra)
bun run build               # ESM + CJS + .d.ts → dist/
bun run dev                 # examples/basic.ts
```

Examples in `examples/`: `basic.ts`, `recall-index.ts`, `index-remote.ts`,
`custom-router.ts`.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for
development setup, code conventions and the architecture.

- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security policy](./SECURITY.md)

## License

Dual-licensed: **GPL-3.0-only** or the **ReQurv Commercial License** (production/
commercial use — contact [licensing@requrv.io](mailto:licensing@requrv.io)).
See [LICENSE](./LICENSE) and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).
