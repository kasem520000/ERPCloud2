import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, numeric, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseSoftDeleteColumns } from '../columns.js';

import { accounts } from './accounting.js';
import { branches, cashLocations } from './organization.js';
import { tenants, users } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * Customer payment methods (طريقة دفع عميل): how a customer normally pays, how many days
 * that buys them, and which cash location the money lands in.
 */
export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en'),
  kind: text('kind').notNull().default('cash'),
  dueDays: integer('due_days').notNull().default(0),
  cashLocationId: uuid('cash_location_id').references(() => cashLocations.id),
  isActive: boolean('is_active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  ...baseAuditColumns(),
  ...baseSoftDeleteColumns(),
}, (table) => ({
  codeKey: uniqueIndex('payment_methods_tenant_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`),
  defaultKey: uniqueIndex('payment_methods_tenant_default_key').on(table.tenantId).where(sql`is_default AND deleted_at IS NULL`),
}));

export const parties = pgTable('parties', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code').notNull(), kind: text('kind').notNull(), name: text('name').notNull(), legalName: text('legal_name'), taxNo: text('tax_no'), nationalId: text('national_id'), address: jsonb('address').$type<Record<string, string | undefined>>(), phone: text('phone'), email: text('email'), receivableAccountId: uuid('receivable_account_id').references(() => accounts.id, { onDelete: 'restrict' }), payableAccountId: uuid('payable_account_id').references(() => accounts.id, { onDelete: 'restrict' }), creditLimit: numeric('credit_limit', money).notNull().default('0'), isOwner: boolean('is_owner').notNull().default(false), isContractor: boolean('is_contractor').notNull().default(false), branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }), paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (table) => ({ codeKey: uniqueIndex('parties_tenant_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`), taxIdx: index('parties_tenant_tax_idx').on(table.tenantId, table.taxNo), kindIdx: index('parties_tenant_kind_idx').on(table.tenantId, table.kind) }));
export const partyContacts = pgTable('party_contacts', { partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'cascade' }), id: uuid('id').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), name: text('name').notNull(), role: text('role'), phone: text('phone'), email: text('email'), isPrimary: boolean('is_primary').notNull().default(false), ...baseAuditColumns(), ...baseSoftDeleteColumns() }, (table) => ({ pk: primaryKey({ columns: [table.partyId, table.id] }), partyIdx: index('party_contacts_tenant_party_idx').on(table.tenantId, table.partyId) }));
export const paymentAllocations = pgTable('payment_allocations', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), voucherId: uuid('voucher_id'), invoiceKind: text('invoice_kind').notNull(), invoiceId: uuid('invoice_id').notNull(), amount: numeric('amount', money).notNull(), allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(), createdBy: uuid('created_by') }, (table) => ({ invoiceIdx: index('payment_allocations_invoice_idx').on(table.tenantId, table.invoiceKind, table.invoiceId), partyIdx: index('payment_allocations_party_idx').on(table.tenantId, table.partyId) }));
export type Party = typeof parties.$inferSelect;
export type PartyContact = typeof partyContacts.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type PartyAddress = NonNullable<Party['address']>;
export const partyAddressKeys = ['country', 'city', 'district', 'street', 'building', 'postalCode', 'additionalNumber'] as const;
export type PaymentMethod = typeof paymentMethods.$inferSelect;

/**
 * A customer login for the self-service portal.
 *
 * The row binds a `users` account to exactly one party; `/portal/*` reads it instead of a
 * permission, and the account's role carries no permissions at all, so the same token cannot
 * reach any ERP endpoint. See `migrations/0030_portal_accounts.sql`.
 */
export const portalAccounts = pgTable('portal_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('active'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  ...baseAuditColumns(),
}, (table) => ({
  userKey: uniqueIndex('portal_accounts_tenant_user_key').on(table.tenantId, table.userId),
  partyIdx: index('portal_accounts_party_idx').on(table.tenantId, table.partyId),
}));
