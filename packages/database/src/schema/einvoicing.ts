import { bigint, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { salesInvoices } from './sales.js';
import { tenants } from './platform.js';

export const einvoiceCredentials = pgTable('einvoice_credentials', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  authority: text('authority').notNull(),
  environment: text('environment').notNull(),
  csr: text('csr'),
  privateKeyEnc: text('private_key_enc'),
  csidEnc: text('csid_enc'),
  secretEnc: text('secret_enc'),
  /** Compliance request id — the desktop's `RequestID`, needed to ask for a production CSID. */
  requestId: text('request_id'),
  /** 🔐 حفظ مفتاح التشفير — the production pair, the desktop's `P_RequestID/P_CSID/P_Secret`. */
  productionRequestId: text('p_request_id'),
  productionCsidEnc: text('p_csid_enc'),
  productionSecretEnc: text('p_secret_enc'),
  org: jsonb('org').$type<Record<string, unknown>>().notNull().default({}),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  ...baseAuditColumns(),
}, (t) => ({ uniqueAuthority: uniqueIndex('einvoice_credentials_tenant_authority_env_key').on(t.tenantId, t.authority, t.environment) }));

export const einvoiceSubmissions = pgTable('einvoice_submissions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').notNull().references(() => salesInvoices.id, { onDelete: 'cascade' }),
  authority: text('authority').notNull(),
  action: text('action').notNull().default('submit'),
  environment: text('environment').notNull().default('simulation'),
  status: text('status').notNull().default('pending'),
  uuid: uuid('uuid'),
  hash: text('hash'),
  previousHash: text('previous_hash'),
  /**
   * 🧾 The invoice counter value (ICV) — 1 for the tenant's first invoice, +1 each time.
   * A separate column (migration 0063) so the chain can be sorted, filtered and audited
   * without parsing the stored document.
   */
  chainIndex: integer('chain_index'),
  /**
   * 🧾 The authority's own status word — the desktop's `ZatcaResponse.Status`, which is
   * `ReportingStatus` for a reported invoice and `ClearanceStatus` for a cleared one
   * (`InvoiceOper.cs` L538-L540).
   */
  authorityStatus: text('authority_status'),
  /** 🧾 The re-signed document a standard (0100000) invoice is answered with; base64 UBL. */
  clearedInvoice: text('cleared_invoice'),
  qrPayload: text('qr_payload'),
  requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull().default({}),
  response: jsonb('response').$type<Record<string, unknown>>(),
  error: text('error'),
  attempts: text('attempts').notNull().default('0'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  ...baseAuditColumns(),
}, (t) => ({ invoice: index('einvoice_submissions_invoice_idx').on(t.tenantId, t.invoiceId), status: index('einvoice_submissions_status_idx').on(t.tenantId, t.status) }));

export const einvoiceChain = pgTable('einvoice_chain', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  authority: text('authority').notNull(),
  environment: text('environment').notNull(),
  lastHash: text('last_hash').notNull().default(''),
  /** ZATCA invoice counter value (ICV): 1 for the first invoice of the chain, +1 each time. */
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.authority, t.environment] }) }));

/**
 * The ZATCA link window — the cloud shape of the desktop's three singleton rows
 * `SettingZatca`, `CSRProperties` and the onboarding stamps of `ZatcaCredential`
 * (`Form_WPF/frmZatcaSetting.xaml.cs` L77-L280). One row per tenant per authority.
 */
export const einvoiceSettings = pgTable('einvoice_settings', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  authority: text('authority').notNull().default('zatca'),
  /** 🔵 Compliance تجريبي or 🔴 Production ربط فعلي. */
  environment: text('environment').notNull().default('compliance'),
  /** 🧪 Simulation تجريبي — the gateway is answered locally instead of dialled. */
  simulation: boolean('simulation').notNull().default(false),
  /** ✅ تمكين Activate, flipped by ⏸ إيقاف الربط / ▶ تشغيل. */
  active: boolean('active').notNull().default(true),
  /** «Sync manual». */
  syncManual: boolean('sync_manual').notNull().default(false),
  /** 📅 التاريخ; the desktop stored an end date one year later. */
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  /** 📋 خصائص شهادة CSR — signed into the certificate by the authority. */
  commonName: text('common_name').notNull().default(''),
  serialNumber: text('serial_number').notNull().default(''),
  organizationIdentifier: text('organization_identifier').notNull().default(''),
  organizationUnitName: text('organization_unit_name').notNull().default(''),
  organizationName: text('organization_name').notNull().default(''),
  countryName: text('country_name').notNull().default('SA'),
  invoiceType: text('invoice_type').notNull().default('1100'),
  address: text('address').notNull().default(''),
  industry: text('industry').notNull().default(''),
  csrGeneratedAt: timestamp('csr_generated_at', { withTimezone: true }),
  complianceCsidAt: timestamp('compliance_csid_at', { withTimezone: true }),
  productionCsidAt: timestamp('production_csid_at', { withTimezone: true }),
  complianceCheckedAt: timestamp('compliance_checked_at', { withTimezone: true }),
  renewedAt: timestamp('renewed_at', { withTimezone: true }),
  /** The six rows «🧪 اختبار الربط» returned the last time it ran. */
  lastComplianceCheck: jsonb('last_compliance_check').$type<Record<string, unknown>>(),
  ...baseAuditColumns(),
}, (t) => ({ tenantAuthority: uniqueIndex('einvoice_settings_tenant_authority_key').on(t.tenantId, t.authority) }));

export const einvoicingTables = { einvoiceCredentials, einvoiceSubmissions, einvoiceChain, einvoiceSettings };
export type EinvoiceCredential = typeof einvoiceCredentials.$inferSelect;
export type EinvoiceSubmission = typeof einvoiceSubmissions.$inferSelect;
export type EinvoiceSetting = typeof einvoiceSettings.$inferSelect;
