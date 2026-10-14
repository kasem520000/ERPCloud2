import { apiData, apiDelete, apiFetch, apiPatch, apiPost } from './api';

export type ApprovalEntity = 'sales_invoice' | 'purchase_invoice' | 'voucher' | 'expense' | 'leave';
export type ApprovalCondition = {
  min_amount?: string | number;
  max_amount?: string | number;
  branch_id?: string | null;
  cost_center_id?: string | null;
};
export type ApprovalStep = {
  id: string;
  workflowId: string;
  stepOrder: number;
  approverRole: string | null;
  approverUserId: string | null;
  condition: ApprovalCondition;
  action: 'approve' | 'notify';
  isRequired: boolean;
};
export type ApprovalWorkflow = {
  id: string;
  tenantId: string;
  entity: ApprovalEntity;
  name: string;
  isActive: boolean;
  steps: ApprovalStep[];
  createdAt: string;
  updatedAt: string | null;
};
export type ApprovalDecision = {
  id: string;
  requestId: string;
  stepId: string;
  userId: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  decidedAt: string;
};
export type ApprovalRequest = {
  id: string;
  tenantId: string;
  workflowId: string;
  entityType: ApprovalEntity;
  entityId: string;
  status: 'pending' | 'approved' | 'rejected';
  currentStepOrder: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string | null;
  workflowName: string | null;
  currentStep: ApprovalStep | null;
  decisions: ApprovalDecision[];
  canAct?: boolean;
};

export type ApprovalWorkflowInput = {
  entity: ApprovalEntity;
  name: string;
  is_active: boolean;
  steps: Array<{
    step_order?: number;
    approver_role?: string;
    approver_user_id?: string;
    condition: ApprovalCondition;
    action: 'approve' | 'notify';
    is_required: boolean;
  }>;
};

export async function listApprovalWorkflows(): Promise<ApprovalWorkflow[]> {
  return apiData<ApprovalWorkflow[]>('/approval-workflows');
}

export async function saveApprovalWorkflow(input: ApprovalWorkflowInput, workflowId?: string) {
  return workflowId
    ? apiPatch<ApprovalWorkflow>(`/approval-workflows/${workflowId}`, input)
    : apiPost<ApprovalWorkflow>('/approval-workflows', input);
}

export async function deactivateApprovalWorkflow(workflowId: string) {
  return apiDelete<ApprovalWorkflow>(`/approval-workflows/${workflowId}`);
}

export async function approvalInbox(status = 'pending'): Promise<ApprovalRequest[]> {
  return apiData<ApprovalRequest[]>(`/approvals/inbox?status=${encodeURIComponent(status)}`);
}

export async function approvalHistory(status = 'approved,rejected'): Promise<ApprovalRequest[]> {
  return apiData<ApprovalRequest[]>(`/approvals/history?status=${encodeURIComponent(status)}`);
}

export async function decideApproval(requestId: string, decision: 'approve' | 'reject', comment: string) {
  return apiPost<ApprovalRequest>(`/approvals/requests/${requestId}/${decision}`, { comment });
}

export async function approvalRequest(requestId: string) {
  return apiFetch<ApprovalRequest>(`/approvals/requests/${requestId}`);
}
