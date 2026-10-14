import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { files } from './platform-services.js';
import { tenants, users } from './platform.js';

/**
 * كتالوج المنصة. بلا `tenant_id`: المستأجر يقرأ، والمنصة وحدها تسعّر.
 * `code` مفتاح الإضافة المُراجَعة، وليس مساراً يُحمَّل.
 */
export const marketplaceApps = pgTable(
  'marketplace_apps',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull().default(''),
    descriptionAr: text('description_ar').notNull().default(''),
    icon: text('icon').notNull().default(''),
    version: text('version').notNull().default('1.0.0'),
    priceMonthly: numeric('price_monthly', { precision: 12, scale: 4 }).notNull().default('0'),
    isCore: boolean('is_core').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    screens: jsonb('screens').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    marketplaceAppsCodeKey: uniqueIndex('marketplace_apps_code_key').on(table.code),
  }),
);

/** تثبيت المستأجر. الإيقاف `is_enabled = false` ولا يحذف الصف ولا `settings`. */
export const tenantApps = pgTable(
  'tenant_apps',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    appCode: text('app_code')
      .notNull()
      .references(() => marketplaceApps.code),
    isEnabled: boolean('is_enabled').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    installedBy: uuid('installed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantAppsCodeKey: uniqueIndex('tenant_apps_tenant_code_key').on(table.tenantId, table.appCode),
    tenantAppsTenantIdx: index('tenant_apps_tenant_idx').on(table.tenantId),
  }),
);

/**
 * دومين المستأجر. فريد بين الصفوف الحية. التحقق سجل TXT، والشهادة `manual`
 * حتى يركّبها المشغّل على الخادم الوكيل.
 */
export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    status: text('status').notNull().default('pending'),
    sslStatus: text('ssl_status').notNull().default('manual'),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    tenantDomainsDomainKey: uniqueIndex('tenant_domains_domain_key')
      .on(table.domain)
      .where(sql`deleted_at IS NULL`),
    tenantDomainsTenantIdx: index('tenant_domains_tenant_idx').on(table.tenantId),
  }),
);

/** شعار وألوان المنشأة. صف واحد لكل مستأجر. */
export const tenantBranding = pgTable('tenant_branding', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  logoFileId: uuid('logo_file_id').references(() => files.id, { onDelete: 'set null' }),
  primaryColor: text('primary_color').notNull().default(''),
  secondaryColor: text('secondary_color').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MarketplaceAppRow = typeof marketplaceApps.$inferSelect;
export type TenantApp = typeof tenantApps.$inferSelect;
export type TenantDomain = typeof tenantDomains.$inferSelect;
export type TenantBranding = typeof tenantBranding.$inferSelect;
