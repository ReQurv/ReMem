# ReMem

Decisional memory for AI agents, in TypeScript (built with Bun).

One **entry point** — `store()` — and one **exit point** — `recall()`. A System-1
**router** decides *where to write* and *where to read* across three internal stores:

| Store | Backend | Purpose |
|-------|---------|---------|
| `vector` | Qdrant (remote REST) | Embeddings for semantic memory / lookup |
| `graph`  | Neo4j | Knowledge graph, populated by LLM entity/relation extraction |
| `index`  | Qdrant (index collection) | File/folder index with short LLM descriptions (local, S3/MinIO, Nextcloud/WebDAV) |

> **Status:** early scaffold (M0). The public API is being built module by module.

## Development

```bash
bun install          # install dependencies
bun run typecheck    # tsc --noEmit
bun test             # unit tests
bun run build        # bun build (ESM+CJS) + tsc (.d.ts) → dist/

# Local infrastructure for integration tests (Podman)
bun run infra:up     # podman compose up -d  (Qdrant + Neo4j)
bun run infra:down
```

Copy `.env.example` to `.env` and fill in the values you need.

## License

MIT — see [LICENSE](./LICENSE).
