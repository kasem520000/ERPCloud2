import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('parties phase 08 integration', () => {
  let ctx: TestApp;
  let alpha: Actor;
  let beta: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('parties-phase-08');
    alpha = await createActor(ctx, {
      tenantCode: 'parties-alpha',
      email: 'owner@parties-alpha.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'parties.view', 'parties.manage', 'parties.allocate'],
    });
    beta = await createActor(ctx, {
      tenantCode: 'parties-beta',
      email: 'owner@parties-beta.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'parties.view', 'parties.manage', 'parties.allocate'],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('isolates party CRUD between tenants', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/parties', {
      token: alpha.token,
      body: { kind: 'customer', name: 'Alpha Customer', creditLimit: '1000.0000' },
    });
    expect(created.status).toBe(201);
    const createdParty = (created.body.data ?? created.body) as { id: string };
    const partyId = createdParty.id;

    const sameTenant = await api(ctx.server, 'get', `/api/v1/parties/${partyId}`, { token: alpha.token });
    expect(sameTenant.status).toBe(200);

    // 🔑 R6: عميلُ مستأجرٍ آخر **غير موجود** بنسبة لنا — لا «200 فارغ». والعزل يبقى تامّاً:
    // الردّ لا يحمل أثراً من بيانات الجار.
    const otherTenant = await api(ctx.server, 'get', `/api/v1/parties/${partyId}`, { token: beta.token });
    expect(otherTenant.status).toBe(404);
    expect((otherTenant.body as { code?: string }).code).toBe('PARTY_NOT_FOUND');
    expect(JSON.stringify(otherTenant.body)).not.toContain('Alpha Customer');

    const betaList = await api(ctx.server, 'get', '/api/v1/parties', { token: beta.token });
    expect(betaList.status).toBe(200);
    expect(betaList.body.data ?? betaList.body).toEqual([]);
  });

  /**
   * 🗑️ حذف عميل — `frmCustomers`. `partyBalance` returns money as four-decimal strings,
   * and `softDelete` used to compare them to `'0'`, which refused **every** delete: a
   * customer with no movement at all could never be removed. Found by
   * `scripts/verify-tailoring.mjs` while cleaning up the عميل it had created.
   */
  it('deletes a party that has no balance — and refuses one that does', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/parties', {
      token: alpha.token,
      body: { kind: 'customer', name: 'Customer With No Movement' },
    });
    expect(created.status).toBe(201);
    const partyId = ((created.body.data ?? created.body) as { id: string }).id;

    const ledger = await api(ctx.server, 'get', `/api/v1/parties/${partyId}/balance`, { token: alpha.token });
    expect(ledger.status).toBe(200);
    // `0.0000` is zero, however many decimals it carries — comparing the *string* to
    // `'0'` is what made every delete fail (`PARTY_HAS_OPEN_BALANCE`).
    expect(Number((ledger.body.data ?? ledger.body).receivable)).toBe(0);

    const removed = await api(ctx.server, 'delete', `/api/v1/parties/${partyId}`, { token: alpha.token });
    expect(removed.status).toBe(200);

    // 🔑 R6: كان الغائب يعود **200 بجسمٍ فارغ**، وهو أسوأ من الخطأ؛ صار الغياب مُعلَناً.
    const gone = await api(ctx.server, 'get', `/api/v1/parties/${partyId}`, { token: alpha.token });
    expect(gone.status).toBe(404);
    expect((gone.body as { code?: string }).code).toBe('PARTY_NOT_FOUND');
  });

  it('keeps contacts tenant-scoped and supports soft deletion', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/parties', {
      token: alpha.token,
      body: { kind: 'supplier', name: 'Alpha Supplier' },
    });
    const createdParty = (created.body.data ?? created.body) as { id: string };
    const partyId = createdParty.id;
    const added = await api(ctx.server, 'post', `/api/v1/parties/${partyId}/contacts`, {
      token: alpha.token,
      body: { name: 'Primary Contact', email: 'contact@alpha.test', isPrimary: true },
    });
    expect(added.status).toBe(201);
    const contactRows = (added.body.data ?? added.body) as Array<{ id: string }>;
    expect(contactRows).toHaveLength(1);
    const contactId = contactRows[0]!.id;

    const hidden = await api(ctx.server, 'delete', `/api/v1/parties/${partyId}/contacts/${contactId}`, { token: alpha.token });
    expect(hidden.status).toBe(200);
    const contacts = await api(ctx.server, 'get', `/api/v1/parties/${partyId}/contacts`, { token: alpha.token });
    expect(contacts.body.data ?? contacts.body).toEqual([]);
  });

  it('rejects allocations that exceed the invoice total', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/allocations', {
      token: alpha.token,
      body: {
        partyId: '00000000-0000-4000-8000-000000000001',
        invoiceKind: 'sales_invoice',
        invoiceId: '00000000-0000-4000-8000-000000000002',
        amount: '60.0000',
        invoiceTotal: '100.0000',
        alreadyAllocated: '50.0000',
      },
    });
    expect(response.status).toBe(422);
  });
});


describe('parties API permissions', () => {
  let ctx: TestApp;
  let actor: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('parties-permissions');
    actor = await createActor(ctx, {
      tenantCode: 'parties-view-only',
      email: 'viewer@parties.test',
      permissions: ['parties.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('forbids party mutation without parties.manage', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'Forbidden Customer' },
    });
    expect(response.status).toBe(403);
  });
});

export {};
