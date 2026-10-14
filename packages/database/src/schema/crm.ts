import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { parties } from './parties.js';
import { tenants, users } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/** مسار مبيعات. المراحل JSON مرتب، وليست جدولاً لكل مرحلة. */
export const crmPipelines = pgTable(
  'crm_pipelines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    stages: jsonb('stages').$type<Array<{ id: string; name: string; color: string; order: number }>>().notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('crm_pipelines_tenant_idx').on(table.tenantId),
    defaultKey: uniqueIndex('crm_pipelines_default_key').on(table.tenantId).where(sql`is_default`),
  }),
);

export const crmDeals = pgTable(
  'crm_deals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => crmPipelines.id, { onDelete: 'cascade' }),
    stageId: text('stage_id').notNull(),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    amount: numeric('amount', money).notNull().default('0'),
    probability: integer('probability').notNull().default(0),
    expectedClose: date('expected_close'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('open'),
    lostReason: text('lost_reason').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardIdx: index('crm_deals_board_idx').on(table.tenantId, table.pipelineId, table.stageId),
  }),
);

export const crmActivities = pgTable(
  'crm_activities',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => crmDeals.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id'),
    type: text('type').notNull(),
    subject: text('subject').notNull().default(''),
    description: text('description').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id'),
    direction: text('direction').notNull().default(''),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    dealIdx: index('crm_activities_deal_idx').on(table.tenantId, table.dealId, table.at),
  }),
);

export const crmWhatsappTemplates = pgTable(
  'crm_whatsapp_templates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameKey: uniqueIndex('crm_whatsapp_templates_name_key').on(table.tenantId, table.name),
  }),
);

/** سر الويب هوك. القراءة العامة مسموحة فقط حين يطابق `app.lookup_webhook` الرمز. */
export const crmSettings = pgTable(
  'crm_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    webhookToken: text('webhook_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenKey: uniqueIndex('crm_settings_webhook_token_key').on(table.webhookToken),
  }),
);
