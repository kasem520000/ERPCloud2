import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { BRANCH_ID_HEADER } from '@erp/contracts';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Branches, warehouses and cash locations — API_CONTRACT §3, PHASE_05 §5.1–§5.3.
 *
 * The interesting behaviour is not the CRUD: it is the invariants around it — one
 * default per tenant, a branch that still owns rows cannot be deleted, a branch-scoped
 * membership sees a smaller world, and bank data is masked in lists.
 */
describe('organization structure (PHASE_05 §5.1–§5.3)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let scoped: Actor;
  let viewer: Actor;
  let mainBranchId: string;
  let secondBranchId: string;

  beforeAll(async () => {
    ctx = await createTestApp('org-structure');
    admin = await createActor(ctx, {
      tenantCode: 'org-struct',
      email: 'admin@org-struct.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const asAdmin = { token: () => admin.token };

  it('creates the first branch as the default one', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: {
        code: 'main',
        nameAr: 'الفرع الرئيسي',
        nameEn: 'Main branch',
        phone: '+966110000000',
        address: { city: 'Riyadh', district: 'Olaya', postal: '12345', countryCode: 'SA' },
      },
    });

    expect(created.status).toBe(201);
    const branch = created.body.data as { id: string; code: string; isDefault: boolean; version: number };
    // `orgCodeSchema` normalises to upper case — codes are matched by humans and imports.
    expect(branch.code).toBe('MAIN');
    expect(branch.isDefault).toBe(true);
    expect(branch.version).toBe(1);
    mainBranchId = branch.id;
  });

  it('refuses a duplicate branch code with 422 VALIDATION_FAILED', async () => {
    const duplicate = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: { code: 'MAIN', nameAr: 'مكرر' },
    });

    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe('VALIDATION_FAILED');
    expect(duplicate.body.detail).toContain('MAIN');
  });

  it('rejects an unknown key on create (mass-assignment defence)', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: { code: 'X1', nameAr: 'فرع', tenantId: admin.tenantId },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('moves the default flag transactionally instead of ever holding two', async () => {
    const second = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: { code: 'JED', nameAr: 'فرع جدة', nameEn: 'Jeddah' },
    });
    expect(second.status).toBe(201);
    secondBranchId = (second.body.data as { id: string }).id;
    expect((second.body.data as { isDefault: boolean }).isDefault).toBe(false);

    const promoted = await api(ctx.server, 'patch', `/api/v1/branches/${secondBranchId}`, {
      token: asAdmin.token(),
      body: { isDefault: true },
    });
    expect(promoted.status).toBe(200);

    const defaults = await api(ctx.server, 'get', '/api/v1/branches?filter[isDefault]=true', {
      token: asAdmin.token(),
    });
    expect((defaults.body.data as unknown[]).length).toBe(1);
    expect((defaults.body.data as Array<{ id: string }>)[0]?.id).toBe(secondBranchId);

    // Put it back so the rest of the suite can reason about MAIN.
    await api(ctx.server, 'patch', `/api/v1/branches/${mainBranchId}`, {
      token: asAdmin.token(),
      body: { isDefault: true },
    });
  });

  it('refuses to clear, deactivate or delete the default branch', async () => {
    const cleared = await api(ctx.server, 'patch', `/api/v1/branches/${mainBranchId}`, {
      token: asAdmin.token(),
      body: { isDefault: false },
    });
    expect(cleared.status).toBe(422);

    const deactivated = await api(ctx.server, 'patch', `/api/v1/branches/${mainBranchId}`, {
      token: asAdmin.token(),
      body: { isActive: false },
    });
    expect(deactivated.status).toBe(422);

    const deleted = await api(ctx.server, 'delete', `/api/v1/branches/${mainBranchId}`, {
      token: asAdmin.token(),
    });
    expect(deleted.status).toBe(422);
  });

  it('refuses a stale version with 409 VERSION_CONFLICT', async () => {
    const read = await api(ctx.server, 'get', `/api/v1/branches/${secondBranchId}`, {
      token: asAdmin.token(),
    });
    const version = (read.body.data as { version: number }).version;

    const first = await api(ctx.server, 'patch', `/api/v1/branches/${secondBranchId}`, {
      token: asAdmin.token(),
      body: { nameEn: 'Jeddah HQ', version },
    });
    expect(first.status).toBe(200);
    expect((first.body.data as { version: number }).version).toBe(version + 1);

    const stale = await api(ctx.server, 'patch', `/api/v1/branches/${secondBranchId}`, {
      token: asAdmin.token(),
      body: { nameEn: 'Jeddah Main', version },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('creates warehouses under a branch and keeps one default', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: asAdmin.token(),
      body: { branchId: mainBranchId, code: 'WH1', name: 'Main store' },
    });
    expect(created.status).toBe(201);
    expect((created.body.data as { isDefault: boolean }).isDefault).toBe(true);

    const second = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: asAdmin.token(),
      body: { branchId: secondBranchId, code: 'WH2', name: 'Jeddah store', isDefault: true },
    });
    expect(second.status).toBe(201);

    const list = await api(ctx.server, 'get', '/api/v1/warehouses?filter[isDefault]=true', {
      token: asAdmin.token(),
    });
    expect((list.body.data as unknown[]).length).toBe(1);
  });

  it('refuses a warehouse under an unknown branch', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: asAdmin.token(),
      body: {
        branchId: '018f3b8a-0000-7000-8000-0000000000ff',
        code: 'WH9',
        name: 'Ghost store',
      },
    });
    expect(response.status).toBe(404);
  });

  it('refuses to delete a branch that still owns a warehouse', async () => {
    const response = await api(ctx.server, 'delete', `/api/v1/branches/${secondBranchId}`, {
      token: asAdmin.token(),
    });
    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('warehouses');
  });

  it('masks the IBAN in the list and returns it in full on the detail read', async () => {
    const iban = 'SA0380000000608010167519';
    const created = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: {
        branchId: mainBranchId,
        kind: 'bank',
        name: 'Al Rajhi current',
        bank: { bankName: 'Al Rajhi', iban, swift: 'RJHISARI' },
      },
    });
    expect(created.status).toBe(201);
    const cashLocationId = (created.body.data as { id: string }).id;

    const list = await api(ctx.server, 'get', '/api/v1/cash-locations?filter[kind]=bank', {
      token: asAdmin.token(),
    });
    const listed = (list.body.data as Array<{ id: string; bank: { iban: string } }>).find(
      (row) => row.id === cashLocationId,
    );
    expect(listed?.bank.iban).toBe('SA03****************7519');

    const detail = await api(ctx.server, 'get', `/api/v1/cash-locations/${cashLocationId}`, {
      token: asAdmin.token(),
    });
    expect((detail.body.data as { bank: { iban: string } }).bank.iban).toBe(iban);
  });

  it('rejects an invalid IBAN and a safe that carries bank details', async () => {
    const badIban = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: {
        branchId: mainBranchId,
        kind: 'bank',
        name: 'Typo bank',
        // The last two digits are transposed: length and charset are fine, mod-97 is not.
        bank: { bankName: 'Al Rajhi', iban: 'SA0380000000608010167591' },
      },
    });
    expect(badIban.status).toBe(400);

    const safeWithBank = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: {
        branchId: mainBranchId,
        kind: 'safe',
        name: 'Confused safe',
        bank: { bankName: 'Al Rajhi' },
      },
    });
    expect(safeWithBank.status).toBe(422);
    expect(safeWithBank.body.detail).toContain('safe');
  });

  it('seeds a zero balance row per cash location and exposes it read-only', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: { branchId: mainBranchId, kind: 'safe', name: 'Main safe' },
    });
    expect(created.status).toBe(201);
    const cashLocationId = (created.body.data as { id: string }).id;

    const balances = await api(ctx.server, 'get', `/api/v1/cash-locations/${cashLocationId}/balances`, {
      token: asAdmin.token(),
    });
    expect(balances.status).toBe(200);
    const rows = balances.body.data as Array<{ currencyCode: string; balance: string }>;
    expect(rows).toHaveLength(1);
    // The tenant's base currency, and money is a decimal string over the wire (ADR-006).
    expect(rows[0]?.currencyCode).toBe('SAR');
    expect(rows[0]?.balance).toBe('0.0000');
  });

  it('writes an explicit before/after audit row for a cash-location update', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: { branchId: mainBranchId, kind: 'bank', name: 'Audited bank', bank: { bankName: 'SNB' } },
    });
    const cashLocationId = (created.body.data as { id: string }).id;

    const updated = await api(ctx.server, 'patch', `/api/v1/cash-locations/${cashLocationId}`, {
      token: asAdmin.token(),
      body: { name: 'Audited bank (renamed)' },
    });
    expect(updated.status).toBe(200);

    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{
        action: string;
        before: { name: string } | null;
        after: { name: string } | null;
        actor_user_id: string | null;
      }>(
        `SELECT action, before, after, actor_user_id FROM audit_log
          WHERE entity = 'cash_location' AND entity_id = $1 ORDER BY created_at ASC`,
        [cashLocationId],
      );

      expect(rows.map((row) => row.action)).toEqual(['create', 'update']);
      expect(rows[1]?.before?.name).toBe('Audited bank');
      expect(rows[1]?.after?.name).toBe('Audited bank (renamed)');
      expect(rows[1]?.actor_user_id).toBe(admin.userId);
    } finally {
      await client.end();
    }
  });

  it('masks the IBAN inside the audit row too', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: asAdmin.token(),
      body: {
        branchId: mainBranchId,
        kind: 'bank',
        name: 'Sensitive bank',
        bank: { bankName: 'ANB', iban: 'GB82WEST12345698765432' },
      },
    });
    const cashLocationId = (created.body.data as { id: string }).id;

    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ after: { bank: { iban: string } } }>(
        `SELECT after FROM audit_log WHERE entity = 'cash_location' AND entity_id = $1`,
        [cashLocationId],
      );
      expect(rows[0]?.after.bank.iban).toBe('GB82**************5432');
    } finally {
      await client.end();
    }
  });

  it('hides soft-deleted rows from every read', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: { code: 'TEMP', nameAr: 'مؤقت' },
    });
    const branchId = (created.body.data as { id: string }).id;

    const removed = await api(ctx.server, 'delete', `/api/v1/branches/${branchId}`, {
      token: asAdmin.token(),
    });
    expect(removed.status).toBe(204);

    const read = await api(ctx.server, 'get', `/api/v1/branches/${branchId}`, { token: asAdmin.token() });
    expect(read.status).toBe(404);

    const list = await api(ctx.server, 'get', '/api/v1/branches?limit=100', { token: asAdmin.token() });
    expect((list.body.data as Array<{ id: string }>).some((row) => row.id === branchId)).toBe(false);

    // The row is still there — DELETE is a soft delete (CR-008), and the code is freed.
    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ deleted_at: Date | null; is_active: boolean }>(
        'SELECT deleted_at, is_active FROM branches WHERE id = $1',
        [branchId],
      );
      expect(rows[0]?.deleted_at).not.toBeNull();
      expect(rows[0]?.is_active).toBe(false);
    } finally {
      await client.end();
    }

    const reused = await api(ctx.server, 'post', '/api/v1/branches', {
      token: asAdmin.token(),
      body: { code: 'TEMP', nameAr: 'مؤقت مرة أخرى' },
    });
    expect(reused.status).toBe(201);
    await api(ctx.server, 'delete', `/api/v1/branches/${(reused.body.data as { id: string }).id}`, {
      token: asAdmin.token(),
    });
  });

  it('narrows every organization list to the membership branch scope', async () => {
    scoped = await createActor(ctx, {
      tenantId: admin.tenantId,
      tenantCode: admin.tenantCode,
      email: 'scoped@org-struct.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
      roleNames: ['Branch manager'],
      isOwner: false,
      branchScope: [secondBranchId],
    });

    const branchList = await api(ctx.server, 'get', '/api/v1/branches?limit=100', {
      token: scoped.token,
    });
    expect(branchList.status).toBe(200);
    expect((branchList.body.data as Array<{ id: string }>).map((row) => row.id)).toEqual([secondBranchId]);

    // A branch outside the scope is *not found*, never "forbidden" (MULTI_TENANCY §7.1).
    const foreign = await api(ctx.server, 'get', `/api/v1/branches/${mainBranchId}`, {
      token: scoped.token,
    });
    expect(foreign.status).toBe(404);

    const warehouseList = await api(ctx.server, 'get', '/api/v1/warehouses?limit=100', {
      token: scoped.token,
    });
    expect(
      (warehouseList.body.data as Array<{ branchId: string }>).every(
        (row) => row.branchId === secondBranchId,
      ),
    ).toBe(true);

    const cashList = await api(ctx.server, 'get', '/api/v1/cash-locations?limit=100', {
      token: scoped.token,
    });
    expect(cashList.body.data).toEqual([]);
  });

  it('rejects an X-Branch-Id outside the membership scope and honours one inside it', async () => {
    const outside = await api(ctx.server, 'get', '/api/v1/branches', {
      token: scoped.token,
      headers: { [BRANCH_ID_HEADER]: mainBranchId },
    });
    expect(outside.status).toBe(403);

    const inside = await api(ctx.server, 'get', '/api/v1/branches', {
      token: scoped.token,
      headers: { [BRANCH_ID_HEADER]: secondBranchId },
    });
    expect(inside.status).toBe(200);
    expect((inside.body.data as unknown[]).length).toBe(1);

    // An unrestricted membership can still narrow itself with the header.
    const narrowed = await api(ctx.server, 'get', '/api/v1/branches?limit=100', {
      token: asAdmin.token(),
      headers: { [BRANCH_ID_HEADER]: mainBranchId },
    });
    expect((narrowed.body.data as Array<{ id: string }>).map((row) => row.id)).toEqual([mainBranchId]);
  });

  it('enforces the organization permissions', async () => {
    viewer = await createActor(ctx, {
      tenantId: admin.tenantId,
      tenantCode: admin.tenantCode,
      email: 'viewer@org-struct.test',
      permissions: ['organization.branch.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });

    const allowed = await api(ctx.server, 'get', '/api/v1/branches', { token: viewer.token });
    expect(allowed.status).toBe(200);

    const denied = await api(ctx.server, 'post', '/api/v1/branches', {
      token: viewer.token,
      body: { code: 'NOPE', nameAr: 'ممنوع' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    const otherResource = await api(ctx.server, 'get', '/api/v1/warehouses', { token: viewer.token });
    expect(otherResource.status).toBe(403);
  });
});
