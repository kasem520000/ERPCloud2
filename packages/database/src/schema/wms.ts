import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { items, unitsOfMeasure } from './catalog.js';
import { itemLots } from './inventory.js';
import { branches, warehouses } from './organization.js';
import { tenants } from './platform.js';

const qty = { precision: 20, scale: 4, mode: 'string' as const };
const money = { precision: 20, scale: 4, mode: 'string' as const };

/** A shelf location inside a warehouse. Code is the human address, e.g. A-01-01. */
export const warehouseBins = pgTable(
  'warehouse_bins',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    zone: text('zone'),
    aisle: text('aisle'),
    rack: text('rack'),
    level: text('level'),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
  },
  (table) => ({
    codeKey: uniqueIndex('warehouse_bins_code_key').on(table.tenantId, table.warehouseId, table.code),
    warehouseIdx: index('warehouse_bins_warehouse_idx').on(table.tenantId, table.warehouseId),
  }),
);

/** Quantity of one item (and optional lot) sitting in one bin. */
export const binBalances = pgTable(
  'bin_balances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    binId: uuid('bin_id')
      .notNull()
      .references(() => warehouseBins.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => itemLots.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', qty).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemIdx: index('bin_balances_item_idx').on(table.tenantId, table.itemId),
    binIdx: index('bin_balances_bin_idx').on(table.tenantId, table.binId),
  }),
);

/** A move that changes bins only. Warehouse quantity stays where it is. */
export const binTransfers = pgTable(
  'bin_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fromBinId: uuid('from_bin_id')
      .notNull()
      .references(() => warehouseBins.id, { onDelete: 'restrict' }),
    toBinId: uuid('to_bin_id')
      .notNull()
      .references(() => warehouseBins.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => itemLots.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', qty).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index('bin_transfers_created_idx').on(table.tenantId, table.createdAt),
  }),
);

export const boms = pgTable(
  'boms',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productItemId: uuid('product_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Recipe version. Not the audit `version` column — that name is already the recipe. */
    version: integer('version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by'),
  },
  (table) => ({
    versionKey: uniqueIndex('boms_product_version_key').on(table.tenantId, table.productItemId, table.version),
    productIdx: index('boms_product_idx').on(table.tenantId, table.productItemId),
  }),
);

export const bomLines = pgTable(
  'bom_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bomId: uuid('bom_id')
      .notNull()
      .references(() => boms.id, { onDelete: 'cascade' }),
    componentItemId: uuid('component_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    qty: numeric('qty', qty).notNull(),
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    scrapPercent: numeric('scrap_percent', { precision: 7, scale: 4, mode: 'string' }).notNull().default('0'),
  },
  (table) => ({
    bomIdx: index('bom_lines_bom_idx').on(table.tenantId, table.bomId),
  }),
);

export type RecipeLine = { componentItemId: string; qty: string; scrapPercent: string };

/**
 * Light manufacturing order. `recipe` is copied from the BOM at creation so a later
 * edit of the card does not change an open order. `warehouseId` is required because
 * the moving-average engine posts against a warehouse, not against a recipe.
 */
export const manufacturingOrders = pgTable(
  'manufacturing_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bomId: uuid('bom_id')
      .notNull()
      .references(() => boms.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    productItemId: uuid('product_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    qtyPlanned: numeric('qty_planned', qty).notNull(),
    qtyProduced: numeric('qty_produced', qty).notNull().default('0'),
    status: text('status').notNull().default('draft'),
    costTotal: numeric('cost_total', money).notNull().default('0'),
    recipe: jsonb('recipe').$type<RecipeLine[]>().notNull().default([]),
    ...baseAuditColumns(),
  },
  (table) => ({
    numberKey: uniqueIndex('manufacturing_orders_number_key').on(table.tenantId, table.number),
    statusIdx: index('manufacturing_orders_status_idx').on(table.tenantId, table.status),
  }),
);

export const manufacturingMoves = pgTable(
  'manufacturing_moves',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => manufacturingOrders.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    qty: numeric('qty', qty).notNull(),
    unitCost: numeric('unit_cost', money).notNull().default('0'),
    cost: numeric('cost', money).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orderIdx: index('manufacturing_moves_order_idx').on(table.tenantId, table.orderId),
  }),
);

export type WarehouseBin = typeof warehouseBins.$inferSelect;
export type BinBalance = typeof binBalances.$inferSelect;
export type Bom = typeof boms.$inferSelect;
export type BomLineRow = typeof bomLines.$inferSelect;
export type ManufacturingOrder = typeof manufacturingOrders.$inferSelect;
export type ManufacturingMove = typeof manufacturingMoves.$inferSelect;
