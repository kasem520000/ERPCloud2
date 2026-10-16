import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { accounts, fiscalPeriods, fiscalYears } from './accounting.js';
import { tenants, users } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * 📊 M6.4 — الموازنات والمقارنة بالفعلي (migration 0131).
 *
 * A budget is a fiscal-year plan: per postable account, an amount per fiscal period.
 * The annual amount the accountant types is **distributed** across the year's periods
 * (even instalment, the last period carries the exact remainder — the same telescoping
 * rule the fixed-asset schedule uses), and a PATCH can replace the monthly lines
 * explicitly for seasonality while the budget is still a draft. Approving freezes the
 * lines: a budget people are measured against does not silently move.
 *
 * `budget-vs-actual` is computed, never stored: the "actual" side is the posted journal
 * movement of each account (the trial balance's own reading), signed by the account's
 * normal balance. No second balance exists to drift from the ledger.
 */
export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'restrict' }),
    /** مسودة ⇒ قابلة للتعديل؛ معتمدة ⇒ سطورها مجمدة والمقارنة تُقرأ عليها. */
    status: text('status').notNull().default('draft'),
    notes: text('notes'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    tenantYearName: uniqueIndex('budgets_tenant_year_name_key').on(t.tenantId, t.fiscalYearId, t.name),
    status: index('budgets_tenant_status_idx').on(t.tenantId, t.status),
  }),
);

/**
 * سطر الموازنة: مبلغ حسابٍ ما في فترة مالية. المجموع السنوي = Σ السطور — لا يُخزَّن
 * رقمٌ سنوي منفصل فيُنحرف عن السطور أبدًا.
 */
export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    amount: numeric('amount', money).notNull(),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (t) => ({
    line: uniqueIndex('budget_lines_budget_account_period_key').on(t.budgetId, t.accountId, t.fiscalPeriodId),
    account: index('budget_lines_tenant_account_idx').on(t.tenantId, t.accountId),
  }),
);

export type BudgetRow = typeof budgets.$inferSelect;
export type BudgetLineRow = typeof budgetLines.$inferSelect;
