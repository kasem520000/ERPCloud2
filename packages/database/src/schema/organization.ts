import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { files } from './platform-services.js';
import { tenants } from './platform.js';

/**
 * Organization — DATABASE_DESIGN §5 (+ `currencies` / `fx_rates` from §3).
 *
 * The structural backbone every later module hangs off: who the tenant is
 * (`company_profiles`), where it operates (`branches`, `warehouses`, `cash_locations`),
 * in which money (`currencies`, `fx_rates`, `price_lists`) and how documents map to the
 * chart of accounts (`branch_posting_profiles`).
 *
 * Two deliberate deferrals, both carried by PHASE_05 §4/§6 and visible in the column
 * comments below:
 *
 * - **No FK to `accounts`.** That table arrives in PHASE_07; the columns are validated
 *   uuids until then (`ValidatedAtRuntime: P07`).
 * - **No FK from `price_list_items.item_id` to `items`.** That table arrives in
 *   PHASE_06.
 *
 * Soft delete (`deleted_at`) applies to master data only, and every uniqueness rule is
 * therefore a *partial* index that ignores deleted rows — otherwise a deleted branch
 * would keep its code hostage forever (PROJECT_CONTRACT §5).
 */

export const companyProfiles = pgTable(
  'company_profiles',
  {
    /** PK is the tenant: exactly one profile per tenant, so the endpoint is an upsert. */
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    taxNo: text('tax_no'),
    crNo: text('cr_no'),
    logoFileId: uuid('logo_file_id').references(() => files.id, { onDelete: 'set null' }),
    /** ZATCA national address (plot, building, street, addStreet, district, city, postal). */
    address: jsonb('address').$type<Record<string, unknown>>(),
    phones: jsonb('phones').$type<string[]>().notNull().default([]),
    email: text('email'),
    countryCode: char('country_code', { length: 2 }),
    einvoiceFlags: jsonb('einvoice_flags').$type<Record<string, boolean>>().notNull().default({}),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    companyProfilesLogoIdx: index('company_profiles_logo_file_idx').on(table.logoFileId),
  }),
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    address: jsonb('address').$type<Record<string, unknown>>(),
    phone: text('phone'),
    mobile: text('mobile'),
    email: text('email'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    branchesCodeKey: uniqueIndex('branches_tenant_code_key')
      .on(table.tenantId, table.code)
      .where(sql`deleted_at IS NULL`),
    branchesDefaultKey: uniqueIndex('branches_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default AND deleted_at IS NULL`),
    branchesActiveIdx: index('branches_tenant_active_idx').on(table.tenantId, table.isActive),
    branchesLegacyKey: uniqueIndex('branches_tenant_legacy_key')
      .on(table.tenantId, table.legacySource, table.legacyId)
      .where(sql`legacy_id IS NOT NULL`),
  }),
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** ValidatedAtRuntime: P07 — FK added when `accounts` exists. */
    inventoryAccountId: uuid('inventory_account_id'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    warehousesCodeKey: uniqueIndex('warehouses_tenant_code_key')
      .on(table.tenantId, table.code)
      .where(sql`deleted_at IS NULL`),
    warehousesDefaultKey: uniqueIndex('warehouses_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default AND deleted_at IS NULL`),
    warehousesBranchIdx: index('warehouses_tenant_branch_idx').on(table.tenantId, table.branchId),
    warehousesLegacyKey: uniqueIndex('warehouses_tenant_legacy_key')
      .on(table.tenantId, table.legacySource, table.legacyId)
      .where(sql`legacy_id IS NOT NULL`),
  }),
);

export const cashLocations = pgTable(
  'cash_locations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    /** `safe` | `bank` — the legacy `Safes` / `Banks` split (DOMAIN_MODEL §3). */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /**
     * ValidatedAtRuntime: P07. DATABASE_DESIGN §5 specifies NOT NULL + FK to `accounts`;
     * the column is nullable in PHASE_05 because no chart of accounts exists yet and a
     * tenant must still be provisioned with a default safe (CR-006). PHASE_07 adds the
     * FK and the NOT NULL.
     */
    accountId: uuid('account_id'),
    /** NULL = the tenant's base currency. */
    currencyCode: char('currency_code', { length: 3 }),
    isDefault: boolean('is_default').notNull().default(false),
    /** `{ bankName, iban, swift, accountNo }` — bank rows only. */
    bank: jsonb('bank').$type<Record<string, unknown>>(),
    /** Legacy `Banks.ChangeInPOS`: this location may give change at the POS. */
    changeInPos: boolean('change_in_pos').notNull().default(false),
    /** 📝 ملاحظات — the note `frmTreasury.xaml` keeps in its own group box. */
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    /** One default *per kind*: a tenant has a default safe and a default bank. */
    cashLocationsDefaultKey: uniqueIndex('cash_locations_tenant_kind_default_key')
      .on(table.tenantId, table.kind)
      .where(sql`is_default AND deleted_at IS NULL`),
    cashLocationsBranchIdx: index('cash_locations_tenant_branch_idx').on(
      table.tenantId,
      table.branchId,
      table.kind,
    ),
    cashLocationsLegacyKey: uniqueIndex('cash_locations_tenant_legacy_key')
      .on(table.tenantId, table.legacySource, table.legacyId)
      .where(sql`legacy_id IS NOT NULL`),
  }),
);

/**
 * Denormalised money-on-hand per location and currency (legacy
 * `Currency_SafeBalance`). DATABASE_DESIGN §5 is explicit that the **truth is the
 * journal**: writers arrive with the treasury module in PHASE_12 and a report
 * reconciles this cache. PHASE_05 only ever seeds zeros and reads.
 */
export const cashLocationBalances = pgTable(
  'cash_location_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cashLocationId: uuid('cash_location_id')
      .notNull()
      .references(() => cashLocations.id, { onDelete: 'cascade' }),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    balance: numeric('balance', { precision: 20, scale: 4 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    cashLocationBalancesPk: primaryKey({ columns: [table.cashLocationId, table.currencyCode] }),
    cashLocationBalancesTenantIdx: index('cash_location_balances_tenant_idx').on(table.tenantId),
  }),
);

export const currencies = pgTable(
  'currencies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: char('code', { length: 3 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    /** Fraction digits: 0 for JPY, 3 for KWD/BHD/OMR, 2 elsewhere. */
    minorUnits: smallint('minor_units').notNull().default(2),
    isBase: boolean('is_base').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
  },
  (table) => ({
    currenciesPk: primaryKey({ columns: [table.tenantId, table.code] }),
    currenciesBaseKey: uniqueIndex('currencies_tenant_base_key').on(table.tenantId).where(sql`is_base`),
  }),
);

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fromCode: char('from_code', { length: 3 }).notNull(),
    toCode: char('to_code', { length: 3 }).notNull(),
    /** 1 `from_code` = `rate` `to_code`; `numeric(20,10)` per DATABASE_DESIGN §0. */
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    fxRatesPairKey: uniqueIndex('fx_rates_tenant_pair_from_key').on(
      table.tenantId,
      table.fromCode,
      table.toCode,
      table.effectiveFrom,
    ),
    /** The lookup `resolveFx` performs: newest row on or before a date. */
    fxRatesLookupIdx: index('fx_rates_tenant_pair_effective_idx').on(
      table.tenantId,
      table.fromCode,
      table.toCode,
      table.effectiveFrom,
    ),
  }),
);

export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    priceListsNameKey: uniqueIndex('price_lists_tenant_name_key')
      .on(table.tenantId, table.name)
      .where(sql`deleted_at IS NULL`),
    priceListsDefaultKey: uniqueIndex('price_lists_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default AND deleted_at IS NULL`),
    priceListsLegacyKey: uniqueIndex('price_lists_tenant_legacy_key')
      .on(table.tenantId, table.legacySource, table.legacyId)
      .where(sql`legacy_id IS NOT NULL`),
  }),
);

export const priceListItems = pgTable(
  'price_list_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    /** ValidatedAtRuntime: P06 — FK to `items` added when that table exists. */
    itemId: uuid('item_id'),
    /** R19 — وحدة القياس التي يُسعَّر بها السطر (NULL = الوحدة الأساسية للصنف). */
    unitId: uuid('unit_id'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 4 }).notNull(),
    /** Quantity break; `0` is the base tier. */
    minQty: numeric('min_qty', { precision: 20, scale: 4 }).notNull().default('0'),
    ...baseAuditColumns(),
  },
  (table) => ({
    priceListItemsIdx: index('price_list_items_list_idx').on(table.priceListId, table.itemId),
    priceListItemsTenantIdx: index('price_list_items_tenant_idx').on(table.tenantId),
    priceListItemsUnitIdx: index('price_list_items_unit_idx').on(table.tenantId, table.unitId),
  }),
);

/**
 * `(branch, doc_type) → account mapping`. `branch_id IS NULL` is the tenant-wide
 * default and `doc_type = '*'` the catch-all, which together reproduce the legacy
 * `SettingGeneral.*Acc` globals with per-branch overrides on top.
 *
 * DATABASE_DESIGN §5 specifies `PK(branch_id, doc_type)`; a nullable `branch_id` cannot
 * live in a primary key, so the table carries a surrogate id and the scope is enforced
 * by a unique index over `coalesce(branch_id, nil-uuid)` — the same technique
 * `document_sequences` already uses (PHASE_04).
 */
export const branchPostingProfiles = pgTable(
  'branch_posting_profiles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(),
    /** `PostProfileV1` from `@erp/contracts` — zod-validated before every write. */
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull().default({}),
    ...baseAuditColumns(),
    ...baseLegacyColumns(),
  },
  (table) => ({
    branchPostingProfilesDocTypeIdx: index('branch_posting_profiles_tenant_doc_type_idx').on(
      table.tenantId,
      table.docType,
    ),
  }),
);

/** Shared with the migration: NULL `branch_id` folded into a value for uniqueness. */
export const POSTING_PROFILE_NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const postingProfileScopeConflictTarget =
  `(tenant_id, coalesce(branch_id, '${POSTING_PROFILE_NIL_UUID}'::uuid), doc_type)` as const;

export type CompanyProfile = typeof companyProfiles.$inferSelect;
export type NewCompanyProfile = typeof companyProfiles.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
export type CashLocation = typeof cashLocations.$inferSelect;
export type NewCashLocation = typeof cashLocations.$inferInsert;
export type CashLocationBalance = typeof cashLocationBalances.$inferSelect;
export type NewCashLocationBalance = typeof cashLocationBalances.$inferInsert;
export type Currency = typeof currencies.$inferSelect;
export type NewCurrency = typeof currencies.$inferInsert;
export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
export type PriceList = typeof priceLists.$inferSelect;
export type NewPriceList = typeof priceLists.$inferInsert;
export type PriceListItem = typeof priceListItems.$inferSelect;
export type NewPriceListItem = typeof priceListItems.$inferInsert;
export type BranchPostingProfile = typeof branchPostingProfiles.$inferSelect;
export type NewBranchPostingProfile = typeof branchPostingProfiles.$inferInsert;
