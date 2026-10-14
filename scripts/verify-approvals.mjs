#!/usr/bin/env node
/**
 * Live verification of Phase 04 — the tenant-scoped approval workflow engine.
 *
 * Run against a migrated, running stack:
 *   node scripts/verify-approvals.mjs
 *
 * Environment:
 *   API_BASE (default http://127.0.0.1:3000/api/v1)
 *   VERIFY_TENANT (default demo)
 *   VERIFY_EMAIL (default owner@demo.test)
 *   DEMO_OWNER_PASSWORD (loaded from the usual .env files)
 *
 * The temporary workflow uses the `expense` entity and is deactivated before exit, so the
 * check does not gate ordinary sales or purchase posting in a shared demo tenant.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let checks = 0;
let failures = 0;
let token = '';
let workflowId = '';

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function raw(method, path, body, authToken = token) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}

function payloadBody(response) {
  return response.body?.data ?? response.body;
}

function rows(response) {
  const payload = payloadBody(response);
  return Array.isArray(payload) ? payload : payload?.data ?? [];
}

async function main() {
  console.log(`■ approval workflow verification @ ${tenantCode}`);

  const login = await raw('POST', '/auth/login', { tenantCode, email, password }, '');
  token = login.body?.data?.accessToken ?? login.body?.accessToken ?? '';
  check('owner login succeeds', login.status === 200 && Boolean(token), `${login.status}`);
  if (!token) throw new Error('Cannot continue without a bearer token');

  const canonicalList = await raw('GET', '/approvals/workflows');
  const legacyList = await raw('GET', '/approval-workflows');
  check('GET /approvals/workflows is available', canonicalList.status === 200);
  check('GET /approval-workflows remains available', legacyList.status === 200);
  check('workflow list responses are arrays', Array.isArray(rows(canonicalList)) && Array.isArray(rows(legacyList)));
  check('workflow list is tenant-scoped', rows(canonicalList).every((workflow) => workflow.tenantId));

  const stamp = Date.now().toString(36);
  const conditionBranch = randomUUID();
  const conditionCostCenter = randomUUID();
  const create = await raw('POST', '/approvals/workflows', {
    entity: 'expense',
    name: `Phase 04 verification ${stamp}`,
    is_active: true,
    steps: [
      {
        step_order: 1,
        approver_role: 'Accountant',
        condition: {
          min_amount: '100',
          max_amount: '10000',
          branch_id: conditionBranch,
          cost_center_id: conditionCostCenter,
        },
        action: 'approve',
        is_required: true,
      },
    ],
  });
  workflowId = payloadBody(create)?.id ?? '';
  check('workflow creation is tenant-authorized', create.status === 201 && Boolean(workflowId));
  check('created workflow targets a supported entity', payloadBody(create)?.entity === 'expense');
  check('created workflow starts active', payloadBody(create)?.isActive === true);
  const createdSteps = payloadBody(create)?.steps ?? [];
  check('workflow creates its ordered steps', createdSteps.length === 1 && createdSteps[0]?.stepOrder === 1);
  check('step stores the approver role', createdSteps[0]?.approverRole === 'Accountant');
  check(
    'step stores amount, branch and cost-centre conditions',
    createdSteps[0]?.condition?.min_amount === '100' &&
      createdSteps[0]?.condition?.max_amount === '10000' &&
      createdSteps[0]?.condition?.branch_id === conditionBranch &&
      createdSteps[0]?.condition?.cost_center_id === conditionCostCenter,
  );

  const canonicalGet = await raw('GET', `/approvals/workflows/${workflowId}`);
  const legacyGet = await raw('GET', `/approval-workflows/${workflowId}`);
  check('canonical workflow detail is readable', canonicalGet.status === 200 && payloadBody(canonicalGet)?.id === workflowId);
  check('legacy workflow detail alias is readable', legacyGet.status === 200 && payloadBody(legacyGet)?.id === workflowId);

  const canonicalSteps = await raw('GET', `/approvals/workflows/${workflowId}/steps`);
  const legacySteps = await raw('GET', `/approval-workflows/${workflowId}/steps`);
  check('canonical steps endpoint is readable', canonicalSteps.status === 200 && rows(canonicalSteps).length === 1);
  check('legacy steps endpoint is readable', legacySteps.status === 200 && rows(legacySteps).length === 1);

  const update = await raw('PATCH', `/approvals/workflows/${workflowId}`, {
    entity: 'expense',
    name: `Phase 04 verification updated ${stamp}`,
    is_active: true,
    steps: [
      {
        step_order: 1,
        approver_role: 'Accountant',
        condition: { min_amount: '250' },
        action: 'approve',
        is_required: true,
      },
    ],
  });
  check('workflow update supports the canonical alias', update.status === 200 && payloadBody(update)?.name?.includes('updated'));

  const addStep = await raw('POST', `/approvals/workflows/${workflowId}/steps`, {
    step_order: 2,
    approver_role: 'Manager',
    condition: {},
    action: 'notify',
    is_required: false,
  });
  check('step append supports the canonical alias', addStep.status === 201 || addStep.status === 200);
  const afterAdd = await raw('GET', `/approvals/workflows/${workflowId}/steps`);
  const afterAddRows = rows(afterAdd);
  check('workflow retains both ordered steps', afterAddRows.length === 2);
  check('appended step is second and notify-only', afterAddRows[1]?.stepOrder === 2 && afterAddRows[1]?.action === 'notify');

  const noToken = await raw('GET', '/approvals/inbox', undefined, '');
  check('approval inbox requires authentication', noToken.status === 401 && noToken.body?.code === 'UNAUTHENTICATED');
  const history = await raw('GET', '/approvals/history');
  check('approval history endpoint is available', history.status === 200 && Array.isArray(rows(history)));
  const unknownSalesApproval = await raw('GET', `/sales/invoices/${randomUUID()}/approval`);
  check('invoice approval status is tenant-safe for an unknown invoice', unknownSalesApproval.status === 200 && payloadBody(unknownSalesApproval) === null);

  const deactivate = await raw('DELETE', `/approvals/workflows/${workflowId}`);
  check('workflow deactivation supports the canonical alias', deactivate.status === 200 && payloadBody(deactivate)?.isActive === false);
  const afterDelete = await raw('GET', `/approvals/workflows/${workflowId}`);
  check('deactivation keeps workflow history readable', afterDelete.status === 200 && payloadBody(afterDelete)?.isActive === false);

  const migration = await readFile(new URL('../packages/database/migrations/0100_approval_workflow_engine.sql', import.meta.url), 'utf8');
  check('migration 0100 exists for the Phase 04 schema', migration.includes('CREATE TABLE') && migration.includes('approval_workflows'));
  check('migration includes request and decision tables', migration.includes('approval_requests') && migration.includes('approval_decisions'));
  check('migration includes tenant RLS policies and idempotency index', migration.includes('ROW LEVEL SECURITY') && migration.includes('approval_requests_pending_entity_key'));
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\n✘ verification aborted: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (workflowId && token) {
    await raw('DELETE', `/approvals/workflows/${workflowId}`).catch(() => undefined);
  }
  console.log(`\n${failures ? '✘' : '✔'} approval verification: ${checks} checks, ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
}
