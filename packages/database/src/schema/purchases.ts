import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns } from '../columns.js';

import { accounts, costCenters, journalEntries } from './accounting.js';
import { items, taxGroups } from './catalog.js';
import { itemLots } from './inventory.js';
import { branches, warehouses } from './organization.js';
import { parties } from './parties.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };
const qty = { precision: 20, scale: 4, mode: 'string' as const };

export const purchaseInvoices = pgTable('purchase_invoices', {
  id: uuid('id').primaryKey(),
  /**
   * R9 — 📊 مركز التكلفة على رأس الفاتورة (`frmInvPurch.xaml` L467): الافتراضي لكل سطرٍ
   * لا يذكر مركزاً، ويُوسم به القيد مع البند.
   */
  costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  warehouseId: uuid('warehouse_id').references(() => warehouses.id),
  partyId: uuid('party_id').notNull().references(() => parties.id),
  referenceInvoiceId: uuid('reference_invoice_id'),
  kind: text('kind').notNull().default('purchase'),
  status: text('status').notNull().default('draft'),
  number: text('number'),
  supplierReferenceNo: text('supplier_reference_no'),
  supplierReferenceDate: date('supplier_reference_date'),
  currency: text('currency').notNull().default('SAR'),
  priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
  landedCostAlloc: text('landed_cost_alloc'),
  invoiceDiscount: numeric('invoice_discount', money).notNull().default('0'),
  extraTax: numeric('extra_tax', money).notNull().default('0'),
  withholding: numeric('withholding', money).notNull().default('0'),
  subtotal: numeric('subtotal', money).notNull().default('0'),
  taxTotal: numeric('tax_total', money).notNull().default('0'),
  additionalCostTotal: numeric('additional_cost_total', money).notNull().default('0'),
  total: numeric('total', money).notNull().default('0'),
  paidTotal: numeric('paid_total', money).notNull().default('0'),
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  ...baseAuditColumns(),
  ...baseLegacyColumns(),
}, (t) => ({
  number: uniqueIndex('purchase_invoices_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL`),
  scope: index('purchase_invoices_scope_idx').on(t.tenantId, t.branchId, t.status),
  party: index('purchase_invoices_party_idx').on(t.tenantId, t.partyId),
  reference: index('purchase_invoices_reference_idx').on(t.tenantId, t.referenceInvoiceId),
}));

export const purchaseInvoiceLines = pgTable('purchase_invoice_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').notNull().references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  lineNo: integer('line_no').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  taxGroupId: uuid('tax_group_id').references(() => taxGroups.id),
  description: text('description'),
  quantity: numeric('quantity', qty).notNull(),
  unitPrice: numeric('unit_price', money).notNull(),
  discountRate: numeric('discount_rate', money).notNull().default('0'),
  discountAmount: numeric('discount_amount', money).notNull().default('0'),
  taxRate: numeric('tax_rate', money).notNull().default('0'),
  net: numeric('net', money).notNull().default('0'),
  tax: numeric('tax', money).notNull().default('0'),
  total: numeric('total', money).notNull().default('0'),
  allocatedCost: numeric('allocated_cost', money).notNull().default('0'),
  landedTotal: numeric('landed_total', money).notNull().default('0'),
  unitCostAtPost: numeric('unit_cost_at_post', money),
  /**
   * 📊 مركز تكلفة السطر — `Inv_Sub.ItemCostCenter` في الديسكتوب؛ وR9 بدأ **يكتبه** من
   * المُدخِل ويمرّره إلى القيد (كان العمود قائماً بلا كاتبٍ ولا قارئ).
   */
  costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
  /**
   * R8 — الأرقام الأربعة على سطر فاتورة الشراء كما على سطر البيع: الإدخال يقرأ العبوة
   * ويكتب ما عليها، والإدخال هو الذي **يُنشئ** الأرقام عند الترحيل (`item_serials`)،
   * والمرتجع يأخذها خارج الرفّ.
   */
  serialNos: jsonb('serial_nos').$type<string[]>().notNull().default([]),
  lotId: uuid('lot_id').references(() => itemLots.id, { onDelete: 'set null' }),
  batchNo: text('batch_no'),
  productionDate: date('production_date'),
  expiryDate: date('expiry_date'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...baseAuditColumns(),
}, (t) => ({
  line: uniqueIndex('purchase_invoice_lines_invoice_line_key').on(t.invoiceId, t.lineNo),
  scope: index('purchase_invoice_lines_scope_idx').on(t.tenantId, t.itemId),
  batch: index('purchase_invoice_lines_batch_idx').on(t.tenantId, t.itemId, t.batchNo),
}));

export const purchaseInvoiceCosts = pgTable('purchase_invoice_costs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').notNull().references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  costName: text('cost_name').notNull(),
  amount: numeric('amount', money).notNull(),
  allocationTarget: text('allocation_target').notNull().default('inventory'),
  costCenterId: uuid('cost_center_id'),
  accountId: uuid('account_id').references(() => accounts.id),
  ...baseAuditColumns(),
}, (t) => ({ invoice: index('purchase_invoice_costs_invoice_idx').on(t.tenantId, t.invoiceId) }));

/** Supplier credit/debit notes — the purchase mirror of `sales_adjustment_notes`. */
export const purchaseAdjustmentNotes = pgTable('purchase_adjustment_notes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').references(() => purchaseInvoices.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('draft'),
  number: text('number'),
  reason: text('reason').notNull(),
  amount: numeric('amount', money).notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  ...baseAuditColumns(),
}, (t) => ({
  number: uniqueIndex('purchase_adjustment_notes_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL`),
  invoice: index('purchase_adjustment_notes_invoice_idx').on(t.tenantId, t.invoiceId),
}));

export const purchaseTables = { purchaseInvoices, purchaseInvoiceLines, purchaseInvoiceCosts, purchaseAdjustmentNotes };
export type PurchaseInvoice = typeof purchaseInvoices.$inferSelect;
export type PurchaseInvoiceLine = typeof purchaseInvoiceLines.$inferSelect;
export type PurchaseInvoiceCost = typeof purchaseInvoiceCosts.$inferSelect;
export type PurchaseAdjustmentNote = typeof purchaseAdjustmentNotes.$inferSelect;
