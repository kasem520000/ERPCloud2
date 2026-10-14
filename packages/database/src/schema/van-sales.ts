import { sql } from 'drizzle-orm';
import {
  boolean,
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from './approvals.js';
import { items } from './catalog.js';
import {
  inventoryTransactions,
  itemLots,
  productionOrders,
  stockAdjustments,
  stockDeliveries,
  stockTransfers,
  stockVouchers,
} from './inventory.js';
import { journalEntries } from './accounting.js';
import { branches, warehouses } from './organization.js';
import { parties } from './parties.js';
import { tenants, users } from './platform.js';
import { salesInvoices, salesmen } from './sales.js';
import { vouchers } from './treasury.js';
import { manufacturingOrders } from './wms.js';

/**
 * طلبات تفعيل الإضافات والباقات القطاعية من سوق الإضافات (`0119`).
 */
export const marketplaceAddonRequests = pgTable(
  'marketplace_addon_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    appCode: text('app_code').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    decisionNote: text('decision_note'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    marketplaceAddonRequestsTenantIdx: index('marketplace_addon_requests_tenant_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    marketplaceAddonRequestsStatusIdx: index('marketplace_addon_requests_status_idx').on(
      table.status,
      table.createdAt,
    ),
  }),
);

/**
 * شرائح أسعار العملاء الخاصة، وتثبيت السعر، وسقف البونص، والحد الائتماني (`0119`–`0122`).
 */
export const vanSalesCustomerPrices = pgTable(
  'van_sales_customer_prices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    priceTierLabel: text('price_tier_label').notNull().default('شريحة جملة المخابز'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 4 }).notNull(),
    maxBonusPct: numeric('max_bonus_pct', { precision: 10, scale: 4 }).notNull().default('0'),
    maxBonusQty: numeric('max_bonus_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    maxBonusKgPerInvoice: numeric('max_bonus_kg_per_invoice', { precision: 18, scale: 4 })
      .notNull()
      .default('2.0000'),
    expectedDailyQty: numeric('expected_daily_qty', { precision: 20, scale: 4 })
      .notNull()
      .default('0'),
    preferNonZatca: boolean('prefer_non_zatca').notNull().default(false),
    preferredInvoiceMode: text('preferred_invoice_mode').notNull().default('zatca_tax'),
    creditLimit: numeric('credit_limit', { precision: 18, scale: 4 }).notNull().default('5000'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(15),
    lockPrice: boolean('lock_price').notNull().default(true),
    maxDiscountPct: numeric('max_discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    effectiveFrom: date('effective_from').notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date('effective_to'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    changeReason: text('change_reason'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    vanSalesCustomerPricesUnique: uniqueIndex('van_sales_customer_prices_unique').on(
      table.tenantId,
      table.partyId,
      table.itemId,
    ),
    vanSalesCustomerPricesTenantIdx: index('van_sales_customer_prices_tenant_idx').on(
      table.tenantId,
      table.partyId,
    ),
  }),
);

/**
 * سجل تأريخ وتدقيق تغييرات أسعار العملاء الخاصة (`0122`).
 */
export const vanSalesCustomerPriceHistory = pgTable(
  'van_sales_customer_price_history',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerPriceId: uuid('customer_price_id')
      .notNull()
      .references(() => vanSalesCustomerPrices.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    previousUnitPrice: numeric('previous_unit_price', { precision: 20, scale: 4 }),
    newUnitPrice: numeric('new_unit_price', { precision: 20, scale: 4 }).notNull(),
    maxBonusPct: numeric('max_bonus_pct', { precision: 10, scale: 4 }).notNull().default('0'),
    maxBonusKgPerInvoice: numeric('max_bonus_kg_per_invoice', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    maxDiscountPct: numeric('max_discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    lockPrice: boolean('lock_price').notNull().default(true),
    effectiveFrom: date('effective_from').notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date('effective_to'),
    changeReason: text('change_reason'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    vanSalesCustomerPriceHistoryTenantIdx: index('van_sales_customer_price_history_tenant_idx').on(
      table.tenantId,
      table.partyId,
      table.createdAt,
    ),
  }),
);

/**
 * دفعات الإنتاج اليومية للمصنع والمخبز (`0120`–`0122`).
 */
export const factoryProductionBatches = pgTable(
  'factory_production_batches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    batchNo: text('batch_no').notNull(),
    productionDate: date('production_date').notNull().default(sql`CURRENT_DATE`),
    /** 🏭 الفرع الذي أنتج الدفعة — يُستخدم في تحديد ملف الترحيل الرسمي للفرع (`0123`). */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    itemName: text('item_name').notNull().default('رقائق سمبوسة وفطائر طازجة'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),
    productionOrderId: uuid('production_order_id').references(() => productionOrders.id, {
      onDelete: 'set null',
    }),
    manufacturingOrderId: uuid('manufacturing_order_id').references(() => manufacturingOrders.id, {
      onDelete: 'set null',
    }),
    lotId: uuid('lot_id').references(() => itemLots.id, { onDelete: 'set null' }),
    inventoryTransactionId: uuid('inventory_transaction_id').references(
      () => inventoryTransactions.id,
      { onDelete: 'set null' },
    ),
    producedQty: numeric('produced_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    scrapQty: numeric('scrap_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    issuedQty: numeric('issued_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    returnedGoodQty: numeric('returned_good_qty', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    damagedQty: numeric('damaged_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('3.80'),
    totalCost: numeric('total_cost', { precision: 18, scale: 4 }).notNull().default('0'),
    status: text('status').notNull().default('active'),
    supervisorName: text('supervisor_name'),
    notes: text('notes'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    factoryProductionBatchesTenantIdx: index('factory_production_batches_tenant_idx').on(
      table.tenantId,
      table.productionDate,
      table.createdAt,
    ),
  }),
);

/**
 * أوامر تحميل وعهدة مناديب التوزيع (`0119`–`0122`).
 */
export const vanLoadOrders = pgTable(
  'van_load_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),
    vanWarehouseId: uuid('van_warehouse_id').references(() => warehouses.id, {
      onDelete: 'set null',
    }),
    stockTransferId: uuid('stock_transfer_id').references(() => stockTransfers.id, {
      onDelete: 'set null',
    }),
    returnTransferId: uuid('return_transfer_id').references(() => stockTransfers.id, {
      onDelete: 'set null',
    }),
    inventoryTxId: uuid('inventory_tx_id').references(() => inventoryTransactions.id, {
      onDelete: 'set null',
    }),
    returnInventoryTxId: uuid('return_inventory_tx_id').references(() => inventoryTransactions.id, {
      onDelete: 'set null',
    }),
    damageVoucherId: uuid('damage_voucher_id').references(() => stockVouchers.id, {
      onDelete: 'set null',
    }),
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    salesmanId: uuid('salesman_id')
      .notNull()
      .references(() => salesmen.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    number: text('number').notNull(),
    vehiclePlate: text('vehicle_plate'),
    loadDate: date('load_date').notNull().default(sql`CURRENT_DATE`),
    batchCode: text('batch_code').default('BATCH-DEFAULT'),
    productionBatchNo: text('production_batch_no').notNull().default('BATCH-DEFAULT'),
    loadedQty: numeric('loaded_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    receivedQty: numeric('received_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    discrepancyQty: numeric('discrepancy_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    discrepancyNotes: text('discrepancy_notes'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    actualRemainingQty: numeric('actual_remaining_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    /**
     * 🧾 تسوية المخزون (`0124`) — the official stocktake document that reconciles the van
     * balance with the rep's physical count. Quantity settlement lives here; the financial
     * responsibility for a shortage stays pending (`shortagePolicyStatus`).
     */
    stockAdjustmentId: uuid('stock_adjustment_id').references(() => stockAdjustments.id, {
      onDelete: 'set null',
    }),
    /** `return_to_main` · `carry_over` — what happened to the counted remainder. */
    remainingAction: text('remaining_action'),
    remainingInventoryTxId: uuid('remaining_inventory_tx_id').references(
      () => inventoryTransactions.id,
      { onDelete: 'set null' },
    ),
    /**
     * `not_required` · `pending_transit_decision` · `pending_count_decision` ·
     * `blocked_missing_accounts` · `settled_officially`.
     */
    stockSettlementStatus: text('stock_settlement_status').notNull().default('not_required'),
    stockSettlementNote: text('stock_settlement_note'),
    damageJournalEntryId: uuid('damage_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    loadedTotalValue: numeric('loaded_total_value', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    soldQty: numeric('sold_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    soldTaxQty: numeric('sold_tax_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    soldInternalQty: numeric('sold_internal_qty', { precision: 20, scale: 4 })
      .notNull()
      .default('0'),
    bonusQty: numeric('bonus_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    returnedQty: numeric('returned_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    damagedQty: numeric('damaged_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    shortageQty: numeric('shortage_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    shortageValue: numeric('shortage_value', { precision: 18, scale: 4 }).notNull().default('0'),
    shortagePolicyStatus: text('shortage_policy_status')
      .notNull()
      .default('pending_policy_approval'),
    maxBonusQty: numeric('max_bonus_qty', { precision: 20, scale: 4 }).notNull().default('5'),
    maxBonusPct: numeric('max_bonus_pct', { precision: 5, scale: 2 }).notNull().default('5.00'),
    unitCost: numeric('unit_cost', { precision: 20, scale: 4 }).notNull().default('0'),
    expectedCash: numeric('expected_cash', { precision: 18, scale: 4 }).notNull().default('0'),
    collectedCash: numeric('collected_cash', { precision: 18, scale: 4 }).notNull().default('0'),
    status: text('status').notNull().default('loaded'),
    damageReason: text('damage_reason'),
    damageInspected: boolean('damage_inspected').notNull().default(false),
    damageInspectedBy: uuid('damage_inspected_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    salaryDeductionApproved: boolean('salary_deduction_approved').notNull().default(false),
    closingNotes: text('closing_notes'),
    closingSubmittedAt: timestamp('closing_submitted_at', { withTimezone: true }),
    closingSubmittedBy: uuid('closing_submitted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    vanLoadOrdersTenantIdx: index('van_load_orders_tenant_idx').on(
      table.tenantId,
      table.loadDate,
      table.createdAt,
    ),
  }),
);

/**
 * فواتير ومستندات مبيعات التوزيع (`zatca_tax` أو `internal_delivery`) (`0119`–`0122`).
 */
export const vanSalesDocuments = pgTable(
  'van_sales_documents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    loadOrderId: uuid('load_order_id')
      .notNull()
      .references(() => vanLoadOrders.id, { onDelete: 'cascade' }),
    salesmanId: uuid('salesman_id')
      .notNull()
      .references(() => salesmen.id, { onDelete: 'restrict' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    customerName: text('customer_name'),
    customerMobile: text('customer_mobile'),
    customerTaxNo: text('customer_tax_no'),
    /** نوع المستند: `sale` فاتورة بيع، أو `return` مرتجع عميل referencing the source sale (`0123`). */
    documentKind: text('document_kind').notNull().default('sale'),
    /** المستند الأصلي عندما يكون هذا المستند مرتجع عميل (`0123`). */
    referenceDocumentId: uuid('reference_document_id').references(
      (): AnyPgColumn => vanSalesDocuments.id,
      { onDelete: 'set null' },
    ),
    docMode: text('doc_mode').notNull().default('zatca_tax'),
    invoiceMode: text('invoice_mode').notNull().default('zatca_tax'),
    taxPolicyStatus: text('tax_policy_status').notNull().default('standard_vat'),
    paymentMethod: text('payment_method').notNull().default('cash'),
    docDate: date('doc_date').notNull().default(sql`CURRENT_DATE`),
    number: text('number').notNull(),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    batchCode: text('batch_code').default('BATCH-DEFAULT'),
    productionBatchNo: text('production_batch_no').notNull().default('BATCH-DEFAULT'),
    soldQty: numeric('sold_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    bonusQty: numeric('bonus_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    bonusReason: text('bonus_reason'),
    bonusApproved: boolean('bonus_approved').notNull().default(true),
    customerPin: text('customer_pin'),
    customerBonusConfirmed: boolean('customer_bonus_confirmed').notNull().default(false),
    customerConfirmationCode: text('customer_confirmation_code'),
    bonusAnomaly: boolean('bonus_anomaly').notNull().default(false),
    anomalyReason: text('anomaly_reason'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 4 }).notNull().default('0'),
    discountAmount: numeric('discount_amount', { precision: 18, scale: 4 }).notNull().default('0'),
    discountReason: text('discount_reason'),
    discountApprovedBy: uuid('discount_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull().default('0'),
    taxRate: numeric('tax_rate', { precision: 10, scale: 4 }).notNull().default('15.00'),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    paidAmount: numeric('paid_amount', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('3.80'),
    netProfit: numeric('net_profit', { precision: 18, scale: 4 }).notNull().default('0'),
    qrPayload: text('qr_payload').default(''),
    zatcaQrTlv: text('zatca_qr_tlv'),
    salesInvoiceId: uuid('sales_invoice_id').references(() => salesInvoices.id, {
      onDelete: 'set null',
    }),
    receiptVoucherId: uuid('receipt_voucher_id').references(() => vouchers.id, {
      onDelete: 'set null',
    }),
    stockDeliveryId: uuid('stock_delivery_id').references(() => stockDeliveries.id, {
      onDelete: 'set null',
    }),
    inventoryTxId: uuid('inventory_tx_id').references(() => inventoryTransactions.id, {
      onDelete: 'set null',
    }),
    anomalyFlags: jsonb('anomaly_flags').$type<string[]>().notNull().default([]),
    notes: text('notes'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    vanSalesDocumentsTenantIdx: index('van_sales_documents_tenant_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  }),
);

/**
 * سجل التدقيق وحركة بضاعة وعهد المناديب (`0120`–`0122`).
 */
export const vanStockMovements = pgTable(
  'van_stock_movements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    movementType: text('movement_type').notNull(),
    batchNo: text('batch_no'),
    loadOrderId: uuid('load_order_id').references(() => vanLoadOrders.id, {
      onDelete: 'set null',
    }),
    salesmanId: uuid('salesman_id').references(() => salesmen.id, { onDelete: 'set null' }),
    partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }),
    inventoryTransactionId: uuid('inventory_transaction_id').references(
      () => inventoryTransactions.id,
      { onDelete: 'set null' },
    ),
    voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }),
    qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull().default('0'),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull().default('0'),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    vanStockMovementsTenantIdx: index('van_stock_movements_tenant_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  }),
);

export type MarketplaceAddonRequest = typeof marketplaceAddonRequests.$inferSelect;
export type VanSalesCustomerPrice = typeof vanSalesCustomerPrices.$inferSelect;
export type VanSalesCustomerPriceHistory = typeof vanSalesCustomerPriceHistory.$inferSelect;
export type FactoryProductionBatch = typeof factoryProductionBatches.$inferSelect;
export type VanLoadOrder = typeof vanLoadOrders.$inferSelect;
export type VanSalesDocument = typeof vanSalesDocuments.$inferSelect;
export type VanStockMovement = typeof vanStockMovements.$inferSelect;

