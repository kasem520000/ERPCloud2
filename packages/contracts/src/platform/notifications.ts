import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * Notification DTOs — API_CONTRACT §2 (`GET /notifications`,
 * `POST /notifications/{id}/read`), DATABASE_DESIGN §4 (`notifications`).
 *
 * A notification always belongs to one membership: it is tenant-scoped by RLS *and*
 * addressed to a person, so listing is implicitly filtered to the caller's membership.
 */

export const notificationDtoSchema = z.object({
  id: uuidSchema,
  membershipId: uuidSchema,
  type: z.string(),
  payload: z.record(z.unknown()),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export const notificationCreateSchema = z
  .object({
    /** Recipient. Defaults to the calling membership when omitted. */
    membershipId: uuidSchema.optional(),
    /** Dot-namespaced event key, e.g. `settings.updated`. */
    type: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'type must be a dot-namespaced lowercase key'),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();

export type NotificationCreate = z.infer<typeof notificationCreateSchema>;

export const NOTIFICATION_FILTERS = ['read', 'type'] as const;
export const NOTIFICATION_SORT_COLUMNS = ['createdAt'] as const;

export const notificationListQuerySchema = paginationQuerySchema.extend({
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export type NotificationListQueryDto = z.infer<typeof notificationListQuerySchema>;

/** Emitted by the platform when a typed tenant setting is written (demo subscription). */
export const SETTINGS_UPDATED_NOTIFICATION = 'settings.updated';
