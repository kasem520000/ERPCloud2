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

import { baseAuditColumns } from '../columns.js';

import { accounts, costCenters } from './accounting.js';
import { vouchers } from './treasury.js';
import { files } from './platform-services.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * Bank feeds — future-enhancement 01.
 *
 * A bank account is deliberately separate from `cash_locations`: the latter is the
 * operational till/bank master used by vouchers, while this table is the identity of a
 * statement feed and may point at the ledger account used by reconciliation.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bankName: text('bank_name').notNull(),
    accountNo: text('account_no'),
    iban: text('iban'),
    currency: text('currency').notNull().default('SAR'),
    openingBalance: numeric('opening_balance', money).notNull().default('0'),
    /** The chart-of-accounts leaf used for the book-side reconciliation balance. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    ...baseAuditColumns(),
  },
  (table) => ({
    scope: index('bank_accounts_tenant_idx').on(table.tenantId),
    iban: uniqueIndex('bank_accounts_tenant_iban_key')
      .on(table.tenantId, table.iban)
      .where(sql`iban IS NOT NULL`),
    accountNo: index('bank_accounts_tenant_account_no_idx').on(table.tenantId, table.accountNo),
  }),
);

export const bankStatements = pgTable(
  'bank_statements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    openingBalance: numeric('opening_balance', money),
    closingBalance: numeric('closing_balance', money),
    status: text('status').notNull().default('processed'),
    sourceFileName: text('source_file_name'),
    rowCount: integer('row_count').notNull().default(0),
    error: text('error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...baseAuditColumns(),
  },
  (table) => ({
    scope: index('bank_statements_tenant_account_period_idx').on(
      table.tenantId,
      table.bankAccountId,
      table.periodFrom,
      table.periodTo,
    ),
    file: uniqueIndex('bank_statements_file_key')
      .on(table.tenantId, table.fileId)
      .where(sql`file_id IS NOT NULL`),
  }),
);

export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatements.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    txnDate: date('txn_date').notNull(),
    description: text('description').notNull().default(''),
    reference: text('reference'),
    amount: numeric('amount', money).notNull(),
    balance: numeric('balance', money),
    matchedVoucherId: uuid('matched_voucher_id').references(() => vouchers.id, { onDelete: 'set null' }),
    /** A UUID without an FK because it can refer to either sales or purchase invoices. */
    matchedInvoiceId: uuid('matched_invoice_id'),
    matchedInvoiceType: text('matched_invoice_type'),
    matchConfidence: numeric('match_confidence', { precision: 5, scale: 4 }),
    matchReason: text('match_reason'),
    suggestedAccountId: uuid('suggested_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    suggestedCostCenterId: uuid('suggested_cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    matchedBy: uuid('matched_by'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
  },
  (table) => ({
    line: uniqueIndex('bank_statement_lines_statement_line_key').on(table.statementId, table.lineNo),
    scope: index('bank_statement_lines_tenant_status_idx').on(table.tenantId, table.status),
    date: index('bank_statement_lines_statement_date_idx').on(table.statementId, table.txnDate),
    voucher: index('bank_statement_lines_matched_voucher_idx').on(table.tenantId, table.matchedVoucherId),
    invoice: index('bank_statement_lines_matched_invoice_idx').on(table.tenantId, table.matchedInvoiceId),
  }),
);

export const bankReconciliationRules = pgTable(
  'bank_reconciliation_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    keyword: text('keyword').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
    priority: integer('priority').notNull().default(100),
    status: text('status').notNull().default('active'),
    ...baseAuditColumns(),
  },
  (table) => ({
    keyword: uniqueIndex('bank_reconciliation_rules_tenant_keyword_key').on(table.tenantId, table.keyword),
    priority: index('bank_reconciliation_rules_priority_idx').on(table.tenantId, table.priority),
  }),
);

export const bankingTables = {
  bankAccounts,
  bankStatements,
  bankStatementLines,
  bankReconciliationRules,
};

export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankReconciliationRule = typeof bankReconciliationRules.$inferSelect;
