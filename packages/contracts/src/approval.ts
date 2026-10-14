import { z } from 'zod';

import { uuidSchema } from './ids.js';

export const approvalEntityTypeSchema = z.enum([
  'sales_invoice',
  'purchase_invoice',
  'voucher',
  'expense',
  'leave',
]);
export type ApprovalEntityType = z.infer<typeof approvalEntityTypeSchema>;

export const approvalActionSchema = z.enum(['approve', 'notify']);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const approvalDecisionSchema = z.enum(['approved', 'rejected']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

const decimalOrNumber = z.union([
  z.number().finite(),
  z.string().trim().regex(/^-?\d+(?:\.\d+)?$/, 'must be a decimal amount'),
]);

/** The condition vocabulary supported by the Phase 04 engine. */
export const approvalConditionSchema = z
  .object({
    min_amount: decimalOrNumber.optional(),
    max_amount: decimalOrNumber.optional(),
    branch_id: uuidSchema.nullable().optional(),
    cost_center_id: uuidSchema.nullable().optional(),
  })
  .strict();
export type ApprovalCondition = z.infer<typeof approvalConditionSchema>;

export const approvalStepInputSchema = z
  .object({
    step_order: z.number().int().positive().optional(),
    approver_role: z.string().trim().min(1).max(120).optional(),
    approver_user_id: uuidSchema.optional(),
    condition: approvalConditionSchema.default({}),
    action: approvalActionSchema.default('approve'),
    is_required: z.boolean().default(true),
  })
  .strict()
  .refine((value) => Boolean(value.approver_role || value.approver_user_id), {
    message: 'An approver role or user is required',
    path: ['approver_role'],
  });
export type ApprovalStepInput = z.infer<typeof approvalStepInputSchema>;

export const approvalWorkflowInputSchema = z
  .object({
    entity: approvalEntityTypeSchema,
    name: z.string().trim().min(1).max(160),
    is_active: z.boolean().default(true),
    steps: z.array(approvalStepInputSchema).min(1),
  })
  .strict();
export type ApprovalWorkflowInput = z.infer<typeof approvalWorkflowInputSchema>;

export const approvalStepDtoSchema = z.object({
  id: uuidSchema,
  workflowId: uuidSchema,
  stepOrder: z.number().int(),
  approverRole: z.string().nullable(),
  approverUserId: uuidSchema.nullable(),
  condition: approvalConditionSchema,
  action: approvalActionSchema,
  isRequired: z.boolean(),
});
export type ApprovalStepDto = z.infer<typeof approvalStepDtoSchema>;

export const approvalWorkflowDtoSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  entity: approvalEntityTypeSchema,
  name: z.string(),
  isActive: z.boolean(),
  steps: z.array(approvalStepDtoSchema),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type ApprovalWorkflowDto = z.infer<typeof approvalWorkflowDtoSchema>;

export const approvalDecisionDtoSchema = z.object({
  id: uuidSchema,
  requestId: uuidSchema,
  stepId: uuidSchema,
  userId: uuidSchema,
  decision: approvalDecisionSchema,
  comment: z.string().nullable(),
  decidedAt: z.string(),
});
export type ApprovalDecisionDto = z.infer<typeof approvalDecisionDtoSchema>;

export const approvalRequestDtoSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  workflowId: uuidSchema,
  entityType: approvalEntityTypeSchema,
  entityId: uuidSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
  currentStepOrder: z.number().int().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  workflowName: z.string().nullable(),
  currentStep: approvalStepDtoSchema.nullable(),
  decisions: z.array(approvalDecisionDtoSchema),
  canAct: z.boolean().optional(),
});
export type ApprovalRequestDto = z.infer<typeof approvalRequestDtoSchema>;

export const approvalDecisionInputSchema = z
  .object({ comment: z.string().trim().max(2000).optional() })
  .strict();
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>;

export const APPROVAL_REQUIRED = 'approval.required';
export const APPROVAL_REQUESTED_NOTIFICATION = 'approval.requested';
export const APPROVAL_APPROVED_NOTIFICATION = 'approval.approved';
export const APPROVAL_REJECTED_NOTIFICATION = 'approval.rejected';
export const APPROVAL_APPROVED_EVENT = 'approval.approved';

export const APPROVAL_STATUS_VALUES = ['pending', 'approved', 'rejected'] as const;
export const APPROVAL_INBOX_STATUSES = ['pending', 'approved', 'rejected'] as const;
