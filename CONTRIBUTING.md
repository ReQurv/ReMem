# Contributing to ReMem

Thanks for your interest in ReMem! It is decisional memory for AI agents, in
TypeScript: one entry point (`store()`) and one exit point (`recall()`), with a
fast **System-1 router** that decides where to write and where to read across
three stores — **vector** (Qdrant), **graph** (Neo4j) and **index** (file/folder
map on Qdrant).

The rule that shapes every contribution: **subsystem calls degrade, they never
throw**. One store down yields a `degraded` recall, not an exception.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (Node ≥ 18 to *consume* the published library)
- [Podman](https://podman.io) or Docker — for the local Qdrant + Neo4j
  infrastructure (`docker-compose.yaml`)

### Setup

```bash
git clone https://github.com/ReQurv/ReMem.git
cd remem
bun install
bun run infra:up       # podman compose up -d → Qdrant (:6333) + Neo4j (:7474/:7687)
cp .env.example .env   # then fill in your keys
```

### Verify your environment

```bash
bun run typecheck
bun run lint
bun test               # unit + integration (integration self-skips without infra)
```

All three must pass before opening a pull request (they also run in CI, with
real Qdrant and Neo4j services). With infra up, `bun test:integration` runs
the backend-touching tests explicitly.

## Code conventions

- **TypeScript strict** — the public API is fully typed; new types belong in
  the `types.ts` of the module they describe.
- **Styling follows the surrounding code**: 2-space indent, single quotes, no
  semicolons. `bun run lint` (ESLint flat config: `@eslint/js` +
  `typescript-eslint` recommended) is the source of truth.
- **Error handling is layered**: throw only the existing hierarchy
  (`ReMemError` → `ConfigError`, `ConnectionError`, …) from `src/errors.ts`.
  Anything that can degrade at the `recall()` boundary must degrade instead
  (catch, record in `sources`/`degraded`, keep going).
- **The index is never a write target of `store()`** — index updates are
  explicit (`mem.index()` only). Preserve this invariant.
- **Multi-tenancy is payload/envelope-scoped**: tenant is fixed per `ReMem`
  instance and enforced at query time. Never accept a per-call tenant
  argument or a way to address another tenant.
- **No version bumps**: contributors do not touch the `version` in
  `package.json`; maintainers do it at release time.
- **Tests**: Bun tests in `test/`, mirroring the `src/` layout
  (`test/router/`, `test/stores/`, `test/providers/`, `test/integration/`).
  Add unit tests for new logic; integration tests must self-skip cleanly
  when the backends are not running.

## Architecture

```
src/core/        # ReMem facade: connect(), store(), recall(), index(), close()
src/router/      # System-1 routing: HeuristicRouter (default), LLMRouter, LayaRouter
src/stores/      # the three backends:
  vector/        #   QdrantVectorStore — embeddings for semantic lookup
  graph/         #   Neo4jGraphStore — LLM entity/relation extraction
  index/         #   file/folder map: scanners (local, S3, WebDAV), describer, diff
src/providers/   # embedder and chat models: OpenAI + Ollama
src/config.ts    # ReMemConfigSchema (zod) + loadConfigFromEnv()
src/errors.ts    # ReMemError hierarchy
```

Data flow: `store()` → `routeWrite()` → `{ vector?, graph? }`; `recall()` →
`routeRead()` → `{ vector?, graph?, index? }` → each store answers or degrades
→ `Recall.toPrompt()`.

The `Router` is a small async interface (`routeWrite`/`routeRead` →
`RouteDecision`); new routers are additive — implement it, inject via the
second `ReMem` argument or the `router` config field, and keep the heuristic
fallback for failure paths (as `LLMRouter` and `LayaRouter` do).

## Pull requests

- Fork and branch from `main` (e.g. `feat/azure-embedder`)
- Small, focused PRs; one feature or one fix each
- All CI checks must pass: `bun run typecheck`, `bun run lint`, `bun test`,
  `bun run build`
- No version bumps, no `package.json` metadata changes
- Update `README.md` in the same PR when the public API, config surface or
  environment variables change

## Releasing (maintainers)

1. Bump `version` in `package.json`
2. `bun run prepublishOnly` (typecheck + tests + build), then publish
   `@requrv/remem` to npm
