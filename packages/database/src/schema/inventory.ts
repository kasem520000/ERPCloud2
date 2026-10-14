import { isNotNull, isNull } from 'drizzle-orm';
import {
  date,
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

import { accounts, journalEntries } from './accounting.js';
import { branches, warehouses } from './organization.js';
import { items, unitsOfMeasure } from './catalog.js';
import { tenants } from './platform.js';

const qty = { precision: 20, scale: 4, mode: 'string' as const };
const money = { precision: 20, scale: 4, mode: 'string' as const };

export const inventoryTransactions = pgTable(
  'inventory_transactions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    docType: text('doc_type').notNull(),
    docId: uuid('doc_id').notNull(),
    lineId: uuid('line_id'),
    direction: text('direction').notNull(),
    qty: numeric('qty', qty).notNull(),
    /** qty × factor — the only quantity the stock balance is ever moved by. */
    baseQty: numeric('base_qty', qty).notNull(),
    /** The unit the clerk counted in (NULL = the item's base unit). */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    /** ItemUnits.ratio snapshot: base units per the entered unit. */
    factor: numeric('factor', { precision: 20, scale: 6 }).notNull().default('1'),
    unitCost: numeric('unit_cost', money).notNull(),
    totalCost: numeric('total_cost', money).notNull(),
    costing: text('costing').notNull(),
    lotId: uuid('lot_id'),
    serialId: uuid('serial_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => ({
    scope: index('inventory_transactions_scope_idx').on(t.tenantId, t.itemId, t.warehouseId, t.occurredAt),
    document: uniqueIndex('inventory_transactions_document_line_key').on(
      t.tenantId,
      t.docType,
      t.docId,
      t.lineId,
    ),
    lot: index('inventory_transactions_lot_idx').on(t.tenantId, t.lotId),
    serial: index('inventory_transactions_serial_idx').on(t.tenantId, t.serialId),
  }),
);

export const stockBalances = pgTable(
  'stock_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', qty).notNull().default('0'),
    value: numeric('value', money).notNull().default('0'),
    averageCost: numeric('average_cost', money).notNull().default('0'),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.itemId, t.warehouseId] }),
    item: index('stock_balances_tenant_item_idx').on(t.tenantId, t.itemId),
    warehouse: index('stock_balances_tenant_warehouse_idx').on(t.tenantId, t.warehouseId),
  }),
);

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    branchId: uuid('branch_id').notNull(),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    reason: text('reason').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    journalEntryId: uuid('journal_entry_id'),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    number: uniqueIndex('stock_adjustments_tenant_number_key').on(t.tenantId, t.number),
    status: index('stock_adjustments_status_idx').on(t.tenantId, t.status),
  }),
);
export const stockAdjustmentLines = pgTable(
  'stock_adjustment_lines',
  {
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    expectedQty: numeric('expected_qty', qty).notNull(),
    countedQty: numeric('counted_qty', qty).notNull(),
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    unitCost: numeric('unit_cost', money),
    varianceQty: numeric('variance_qty', qty),
    varianceValue: numeric('variance_value', money).notNull().default('0'),
    lotId: uuid('lot_id'),
    /**
     * 📁 رقم الدفعة وتواريخه على **سطر المستند** — R5، على أثر
     * `InvoiceItemDetail(BatchNo, ItemProductionDate, ItemExpireDate)` في
     * `Class/InvoiceOper.cs` L1635. و`lot_id` يشير إلى الدفعة، وهذه الثلاثة هي ما كتبه
     * المُدخِل بلغته: رقمُ الدفعة كما على العبوة، وتاريخا الإنتاج والانتهاء مطبوعين عليها.
     * تُحفظ كما كُتبت ولو لم تكن الدفعة قد سُجّلت بعد — والسطر الذي يُنشئ الدفعة يُنشئها.
     */
    batchNo: text('batch_no'),
    productionDate: date('production_date'),
    expiryDate: date('expiry_date'),
    /** 🔢 الأرقام التسلسلية counted on the line. */
    serialNos: jsonb('serial_nos').$type<string[]>().notNull().default([]),
    note: text('note'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.adjustmentId, t.lineNo] }),
    scope: index('stock_adjustment_lines_scope_idx').on(t.tenantId, t.itemId),
  }),
);

/**
 * سند إدخال / إخراج مخزني — the cloud counterpart of the desktop `frmInvInOutput`
 * (invType 4 / 5) and بضاعة أول المدة (invType 9). Migration 0034.
 *
 * The desktop saved these documents with no journal at all (`entry = null`) and let
 * the accountant fix the ledger by hand. The cloud cannot: sales and purchases already
 * post to the inventory account, so a document that moved quantity without a journal
 * would leave the ledger permanently disagreeing with the stock balance.
 */
export const stockVouchers = pgTable(
  'stock_vouchers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    /** `stock_in` (إدخال) · `stock_out` (إخراج) · `opening` (بضاعة أول المدة). */
    kind: text('kind').notNull().default('stock_in'),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    voucherDate: date('voucher_date').notNull(),
    reason: text('reason'),
    counterAccountId: uuid('counter_account_id').references(() => accounts.id),
    notes: text('notes'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    totalCost: numeric('total_cost', money).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    number: uniqueIndex('stock_vouchers_tenant_number_key').on(t.tenantId, t.number),
    scope: index('stock_vouchers_scope_idx').on(t.tenantId, t.branchId, t.status),
  }),
);

export const stockVoucherLines = pgTable(
  'stock_voucher_lines',
  {
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => stockVouchers.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', qty).notNull(),
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    unitCost: numeric('unit_cost', money),
    lineCost: numeric('line_cost', money).notNull().default('0'),
    lotId: uuid('lot_id').references(() => itemLots.id),
    /**
     * 📁 رقم الدفعة وتواريخه على **سطر المستند** — R5، على أثر
     * `InvoiceItemDetail(BatchNo, ItemProductionDate, ItemExpireDate)` في
     * `Class/InvoiceOper.cs` L1635. و`lot_id` يشير إلى الدفعة، وهذه الثلاثة هي ما كتبه
     * المُدخِل بلغته: رقمُ الدفعة كما على العبوة، وتاريخا الإنتاج والانتهاء مطبوعين عليها.
     * تُحفظ كما كُتبت ولو لم تكن الدفعة قد سُجّلت بعد — والسطر الذي يُنشئ الدفعة يُنشئها.
     */
    batchNo: text('batch_no'),
    productionDate: date('production_date'),
    expiryDate: date('expiry_date'),

    serialId: uuid('serial_id').references(() => itemSerials.id),
    /** 🔢 الأرقام التسلسلية as typed on the line; resolved into `stockDocumentSerials` at posting. */
    serialNos: jsonb('serial_nos').$type<string[]>().notNull().default([]),
    note: text('note'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.voucherId, t.lineNo] }),
    item: index('stock_voucher_lines_item_idx').on(t.tenantId, t.itemId),
  }),
);

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fromWarehouseId: uuid('from_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    toWarehouseId: uuid('to_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    branchId: uuid('branch_id').references(() => branches.id),
    sentJournalEntryId: uuid('sent_journal_entry_id').references(() => journalEntries.id),
    receivedJournalEntryId: uuid('received_journal_entry_id').references(() => journalEntries.id),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedJournalEntryId: uuid('closed_journal_entry_id').references(() => journalEntries.id),
    closureMode: text('closure_mode'),
    closureReason: text('closure_reason'),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    number: uniqueIndex('stock_transfers_tenant_number_key').on(t.tenantId, t.number),
    status: index('stock_transfers_status_idx').on(t.tenantId, t.status),
  }),
);
export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', qty).notNull(),
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    sentQty: numeric('sent_qty', qty).notNull().default('0'),
    receivedQty: numeric('received_qty', qty).notNull().default('0'),
    /** Settled by closing the transfer — returned home or written off, never received. */
    closedQty: numeric('closed_qty', qty).notNull().default('0'),
    unitCost: numeric('unit_cost', money).notNull().default('0'),
    lotId: uuid('lot_id'),
    /**
     * 📁 رقم الدفعة وتواريخه على **سطر المستند** — R5، على أثر
     * `InvoiceItemDetail(BatchNo, ItemProductionDate, ItemExpireDate)` في
     * `Class/InvoiceOper.cs` L1635. و`lot_id` يشير إلى الدفعة، وهذه الثلاثة هي ما كتبه
     * المُدخِل بلغته: رقمُ الدفعة كما على العبوة، وتاريخا الإنتاج والانتهاء مطبوعين عليها.
     * تُحفظ كما كُتبت ولو لم تكن الدفعة قد سُجّلت بعد — والسطر الذي يُنشئ الدفعة يُنشئها.
     */
    batchNo: text('batch_no'),
    productionDate: date('production_date'),
    expiryDate: date('expiry_date'),
    /** Superseded by `stockDocumentSerials` — kept so nothing that reads it breaks. */
    serialIds: jsonb('serial_ids').$type<string[]>().notNull().default([]),
    /** 🔢 الأرقام التسلسلية travelling on the line. */
    serialNos: jsonb('serial_nos').$type<string[]>().notNull().default([]),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.transferId, t.lineNo] }),
    scope: index('stock_transfer_lines_scope_idx').on(t.tenantId, t.itemId),
  }),
);

export const itemLots = pgTable(
  'item_lots',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    lotNo: text('lot_no').notNull(),
    /**
     * 📅 تاريخ الإنتاج — R5: الديسكتوب يفصل تاريخ الإنتاج (`ItemProductionDate`) عن
     * الاستلام، وكانت السحابة تلصق الأول على `received_at` (وُصف في الشاشة «تاريخ
     * الإنتاج» وهو تاريخ استلام). عمودٌ صريح لكلٍّ، والاثنان اختياريان.
     */
    productionDate: date('production_date'),
    expiryDate: date('expiry_date'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (t) => ({
    lot: uniqueIndex('item_lots_tenant_item_lot_key')
      .on(t.tenantId, t.itemId, t.lotNo)
      .where(isNull(t.deletedAt)),
  }),
);
export const itemSerials = pgTable(
  'item_serials',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    serialNo: text('serial_no').notNull(),
    lotId: uuid('lot_id'),
    status: text('status').notNull().default('available'),
    warehouseId: uuid('warehouse_id'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (t) => ({
    serial: uniqueIndex('item_serials_tenant_serial_key')
      .on(t.tenantId, t.serialNo)
      .where(isNull(t.deletedAt)),
    item: index('item_serials_stock_idx').on(t.tenantId, t.itemId, t.warehouseId, t.status),
  }),
);
/**
 * طلب بضاعة — the internal requisition that precedes a transfer. `transferId` is filled
 * when an approved request is fulfilled; the transfer, not the request, owns the stock
 * movement.
 */
export const goodsRequests = pgTable(
  'goods_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    toWarehouseId: uuid('to_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    fromWarehouseId: uuid('from_warehouse_id').references(() => warehouses.id),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    requestedAt: date('requested_at').notNull(),
    neededBy: date('needed_by'),
    notes: text('notes'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by'),
    rejectionReason: text('rejection_reason'),
    transferId: uuid('transfer_id').references(() => stockTransfers.id),
    ...baseAuditColumns(),
  },
  (t) => ({
    number: uniqueIndex('goods_requests_tenant_number_key').on(t.tenantId, t.number),
    status: index('goods_requests_status_idx').on(t.tenantId, t.status),
  }),
);
export const goodsRequestLines = pgTable(
  'goods_request_lines',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => goodsRequests.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', qty).notNull(),
    approvedQty: numeric('approved_qty', qty),
    note: text('note'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.lineNo] }),
    scope: index('goods_request_lines_scope_idx').on(t.tenantId, t.itemId),
  }),
);

/**
 * توصيل مخزني — the handover record for a posted sales invoice. It carries no inventory
 * line on purpose: posting the invoice already relieved the warehouse, so a delivery only
 * records who physically received what, and how much of the invoice is still outstanding.
 */
export const stockDeliveries = pgTable(
  'stock_deliveries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    invoiceId: uuid('invoice_id').notNull(),
    partyId: uuid('party_id'),
    number: text('number').notNull(),
    status: text('status').notNull().default('draft'),
    deliveredOn: date('delivered_on').notNull(),
    recipientName: text('recipient_name'),
    driverName: text('driver_name'),
    notes: text('notes'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (t) => ({
    number: uniqueIndex('stock_deliveries_tenant_number_key').on(t.tenantId, t.number),
    invoice: index('stock_deliveries_invoice_idx').on(t.tenantId, t.invoiceId),
    status: index('stock_deliveries_status_idx').on(t.tenantId, t.status),
  }),
);
export const stockDeliveryLines = pgTable(
  'stock_delivery_lines',
  {
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => stockDeliveries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', qty).notNull(),
    note: text('note'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.deliveryId, t.lineNo] }),
    scope: index('stock_delivery_lines_scope_idx').on(t.tenantId, t.itemId),
  }),
);

export const invoiceItemAttributes = pgTable(
  'invoice_item_attributes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    lineId: uuid('line_id').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
  },
  (t) => ({
    line: uniqueIndex('invoice_item_attributes_line_key').on(
      t.tenantId,
      t.documentType,
      t.documentId,
      t.lineId,
    ),
  }),
);

export const inventoryTables = {
  inventoryTransactions,
  stockBalances,
  stockAdjustments,
  stockAdjustmentLines,
  stockVouchers,
  stockVoucherLines,
  stockTransfers,
  stockTransferLines,
  goodsRequests,
  goodsRequestLines,
  stockDeliveries,
  stockDeliveryLines,
  itemLots,
  itemSerials,
  invoiceItemAttributes,
};
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;
export type StockBalance = typeof stockBalances.$inferSelect;
export type StockVoucher = typeof stockVouchers.$inferSelect;
export type StockVoucherLine = typeof stockVoucherLines.$inferSelect;
export type StockTransfer = typeof stockTransfers.$inferSelect;
export type GoodsRequest = typeof goodsRequests.$inferSelect;
export type GoodsRequestLine = typeof goodsRequestLines.$inferSelect;
export type StockDelivery = typeof stockDeliveries.$inferSelect;
export type StockDeliveryLine = typeof stockDeliveryLines.$inferSelect;
export type ItemLot = typeof itemLots.$inferSelect;
export type ItemSerial = typeof itemSerials.$inferSelect;

/**
 * أمر الإنتاج — components out, one finished item in. Ledger-neutral by construction:
 * `unit_cost` is the total component cost spread over the produced quantity, so the value
 * that leaves the warehouse is exactly the value that re-enters it.
 */
/**
 * Which serial number travelled on which document line — the desktop's
 * `InvoiceItemDetail.ItemSerialNo` (`Class/InvoiceOper.cs:1635`), kept as a relation
 * instead of a text column so that "which documents has this number been through?" is a
 * query and not a `LIKE`.
 */
export const stockDocumentSerials = pgTable(
  'stock_document_serials',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(),
    docId: uuid('doc_id').notNull(),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    serialId: uuid('serial_id')
      .notNull()
      .references(() => itemSerials.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    line: uniqueIndex('stock_document_serials_line_key').on(t.tenantId, t.docType, t.docId, t.lineNo, t.serialId),
    doc: uniqueIndex('stock_document_serials_doc_key').on(t.tenantId, t.docType, t.docId, t.serialId),
    serial: index('stock_document_serials_serial_idx').on(t.tenantId, t.serialId),
  }),
);

export const productionOrders = pgTable(
  'production_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    number: text('number').notNull(),
    orderDate: date('order_date').notNull(),
    status: text('status').notNull().default('draft'),
    outputItemId: uuid('output_item_id')
      .notNull()
      .references(() => items.id),
    outputQty: numeric('output_qty', qty).notNull(),
    /** 📄 رقم المرجع / 📅 تاريخ المرجع — the document this build answers. */
    referenceNo: text('reference_no'),
    referenceDate: date('reference_date'),
    /** 📐 الوحدة the produced quantity was counted in; null means the item's base unit. */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
    componentCost: numeric('component_cost', money).notNull().default('0'),
    unitCost: numeric('unit_cost', money).notNull().default('0'),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (t) => ({
    number: uniqueIndex('production_orders_tenant_number_key').on(t.tenantId, t.number),
    status: index('production_orders_status_idx').on(t.tenantId, t.status, t.orderDate),
    reference: index('production_orders_reference_idx')
      .on(t.tenantId, t.referenceNo)
      .where(isNotNull(t.referenceNo)),
  }),
);

export const productionOrderComponents = pgTable(
  'production_order_components',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => productionOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    qty: numeric('qty', qty).notNull(),
    unitCost: numeric('unit_cost', money).notNull().default('0'),
    lineCost: numeric('line_cost', money).notNull().default('0'),
    /** Unit the quantity was counted in; the movement is posted in base units. */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orderId, t.lineNo] }),
    item: index('production_order_components_item_idx').on(t.tenantId, t.itemId),
  }),
);

export type ProductionOrder = typeof productionOrders.$inferSelect;
export type ProductionOrderComponent = typeof productionOrderComponents.$inferSelect;
