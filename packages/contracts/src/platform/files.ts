import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * Files DTOs — API_CONTRACT §2 (`POST /files/presign`), DATABASE_DESIGN §4 (`files`).
 *
 * The upload is a three-step flow (TARGET_ARCHITECTURE §8: "S3 pre-signed upload →
 * `files` row → entity attach"):
 *
 * 1. `POST /files/presign`      → a `files` row in `pending` + a pre-signed PUT URL
 * 2. client `PUT`s the bytes straight to object storage (never through the API)
 * 3. `POST /files/{id}/finalize` → the row flips to `ready` and may attach to an entity
 *
 * Write schemas are `.strict()` (SECURITY_ARCHITECTURE §6, mass-assignment defence).
 */

export const fileStatusSchema = z.enum(['pending', 'ready', 'deleted']);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/**
 * Object-storage keys are derived from this name, so anything that could escape the
 * tenant prefix (`/`, `\`, `..`, control characters) is rejected rather than sanitised.
 */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  .refine((value) => !/[/\\\u0000-\u001f]/.test(value), {
    message: 'name must not contain path separators or control characters',
  })
  .refine((value) => value !== '.' && value !== '..' && !value.includes('..'), {
    message: 'name must not contain a parent-directory segment',
  });

export const filePresignSchema = z
  .object({
    name: fileNameSchema,
    mime: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'mime must be a media type'),
    /** Byte length of the object. Checked against `FILES_MAX_UPLOAD_BYTES`. */
    sizeBytes: z.number().int().positive(),
    entity: z.string().trim().min(1).max(80).optional(),
    entityId: uuidSchema.optional(),
  })
  .strict();

export type FilePresignRequest = z.infer<typeof filePresignSchema>;

export const fileFinalizeSchema = z
  .object({
    /** Hex or base64 digest reported by the client; stored verbatim for reconciliation. */
    checksum: z.string().trim().min(8).max(200).optional(),
    entity: z.string().trim().min(1).max(80).optional(),
    entityId: uuidSchema.optional(),
  })
  .strict();

export type FileFinalizeRequest = z.infer<typeof fileFinalizeSchema>;

export const fileDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  bucket: z.string(),
  objectKey: z.string(),
  checksum: z.string().nullable(),
  status: fileStatusSchema,
  entity: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  uploadedBy: uuidSchema.nullable(),
  createdAt: z.string(),
});

export type FileDto = z.infer<typeof fileDtoSchema>;

export const filePresignResponseSchema = z.object({
  fileId: uuidSchema,
  uploadUrl: z.string(),
  objectKey: z.string(),
  /** Header the client MUST send with the PUT, or the signature will not match. */
  requiredHeaders: z.record(z.string()),
  expiresAt: z.string(),
});

export type FilePresignResponse = z.infer<typeof filePresignResponseSchema>;

export const fileDownloadResponseSchema = z.object({
  fileId: uuidSchema,
  name: z.string(),
  /** App-signed, short-lived URL served by the API (no bearer token required). */
  url: z.string(),
  expiresAt: z.string(),
});

export type FileDownloadResponse = z.infer<typeof fileDownloadResponseSchema>;

export const FILE_FILTERS = ['status', 'entity', 'entityId'] as const;
export const FILE_SORT_COLUMNS = ['createdAt', 'name', 'sizeBytes'] as const;

export const fileListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export type FileListQueryDto = z.infer<typeof fileListQuerySchema>;

/**
 * Query string of the app-signed download URL (`GET /files/{id}/content`).
 *
 * `tenant` is not a secret and not an authority: it is part of the signed payload, so a
 * caller who edits it invalidates the signature. It travels in the URL because the route
 * is unauthenticated — there is no token to read the tenant from.
 */
export const fileContentQuerySchema = z.object({
  tenant: uuidSchema,
  expires: z.coerce.number().int().positive(),
  signature: z.string().trim().min(16).max(200),
});

export type FileContentQuery = z.infer<typeof fileContentQuerySchema>;
