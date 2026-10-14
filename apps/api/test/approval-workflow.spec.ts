import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

const workflowPermissions = [
  'approval.manage',
  'sales.view',
  'sales.invoice.create',
  'sales.invoice.post',
  'purchase.view',
  'purchase.invoice.create',
  'purchase.invoice.post',
  'parties.manage',
  'organization.branch.view',
  'organization.branch.manage',
  'tenant.notification.view',
];
const approverPermissions = ['approval.approve', 'sales.view', 'tenant.notification.view'];

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? body) as Record<string, unknown>;
}

function requestIdFrom(body: Record<string, unknown>): string {
  const errors = body.errors as Array<Record<string, unknown>> | undefined;
  return String(errors?.[0]?.requestId ?? '');
}

describe('approval workflow engine — sequential tenant approvals', () => {
  let ctx: TestApp;
  let requester: Actor;
  let accountant: Actor;
  let manager: Actor;
  let branchId = '';
  let highInvoiceId = '';
  let purchaseInvoiceId = '';
  let zeroInvoiceId = '';
  let highRequestId = '';
  let purchaseRequestId = '';
  let zeroRequestId = '';

  const call = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token = requester.token,
    body?: Record<string, unknown>,
  ) => api(ctx.server, method, `/api/v1${path}`, { token, body });

  beforeAll(async () => {
    ctx = await createTestApp('approval-workflow');
    requester = await createActor(ctx, {
      tenantCode: 'approval-workflow',
      email: 'requester@approval-workflow.test',
      permissions: workflowPermissions,
      roleNames: ['Requester'],
      isOwner: false,
    });
    accountant = await createActor(ctx, {
      tenantCode: 'approval-workflow',
      tenantId: requester.tenantId,
      email: 'accountant@approval-workflow.test',
      permissions: approverPermissions,
      roleNames: ['Accountant'],
      isOwner: false,
    });
    manager = await createActor(ctx, {
      tenantCode: 'approval-workflow',
      tenantId: requester.tenantId,
      email: 'manager@approval-workflow.test',
      permissions: approverPermissions,
      roleNames: ['Manager'],
      isOwner: false,
    });

    const branch = await call('post', '/branches', requester.token, {
      code: 'APPROVAL',
      nameAr: 'فرع الموافقات',
    });
    expect(branch.status).toBe(201);
    branchId = String(data(branch.body).id);
  }, 240_000);

  afterAll(async () => ctx?.close());

  it('creates a high-value workflow with a minimum amount condition', async () => {
    const response = await call('post', '/approvals/workflows', requester.token, {
      entity: 'sales_invoice',
      name: 'High value sales',
      is_active: true,
      steps: [
        {
          approver_role: 'Accountant',
          condition: { min_amount: '5000' },
          action: 'approve',
          is_required: true,
        },
      ],
    });
    expect(response.status).toBe(201);
    const workflow = data(response.body);
    expect(workflow.entity).toBe('sales_invoice');
    expect((workflow.steps as unknown[]).length).toBe(1);
  });

  it('gates a 6000 purchase draft before posting too', async () => {
    const workflow = await call('post', '/approvals/workflows', requester.token, {
      entity: 'purchase_invoice',
      name: 'High value purchases',
      is_active: true,
      steps: [{ approver_role: 'Accountant', condition: { min_amount: '5000' }, action: 'approve', is_required: true }],
    });
    expect(workflow.status).toBe(201);

    const supplier = await call('post', '/parties', requester.token, {
      kind: 'supplier',
      name: 'مورد الموافقات',
    });
    expect(supplier.status).toBe(201);
    const draft = await call('post', '/purchase-invoices', requester.token, {
      branchId,
      partyId: String(data(supplier.body).id),
      headerTotals: { subtotal: '6000', tax: '0', total: '6000' },
      lines: [],
    });
    expect(draft.status).toBe(201);
    purchaseInvoiceId = String(data(draft.body).id);

    const post = await call('post', `/purchase-invoices/${purchaseInvoiceId}/post`, requester.token, {});
    expect(post.status).toBe(202);
    expect(post.body.code).toBe('APPROVAL_REQUIRED');
    purchaseRequestId = requestIdFrom(post.body);
    expect(purchaseRequestId).not.toBe('');

    const reject = await call('post', `/approvals/requests/${purchaseRequestId}/reject`, accountant.token, {
      comment: 'مراجعة مشتريات مطلوبة',
    });
    expect(reject.status).toBe(201);
    expect(data(reject.body).status).toBe('rejected');
    const after = await call('get', `/purchase-invoices/${purchaseInvoiceId}`);
    expect(data(after.body).status).toBe('draft');
    const approval = await call('get', `/purchases/invoices/${purchaseInvoiceId}/approval`);
    expect(approval.status).toBe(200);
    expect(data(approval.body).status).toBe('rejected');
  });

  it('rejects a direct approver user who is not an active tenant member', async () => {
    const response = await call('post', '/approval-workflows', requester.token, {
      entity: 'purchase_invoice',
      name: 'Invalid approver',
      is_active: true,
      steps: [
        {
          approver_user_id: randomUUID(),
          condition: {},
          action: 'approve',
          is_required: true,
        },
      ],
    });
    expect(response.status).toBe(422);
  });

  it('creates an active two-step workflow through the legacy alias too', async () => {
    const response = await call('post', '/approval-workflows', requester.token, {
      entity: 'sales_invoice',
      name: 'Zero total two-step chain',
      is_active: true,
      steps: [
        { approver_role: 'Accountant', condition: {}, action: 'approve', is_required: true },
        { approver_role: 'Manager', condition: {}, action: 'approve', is_required: true },
      ],
    });
    expect(response.status).toBe(201);
    const workflow = data(response.body);
    expect((workflow.steps as Array<Record<string, unknown>>).map((step) => step.stepOrder)).toEqual([1, 2]);
  });

  it('creates a high-value draft without posting it', async () => {
    const response = await call('post', '/sales/invoices', requester.token, {
      branchId,
      cashCustomerName: 'عميل الموافقات',
      lines: [{ quantity: '1', unitPrice: '6000', taxRate: '0' }],
    });
    expect(response.status).toBe(201);
    highInvoiceId = String(data(response.body).id);
    expect(data(response.body).status).toBe('draft');
  });

  it('returns 202 APPROVAL_REQUIRED before any posting side effect', async () => {
    const response = await call('post', `/sales/invoices/${highInvoiceId}/post`, requester.token, {});
    expect(response.status).toBe(202);
    expect(response.body.code).toBe('APPROVAL_REQUIRED');
    highRequestId = requestIdFrom(response.body);
    expect(highRequestId).not.toBe('');

    const invoice = await call('get', `/sales/invoices/${highInvoiceId}`);
    expect(data(invoice.body).status).toBe('draft');
  });

  it('is idempotent when the same draft is submitted again', async () => {
    const response = await call('post', `/sales/invoices/${highInvoiceId}/post`, requester.token, {});
    expect(response.status).toBe(202);
    expect(requestIdFrom(response.body)).toBe(highRequestId);
  });

  it('shows the high-value request to its role and not to the next role', async () => {
    const accountantInbox = await call('get', '/approvals/inbox', accountant.token);
    const managerInbox = await call('get', '/approvals/inbox', manager.token);
    expect(accountantInbox.status).toBe(200);
    expect((accountantInbox.body as unknown as Array<Record<string, unknown>>).some((row) => row.id === highRequestId)).toBe(true);
    expect(managerInbox.status).toBe(200);
    expect((managerInbox.body as unknown as Array<Record<string, unknown>>).some((row) => row.id === highRequestId)).toBe(false);
  });

  it('rejects the request and keeps the source invoice in draft state', async () => {
    const response = await call('post', `/approvals/requests/${highRequestId}/reject`, accountant.token, {
      comment: 'يحتاج إلى مستند داعم',
    });
    expect(response.status).toBe(201);
    expect(data(response.body).status).toBe('rejected');
    const invoice = await call('get', `/sales/invoices/${highInvoiceId}`);
    expect(data(invoice.body).status).toBe('draft');
    const approval = await call('get', `/sales/invoices/${highInvoiceId}/approval`);
    expect(approval.status).toBe(200);
    expect(data(approval.body).status).toBe('rejected');
  });

  it('writes an in-app rejection notification to the request creator', async () => {
    const response = await call('get', '/notifications?filter[type]=approval.rejected');
    expect(response.status).toBe(200);
    const rows = (Array.isArray(response.body.data) ? response.body.data : response.body) as Array<Record<string, unknown>>;
    expect(rows.some((row) => (row.payload as Record<string, unknown>)?.requestId === highRequestId)).toBe(true);
  });

  it('creates a zero-total invoice for the two-step chain', async () => {
    const response = await call('post', '/sales/invoices', requester.token, {
      branchId,
      cashCustomerName: 'عميل السلسلة',
      lines: [{ quantity: '1', unitPrice: '0', taxRate: '0' }],
    });
    expect(response.status).toBe(201);
    zeroInvoiceId = String(data(response.body).id);
    const post = await call('post', `/sales/invoices/${zeroInvoiceId}/post`, requester.token, {});
    expect(post.status).toBe(202);
    zeroRequestId = requestIdFrom(post.body);
  });

  it('moves the request to the manager after the accountant approves', async () => {
    const response = await call('post', `/approvals/requests/${zeroRequestId}/approve`, accountant.token, {
      comment: 'تمت المراجعة',
    });
    expect(response.status).toBe(201);
    expect(data(response.body).status).toBe('pending');
    expect(data(response.body).currentStepOrder).toBe(2);
    const accountantInbox = await call('get', '/approvals/inbox', accountant.token);
    const managerInbox = await call('get', '/approvals/inbox', manager.token);
    expect((accountantInbox.body as unknown as Array<Record<string, unknown>>).some((row) => row.id === zeroRequestId)).toBe(false);
    expect((managerInbox.body as unknown as Array<Record<string, unknown>>).some((row) => row.id === zeroRequestId)).toBe(true);
  });

  it('auto-posts the document after the manager approves the final step', async () => {
    const response = await call('post', `/approvals/requests/${zeroRequestId}/approve`, manager.token, {
      comment: 'اعتماد نهائي',
    });
    expect(response.status).toBe(201);
    expect(data(response.body).status).toBe('approved');
    const invoice = await call('get', `/sales/invoices/${zeroInvoiceId}`);
    expect(data(invoice.body).status).toBe('posted');
  });

  it('lists approved and rejected requests with their decision history', async () => {
    const response = await call('get', '/approvals/history?status=approved,rejected', accountant.token);
    expect(response.status).toBe(200);
    const rows = response.body as unknown as Array<Record<string, unknown>>;
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.has(highRequestId)).toBe(true);
    expect(ids.has(purchaseRequestId)).toBe(true);
    expect(ids.has(zeroRequestId)).toBe(true);
    const completed = rows.find((row) => row.id === zeroRequestId);
    expect((completed?.decisions as unknown[]).length).toBe(2);
  });
});
