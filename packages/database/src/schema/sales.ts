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
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns } from '../columns.js';

import { branches, warehouses } from './organization.js';
import { items, taxGroups } from './catalog.js';
import { itemLots } from './inventory.js';
import { costCenters } from './accounting.js';
import { parties } from './parties.js';
import { tenants } from './platform.js';
import { shiftCloses } from './treasury.js';
import { employees } from './hrm.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };
const qty = { precision: 20, scale: 4, mode: 'string' as const };
/** نسبة مئوية — a commission percentage: 15 means «15%», four decimals like the desktop's `decimal`. */
const percent = { precision: 9, scale: 4, mode: 'string' as const };

export const salesInvoices = pgTable(
  'sales_invoices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    referenceInvoiceId: uuid('reference_invoice_id'),
    partyId: uuid('party_id').references(() => parties.id),
    salesmanId: uuid('salesman_id'),
    /**
     * R9 — 📊 مركز التكلفة على رأس الفاتورة كلها (`Invoices.CCcode` في الديسكتوب، من قائمة
     * «📊 مركز التكلفة:» في `frmInvSale.xaml` L530). هو **الافتراضي**: سطرٌ لا يذكر مركزاً
     * يأخذه عند وسم القيد (`InvoiceOper.cs` L2461)، وسطرٌ يذكر مركزاً يسبقه (L2432).
     */
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('sale'),
    validUntil: date('valid_until'),
    convertedInvoiceId: uuid('converted_invoice_id'),
    status: text('status').notNull().default('draft'),
    number: text('number'),
    currency: text('currency').notNull().default('SAR'),
    priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
    cashCustomerName: text('cash_customer_name'),
    cashCustomerMobile: text('cash_customer_mobile'),
    invoiceDiscount: numeric('invoice_discount', money).notNull().default('0'),
    extraTax: numeric('extra_tax', money).notNull().default('0'),
    withholding: numeric('withholding', money).notNull().default('0'),
    subtotal: numeric('subtotal', money).notNull().default('0'),
    taxTotal: numeric('tax_total', money).notNull().default('0'),
    total: numeric('total', money).notNull().default('0'),
    paidTotal: numeric('paid_total', money).notNull().default('0'),
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    costTotal: numeric('cost_total', money).notNull().default('0'),
    profit: numeric('profit', money).notNull().default('0'),
    zatcaUuid: uuid('zatca_uuid'),
    zatcaHash: text('zatca_hash'),
    zatcaQr: text('zatca_qr'),
    zatcaStatus: text('zatca_status'),
    orderType: text('order_type'),
    tableNo: text('table_no'),
    combinedInto: uuid('combined_into'),
    /**
     * The open cashier shift that captured this sale (migration 0033). NULL for
     * back-office invoices and for till sales made with no shift open — the shift
     * closing report falls back to the branch + time window for those.
     */
    shiftId: uuid('shift_id').references(() => shiftCloses.id, { onDelete: 'set null' }),
    /**
     * الكاشير الذي قبض — migration 0087. `created_by` يقول مَن كتب المستند، وهذا يقول
     * مَن كان على الصندوق؛ وهما يفترقان في ورديةٍ ينوب فيها مشرفٌ عن كاشير: الديسكتوب
     * يخزّن `Entry.emp` لكل فاتورة، و`CasherClosed.UserId` للوردية وحدها.
     */
    cashierId: uuid('cashier_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    number: uniqueIndex('sales_invoices_tenant_number_key')
      .on(t.tenantId, t.number)
      .where(sql`number IS NOT NULL`),
    scope: index('sales_invoices_scope_idx').on(t.tenantId, t.branchId, t.status),
    party: index('sales_invoices_party_idx').on(t.tenantId, t.partyId),
    shift: index('sales_invoices_shift_idx').on(t.tenantId, t.shiftId),
    cashier: index('sales_invoices_cashier_idx').on(t.tenantId, t.cashierId),
  }),
);

export const salesInvoiceLines = pgTable(
  'sales_invoice_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => salesInvoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id').references(() => items.id),
    taxGroupId: uuid('tax_group_id').references(() => taxGroups.id),
    description: text('description'),
    modifiers: jsonb('modifiers').$type<Array<Record<string, unknown>>>().notNull().default([]),
    quantity: numeric('quantity', qty).notNull(),
    unitPrice: numeric('unit_price', money).notNull(),
    discountRate: numeric('discount_rate', money).notNull().default('0'),
    discountAmount: numeric('discount_amount', money).notNull().default('0'),
    taxRate: numeric('tax_rate', money).notNull().default('0'),
    net: numeric('net', money).notNull().default('0'),
    tax: numeric('tax', money).notNull().default('0'),
    total: numeric('total', money).notNull().default('0'),
    costTotal: numeric('cost_total', money).notNull().default('0'),
    /**
     * R8 — الأرقام الأربعة على **سطر الفاتورة** كما في الديسكتوب
     * (`Class/InvoiceOper.cs` L1635: `ItemSerialNo`, `BatchNo`, `ItemProductionDate`,
     * `ItemExpireDate`). `serial_nos` يحفظ ما كتبه المُدخِل (أو مسحه) حتى في المسودّة
     * بلا اختراع صفوفٍ في `item_serials` لبضاعةٍ لم تُرحَّل بعد، و`lot_id` يُحسم عند
     * الترحيل (`resolveUploadedLots`) حين تُبحث الدفعة أو تُنشأ.
     */
    serialNos: jsonb('serial_nos').$type<string[]>().notNull().default([]),
    lotId: uuid('lot_id').references(() => itemLots.id, { onDelete: 'set null' }),
    /**
     * R9 — 📊 مركز تكلفة **السطر** (`Inv_Sub.ItemCostCenter`، `Class/InvoiceOper.cs` L1635):
     * يسبق مركز الرأس عند وسم قيد الفاتورة (L2432)، والرأس افتراضيّ لمن لم يذكر مركزاً (L2461).
     */
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
    batchNo: text('batch_no'),
    productionDate: date('production_date'),
    expiryDate: date('expiry_date'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
  },
  (t) => ({
    number: uniqueIndex('sales_invoice_lines_invoice_line_key').on(t.invoiceId, t.lineNo),
    scope: index('sales_invoice_lines_scope_idx').on(t.tenantId, t.itemId),
    batch: index('sales_invoice_lines_batch_idx').on(t.tenantId, t.itemId, t.batchNo),
  }),
);

export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => salesInvoices.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    amount: numeric('amount', money).notNull(),
    cashLocationId: uuid('cash_location_id'),
    reference: text('reference'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => ({
    idem: uniqueIndex('invoice_payments_tenant_idempotency_key').on(t.tenantId, t.idempotencyKey),
    invoice: index('invoice_payments_invoice_idx').on(t.tenantId, t.invoiceId),
  }),
);
export const salesAdjustmentNotes = pgTable(
  'sales_adjustment_notes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').references(() => salesInvoices.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('draft'),
    number: text('number'),
    reason: text('reason').notNull(),
    amount: numeric('amount', money).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (t) => ({
    number: uniqueIndex('sales_adjustment_notes_tenant_number_key')
      .on(t.tenantId, t.number)
      .where(sql`number IS NOT NULL`),
  }),
);
export const offers = pgTable(
  'offers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('active'),
    targetType: text('target_type').notNull().default('quantity'),
    targetValue: numeric('target_value', qty).notNull().default('0'),
    discountType: text('discount_type').notNull().default('percent'),
    discountValue: numeric('discount_value', money).notNull().default('0'),
    ...baseAuditColumns(),
  },
  (t) => ({
    code: uniqueIndex('offers_tenant_code_key').on(t.tenantId, t.code),
    scope: index('offers_validity_idx').on(t.tenantId, t.validFrom, t.validTo),
  }),
);
export const offerItems = pgTable(
  'offer_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    ...baseAuditColumns(),
  },
  (t) => ({ key: uniqueIndex('offer_items_offer_item_key').on(t.tenantId, t.offerId, t.itemId) }),
);
export const offerParties = pgTable(
  'offer_parties',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    ...baseAuditColumns(),
  },
  (t) => ({ key: uniqueIndex('offer_parties_offer_party_key').on(t.tenantId, t.offerId, t.partyId) }),
);
/**
 * 🧑‍💼 المندوب — `Form_WPF/frmSalesMen.xaml` («شاشة المندوبين»).
 *
 * The desktop's card is a name, three commission percentages and three contacts
 * (`frmSalesMen.xaml.cs` L155 `btnSave_Click` writes
 * `name, comm, tel, mobile, email, notes, Profit_Comm, Colle_Comm`). The three rates
 * are what `frmInvBySalesMen.xaml.cs` reads back on every document it prints
 * (L295 `SELECT comm, name, Profit_Comm, Colle_Comm FROM salesmen`).
 *
 * `employeeId` is the cloud's own bridge: a فاتورة names this card
 * (`sales_invoices.salesman_id`) while a سند قبض names the employee card
 * (`vouchers.salesman_id`), and the desktop joins both to one `salesmen` table. See
 * migration 0052.
 */
export const salesmen = pgTable(
  'salesmen',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    employeeRef: text('employee_ref'),
    active: boolean('active').notNull().default(true),
    /** عمولة المبيعات — `salesmen.comm`. */
    commissionRate: numeric('commission_rate', percent).notNull().default('0'),
    /** عمولة التحصيل — `salesmen.Colle_Comm`. */
    collectionCommissionRate: numeric('collection_commission_rate', percent).notNull().default('0'),
    /** عمولة الربح — `salesmen.Profit_Comm`. */
    profitCommissionRate: numeric('profit_commission_rate', percent).notNull().default('0'),
    /** بطاقة الموظف — the employee card this مندوب is, when he has one. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    /** 🚐 مستودع المندوب / السيارة المخصص لتوزيع المندوب. */
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),
    /** رقم لوحة سيارة التوزيع */
    vehiclePlate: text('vehicle_plate'),
    /** 📞 الهاتف */
    tel: text('tel'),
    /** 📱 الجوال */
    mobile: text('mobile'),
    /** 📧 البريد الإلكتروني */
    email: text('email'),
    /** ملاحظات */
    notes: text('notes'),
    ...baseAuditColumns(),
  },
  (t) => ({
    name: uniqueIndex('salesmen_tenant_name_key').on(t.tenantId, t.name),
    employee: uniqueIndex('salesmen_tenant_employee_key')
      .on(t.tenantId, t.employeeId)
      .where(sql`employee_id IS NOT NULL`),
    active: index('salesmen_tenant_active_idx').on(t.tenantId, t.name).where(sql`active`),
  }),
);

export const salesTables = {
  salesInvoices,
  salesInvoiceLines,
  invoicePayments,
  salesAdjustmentNotes,
  offers,
  offerItems,
  offerParties,
  salesmen,
};
export type SalesInvoice = typeof salesInvoices.$inferSelect;
export type SalesInvoiceLine = typeof salesInvoiceLines.$inferSelect;
