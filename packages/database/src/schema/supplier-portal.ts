import { boolean, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { bytea } from '../columns.js';

import { parties } from './parties.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };

/** A supplier login that is not a staff user and holds no ERP permissions. */
export const supplierPortalUsers = pgTable(
  'supplier_portal_users',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => ({
    emailKey: uniqueIndex('supplier_portal_users_email_key').on(table.tenantId, table.email),
    partyIdx: index('supplier_portal_users_party_idx').on(table.tenantId, table.partyId),
  }),
);

export const supplierPortalSessions = pgTable(
  'supplier_portal_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => supplierPortalUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenKey: uniqueIndex('supplier_portal_sessions_token_key').on(table.tenantId, table.tokenHash),
  }),
);

/** A request for quotation sent to one supplier. */
export const supplierRfqs = pgTable(
  'supplier_rfqs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    title: text('title').notNull(),
    note: text('note').notNull().default(''),
    status: text('status').notNull().default('open'),
    offer: numeric('offer', money),
    responseNote: text('response_note'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => ({
    numberKey: uniqueIndex('supplier_rfqs_number_key').on(table.tenantId, table.number),
    partyIdx: index('supplier_rfqs_party_idx').on(table.tenantId, table.partyId, table.status),
  }),
);

/** A supplier-submitted invoice. It is not posted to the ledger until a clerk books it. */
export const supplierInvoiceUploads = pgTable(
  'supplier_invoice_uploads',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }),
    referenceNo: text('reference_no').notNull(),
    declaredTotal: numeric('declared_total', money).notNull(),
    note: text('note').notNull().default(''),
    status: text('status').notNull().default('submitted'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    partyIdx: index('supplier_invoice_uploads_party_idx').on(table.tenantId, table.partyId, table.createdAt),
  }),
);

export const esignRequests = pgTable(
  'esign_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    signerName: text('signer_name').notNull().default(''),
    signerEmail: text('signer_email').notNull(),
    tokenHash: text('token_hash').notNull(),
    otpHash: text('otp_hash').notNull(),
    status: text('status').notNull().default('sent'),
    signedFileId: uuid('signed_file_id'),
    signedPdf: bytea('signed_pdf'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    payload: text('payload').notNull().default('{}'),
    createdBy: uuid('created_by'),
    createdByMembershipId: uuid('created_by_membership_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenKey: uniqueIndex('esign_requests_token_key').on(table.tenantId, table.tokenHash),
    entityIdx: index('esign_requests_entity_idx').on(table.tenantId, table.entityType, table.entityId),
  }),
);

export const esignEvents = pgTable(
  'esign_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull().references(() => esignRequests.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
  },
  (table) => ({
    requestIdx: index('esign_events_request_idx').on(table.tenantId, table.requestId, table.at),
  }),
);
