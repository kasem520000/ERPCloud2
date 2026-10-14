import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * Audit-log DTOs — API_CONTRACT §2 (`GET /audit-log`), DATABASE_DESIGN §4 (`audit_log`).
 *
 * The table is append-only (`UPDATE`/`DELETE` are revoked from the API role), so the
 * contract exposes reads only. SECURITY_ARCHITECTURE §9: no PII beyond the actor label.
 */

export const auditEntryDtoSchema = z.object({
  id: uuidSchema,
  actorUserId: uuidSchema.nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  meta: z.record(z.unknown()),
  createdAt: z.string(),
});

export type AuditEntryDto = z.infer<typeof auditEntryDtoSchema>;

export const AUDIT_FILTERS = ['entity', 'entityId', 'action', 'actorUserId', 'from', 'to'] as const;
export const AUDIT_SORT_COLUMNS = ['createdAt'] as const;

export const auditListQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export type AuditListQueryDto = z.infer<typeof auditListQuerySchema>;

/**
 * Actions the platform records itself. Domain modules pass their own
 * `module.entity.action`-shaped verbs; these are the ones Phase 04 owns.
 */
export const auditActions = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  REFRESH: 'auth.refresh',
  PASSWORD_CHANGE: 'auth.password_change',
} as const;

export type AuditAction = (typeof auditActions)[keyof typeof auditActions];
