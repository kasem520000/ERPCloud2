import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseSoftDeleteColumns } from '../columns.js';

import { branches } from './organization.js';
import { tenants } from './platform.js';

/**
 * Canonical tenant device registry — 2026-09 architecture/RBAC reorganisation
 * (migration 0032).
 *
 * A device (till, handheld, kiosk, back-office printer agent) is an *entity*, not a
 * human and not a role: the `cashier` role describes what a person may do, while a
 * `devices` row describes which hardware the tenant trusts, where it lives, and
 * which credential it authenticates with. Separation of concerns:
 *
 *   - `users` — a human (or a portal login) with a password;
 *   - `cashier` role — what a human cashier may do in the ERP;
 *   - `devices` — which hardware is enrolled, its activation lifecycle and its
 *     hashed credential (`credentialHash`, never the secret itself);
 *   - `compat_devices` (PHASE_16, untouched) — the legacy desktop gateway's own
 *     registry. Migration 0032 *copies* its rows here as `device_type =
 *     'compat'` for a unified inventory; the compat endpoints keep serving from
 *     their table (no function removed, cutover documented in
 *     docs/architecture-rbac/04-migration-plan.md).
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    /** e.g. `pos_terminal`, `handheld`, `kiosk`, `printer_agent`, `compat`, `api_client`. */
    deviceType: text('device_type').notNull(),
    deviceName: text('device_name').notNull(),
    /** CHECK(pending,active,suspended,revoked) */
    activationStatus: text('activation_status').notNull().default('pending'),
    /** SHA-256 hex of the provisioned secret. Plaintext is shown once, at enrolment. */
    credentialHash: text('credential_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** Declared abilities, e.g. `{ "print": true, "cashDrawer": false, "offline": true }`. */
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    devicesTenantNameUnique: uniqueIndex('devices_tenant_branch_name_key')
      .on(table.tenantId, table.branchId, table.deviceName)
      .where(sql`deleted_at IS NULL`),
    devicesBranchIdx: index('devices_branch_idx').on(table.tenantId, table.branchId),
    devicesStatusIdx: index('devices_status_idx').on(table.tenantId, table.activationStatus),
  }),
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
