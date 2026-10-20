import { z } from 'zod'

import { ConfigError } from './errors'
import { IndexSourceSchema } from './stores/index/sources/config'

/**
 * ReMem configuration, validated with zod. Providers (`embedder`, `chat`) and the
 * `index.sources` are discriminated unions. A `logger` is passed at runtime via
 * the constructor (not part of the schema).
 */
export const ReMemConfigSchema = z.object({
  vector: z.object({
    url: z.string().url().default('http://localhost:6333'),
    apiKey: z.string().optional(),
    memoryCollection: z.string().default('remem_memories'),
    indexCollection: z.string().default('remem_index'),
  }).default({}),
  graph: z.object({
    uri: z.string().default('bolt://localhost:7687'),
    username: z.string().default('neo4j'),
    password: z.string().default('changeit'),
    database: z.string().default('neo4j'),
  }).default({}),
  embedder: z.discriminatedUnion('provider', [
    z.object({
      provider: z.literal('openai'),
      apiKey: z.string(),
      /** Any OpenAI-compatible endpoint. */
      baseUrl: z.string().url().default('https://hive.requrv.ai/api/v1'),
      model: z.string().default('text-embedding-3-small'),
      dimensions: z.number().optional(),
    }),
    z.object({
      provider: z.literal('ollama'),
      baseUrl: z.string().default('http://localhost:11434'),
      model: z.string().default('nomic-embed-text'),
      dimensions: z.number().default(768),
    }),
  ]),
  chat: z.discriminatedUnion('provider', [
    z.object({
      provider: z.literal('openai'),
      apiKey: z.string(),
      /** Any OpenAI-compatible endpoint. */
      baseUrl: z.string().url().default('https://hive.requrv.ai/api/v1'),
      model: z.string().default('gpt-4o-mini'),
    }),
    z.object({
      provider: z.literal('ollama'),
      baseUrl: z.string().default('http://localhost:11434'),
      model: z.string().default('llama3.1'),
    }),
  ]),
  /**
   * Tenant: when set, all data (memories, index, graph) is scoped to it.
   * One ReMem instance = one tenant. Omitted → single-tenant mode.
   */
  tenant: z.string().min(1).optional(),
  /** 'heuristic' (default) | 'llm' | 'laya'. */
  router: z.enum(['heuristic', 'llm', 'laya']).default('heuristic'),
  /** Used only when `router === 'laya'`. */
  laya: z
    .object({
      endpoint: z.string().url(),
      checkpoint: z.string().optional(),
      threshold: z.number().min(0).max(1).default(0.5),
      timeoutMs: z.number().default(800),
      headers: z.record(z.string()).optional(),
    })
    .optional(),
  index: z.object({
    sources: z.array(IndexSourceSchema).default([]),
    ignore: z.array(z.string()).default(['.git', 'node_modules', 'dist']),
    describeFiles: z.boolean().default(false),
    maxEntries: z.number().default(2000),
  }).default({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type ReMemConfig = z.infer<typeof ReMemConfigSchema>

type Provider = 'openai' | 'ollama'

function pickProvider(explicit: string | undefined, env: NodeJS.ProcessEnv): Provider {
  if (explicit === 'openai' || explicit === 'ollama') return explicit
  // Default: OpenAI when a key is present, otherwise local Ollama.
  return (env.OPENAI_API_KEY ?? '').trim().length > 0 ? 'openai' : 'ollama'
}

function describeError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/**
 * Build a config from environment variables (`.env`).
 * - `EMBEDDER_PROVIDER` / `CHAT_PROVIDER` optionally force a provider.
 * - Defaults to OpenAI when `OPENAI_API_KEY` is set, else Ollama.
 * - Throws `ConfigError` when the schema is not satisfied (e.g. OpenAI chosen
 *   but no API key).
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReMemConfig {
  const ollamaBase = env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  const embedderProvider = pickProvider(env.EMBEDDER_PROVIDER, env)
  const chatProvider = pickProvider(env.CHAT_PROVIDER, env)

  const routerEnv = env.ROUTER?.trim()
  const tenantEnv = env.TENANT?.trim()
  const partial: Record<string, unknown> = {
    ...(tenantEnv ? { tenant: tenantEnv } : {}),
    ...(routerEnv ? { router: routerEnv } : {}),
    ...(env.LAYA_ENDPOINT
      ? {
          laya: {
            endpoint: env.LAYA_ENDPOINT,
            checkpoint: env.LAYA_CHECKPOINT || undefined,
            threshold: env.LAYA_THRESHOLD ? Number(env.LAYA_THRESHOLD) : undefined,
            timeoutMs: env.LAYA_TIMEOUT_MS ? Number(env.LAYA_TIMEOUT_MS) : undefined,
          },
        }
      : {}),
    vector: {
      url: env.QDRANT_URL ?? 'http://localhost:6333',
      apiKey: env.QDRANT_API_KEY || undefined,
    },
    graph: {
      uri: env.NEO4J_URI ?? 'bolt://localhost:7687',
      username: env.NEO4J_USER ?? 'neo4j',
      password: env.NEO4J_PASSWORD ?? 'changeit',
    },
    embedder:
      embedderProvider === 'openai'
        ? {
            provider: 'openai',
            apiKey: env.OPENAI_API_KEY,
            baseUrl: env.OPENAI_BASE_URL,
            model: env.OPENAI_EMBED_MODEL,
            dimensions: env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined,
          }
        : { provider: 'ollama', baseUrl: ollamaBase, model: env.OLLAMA_EMBED_MODEL },
    chat:
      chatProvider === 'openai'
        ? { provider: 'openai', apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, model: env.OPENAI_CHAT_MODEL }
        : { provider: 'ollama', baseUrl: ollamaBase, model: env.OLLAMA_CHAT_MODEL },
  }

  const parsed = ReMemConfigSchema.safeParse(partial)
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${describeError(parsed.error)}`)
  }
  return parsed.data
}
