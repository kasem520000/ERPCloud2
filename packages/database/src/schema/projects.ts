import { sql } from 'drizzle-orm';
import { date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { costCenters } from './accounting.js';
import { items } from './catalog.js';
import { branches } from './organization.js';
import { parties } from './parties.js';
import { salesAdjustmentNotes, salesInvoices } from './sales.js';
import { tenants, users } from './platform.js';
import { vouchers } from './treasury.js';

const value = { precision: 20, scale: 4, mode: 'string' as const };
const pct = { precision: 7, scale: 4, mode: 'string' as const };

export const installmentContracts = pgTable('installment_contracts', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'restrict' }), partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }), sourceInvoiceId: uuid('source_invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }), number: text('number'), contractValue: numeric('contract_value', value).notNull(), downPayment: numeric('down_payment', value).notNull().default('0'), installmentCount: integer('installment_count').notNull(), periodUnit: text('period_unit').notNull().default('months'), periodEvery: integer('period_every').notNull().default(1), firstDueDate: date('first_due_date').notNull(), status: text('status').notNull().default('draft'), earlySettlementDiscount: numeric('early_settlement_discount', value).notNull().default('0'), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ numberKey: uniqueIndex('installment_contracts_number_key').on(table.tenantId, table.number).where(sql`number IS NOT NULL`), partyIdx: index('installment_contracts_party_idx').on(table.tenantId, table.partyId, table.status) }));

export const installmentSchedule = pgTable('installment_schedule', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), contractId: uuid('contract_id').notNull().references(() => installmentContracts.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), dueDate: date('due_date').notNull(), dueValue: numeric('due_value', value).notNull(), paidValue: numeric('paid_value', value).notNull().default('0'), status: text('status').notNull().default('open'), voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }), collectedAt: timestamp('collected_at', { withTimezone: true }),
}, (table) => ({ lineKey: uniqueIndex('installment_schedule_line_key').on(table.contractId, table.lineNo), dueIdx: index('installment_schedule_due_idx').on(table.tenantId, table.dueDate, table.status) }));

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }), code: text('code').notNull(), name: text('name').notNull(), partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), contractorPartyId: uuid('contractor_party_id').references(() => parties.id, { onDelete: 'set null' }), status: text('status').notNull().default('draft'), startsOn: date('starts_on'), endsOn: date('ends_on'), contractValue: numeric('contract_value', value).notNull().default('0'), retentionPct: numeric('retention_pct', pct).notNull().default('0'), costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ codeKey: uniqueIndex('projects_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`), partyIdx: index('projects_party_idx').on(table.tenantId, table.partyId, table.status) }));

export const projectStageTemplates = pgTable('project_stage_templates', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), name: text('name').notNull(), stages: jsonb('stages').$type<Array<{ name: string; order: number }>>().notNull().default([]), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ nameKey: uniqueIndex('project_stage_templates_name_key').on(table.tenantId, table.name).where(sql`deleted_at IS NULL`) }));

export const projectStages = pgTable('project_stages', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), name: text('name').notNull(), stageOrder: integer('stage_order').notNull().default(0), status: text('status').notNull().default('pending'), accreditedBy: uuid('accredited_by').references(() => users.id, { onDelete: 'set null' }), accreditedAt: timestamp('accredited_at', { withTimezone: true }), accreditationNote: text('accreditation_note'), ...baseAuditColumns(), ...baseLegacyColumns(),
}, (table) => ({ projectOrderKey: uniqueIndex('project_stages_order_key').on(table.projectId, table.stageOrder), projectIdx: index('project_stages_project_idx').on(table.tenantId, table.projectId, table.status) }));

export const boqTerms = pgTable('boq_terms', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), code: text('code').notNull(), description: text('description').notNull(), qty: numeric('qty', value).notNull().default('1'), unitValue: numeric('unit_value', value).notNull(), estimatedCost: numeric('estimated_cost', value).notNull().default('0'), executionPeriod: text('execution_period'), previouslyBilled: numeric('previously_billed', value).notNull().default('0'), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ codeKey: uniqueIndex('boq_terms_code_key').on(table.tenantId, table.projectId, table.code).where(sql`deleted_at IS NULL`), projectIdx: index('boq_terms_project_idx').on(table.tenantId, table.projectId) }));

export const progressBills = pgTable('progress_bills', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }), number: text('number'), billDate: date('bill_date').notNull(), status: text('status').notNull().default('draft'), workValue: numeric('work_value', value).notNull().default('0'), previousValue: numeric('previous_value', value).notNull().default('0'), retentionValue: numeric('retention_value', value).notNull().default('0'), netDue: numeric('net_due', value).notNull().default('0'), invoiceId: uuid('invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }), postedAt: timestamp('posted_at', { withTimezone: true }), releasedAt: timestamp('released_at', { withTimezone: true }), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseLegacyColumns(),
}, (table) => ({ numberKey: uniqueIndex('progress_bills_number_key').on(table.tenantId, table.number).where(sql`number IS NOT NULL`), projectIdx: index('progress_bills_project_idx').on(table.tenantId, table.projectId, table.status) }));

export const progressBillLines = pgTable('progress_bill_lines', {
  billId: uuid('bill_id').notNull().references(() => progressBills.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), termId: uuid('term_id').notNull().references(() => boqTerms.id, { onDelete: 'restrict' }), billPct: numeric('bill_pct', pct).notNull().default('0'), billValue: numeric('bill_value', value).notNull(), previousValue: numeric('previous_value', value).notNull().default('0'), remainingValue: numeric('remaining_value', value).notNull().default('0'),
}, (table) => ({ pk: primaryKey({ columns: [table.billId, table.lineNo] }), termIdx: index('progress_bill_lines_term_idx').on(table.tenantId, table.termId) }));

export const projectRequirements = pgTable('project_requirements', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), partyId: uuid('party_id').references(() => parties.id, { onDelete: 'set null' }), title: text('title').notNull(), status: text('status').notNull().default('open'), payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ statusIdx: index('project_requirements_status_idx').on(table.tenantId, table.status) }));

export type InstallmentContract = typeof installmentContracts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type BoqTerm = typeof boqTerms.$inferSelect;

/**
 * عقد مقاول — the subcontractor mirror of the client contract on `projects`. The advance
 * lives here (not on the payment) because it is recovered across many payments, so the
 * running `advanceRecovered` total is contract state.
 */
export const contractorContracts = pgTable('contractor_contracts', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }), contractorPartyId: uuid('contractor_party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), number: text('number').notNull(), title: text('title').notNull(), scope: text('scope'), status: text('status').notNull().default('draft'), contractValue: numeric('contract_value', value).notNull().default('0'), retentionPct: numeric('retention_pct', pct).notNull().default('0'), advanceAmount: numeric('advance_amount', value).notNull().default('0'), advanceRecovered: numeric('advance_recovered', value).notNull().default('0'), startsOn: date('starts_on'), endsOn: date('ends_on'), notes: text('notes'), signedAt: timestamp('signed_at', { withTimezone: true }), closedAt: timestamp('closed_at', { withTimezone: true }), ...baseAuditColumns(),
}, (table) => ({ numberKey: uniqueIndex('contractor_contracts_tenant_number_key').on(table.tenantId, table.number), projectIdx: index('contractor_contracts_project_idx').on(table.tenantId, table.projectId, table.status) }));

export const contractorContractLines = pgTable('contractor_contract_lines', {
  contractId: uuid('contract_id').notNull().references(() => contractorContracts.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), description: text('description').notNull(), qty: numeric('qty', value).notNull().default('1'), unitValue: numeric('unit_value', value).notNull().default('0'), lineValue: numeric('line_value', value).notNull().default('0'),
}, (table) => ({ pk: primaryKey({ columns: [table.contractId, table.lineNo] }) }));

/** سند دفع لمقاول — the payment certificate; retention and advance recovery are computed. */
export const contractorPayments = pgTable('contractor_payments', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), contractId: uuid('contract_id').notNull().references(() => contractorContracts.id, { onDelete: 'restrict' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }), branchId: uuid('branch_id').references(() => branches.id), number: text('number').notNull(), kind: text('kind').notNull().default('progress'), status: text('status').notNull().default('draft'), paymentDate: date('payment_date').notNull(), grossAmount: numeric('gross_amount', value).notNull(), retentionAmount: numeric('retention_amount', value).notNull().default('0'), advanceRecovery: numeric('advance_recovery', value).notNull().default('0'), netAmount: numeric('net_amount', value).notNull().default('0'), voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }), notes: text('notes'), approvedAt: timestamp('approved_at', { withTimezone: true }), approvedBy: uuid('approved_by'), paidAt: timestamp('paid_at', { withTimezone: true }), cancelledAt: timestamp('cancelled_at', { withTimezone: true }), ...baseAuditColumns(),
}, (table) => ({ numberKey: uniqueIndex('contractor_payments_tenant_number_key').on(table.tenantId, table.number), contractIdx: index('contractor_payments_contract_idx').on(table.tenantId, table.contractId, table.status) }));

/** عروض المشاريع — accepted offers convert into a project whose BOQ is the offer's lines. */
export const projectOffers = pgTable('project_offers', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').references(() => branches.id), partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), number: text('number').notNull(), title: text('title').notNull(), status: text('status').notNull().default('draft'), offerDate: date('offer_date').notNull(), validUntil: date('valid_until'), totalValue: numeric('total_value', value).notNull().default('0'), retentionPct: numeric('retention_pct', pct).notNull().default('0'), notes: text('notes'), decidedAt: timestamp('decided_at', { withTimezone: true }), rejectionReason: text('rejection_reason'), ...baseAuditColumns(),
}, (table) => ({ numberKey: uniqueIndex('project_offers_tenant_number_key').on(table.tenantId, table.number), partyIdx: index('project_offers_party_idx').on(table.tenantId, table.partyId, table.status) }));

export const projectOfferLines = pgTable('project_offer_lines', {
  offerId: uuid('offer_id').notNull().references(() => projectOffers.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code').notNull(), description: text('description').notNull(), qty: numeric('qty', value).notNull().default('1'), unitValue: numeric('unit_value', value).notNull().default('0'), lineValue: numeric('line_value', value).notNull().default('0'),
}, (table) => ({ pk: primaryKey({ columns: [table.offerId, table.lineNo] }) }));

export type ContractorContract = typeof contractorContracts.$inferSelect;
export type ContractorPayment = typeof contractorPayments.$inferSelect;
export type ProjectOffer = typeof projectOffers.$inferSelect;

/**
 * مرتجع مقاولات — work taken back off a posted progress bill. It exists as its own
 * document because the bill it reverses has already produced a posted sales invoice:
 * deleting or editing the bill would erase an audited trail, so the return releases BOQ
 * value for re-billing and issues a credit note instead.
 */
export const contractingReturns = pgTable('contracting_returns', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }), billId: uuid('bill_id').notNull().references(() => progressBills.id, { onDelete: 'restrict' }), branchId: uuid('branch_id').references(() => branches.id), number: text('number').notNull(), returnDate: date('return_date').notNull(), status: text('status').notNull().default('draft'), reason: text('reason').notNull(), returnValue: numeric('return_value', value).notNull().default('0'), retentionValue: numeric('retention_value', value).notNull().default('0'), netValue: numeric('net_value', value).notNull().default('0'), creditNoteId: uuid('credit_note_id').references(() => salesAdjustmentNotes.id, { onDelete: 'set null' }), postedAt: timestamp('posted_at', { withTimezone: true }), cancelledAt: timestamp('cancelled_at', { withTimezone: true }), ...baseAuditColumns(),
}, (table) => ({ numberKey: uniqueIndex('contracting_returns_tenant_number_key').on(table.tenantId, table.number), billIdx: index('contracting_returns_bill_idx').on(table.tenantId, table.billId, table.status) }));

export const contractingReturnLines = pgTable('contracting_return_lines', {
  returnId: uuid('return_id').notNull().references(() => contractingReturns.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), termId: uuid('term_id').notNull().references(() => boqTerms.id, { onDelete: 'restrict' }), returnValue: numeric('return_value', value).notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.returnId, table.lineNo] }), termIdx: index('contracting_return_lines_term_idx').on(table.tenantId, table.termId) }));

export type ContractingReturn = typeof contractingReturns.$inferSelect;
