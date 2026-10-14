import { sql } from 'drizzle-orm';
import { boolean, integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants, users } from './platform.js';

/**
 * Sequential, tenant-scoped approval workflows.  The engine intentionally keeps the
 * condition as JSON: adding a new document attribute must not require a migration, while
 * the service validates the four conditions currently supported by Phase 04.
 */
export const approvalWorkflows = pgTable(
  'approval_workflows',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
  },
  (table) => ({
    tenantEntityIdx: index('approval_workflows_tenant_entity_idx').on(table.tenantId, table.entity, table.isActive),
    tenantNameKey: uniqueIndex('approval_workflows_tenant_name_key').on(table.tenantId, table.name),
  }),
);

export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id').notNull().references(() => approvalWorkflows.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    approverRole: text('approver_role'),
    approverUserId: uuid('approver_user_id').references(() => users.id, { onDelete: 'set null' }),
    conditionJson: jsonb('condition_json').$type<Record<string, unknown>>().notNull().default({}),
    action: text('action').notNull().default('approve'),
    isRequired: boolean('is_required').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowOrderKey: uniqueIndex('approval_steps_workflow_order_key').on(table.workflowId, table.stepOrder),
    workflowIdx: index('approval_steps_workflow_idx').on(table.workflowId, table.stepOrder),
  }),
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').notNull().references(() => approvalWorkflows.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    status: text('status').notNull().default('pending'),
    currentStepOrder: integer('current_step_order'),
    contextJson: jsonb('context_json').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => ({
    pendingEntityKey: uniqueIndex('approval_requests_pending_entity_key')
      .on(table.tenantId, table.entityType, table.entityId)
      .where(sql`status = 'pending'`),
    tenantStatusIdx: index('approval_requests_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    entityIdx: index('approval_requests_tenant_entity_idx').on(table.tenantId, table.entityType, table.entityId),
  }),
);

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey(),
    requestId: uuid('request_id').notNull().references(() => approvalRequests.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').notNull().references(() => approvalSteps.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    decision: text('decision').notNull(),
    comment: text('comment'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestStepKey: uniqueIndex('approval_decisions_request_step_key').on(table.requestId, table.stepId),
    requestIdx: index('approval_decisions_request_idx').on(table.requestId, table.decidedAt),
    userIdx: index('approval_decisions_user_idx').on(table.userId, table.decidedAt),
  }),
);

export type ApprovalWorkflow = typeof approvalWorkflows.$inferSelect;
export type ApprovalStep = typeof approvalSteps.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type ApprovalDecision = typeof approvalDecisions.$inferSelect;

export const approvalTables = {
  approvalWorkflows,
  approvalSteps,
  approvalRequests,
  approvalDecisions,
};
