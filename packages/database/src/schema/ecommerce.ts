import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { salesInvoices } from './sales.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * Provider-neutral e-commerce connection.
 *
 * The encrypted columns contain AES-256-GCM envelopes, never provider credentials in
 * plaintext. The service deliberately maps rows through a masked DTO before they leave
 * the API boundary.
 */
export const ecommerceStores = pgTable(
  'ecommerce_stores',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    storeUrl: text('store_url'),
    remoteStoreId: text('remote_store_id'),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    webhookSecretEnc: text('webhook_secret_enc'),
    status: text('status').notNull().default('active'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...baseAuditColumns(),
  },
  (table) => ({
    tenantIdKey: unique('ecommerce_stores_tenant_id_key').on(table.tenantId, table.id),
    tenantProvider: index('ecommerce_stores_tenant_provider_idx').on(table.tenantId, table.provider),
    tenantStatus: index('ecommerce_stores_tenant_status_idx').on(table.tenantId, table.status),
    remote: uniqueIndex('ecommerce_stores_tenant_provider_remote_key')
      .on(table.tenantId, table.provider, table.remoteStoreId)
      .where(sql`remote_store_id IS NOT NULL`),
  }),
);

/** One row per remote order. The store is part of the idempotency key. */
export const ecommerceOrders = pgTable(
  'ecommerce_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').notNull(),
    remoteId: text('remote_id').notNull(),
    remoteOrderNo: text('remote_order_no'),
    remoteStatus: text('remote_status'),
    status: text('status').notNull().default('pending'),
    customerName: text('customer_name'),
    customerMobile: text('customer_mobile'),
    currency: text('currency').notNull().default('SAR'),
    total: numeric('total', money).notNull().default('0'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    erpInvoiceId: uuid('erp_invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    importedAt: timestamp('imported_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (table) => ({
    remote: uniqueIndex('ecommerce_orders_store_remote_key').on(table.storeId, table.remoteId),
    tenantRemote: index('ecommerce_orders_tenant_remote_idx').on(table.tenantId, table.remoteId),
    status: index('ecommerce_orders_tenant_status_idx').on(table.tenantId, table.status),
    store: index('ecommerce_orders_tenant_store_created_idx').on(
      table.tenantId,
      table.storeId,
      table.createdAt,
    ),
    storeTenant: foreignKey({
      columns: [table.tenantId, table.storeId],
      foreignColumns: [ecommerceStores.tenantId, ecommerceStores.id],
      name: 'ecommerce_orders_store_tenant_fk',
    }).onDelete('cascade'),
  }),
);

/** Audit trail for inbound order pulls and outbound stock updates. */
export const ecommerceSyncLogs = pgTable(
  'ecommerce_sync_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').notNull(),
    direction: text('direction').notNull(),
    entity: text('entity').notNull(),
    status: text('status').notNull(),
    message: text('message'),
    records: numeric('records', { precision: 12, scale: 0, mode: 'number' }).notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (table) => ({
    tenantStore: index('ecommerce_sync_logs_tenant_store_idx').on(
      table.tenantId,
      table.storeId,
      table.createdAt,
    ),
    status: index('ecommerce_sync_logs_tenant_status_idx').on(table.tenantId, table.status),
    storeTenant: foreignKey({
      columns: [table.tenantId, table.storeId],
      foreignColumns: [ecommerceStores.tenantId, ecommerceStores.id],
      name: 'ecommerce_sync_logs_store_tenant_fk',
    }).onDelete('cascade'),
  }),
);

export type EcommerceStore = typeof ecommerceStores.$inferSelect;
export type EcommerceOrder = typeof ecommerceOrders.$inferSelect;
export type EcommerceSyncLog = typeof ecommerceSyncLogs.$inferSelect;

export const ecommerceTables = {
  ecommerceStores,
  ecommerceOrders,
  ecommerceSyncLogs,
};
