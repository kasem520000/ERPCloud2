import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { accounts, fiscalPeriods, journalEntries } from './accounting.js';
import { branches } from './organization.js';
import { tenants, users } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * M6.1 — fixed assets (الأصول الثابتة): register, categories, depreciation schedule and
 * the posting runs that turn the schedule into journal entries.
 *
 * The module is isolated by design (IMPLEMENTATION_ROADMAP M6.1): it owns its tables and
 * reads the chart of accounts, but it NEVER writes the ledger directly — every posting
 * goes through `AccountingService.postJournalInTx`, so the GL invariants (balanced
 * entries, open-period check, module locks, sequences) stay in one place.
 *
 * `asset_depreciation_entries` is the run ledger, not a second balance: one row per
 * asset per month ever, each pointing at the journal entry that posted it — the unique
 * constraint `(tenant_id, asset_id, period)` IS the idempotency of the run.
 */
export const assetCategories = pgTable(
  'asset_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    /** عمر الإهلاك الافتراضي بالأشهر — الوريثة عند إنشاء أصل بلا عمر صريح. */
    defaultUsefulLifeMonths: integer('default_useful_life_months').notNull(),
    /** الحساب الأصلي (مدين عند الشراء) — من دليل الحسابات. */
    assetAccountId: uuid('asset_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** مجمع الإهلاك (دائن شهريًا). */
    accumulatedAccountId: uuid('accumulated_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** مصروف الإهلاك (مدين شهريًا). */
    depreciationAccountId: uuid('depreciation_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    codeKey: uniqueIndex('asset_categories_tenant_code_key').on(table.tenantId, table.code),
  }),
);

export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** تاريخ الاقتناء — شهره أول شهر إهلاك. */
    acquisitionDate: date('acquisition_date').notNull(),
    acquisitionCost: numeric('acquisition_cost', money).notNull(),
    salvageValue: numeric('salvage_value', money).notNull().default('0'),
    usefulLifeMonths: integer('useful_life_months').notNull(),
    method: text('method').notNull().default('straight_line'),
    status: text('status').notNull().default('active'),
    /** تجاوزات حسابات التصنيف — NULL يعني «حساب التصنيف». */
    assetAccountId: uuid('asset_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    accumulatedAccountId: uuid('accumulated_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    depreciationAccountId: uuid('depreciation_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    codeKey: uniqueIndex('fixed_assets_tenant_code_key').on(table.tenantId, table.code),
    statusIdx: index('fixed_assets_tenant_status_idx').on(table.tenantId, table.status),
    categoryIdx: index('fixed_assets_tenant_category_idx').on(table.tenantId, table.categoryId),
  }),
);

export const assetDepreciationEntries = pgTable(
  'asset_depreciation_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAssets.id, { onDelete: 'cascade' }),
    /** الشهر المحاسبي للإهلاك — `YYYY-MM`، مفتاح التكرار مع الأصل. */
    period: text('period').notNull(),
    depreciationDate: date('depreciation_date').notNull(),
    amount: numeric('amount', money).notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    fiscalPeriodId: uuid('fiscal_period_id').references(() => fiscalPeriods.id, {
      onDelete: 'restrict',
    }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetPeriodKey: uniqueIndex('asset_depreciation_entries_asset_period_key').on(
      table.tenantId,
      table.assetId,
      table.period,
    ),
    periodIdx: index('asset_depreciation_entries_tenant_period_idx').on(
      table.tenantId,
      table.period,
    ),
    journalIdx: index('asset_depreciation_entries_journal_idx').on(table.journalEntryId),
  }),
);

export type AssetCategoryRow = typeof assetCategories.$inferSelect;
export type FixedAssetRow = typeof fixedAssets.$inferSelect;
export type AssetDepreciationEntryRow = typeof assetDepreciationEntries.$inferSelect;
