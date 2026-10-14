import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { tenants } from './platform.js';

/**
 * File-level operations (النسخ الاحتياطي، الإستعادة، تدوير البيانات، صيانة الفواتير،
 * إنشاء ملف) and saved report layouts (مصمم التقارير).
 *
 * Each of the first four is stored as a **run** rather than a setting, because each is an
 * event with an actor, a scope and a result that somebody will eventually need to account
 * for. `report_layouts` stores only presentation — column choice, order and headings —
 * never SQL: the report's query stays in the server-side catalog.
 */
export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), kind: text('kind').notNull().default('full'), status: text('status').notNull().default('ready'), note: text('note'), tables: jsonb('tables').$type<string[]>().notNull().default([]), rowCounts: jsonb('row_counts').$type<Record<string, number>>().notNull().default({}), totalRows: integer('total_rows').notNull().default(0), sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0), checksum: text('checksum').notNull().default(''), payload: jsonb('payload').$type<Record<string, unknown[]>>(), failedReason: text('failed_reason'), completedAt: timestamp('completed_at', { withTimezone: true }), ...baseAuditColumns(),
}, (t) => ({ tenantIdx: index('backup_runs_tenant_idx').on(t.tenantId, t.createdAt) }));

export const restoreRuns = pgTable('restore_runs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), backupId: uuid('backup_id').references(() => backupRuns.id, { onDelete: 'set null' }), mode: text('mode').notNull().default('dry_run'), status: text('status').notNull().default('ready'), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), insertedRows: integer('inserted_rows').notNull().default(0), skippedRows: integer('skipped_rows').notNull().default(0), failedReason: text('failed_reason'), ...baseAuditColumns(),
}, (t) => ({ tenantIdx: index('restore_runs_tenant_idx').on(t.tenantId, t.createdAt) }));

export const maintenanceRuns = pgTable('maintenance_runs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), kind: text('kind').notNull(), mode: text('mode').notNull().default('preview'), status: text('status').notNull().default('ready'), cutoffDate: date('cutoff_date'), backupId: uuid('backup_id').references(() => backupRuns.id, { onDelete: 'set null' }), findings: jsonb('findings').$type<Record<string, unknown>>().notNull().default({}), applied: jsonb('applied').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(),
}, (t) => ({ tenantIdx: index('maintenance_runs_tenant_idx').on(t.tenantId, t.kind, t.createdAt) }));

export const companyFiles = pgTable('company_files', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), newTenantId: uuid('new_tenant_id').references(() => tenants.id, { onDelete: 'set null' }), code: text('code').notNull(), name: text('name').notNull(), status: text('status').notNull().default('created'), copied: jsonb('copied').$type<Record<string, number>>().notNull().default({}), ...baseAuditColumns(),
}, (t) => ({ tenantIdx: index('company_files_tenant_idx').on(t.tenantId, t.createdAt) }));

export type ReportLayoutColumn = { key: string; labelAr?: string; visible: boolean };

export const reportLayouts = pgTable('report_layouts', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), reportKey: text('report_key').notNull(), name: text('name').notNull(), titleAr: text('title_ar'), columns: jsonb('columns').$type<ReportLayoutColumn[]>().notNull().default([]), filters: jsonb('filters').$type<Record<string, string>>().notNull().default({}), isDefault: boolean('is_default').notNull().default(false), ...baseAuditColumns(),
}, (t) => ({ nameKey: uniqueIndex('report_layouts_tenant_key_name').on(t.tenantId, t.reportKey, t.name) }));

export type BackupRun = typeof backupRuns.$inferSelect;
export type RestoreRun = typeof restoreRuns.$inferSelect;
export type MaintenanceRun = typeof maintenanceRuns.$inferSelect;
export type CompanyFile = typeof companyFiles.$inferSelect;
export type ReportLayout = typeof reportLayouts.$inferSelect;
