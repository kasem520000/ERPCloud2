import { sql } from 'drizzle-orm';
import { date, index, integer, jsonb, numeric, pgTable, primaryKey, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { accounts, costCenters, journalEntries, fiscalPeriods } from './accounting.js';
import { employees } from './hrm.js';
import { branches, cashLocations } from './organization.js';
import { parties } from './parties.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

export const vouchers = pgTable('vouchers', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id),
  kind: text('kind').notNull(), subtype: text('subtype').notNull(), number: text('number'), date: date('date').notNull(), partyId: uuid('party_id').references(() => parties.id), counterAccountId: uuid('counter_account_id').references(() => accounts.id), cashLocationId: uuid('cash_location_id').notNull().references(() => cashLocations.id), method: text('method').notNull(), amount: numeric('amount', money).notNull(), vatAmount: numeric('vat_amount', money).notNull().default('0'), netAmount: numeric('net_amount', money).notNull().default('0'), currency: text('currency').notNull().default('SAR'), fxRate: numeric('fx_rate', { precision: 20, scale: 10 }), chequeNo: text('cheque_no'), chequeDate: date('cheque_date'), bankName: text('bank_name'), chequeState: text('cheque_state'), costCenterId: uuid('cost_center_id').references(() => costCenters.id), referenceNo: text('reference_no'), referenceDate: date('reference_date'), recipient: text('recipient'),
  /**
   * 📝 البيان — `Receipts.Notes` in the desktop, which `BindReceiptToEntry` copies onto
   * the journal entry (`entry.Note = Receipt.Notes`). Without it a posted receipt reads
   * `receipt voucher RV-000004` in the ledger, which tells an auditor nothing.
   */
  description: text('description'),
  /** ⏰ الوقت — the desktop stores date *and* time; حركة الصندوق filters by both. */
  voucherTime: time('voucher_time'),
  /** 👔 المندوب — `Receipts.SalesManID`, carried onto the journal line by the desktop. */
  salesmanId: uuid('salesman_id').references(() => employees.id, { onDelete: 'set null' }),
  /** 💲 قيمة السند بالعملة الأجنبية — as counted in `currency`; `amount` stays in base. */
  foreignAmount: numeric('foreign_amount', money), status: text('status').notNull().default('draft'), journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id), fiscalPeriodId: uuid('fiscal_period_id').references(() => fiscalPeriods.id), postedAt: timestamp('posted_at', { withTimezone: true }), voidedAt: timestamp('voided_at', { withTimezone: true }), idempotencyKey: text('idempotency_key'), ...baseAuditColumns(), ...baseLegacyColumns(),
}, (t) => ({ number: uniqueIndex('vouchers_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL`), idem: uniqueIndex('vouchers_tenant_idempotency_key').on(t.tenantId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`), scope: index('vouchers_scope_idx').on(t.tenantId, t.branchId, t.status, t.kind), cash: index('vouchers_cash_idx').on(t.tenantId, t.cashLocationId, t.postedAt),
    /** حركة الصندوق (frmRptKhzna): one location between two dates, oldest first. */
    statement: index('vouchers_location_date_idx')
      .on(t.tenantId, t.cashLocationId, t.date, t.voucherTime)
      .where(sql`status = 'posted'`),
    salesman: index('vouchers_salesman_idx').on(t.tenantId, t.salesmanId).where(sql`salesman_id IS NOT NULL`) }));

/**
 * 👤 مسئولي الصندوق — the desktop's `Stock_Emps (stock_id, emp_id)`.
 *
 * `frmTreasury.xaml.cs:222` refuses to save a الصندوق with no responsible employee and
 * replaces the whole set inside the treasury's own transaction. A box is a physical
 * thing; the signature is what makes its balance somebody's answer.
 */
export const cashLocationCustodians = pgTable(
  'cash_location_custodians',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cashLocationId: uuid('cash_location_id')
      .notNull()
      .references(() => cashLocations.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    ...baseAuditColumns(),
  },
  (table) => ({
    one: uniqueIndex('cash_location_custodians_key').on(
      table.tenantId,
      table.cashLocationId,
      table.employeeId,
    ),
    employee: index('cash_location_custodians_employee_idx').on(table.tenantId, table.employeeId),
  }),
);

export const cashTransfers = pgTable('cash_transfers', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id), fromCashLocationId: uuid('from_cash_location_id').notNull().references(() => cashLocations.id), toCashLocationId: uuid('to_cash_location_id').notNull().references(() => cashLocations.id), number: text('number'), amount: numeric('amount', money).notNull(), currency: text('currency').notNull().default('SAR'), status: text('status').notNull().default('draft'), sentJournalEntryId: uuid('sent_journal_entry_id').references(() => journalEntries.id), receivedJournalEntryId: uuid('received_journal_entry_id').references(() => journalEntries.id), sentAt: timestamp('sent_at', { withTimezone: true }), receivedAt: timestamp('received_at', { withTimezone: true }), ...baseAuditColumns(), ...baseLegacyColumns() }, (t) => ({ number: uniqueIndex('cash_transfers_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL`), scope: index('cash_transfers_scope_idx').on(t.tenantId, t.status) }));

export const expenseTypes = pgTable('expense_types', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), nameAr: text('name_ar').notNull(), nameEn: text('name_en'), accountId: uuid('account_id').notNull().references(() => accounts.id), costCenterId: uuid('cost_center_id').references(() => costCenters.id), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns() }, (t) => ({ name: uniqueIndex('expense_types_tenant_name_key').on(t.tenantId, t.nameAr).where(sql`deleted_at IS NULL`) }));

export const shiftCloses = pgTable('shift_closes', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id), userId: uuid('user_id').notNull(), openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(), closedAt: timestamp('closed_at', { withTimezone: true }), status: text('status').notNull().default('open'),
  /**
   * 🔢 الرقم — `frmCloseShift.xaml`'s first column (`CasherClosed.ClosedID`).
   * Allocated when the drawer is *closed*, from the tenant's document sequence, so an
   * open shift — a draft — has none until it is counted (migration 0042).
   */
  number: text('number'),
  /**
   * 📒 القيد — `Class/EntryOper.cs` `BindCloseShiftToEntry` hangs the close's entry on the
   * close's own number. In the cloud the entry carries only what the *count* revealed
   * (📉 الفرق), because sales, VAT and the bank legs were posted per invoice; NULL means
   * the drawer balanced, or was never posted (migration 0043).
   */
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  expectedCash: numeric('expected_cash', money).notNull().default('0'), countedCash: numeric('counted_cash', money).notNull().default('0'), diff: numeric('diff', money).notNull().default('0'), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), reportHtml: text('report_html'), ...baseAuditColumns() }, (t) => ({ open: uniqueIndex('shift_closes_one_open_key').on(t.tenantId, t.branchId, t.userId).where(sql`status = 'open'`),
    number: uniqueIndex('shift_closes_number_key').on(t.tenantId, t.number).where(sql`${t.number} IS NOT NULL`), scope: index('shift_closes_scope_idx').on(t.tenantId, t.branchId, t.status) }));

export const shiftCloseLines = pgTable('shift_close_lines', { shiftCloseId: uuid('shift_close_id').notNull().references(() => shiftCloses.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), kind: text('kind').notNull(), method: text('method'), partyId: uuid('party_id').references(() => parties.id), amount: numeric('amount', money).notNull().default('0'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}) }, (t) => ({ pk: primaryKey({ columns: [t.shiftCloseId, t.lineNo] }) }));

export const cashCountLines = pgTable('cash_count_lines', { shiftCloseId: uuid('shift_close_id').notNull().references(() => shiftCloses.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), currencyCode: text('currency_code').notNull().default('SAR'), denomination: numeric('denomination', money).notNull(), count: integer('count').notNull(), total: numeric('total', money).notNull() }, (t) => ({ pk: primaryKey({ columns: [t.shiftCloseId, t.lineNo] }) }));

export const treasuryTables = { vouchers, cashLocationCustodians, cashTransfers, expenseTypes, shiftCloses, shiftCloseLines, cashCountLines };
export type Voucher = typeof vouchers.$inferSelect;
export type CashTransfer = typeof cashTransfers.$inferSelect;
export type ShiftClose = typeof shiftCloses.$inferSelect;
