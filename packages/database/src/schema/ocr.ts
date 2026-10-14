import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns } from '../columns.js';

import { files } from './platform-services.js';
import { tenants } from './platform.js';
import { purchaseInvoices } from './purchases.js';

/**
 * OCR work items for purchase invoices.
 *
 * The document bytes never pass through the API: `file_id` points to the tenant-owned
 * object-storage row and the worker gives the configured provider a short-lived download
 * URL. The extracted payload is deliberately JSON so a provider can add fields without a
 * migration, while the stable header keys are normalised by the API service.
 */
export const ocrJobs = pgTable(
  'ocr_jobs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull().default('purchase_invoice'),
    status: text('status').notNull().default('queued'),
    extracted: jsonb('extracted').$type<Record<string, unknown>>().notNull().default({}),
    confidence: numeric('confidence', { precision: 5, scale: 4, mode: 'string' }),
    provider: text('provider'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    draftInvoiceId: uuid('draft_invoice_id').references(() => purchaseInvoices.id, { onDelete: 'set null' }),
    ...baseAuditColumns(),
  },
  (table) => ({
    tenantStatus: index('ocr_jobs_tenant_status_created_idx').on(table.tenantId, table.status, table.createdAt),
    tenantFile: index('ocr_jobs_tenant_file_idx').on(table.tenantId, table.fileId),
    entity: index('ocr_jobs_tenant_entity_idx').on(table.tenantId, table.entityType, table.draftInvoiceId),
    entityTypeCheck: check('ocr_jobs_entity_type_check', sql`${table.entityType} IN ('purchase_invoice')`),
    statusCheck: check('ocr_jobs_status_check', sql`${table.status} IN ('queued', 'processing', 'done', 'failed')`),
  }),
);

export type OcrJob = typeof ocrJobs.$inferSelect;
export type NewOcrJob = typeof ocrJobs.$inferInsert;
