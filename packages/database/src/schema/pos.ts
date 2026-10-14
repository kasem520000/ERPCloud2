import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { branches } from './organization.js';
import { salesInvoices } from './sales.js';
import { tenants, users } from './platform.js';

const qty = { precision: 20, scale: 4, mode: 'string' as const };
const money = { precision: 20, scale: 4, mode: 'string' as const };

export const tableCategories = pgTable(
  'table_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    printerName: text('printer_name'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    tableCategoriesNameKey: uniqueIndex('table_categories_name_key')
      .on(table.tenantId, table.branchId, table.name)
      .where(sql`deleted_at IS NULL`),
    tableCategoriesBranchIdx: index('table_categories_branch_idx').on(table.tenantId, table.branchId),
  }),
);

export const diningTables = pgTable(
  'dining_tables',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => tableCategories.id, { onDelete: 'restrict' }),
    tableNo: text('table_no').notNull(),
    name: text('name').notNull(),
    seats: integer('seats').notNull().default(4),
    status: text('status').notNull().default('free'),
    currentInvoiceId: uuid('current_invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
    combinedInto: uuid('combined_into'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    diningTablesNoKey: uniqueIndex('dining_tables_no_key')
      .on(table.tenantId, table.branchId, table.tableNo)
      .where(sql`deleted_at IS NULL`),
    diningTablesStatusIdx: index('dining_tables_status_idx').on(table.tenantId, table.branchId, table.status),
  }),
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => diningTables.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    businessDay: date('business_day').notNull(),
    lineKey: text('line_key').notNull(),
    itemId: uuid('item_id'),
    description: text('description'),
    qty: numeric('qty', qty).notNull().default('1'),
    unitValue: numeric('unit_value', money).notNull().default('0'),
    modifiers: jsonb('modifiers').$type<Array<Record<string, unknown>>>().notNull().default([]),
    reason: text('reason'),
    invoiceId: uuid('invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
    firedAt: timestamp('fired_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    orderEventsTableIdx: index('order_events_table_idx').on(table.tenantId, table.tableId, table.createdAt),
    orderEventsInvoiceIdx: index('order_events_invoice_idx').on(table.tenantId, table.invoiceId),
    orderEventsDayIdx: index('order_events_day_idx').on(table.tenantId, table.branchId, table.businessDay),
  }),
);

export type TableCategory = typeof tableCategories.$inferSelect;
export type DiningTable = typeof diningTables.$inferSelect;
export type OrderEvent = typeof orderEvents.$inferSelect;

/**
 * 🅿️ الفواتير المعلَّقة — `frmPOS.xaml.cs` L1871–L1962 (`Hold Orders`).
 *
 * الديسكتوب كان يحفظ «الفاتورة المعلّقة» **فاتورةً حقيقية** بـ`inv_type=3, proc_type=3`
 * ثم يقرأها بالتاريخ ويعرضها في ٩ أزرار (`HoldList[9]`). والسحابة تفصل الأمرين: الفاتورة
 * لا تُكتب قبل الدفع، و`pos_holds` يحمل **السلة** لا مستنداً محاسبياً — فلا رقمَ محجوز ولا
 * قيدَ معلّق إن لم يُغلق المستخدم الفاتورة أبداً.
 *
 * والخانة (`slot`) هي زرُّ الديسكتوب: رقمٌ من ٠ إلى ٨، فريدٌ لكل كاشير في الفرع، والسلة
 * المسكوبة فيه هي «الملفّ المعلّق». `cart` يخزّن سطور الواجهة كما كتبها الكاشير قبل أن
 * يلمسها المحرّك، فاسترجاعُها يعيد الشاشة إلى ما كانت عليه لا إلى ما يفهمه الخادم فقط.
 */
export const posHolds = pgTable(
  'pos_holds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    slot: integer('slot').notNull(),
    label: text('label'),
    cart: jsonb('cart').$type<Record<string, unknown>>().notNull().default({}),
    total: numeric('total', money).notNull().default('0'),
    linesCount: integer('lines_count').notNull().default(0),
    heldAt: timestamp('held_at', { withTimezone: true }).notNull().defaultNow(),
    // `created_by` يأتي من `baseAuditColumns` — لا تكرار هنا.
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    posHoldsSlotKey: uniqueIndex('pos_holds_slot_key').on(
      table.tenantId,
      table.branchId,
      table.userId,
      table.slot,
    ),
    posHoldsScopeIdx: index('pos_holds_scope_idx').on(table.tenantId, table.branchId),
  }),
);

export type PosHold = typeof posHolds.$inferSelect;

/**
 * Offline POS tickets. The browser owns the first copy in IndexedDB; this table is the
 * server-side receipt/idempotency ledger that makes replay safe and exposes stock conflicts
 * instead of silently dropping a sale.
 */
export const offlineQueue = pgTable(
  'offline_queue',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    offlineId: text('offline_id').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    status: text('status').notNull().default('pending'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    invoiceId: uuid('invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
    invoiceNumber: text('invoice_number'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (table) => ({
    offlineIdKey: uniqueIndex('offline_queue_tenant_offline_id_key').on(table.tenantId, table.offlineId),
    sequenceKey: uniqueIndex('offline_queue_tenant_device_sequence_key').on(
      table.tenantId,
      table.deviceId,
      table.sequenceNo,
    ),
    scopeIdx: index('offline_queue_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    deviceIdx: index('offline_queue_tenant_device_idx').on(table.tenantId, table.deviceId, table.sequenceNo),
  }),
);

export type OfflineQueue = typeof offlineQueue.$inferSelect;
