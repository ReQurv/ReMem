/**
 * Remote sources example: one index view across S3/MinIO and Nextcloud (WebDAV),
 * plus an optional local source. `mem.index()` iterates every configured source.
 *
 * Fill S3_* / WEBDAV_* in `.env` (see .env.example). Run:
 *   bun examples/index-remote.ts
 */
import { createReMem, loadConfigFromEnv, type IndexSourceConfig } from '../src/index'

const config = loadConfigFromEnv()

const sources: IndexSourceConfig[] = []

if (process.env.S3_BUCKET) {
  sources.push({
    kind: 's3',
    id: 's3',
    bucket: process.env.S3_BUCKET,
    prefix: process.env.S3_PREFIX ?? '',
    region: process.env.S3_REGION ?? 'eu-west-1',
    accessKey: process.env.S3_ACCESS_KEY || undefined,
    secretKey: process.env.S3_SECRET_KEY || undefined,
    endpoint: process.env.S3_ENDPOINT || undefined,
    // MinIO needs path-style addressing:
    // forcePathStyle: !!process.env.S3_ENDPOINT,
  })
}

if (process.env.WEBDAV_URL && process.env.WEBDAV_USER) {
  sources.push({
    kind: 'webdav',
    id: 'webdav',
    url: process.env.WEBDAV_URL,
    user: process.env.WEBDAV_USER,
    password: process.env.WEBDAV_PASSWORD ?? '',
    prefix: process.env.WEBDAV_PREFIX ?? '',
  })
}

if (sources.length === 0) {
  console.error('No S3_* / WEBDAV_* env set — nothing to index. See .env.example.')
  process.exit(1)
}

config.index.sources.push(...sources)

const mem = createReMem(config)
await mem.connect()

const map = await mem.index()
console.log(map.toPrompt())

const r = await mem.recall('che contenuti ci sono sul bucket?')
console.log('\nrecall:', r.toPrompt())

await mem.close()
