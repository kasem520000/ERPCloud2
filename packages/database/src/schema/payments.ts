import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { tenants, users } from './platform.js';
import { salesInvoices } from './sales.js';
import { cashLocations } from './organization.js';
import { vouchers } from './treasury.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * 💳 بوابات الدفع — the two payment providers of
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` L1726-L1831.
 *
 * The desktop held two singleton rows in the company database —
 * `GediaSetting (id=1)` and `SettingNeoleap (id=1)` — because a desktop database is one
 * company. Here they are one row per `(tenant_id, provider)`, as `einvoice_settings` is
 * one row per `(tenant_id, authority)`.
 */
export const paymentGatewaySettings = pgTable(
  'payment_gateway_settings',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** جيديا · NeoLeap. */
    provider: text('provider').notNull(),
    /** تفعيل الدفع عن طريق جيديا / تفعيل NeoLeap. */
    active: boolean('active').notNull().default(false),
    /** طباعة ايصال / طباعة إيصال NeoLeap — `printFlag` in `NeoleapService`. */
    printReceipt: boolean('print_receipt').notNull().default(false),
    /** المنفذ — the desktop's `GediaPort` / `NeoLeapPort`. */
    port: integer('port'),
    /** Where the gateway is dialled; the desktop used a COM port or a local socket. */
    baseUrl: text('base_url').notNull().default(''),
    currency: text('currency').notNull().default('SAR'),
    /** Geidea merchant public key · NeoLeap tranportal id — not a secret. */
    merchantKey: text('merchant_key').notNull().default(''),
    /** Geidea API password · NeoLeap merchant token — `v1:iv:tag:data` AES-256-GCM. */
    merchantSecretEnc: text('merchant_secret_enc'),
    /** Geidea `callbackUrl`. */
    callbackUrl: text('callback_url').notNull().default(''),
    /** 🧪 Simulation — the gateway is answered locally instead of dialled. */
    simulation: boolean('simulation').notNull().default(true),
    /** «Logging» — the last 🧪 TEST / 🧪 Test, kept so the window still shows it. */
    lastTest: jsonb('last_test').$type<Record<string, unknown>>(),
    ...baseAuditColumns(),
  },
  (t) => ({
    tenantProvider: uniqueIndex('payment_gateway_settings_tenant_provider_key').on(t.tenantId, t.provider),
    tenant: index('payment_gateway_settings_tenant_idx').on(t.tenantId),
  }),
);

/**
 * One 💳 operation: what the cashier asked for, what the gateway answered, and whether
 * the answer was written onto the invoice.
 *
 * The desktop kept no such row — it printed a receipt and moved on. A server has to be
 * able to prove what a gateway said, and to make a double-tap on 💳 a duplicate rather
 * than a second charge, so `reference` (the desktop's own `ecrRef`, `NeoleapService.cs`
 * L32) is unique per tenant and provider.
 */
export const paymentGatewayTransactions = pgTable(
  'payment_gateway_transactions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** `ecrRef` · Geidea `merchantReferenceId` — the caller's idempotency key. */
    reference: text('reference').notNull(),
    /** Geidea `session.id` / `orderId` · NeoLeap `uuid`. */
    sessionId: text('session_id'),
    invoiceId: uuid('invoice_id'),
    branchId: uuid('branch_id'),
    amount: numeric('amount', money).notNull(),
    currency: text('currency').notNull().default('SAR'),
    /** initiated · approved · declined · cancelled · unknown · error. */
    status: text('status').notNull().default('initiated'),
    /** Geidea `responseCode` / `detailedResponseCode` · NeoLeap `StatusCode`. */
    responseCode: text('response_code'),
    detailedResponseCode: text('detailed_response_code'),
    message: text('message'),
    approvalCode: text('approval_code'),
    rrn: text('rrn'),
    stan: text('stan'),
    cardScheme: text('card_scheme'),
    panMasked: text('pan_masked'),
    transactionType: text('transaction_type'),
    /** Geidea's hosted page, for the cashier to open. */
    checkoutUrl: text('checkout_url'),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown>>(),
    simulation: boolean('simulation').notNull().default(false),
    /** True once the approved amount was recorded on the invoice. */
    settled: boolean('settled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => ({
    reference: uniqueIndex('payment_gateway_transactions_reference_key').on(t.tenantId, t.provider, t.reference),
    recent: index('payment_gateway_transactions_recent_idx').on(t.tenantId, t.createdAt),
    invoice: index('payment_gateway_transactions_invoice_idx').on(t.tenantId, t.invoiceId),
  }),
);

/**
 * Online invoice links — Moyasar, HyperPay and Tap. Distinct from the till gateways
 * (`payment_gateway_settings`), which dial a local terminal rather than a hosted invoice.
 */
export const paymentProviderConfigs = pgTable(
  'payment_provider_configs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    apiKeyEnc: text('api_key_enc'),
    webhookSecretEnc: text('webhook_secret_enc'),
    publishableKey: text('publishable_key'),
    isActive: boolean('is_active').notNull().default(true),
    simulation: boolean('simulation').notNull().default(true),
    currency: text('currency').notNull().default('SAR'),
    cashLocationId: uuid('cash_location_id').references(() => cashLocations.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantProvider: uniqueIndex('payment_provider_configs_tenant_provider_key').on(table.tenantId, table.provider),
  }),
);

export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull().references(() => salesInvoices.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    amount: numeric('amount', money).notNull(),
    currency: text('currency').notNull().default('SAR'),
    linkUrl: text('link_url').notNull(),
    externalId: text('external_id'),
    status: text('status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    invoiceIdx: index('payment_links_invoice_idx').on(table.tenantId, table.invoiceId, table.createdAt),
  }),
);

export type PaymentGatewaySetting = typeof paymentGatewaySettings.$inferSelect;
export type PaymentGatewayTransaction = typeof paymentGatewayTransactions.$inferSelect;
export type PaymentProviderConfig = typeof paymentProviderConfigs.$inferSelect;
export type PaymentLink = typeof paymentLinks.$inferSelect;
