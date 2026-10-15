import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';
import { salesmen } from './sales.js';
import { vanSalesDocuments } from './van-sales.js';

/**
 * M4 field-sync — the server-side ledger for offline-first rep documents.
 *
 * Modeled on `offline_queue` (0102): the device's IndexedDB is the working queue, this
 * table is the replay identity + conflict ledger only. `salesman_id` is derived from the
 * replaying membership (D-004), never from the payload, so the conflict inbox and the
 * device binding stay auditable. See `apps/api/src/modules/field-sync/README.md`.
 */
export const fieldSyncQueue = pgTable(
  'field_sync_queue',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    salesmanId: uuid('salesman_id').references(() => salesmen.id, { onDelete: 'set null' }),
    offlineId: text('offline_id').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    operation: text('operation').notNull(),
    status: text('status').notNull().default('pending'),
    payload: jsonb('payload').notNull(),
    result: jsonb('result'),
    documentId: uuid('document_id').references(() => vanSalesDocuments.id, {
      onDelete: 'set null',
    }),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (table) => ({
    offlineIdKey: uniqueIndex('field_sync_queue_tenant_offline_id_key').on(
      table.tenantId,
      table.offlineId,
    ),
    sequenceKey: uniqueIndex('field_sync_queue_tenant_device_sequence_key').on(
      table.tenantId,
      table.deviceId,
      table.sequenceNo,
    ),
    statusIdx: index('field_sync_queue_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    deviceIdx: index('field_sync_queue_tenant_device_idx').on(
      table.tenantId,
      table.deviceId,
      table.sequenceNo,
    ),
    salesmanIdx: index('field_sync_queue_salesman_idx').on(
      table.tenantId,
      table.salesmanId,
      table.createdAt,
    ),
  }),
);

export type FieldSyncQueueRow = typeof fieldSyncQueue.$inferSelect;
export type FieldSyncQueueInsert = typeof fieldSyncQueue.$inferInsert;
