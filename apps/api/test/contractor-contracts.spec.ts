import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Contractor contracts, their payment certificates, and project offers.
 *
 * The invariants worth a test are the two deductions on a certificate — retention and
 * advance recovery — plus the ceiling on how much of a contract can be certified. Those
 * three are where a subcontractor gets overpaid, and none of them can be verified by
 * looking at a single row: they are running totals across the whole contract.
 */
describe('contractor contracts, payments and offers', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let clientId = '';
  let contractorId = '';
  let projectId = '';
  let cashLocationId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp('contractor-contracts');
    actor = await createActor(ctx, {
      tenantCode: 'contracting',
      email: 'owner@contracting.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'projects.view',
        'projects.manage',
        'projects.contractor.pay',
        'parties.view',
        'parties.manage',
        'treasury.view',
        'treasury.voucher.create',
      ],
    });

    const branch = await api(ctx.server, 'post', '/api/v1/branches', { token: actor.token, body: { code: 'MAIN', nameAr: 'الفرع الرئيسي' } });
    branchId = body(branch).id;
    const client = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'customer', name: 'عميل المشروع' } });
    clientId = body(client).id;
    const contractor = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'supplier', name: 'مقاول الباطن', isContractor: true } });
    contractorId = body(contractor).id;
    const project = await api(ctx.server, 'post', '/api/v1/projects', {
      token: actor.token,
      body: { branchId, code: 'PRJ-1', name: 'برج التقنية', partyId: clientId, contractValue: '1000000', retentionPct: '5' },
    });
    projectId = body(project).id;
    const cash = await api(ctx.server, 'post', '/api/v1/cash-locations', { token: actor.token, body: { branchId, kind: 'safe', name: 'الخزينة الرئيسية' } });
    cashLocationId = body(cash).id;
  }, 240_000);

  afterAll(async () => ctx.close());

  const createContract = () =>
    api(ctx.server, 'post', '/api/v1/contracting/contracts', {
      token: actor.token,
      body: {
        projectId,
        contractorPartyId: contractorId,
        title: 'أعمال الهيكل الخرساني',
        retentionPct: '10',
        advanceAmount: '20000',
        lines: [
          { description: 'حفر وأساسات', qty: '1', unitValue: '120000' },
          { description: 'خرسانة الأدوار', qty: '4', unitValue: '20000' },
        ],
      },
    });

  it('derives the contract value from its lines and refuses payments until it is active', async () => {
    const created = await createContract();
    expect(created.status).toBe(201);
    const contract = body(created);
    expect(contract.contractValue).toBe('200000.0000');
    expect(contract.status).toBe('draft');

    const early = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contract.id}/payments`, { token: actor.token, body: { grossAmount: '1000' } });
    expect(early.status).toBe(409);
    expect(early.body.code ?? (early.body as { error?: { code: string } }).error?.code).toBe('CONTRACT_INVALID_STATUS');

    const activated = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contract.id}/activate`, { token: actor.token, body: {} });
    expect(body(activated).status).toBe('active');
  });

  it('computes retention and advance recovery, and caps certification at the contract value', async () => {
    const created = await createContract();
    const contractId = body(created).id;
    await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/activate`, { token: actor.token, body: {} });

    const overRun = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, { token: actor.token, body: { grossAmount: '250000' } });
    expect(overRun.status).toBe(422);
    expect(overRun.body.code ?? (overRun.body as { error?: { code: string } }).error?.code).toBe('CONTRACTOR_PAYMENT_EXCEEDS_CONTRACT');

    // The advance is a prepayment: no retention, and it never eats the contract value.
    const advance = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, {
      token: actor.token,
      body: { kind: 'advance', grossAmount: '20000' },
    });
    expect(body(advance).retentionAmount).toBe('0.0000');
    expect(body(advance).netAmount).toBe('20000.0000');

    const tooMuchAdvance = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, {
      token: actor.token,
      body: { kind: 'advance', grossAmount: '1' },
    });
    expect(tooMuchAdvance.status).toBe(422);

    const certificate = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, {
      token: actor.token,
      body: { kind: 'progress', grossAmount: '100000', advanceRecovery: '10000' },
    });
    const payment = body(certificate);
    expect(payment.retentionAmount).toBe('10000.0000');
    expect(payment.netAmount).toBe('80000.0000');

    // Approve → pay: the money leaves through a draft treasury voucher, not a shadow ledger.
    await api(ctx.server, 'post', `/api/v1/contracting/payments/${payment.id}/approve`, { token: actor.token, body: {} });
    const paid = await api(ctx.server, 'post', `/api/v1/contracting/payments/${payment.id}/pay`, { token: actor.token, body: { cashLocationId } });
    expect(body(paid).status).toBe('paid');
    const voucherId = body(paid).voucherId;
    expect(voucherId).toBeTruthy();
    const voucher = await api(ctx.server, 'get', `/api/v1/vouchers/${voucherId}`, { token: actor.token });
    expect(body(voucher).kind).toBe('payment');
    expect(body(voucher).subtype).toBe('supplier');
    expect(body(voucher).status).toBe('draft');
    expect(String(body(voucher).amount)).toBe('80000.0000');

    const after = await api(ctx.server, 'get', `/api/v1/contracting/contracts/${contractId}`, { token: actor.token });
    expect(body(after).certified).toBe('100000.0000');
    expect(body(after).retentionHeld).toBe('10000.0000');
    expect(body(after).advanceOutstanding).toBe('10000.0000');

    // Retention can only be released down to what is actually held.
    const greedy = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, {
      token: actor.token,
      body: { kind: 'retention_release', grossAmount: '15000' },
    });
    expect(greedy.status).toBe(422);
    expect(greedy.body.code ?? (greedy.body as { error?: { code: string } }).error?.code).toBe('CONTRACTOR_RETENTION_EXCEEDED');

    // A cancelled certificate gives its value back to the contract.
    const spare = await api(ctx.server, 'post', `/api/v1/contracting/contracts/${contractId}/payments`, { token: actor.token, body: { grossAmount: '100000' } });
    const cancelled = await api(ctx.server, 'post', `/api/v1/contracting/payments/${body(spare).id}/cancel`, { token: actor.token, body: {} });
    expect(body(cancelled).status).toBe('cancelled');
    const released = await api(ctx.server, 'get', `/api/v1/contracting/contracts/${contractId}`, { token: actor.token });
    expect(body(released).remainingValue).toBe('100000.0000');

    const cancelPaid = await api(ctx.server, 'post', `/api/v1/contracting/payments/${payment.id}/cancel`, { token: actor.token, body: {} });
    expect(cancelPaid.status).toBe(409);
  });

  it('turns an accepted offer into a project whose BOQ mirrors the offer', async () => {
    const offer = await api(ctx.server, 'post', '/api/v1/contracting/offers', {
      token: actor.token,
      body: {
        partyId: clientId,
        branchId,
        title: 'عرض تنفيذ فيلا سكنية',
        retentionPct: '5',
        lines: [
          { code: 'A-1', description: 'أعمال الحفر', qty: '2', unitValue: '15000' },
          { code: 'A-2', description: 'أعمال التشطيب', qty: '1', unitValue: '70000' },
        ],
      },
    });
    expect(offer.status).toBe(201);
    const offerId = body(offer).id;
    expect(body(offer).totalValue).toBe('100000.0000');

    const early = await api(ctx.server, 'post', `/api/v1/contracting/offers/${offerId}/convert`, { token: actor.token, body: {} });
    expect(early.status).toBe(409);

    await api(ctx.server, 'post', `/api/v1/contracting/offers/${offerId}/send`, { token: actor.token, body: {} });
    await api(ctx.server, 'post', `/api/v1/contracting/offers/${offerId}/accept`, { token: actor.token, body: {} });

    const converted = await api(ctx.server, 'post', `/api/v1/contracting/offers/${offerId}/convert`, { token: actor.token, body: { code: 'PRJ-OF-1' } });
    expect(converted.status).toBe(201);
    const project = (converted.body.data ?? converted.body) as { id: string; contractValue: string; boq: Array<{ code: string; unitValue: string }> };
    expect(project.contractValue).toBe('100000.0000');
    expect(project.boq).toHaveLength(2);
    expect(project.boq.find((term) => term.code === 'A-1')?.unitValue).toBe('15000.0000');

    const again = await api(ctx.server, 'post', `/api/v1/contracting/offers/${offerId}/convert`, { token: actor.token, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.code ?? (again.body as { error?: { code: string } }).error?.code).toBe('OFFER_ALREADY_CONVERTED');
  });
});
