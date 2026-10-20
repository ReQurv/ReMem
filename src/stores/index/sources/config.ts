import { z } from 'zod'

/**
 * Configuration for an index FileSource (M4/M4b). One of: local, s3 (or MinIO),
 * webdav (Nextcloud/ownCloud).
 */
export const IndexSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    id: z.string(),
    root: z.string(),
  }),
  z.object({
    kind: z.literal('s3'),
    id: z.string(),
    bucket: z.string(),
    prefix: z.string().default(''),
    region: z.string(),
    accessKey: z.string().optional(),
    secretKey: z.string().optional(),
    endpoint: z.string().optional(),
    forcePathStyle: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('webdav'),
    id: z.string(),
    url: z.string(),
    user: z.string(),
    password: z.string(),
    prefix: z.string().default(''),
  }),
])

export type IndexSourceConfig = z.infer<typeof IndexSourceSchema>
