import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { branches, warehouses } from './organization.js';
import { tenants } from './platform.js';

export const itemCategories = pgTable(
  'item_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    sortOrder: integer('sort_order').notNull().default(0),
    showInPos: boolean('show_in_pos').notNull().default(true),
    showInSale: boolean('show_in_sale').notNull().default(true),
    showInPurch: boolean('show_in_purch').notNull().default(true),
    kitchenPrinter: text('kitchen_printer'),
    printSeparately: boolean('print_separately').notNull().default(false),
    branchId: uuid('branch_id').references(() => branches.id),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    code: uniqueIndex('item_categories_tenant_code_key')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
    tenant: index('item_categories_tenant_idx').on(t.tenantId),
  }),
);

export const unitsOfMeasure = pgTable(
  'units_of_measure',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    code: uniqueIndex('units_of_measure_tenant_code_key')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const taxGroups = pgTable(
  'tax_groups',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    vatAccountId: uuid('vat_account_id'),
    isInclusiveDefault: boolean('is_inclusive_default').notNull().default(false),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({ tenant: index('tax_groups_tenant_idx').on(t.tenantId) }),
);

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => itemCategories.id),
    baseUnitId: uuid('base_unit_id')
      .notNull()
      .references(() => unitsOfMeasure.id),
    kind: text('kind').notNull().default('stock'),
    salePrice: numeric('sale_price', { precision: 20, scale: 4 }),
    purchasePrice: numeric('purchase_price', { precision: 20, scale: 4 }),
    taxGroupId: uuid('tax_group_id').references(() => taxGroups.id),
    minQty: numeric('min_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    maxQty: numeric('max_qty', { precision: 20, scale: 4 }),
    maxDiscountPct: numeric('max_discount_pct', { precision: 7, scale: 4 }),
    maxDiscountAmt: numeric('max_discount_amt', { precision: 20, scale: 4 }),
    trackLot: boolean('track_lot').notNull().default(false),
    trackSerial: boolean('track_serial').notNull().default(false),
    weightedScale: boolean('weighted_scale').notNull().default(false),
    showInPos: boolean('show_in_pos').notNull().default(true),
    egyItemCode: text('egy_item_code'),
    egyCodeType: text('egy_code_type'),
    withholdingRate: numeric('withholding_rate', { precision: 7, scale: 4 }),
    imageFileId: uuid('image_file_id'),
    kindFlags: jsonb('kind_flags').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    sku: uniqueIndex('items_tenant_sku_key')
      .on(t.tenantId, t.sku)
      .where(sql`deleted_at IS NULL`),
    barcode: index('items_tenant_barcode_idx').on(t.tenantId, t.barcode),
    category: index('items_tenant_category_idx').on(t.tenantId, t.categoryId),
  }),
);

export const itemUnits = pgTable(
  'item_units',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => unitsOfMeasure.id),
    ratio: numeric('ratio', { precision: 20, scale: 6 }).notNull(),
    barcode: text('barcode'),
    salePrice: numeric('sale_price', { precision: 20, scale: 4 }),
    purchasePrice: numeric('purchase_price', { precision: 20, scale: 4 }),
    isDefaultPurchase: boolean('is_default_purchase').notNull().default(false),
    isDefaultSale: boolean('is_default_sale').notNull().default(false),
  },
  (t) => ({ pk: primaryKey({ columns: [t.itemId, t.unitId] }) }),
);
export const itemBarcodes = pgTable(
  'item_barcodes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    barcode: text('barcode').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.barcode] }) }),
);
export const itemAlternativeCodes = pgTable(
  'item_alternative_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    code: text('code').notNull(),
    notes: text('notes'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (t) => ({
    code: uniqueIndex('item_alt_codes_tenant_code_key')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
  }),
);
export const itemComponents = pgTable(
  'item_components',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    componentItemId: uuid('component_item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', { precision: 20, scale: 4 }).notNull(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => unitsOfMeasure.id),
    kind: text('kind').notNull().default('component'),
    /** The desktop `store`: which warehouse this component is drawn from. Optional. */
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.componentItemId] }),
    warehouse: index('item_components_warehouse_idx').on(t.tenantId, t.warehouseId),
  }),
);
export const itemPriceHistory = pgTable('item_price_history', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  itemId: uuid('item_id')
    .notNull()
    .references(() => items.id),
  unitId: uuid('unit_id'),
  prices: jsonb('prices').$type<Record<string, string>>().notNull(),
  recordedBy: uuid('recorded_by'),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});
export const itemDetails = pgTable('item_details', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  supplierRef: text('supplier_ref'),
  importer: text('importer'),
  netWeight: numeric('net_weight', { precision: 20, scale: 4 }),
  leadTime: text('lead_time'),
  notes: text('notes'),
  ...baseAuditColumns(),
  ...baseSoftDeleteColumns(),
});

export const catalogTables = {
  itemCategories,
  unitsOfMeasure,
  taxGroups,
  items,
  itemUnits,
  itemBarcodes,
  itemAlternativeCodes,
  itemComponents,
  itemPriceHistory,
  itemDetails,
};
export type CatalogItem = typeof items.$inferSelect;
