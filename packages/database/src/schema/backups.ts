import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/**
 * P-C10 — نسخ المنصّة وطلبات البيانات (migration `0074_platform_backups.sql`).
 *
 * التعريفات هنا مطابقةٌ للترحيل حرفاً بحرف (أسماء الأعمدة وأنواعها وعدم القابلية للفراغ)،
 * لأن الدروس المستفادة من P-C9 كانت صريحة: جدولٌ بلا تعريف drizzle يُقرأ بـ`tx.execute`
 * نصّاً، فيضيع التحقّق النوعي وتُكتب الأعمدة مرّتين — مرّةً في SQL ومرّةً في الردّ.
 *
 * ولا سياسة عزلٍ مستأجري على الثلاثة: `backup_*` صفوفُ منصّة بلا `tenant_id`، و
 * `data_requests` يحمله ولكن قارئه مشغّل المنصّة وحده (سياسة مستوى المنصّة في الترحيل).
 */
export const backupArtifacts = pgTable(
  'backup_artifacts',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull().default('platform-dump'),
    store: text('store').notNull(),
    objectKey: text('object_key').notNull(),
    format: text('format').notNull().default('erp-platform-dump/1'),
    encryption: text('encryption').notNull().default('aes-256-gcm'),
    iv: text('iv'),
    bytes: integer('bytes').notNull(),
    checksum: text('checksum').notNull(),
    tables: integer('tables').notNull().default(0),
    rows: integer('rows').notNull().default(0),
    prunedAt: timestamp('pruned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({ kindIdx: index('backup_artifacts_kind_created_idx').on(table.kind, table.createdAt) }),
);

export const backupJobs = pgTable(
  'backup_jobs',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope').notNull().default('platform'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('running'),
    artifactId: uuid('artifact_id').references(() => backupArtifacts.id, { onDelete: 'set null' }),
    note: text('note'),
    failureReason: text('failure_reason'),
    tables: integer('tables').notNull().default(0),
    rows: integer('rows').notNull().default(0),
    tenants: integer('tenants').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedChecksum: text('verified_checksum'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({ startedIdx: index('backup_jobs_started_idx').on(table.startedAt) }),
);

export const dataRequests = pgTable(
  'data_requests',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subjectEmail: text('subject_email').notNull(),
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    decisionNote: text('decision_note'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({ statusIdx: index('data_requests_status_idx').on(table.status, table.createdAt) }),
);

export type BackupArtifact = typeof backupArtifacts.$inferSelect;
export type BackupJob = typeof backupJobs.$inferSelect;
export type DataRequest = typeof dataRequests.$inferSelect;
