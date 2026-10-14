import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { branches } from './organization.js';
import { tenants } from './platform.js';

/** Legacy desktop compatibility devices — PHASE_16. */
export const compatDevices = pgTable(
  'compat_devices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    apiKeyHash: text('api_key_hash').notNull(),
    branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'restrict' }),
    cursors: jsonb('cursors').$type<Record<string, { updatedAt: string; id: string }>>().notNull().default({}),
    enumMaps: jsonb('enum_maps').$type<Record<string, Record<string, string>>>().notNull().default({}),
    status: text('status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    rateWindowStartedAt: timestamp('rate_window_started_at', { withTimezone: true }),
    rateWindowCount: text('rate_window_count').notNull().default('0'),
    ...baseAuditColumns(),
  },
  (table) => ({
    compatDevicesHashKey: uniqueIndex('compat_devices_tenant_hash_key').on(table.tenantId, table.apiKeyHash),
    compatDevicesBranchIdx: index('compat_devices_branch_idx').on(table.tenantId, table.branchId),
    compatDevicesStatusIdx: index('compat_devices_status_idx').on(table.tenantId, table.status),
  }),
);

export type CompatDevice = typeof compatDevices.$inferSelect;
export type NewCompatDevice = typeof compatDevices.$inferInsert;

/**
 * AUD-09 — جلسات gateway التوافق. كانت في `Map` داخل العملية فتضيع بإعادة التشغيل ولا
 * يراها replica آخر؛ صارت صفوفاً محميّة بسياسة العزل نفسها، ويُخزَّن **هاش** الرمز فقط.
 */
export const compatSessions = pgTable(
  'compat_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => compatDevices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => ({
    compatSessionsTokenKey: uniqueIndex('compat_sessions_token_key').on(table.tokenHash),
    compatSessionsDeviceIdx: index('compat_sessions_device_idx').on(table.tenantId, table.deviceId),
    compatSessionsExpiryIdx: index('compat_sessions_expiry_idx').on(table.expiresAt),
  }),
);

export type CompatSession = typeof compatSessions.$inferSelect;
