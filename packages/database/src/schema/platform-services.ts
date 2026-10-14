import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseSoftDeleteColumns } from '../columns.js';

import { memberships } from './tenancy.js';
import { tenants, users } from './platform.js';

/**
 * Platform services — DATABASE_DESIGN §4 (+ `document_sequences` from §3).
 *
 * These six tables are the shared capabilities every later module consumes:
 * append-only audit, object-storage metadata, in-app notifications, the transactional
 * outbox that feeds BullMQ, idempotency-key storage and document numbering.
 *
 * All of them are tenant-scoped and carry the canonical RLS policy, with one deliberate
 * exception: `audit_log.tenant_id` is nullable so that platform-plane events (a login
 * attempt that never reached a tenant, an ops action) can be recorded. The policy still
 * only ever *reads back* rows of the current tenant — see
 * `migrations/0001_platform_services.sql`.
 */

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /** NULL = platform event (no tenant context existed when it happened). */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Display label of the actor at the time of the event (no PII beyond this). */
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    /** Text, not uuid: some entities are keyed by a natural key (e.g. a setting key). */
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    /** ip, user agent, trace id, http method/path — never a secret. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    auditLogEntityIdx: index('audit_log_tenant_entity_idx').on(table.tenantId, table.entity, table.entityId),
    auditLogCreatedIdx: index('audit_log_tenant_created_at_idx').on(table.tenantId, table.createdAt),
    auditLogActorIdx: index('audit_log_tenant_actor_idx').on(table.tenantId, table.actorUserId),
  }),
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum'),
    /** Upload lifecycle: `pending` (presigned) → `ready` (finalised) → `deleted`. */
    status: text('status').notNull().default('pending'),
    entity: text('entity'),
    entityId: uuid('entity_id'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    filesObjectKeyUnique: uniqueIndex('files_bucket_object_key_key').on(table.bucket, table.objectKey),
    filesEntityIdx: index('files_tenant_entity_idx').on(table.tenantId, table.entity, table.entityId),
    filesStatusIdx: index('files_tenant_status_created_at_idx').on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
  }),
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    notificationsInboxIdx: index('notifications_tenant_membership_idx').on(
      table.tenantId,
      table.membershipId,
      table.createdAt,
    ),
    notificationsUnreadIdx: index('notifications_tenant_unread_idx')
      .on(table.tenantId, table.membershipId)
      .where(sql`read_at IS NULL`),
  }),
);

export const outboxJobs = pgTable(
  'outbox_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** One of `@erp/contracts` QUEUE_NAMES (TARGET_ARCHITECTURE §6). */
    queue: text('queue').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** `pending` → `published`, or `dead` once OUTBOX_MAX_ATTEMPTS is exhausted. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    outboxDueIdx: index('outbox_jobs_status_run_at_idx').on(table.status, table.runAt),
    outboxTenantIdx: index('outbox_jobs_tenant_created_at_idx').on(table.tenantId, table.createdAt),
  }),
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** `METHOD /path` the key was first used on. */
    endpoint: text('endpoint').notNull(),
    /** SHA-256 of the request body — a reused key with a different body is a conflict. */
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    /**
     * The response **as it was serialised on the wire**, stored as text rather than
     * jsonb on purpose: API_CONTRACT §0 promises a *byte-identical* replay, and jsonb
     * normalises key order and whitespace, which would break that guarantee.
     */
    response: text('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    idempotencyKeysPk: primaryKey({ columns: [table.tenantId, table.key] }),
    idempotencyExpiryIdx: index('idempotency_keys_expires_at_idx').on(table.expiresAt),
  }),
);

export const documentSequences = pgTable(
  'document_sequences',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * NULL = tenant-wide numbering. No FK yet: `branches` arrives in PHASE_05
     * (DATABASE_DESIGN §5); the constraint is added by that phase's migration.
     */
    branchId: uuid('branch_id'),
    docType: text('doc_type').notNull(),
    /** NULL = the sequence does not restart per fiscal year. */
    fiscalYearId: uuid('fiscal_year_id'),
    prefix: text('prefix').notNull().default(''),
    currentValue: bigint('current_value', { mode: 'number' }).notNull().default(0),
    padding: integer('padding').notNull().default(6),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    documentSequencesScopeIdx: index('document_sequences_tenant_doc_type_idx').on(
      table.tenantId,
      table.docType,
    ),
  }),
);

/**
 * The unique scope of a sequence is `(tenant_id, branch_id, doc_type, fiscal_year_id)`
 * with NULL treated as a value, which SQL uniqueness does not do. The migration creates
 * the index over these COALESCE expressions and the allocation statement targets it, so
 * the ON CONFLICT arbiter and the index must stay in sync — hence one shared constant.
 */
export const SEQUENCE_SCOPE_NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const sequenceScopeConflictTarget =
  `(tenant_id, coalesce(branch_id, '${SEQUENCE_SCOPE_NIL_UUID}'::uuid), doc_type, ` +
  `coalesce(fiscal_year_id, '${SEQUENCE_SCOPE_NIL_UUID}'::uuid))`;

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type OutboxJob = typeof outboxJobs.$inferSelect;
export type NewOutboxJob = typeof outboxJobs.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
export type DocumentSequence = typeof documentSequences.$inferSelect;
export type NewDocumentSequence = typeof documentSequences.$inferInsert;
