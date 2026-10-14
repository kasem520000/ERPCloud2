import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { tenants } from './platform.js';

/**
 * 📱 إرسال الفاتورة عبر واتساب — the tenant's own WhatsApp Cloud API connection.
 *
 * `Desktop_ERP` had no settings row at all: `WhatsAppSender` drove a Chrome window on the
 * cashier's machine and scanned a QR code once. A server needs a number and a token
 * instead, and both belong to the tenant, not to the deployment.
 */
export const whatsappSettings = pgTable(
  'whatsapp_settings',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** تفعيل. */
    active: boolean('active').notNull().default(false),
    /** Cloud API `{phone-number-id}`. */
    phoneNumberId: text('phone_number_id').notNull().default(''),
    /** Cloud API access token — `v1:iv:tag:data` AES-256-GCM, never returned in the clear. */
    accessTokenEnc: text('access_token_enc'),
    /** The desktop hard-coded «966» (`WhatsAppSender.cs` L113-L116). */
    defaultCountryCode: text('default_country_code').notNull().default('966'),
    /** 📎 — attach the invoice sheet. */
    attachDocument: boolean('attach_document').notNull().default(true),
    /** 🧪 Simulation — answered locally instead of dialled. */
    simulation: boolean('simulation').notNull().default(true),
    /** The last 🧪 اختبار. */
    lastTest: jsonb('last_test').$type<Record<string, unknown>>(),
    ...baseAuditColumns(),
  },
  (t) => ({
    tenant: uniqueIndex('whatsapp_settings_tenant_key').on(t.tenantId),
  }),
);

/**
 * One 💬 press. The desktop kept nothing — the message left the cashier's Chrome and was
 * gone — so this table is entirely ours: what was sent, to whom, with which attachment,
 * and what the provider called it.
 */
export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id'),
    partyId: uuid('party_id'),
    /** Country code and all, no `+` — exactly as it was dialled. */
    phone: text('phone').notNull(),
    message: text('message').notNull(),
    /** 📎 «فاتورة-INV123.txt», or null when the greeting went alone. */
    attachmentName: text('attachment_name'),
    /** none · sent · failed. */
    attachmentStatus: text('attachment_status').notNull().default('none'),
    /** sent · failed · skipped. */
    status: text('status').notNull().default('sent'),
    /** The provider's own `messages[0].id` — the greeting. */
    providerMessageId: text('provider_message_id'),
    /** The id of the 📎 document message, when one went out beside the greeting. */
    attachmentMessageId: text('attachment_message_id'),
    error: text('error'),
    simulation: boolean('simulation').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => ({
    recent: index('whatsapp_messages_recent_idx').on(t.tenantId, t.createdAt),
    invoice: index('whatsapp_messages_invoice_idx').on(t.tenantId, t.invoiceId),
  }),
);

export type WhatsappSetting = typeof whatsappSettings.$inferSelect;
export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
