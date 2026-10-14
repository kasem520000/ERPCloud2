import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/**
 * PHASE_08 — accounting assistant.
 *
 * Platform credentials are a singleton with no `tenant_id`: only the admin plane
 * can read the encrypted key. Conversations, usage and suggestions are tenant
 * scoped. Facts sent to a model are aggregates, never identity or payroll rows.
 */
export const aiPlatformSettings = pgTable('ai_platform_settings', {
  id: boolean('id').primaryKey().default(true),
  provider: text('provider').notNull().default('local'),
  model: text('model').notNull().default('local-grounded'),
  apiKeyEnc: text('api_key_enc'),
  baseUrl: text('base_url').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  defaultMonthlyTokenLimit: integer('default_monthly_token_limit').notNull().default(200000),
  costPerMillionIn: numeric('cost_per_million_in', { precision: 12, scale: 6, mode: 'string' }).notNull().default('0'),
  costPerMillionOut: numeric('cost_per_million_out', { precision: 12, scale: 6, mode: 'string' }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiSettings = pgTable('ai_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  platformSuspended: boolean('platform_suspended').notNull().default(false),
  provider: text('provider'),
  model: text('model'),
  apiKeyEnc: text('api_key_enc'),
  baseUrl: text('base_url').notNull().default(''),
  monthlyTokenLimit: integer('monthly_token_limit'),
  monthlyCostLimit: numeric('monthly_cost_limit', { precision: 12, scale: 4, mode: 'string' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    messages: jsonb('messages').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('ai_conversations_user_idx').on(table.tenantId, table.userId, table.updatedAt),
  }),
);

export const aiUsageLogs = pgTable(
  'ai_usage_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 6, mode: 'string' }).notNull().default('0'),
    provider: text('provider').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    periodIdx: index('ai_usage_logs_period_idx').on(table.tenantId, table.createdAt),
  }),
);

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    period: date('period').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    periodKey: uniqueIndex('ai_suggestions_tenant_kind_period_key').on(table.tenantId, table.kind, table.period),
  }),
);

export type AiPlatformSetting = typeof aiPlatformSettings.$inferSelect;
export type AiSetting = typeof aiSettings.$inferSelect;
export type AiConversation = typeof aiConversations.$inferSelect;
export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
