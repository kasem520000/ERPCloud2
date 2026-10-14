import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/**
 * P-C11 — بوابة المطوّر (migration `0075_developer_platform.sql`).
 *
 * التعريفات مطابقةٌ للترحيل حرفاً بحرف، والسبب نفسه الذي كُتب في P-C10: جدولٌ بلا تعريف
 * drizzle يُقرأ نصّاً فيضيع التحقّق النوعي.
 *
 * وملاحظتان تُقرآن من الأعمدة:
 *
 *   * `apiKeys.keyHash` فقط — لا عمود `secret` إطلاقاً. النصّ الصريح يعيش في الاستجابة
 *     الوحيدة التي تُنشئه، ثم لا مكان في هذا المخطط يعيده.
 *   * `webhookEndpoints.secretEnc` مشفَّر (مغلّف `v1:`) لا مُجزَّأ: السرّ **يُقرأ** لحظة
 *     التوقيع، بخلاف المفتاح الذي يُقارَن فقط.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedFrom: uuid('rotated_from'),
  },
  (table) => ({ tenantIdx: index('api_keys_tenant_idx').on(table.tenantId, table.createdAt) }),
);

export const apiKeyUses = pgTable(
  'api_key_uses',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code'),
    ip: text('ip'),
  },
  (table) => ({ keyIdx: index('api_key_uses_key_idx').on(table.apiKeyId, table.at) }),
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events').array().notNull(),
    status: text('status').notNull().default('active'),
    secretPrefix: text('secret_prefix').notNull(),
    secretEnc: text('secret_enc').notNull(),
    secretSetAt: timestamp('secret_set_at', { withTimezone: true }).notNull().defaultNow(),
    description: text('description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({ tenantIdx: index('webhook_endpoints_tenant_idx').on(table.tenantId, table.createdAt) }),
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(4),
    responseCode: integer('response_code'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointIdx: index('webhook_deliveries_endpoint_idx').on(table.endpointId, table.createdAt),
  }),
);
