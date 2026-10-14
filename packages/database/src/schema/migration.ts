import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/** Migration engine run tables — MIGRATION_ARCHITECTURE §6 / DATABASE_DESIGN §14. */
export const migrationRuns = pgTable(
  'migration_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    sourceLabel: text('source_label').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('queued'),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    migrationRunsTenantStartedIdx: index('migration_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
    migrationRunsTenantStatusIdx: index('migration_runs_tenant_status_idx').on(table.tenantId, table.status),
  }),
);

export const legacyIdMappings = pgTable(
  'legacy_id_mappings',
  {
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    legacySource: text('legacy_source').notNull(),
    legacyPk: text('legacy_pk').notNull(),
    newId: uuid('new_id').notNull(),
    runId: uuid('run_id').notNull().references(() => migrationRuns.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    legacyIdMappingsPk: primaryKey({ columns: [table.tenantId, table.entity, table.legacySource, table.legacyPk] }),
    legacyIdMappingsRunIdx: index('legacy_id_mappings_run_idx').on(table.tenantId, table.runId),
    legacyIdMappingsNewIdIdx: index('legacy_id_mappings_new_id_idx').on(table.tenantId, table.entity, table.newId),
  }),
);

export const migrationIssues = pgTable(
  'migration_issues',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => migrationRuns.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    legacyPk: text('legacy_pk'),
    severity: text('severity').notNull(),
    code: text('code').notNull(),
    message: text('message').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    migrationIssuesRunIdx: index('migration_issues_run_idx').on(table.tenantId, table.runId, table.severity),
    migrationIssuesCodeIdx: index('migration_issues_code_idx').on(table.tenantId, table.code),
  }),
);

export type MigrationRun = typeof migrationRuns.$inferSelect;
export type NewMigrationRun = typeof migrationRuns.$inferInsert;
export type LegacyIdMapping = typeof legacyIdMappings.$inferSelect;
export type NewLegacyIdMapping = typeof legacyIdMappings.$inferInsert;
export type MigrationIssue = typeof migrationIssues.$inferSelect;
export type NewMigrationIssue = typeof migrationIssues.$inferInsert;
