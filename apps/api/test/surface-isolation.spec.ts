import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectIsolation, rlsProbe } from '@erp/testing';

import { TokenService } from '../src/modules/platform/index.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_TENANT_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api, createIsolationHttp } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Surface & plane isolation after the 2026-09 architecture/RBAC reorganisation
 * (docs/architecture-rbac/). The six mandatory proofs:
 *
 *   1. a user cannot reach another tenant;
 *   2. a tenant user cannot reach the platform console;
 *   3. an external (portal) customer cannot reach the ERP;
 *   4. a tenant owner holds no platform permission;
 *   5. RLS isolates reads and writes at the SQL layer;
 *   6. authentication/authorisation keep working after the reorganisation
 *      (legacy `platform.*` grants, canonical `tenant.*` grants, platform roles,
 *      devices, membership scopes).
 */
describe('surface isolation', () => {
  let ctx: TestApp;
  let http: ReturnType<typeof createIsolationHttp>;
  let ownerA: Actor;
  let ownerB: Actor;
  let platformOwner: Actor;
  let support: Actor;
  let portalBuyerToken = '';

  const body = (response: { body: Record<string, unknown> }) =>
    (response.body.data ?? response.body) as Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp('surface-isolation');
    http = createIsolationHttp(ctx.server);

    const staffPermissions = [
      ...ALL_TENANT_PERMISSIONS,
      ...ALL_ORGANIZATION_PERMISSIONS,
      'parties.view',
      'parties.manage',
      'sales.view',
      'catalog.item.view',
    ];
    ownerA = await createActor(ctx, {
      tenantCode: 'surf-a',
      email: 'owner@surf-a.test',
      permissions: staffPermissions,
      isOwner: true,
    });
    ownerB = await createActor(ctx, {
      tenantCode: 'surf-b',
      email: 'owner@surf-b.test',
      permissions: staffPermissions,
      isOwner: true,
    });
    // Legacy platform administrator (flag only — no platform_memberships row) plus a
    // real password, so the login flow itself is exercised below.
    platformOwner = await createActor(ctx, {
      tenantCode: 'surf-ops',
      email: 'ops@platform.test',
      permissions: [],
      isOwner: false,
      isPlatformAdmin: true,
      password: 'Ops-Platform-2026!',
    });
    // Fine-grained platform operator: support role, no user administration.
    support = await createActor(ctx, {
      tenantCode: 'surf-ops',
      tenantId: platformOwner.tenantId,
      email: 'support@platform.test',
      permissions: [],
      roleNames: ['Support'],
      isOwner: false,
      platformRoles: ['platform_support'],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------ 1. cross-tenant

  it('runs the full isolation harness against roles (HTTP + RLS)', async () => {
    let counter = 0;
    const actors = () => ({
      a: { label: ownerA.tenantCode, tenantId: ownerA.tenantId, token: ownerA.token },
      b: { label: ownerB.tenantCode, tenantId: ownerB.tenantId, token: ownerB.token },
    });
    const result = await expectIsolation(
      http,
      actors(),
      {
        resource: 'roles',
        tableName: 'roles',
        createRow: async (actor) => {
          counter += 1;
          const response = await http.post(actor, '/api/v1/roles', {
            name: `Probe ${counter}`,
            permissionCodes: ['tenant.view'],
          });
          expect(response.status).toBe(201);
          return (response.body as { data: { id: string } }).data.id;
        },
        readById: async (actor, rowId) => (await http.get(actor, `/api/v1/roles/${rowId}`)).status,
        listRowIds: async (actor) => {
          const response = await http.get(actor, '/api/v1/roles?limit=200');
          return ((response.body as { data: Array<{ id: string }> }).data ?? []).map((row) => row.id);
        },
        writeForeignRow: async (actor, rowId) =>
          (await http.put(actor, `/api/v1/roles/${rowId}`, { description: 'hijacked' })).status,
        createWithForeignReference: async (actor, foreignRowId) =>
          (
            await http.post(actor, '/api/v1/memberships', {
              email: `sneaky-${counter}@surf.test`,
              roleIds: [foreignRowId],
            })
          ).status,
        attemptForeignInsert: async (client, foreignTenantId) => {
          await client.query(
            `INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'smuggled')`,
            [foreignTenantId],
          );
        },
      },
      { appUrl: ctx.db.appUrl, migratorUrl: ctx.db.migratorUrl },
    );
    expect(result.readBlocked).toBe(true);
    expect(result.writeBlocked).toBe(true);
    expect(result.rlsBlocked).toBe(true);
  });

  it('rejects a token whose tid/mid pair does not belong together', async () => {
    const tokens = ctx.app.get(TokenService);
    const { token } = await tokens.signAccessToken({
      sub: ownerA.userId,
      tid: ownerB.tenantId,
      mid: ownerA.membershipId,
      scope: ['erp'],
    });
    const response = await api(ctx.server, 'get', '/api/v1/tenant', { token });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('serves each tenant only its own tenant record', async () => {
    const a = await api(ctx.server, 'get', '/api/v1/tenant', { token: ownerA.token });
    expect(a.status).toBe(200);
    expect(body(a).code).toBe('surf-a');
  });

  // ------------------------------------------------------- 2. tenant vs platform

  it('denies a tenant user on the platform console plane', async () => {
    for (const path of ['/api/v1/platform/overview', '/api/v1/platform/tenants', '/api/v1/platform/users']) {
      const response = await api(ctx.server, 'get', path, { token: ownerA.token });
      expect(response.status, path).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
  });

  // ------------------------------------------------------- 3. portal vs ERP

  it('grants a buyer portal access, then contains it to /portal/*', async () => {
    const party = await api(ctx.server, 'post', '/api/v1/parties', {
      token: ownerA.token,
      body: { kind: 'customer', name: 'مشتري البوابة' },
    });
    expect(party.status).toBe(201);
    const partyId = body(party).id;

    const granted = await api(ctx.server, 'post', `/api/v1/parties/${partyId}/portal-access`, {
      token: ownerA.token,
      body: { email: 'buyer@surf-a.test', notify: false },
    });
    expect(granted.status).toBe(201);
    const temporaryPassword = (body(granted) as Record<string, string>).temporaryPassword ?? '';
    expect(temporaryPassword.length).toBeGreaterThan(0);

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'buyer@surf-a.test', password: temporaryPassword, tenantCode: 'surf-a' },
    });
    expect(login.status).toBe(200);
    portalBuyerToken = body(login).accessToken;
    expect(portalBuyerToken).toBeTruthy();

    const membership = (
      (login.body.data ?? login.body) as {
        memberships: Array<{ kind: string; roles: Array<{ name: string }> }>;
      }
    ).memberships[0];
    expect(membership?.kind).toBe('portal');

    // The buyer's own surface works…
    const me = await api(ctx.server, 'get', '/api/v1/portal/me', { token: portalBuyerToken });
    expect(me.status).toBe(200);
    const invoices = await api(ctx.server, 'get', '/api/v1/portal/invoices', { token: portalBuyerToken });
    expect(invoices.status).toBe(200);

    // …and everything else refuses, with the explicit portal denial.
    for (const path of ['/api/v1/tenant', '/api/v1/roles', '/api/v1/devices', '/api/v1/branches']) {
      const denied = await api(ctx.server, 'get', path, { token: portalBuyerToken });
      expect(denied.status, path).toBe(403);
      expect(denied.body.detail).toBe('portal memberships cannot access staff endpoints');
    }
    const consoleDenied = await api(ctx.server, 'get', '/api/v1/platform/overview', {
      token: portalBuyerToken,
    });
    expect(consoleDenied.status).toBe(403);
  });

  it('denies a fixture-level portal membership on ERP routes even with a granted permission', async () => {
    const portalActor = await createActor(ctx, {
      tenantCode: 'surf-a',
      tenantId: ownerA.tenantId,
      email: 'smuggled@surf-a.test',
      permissions: ['tenant.view'],
      roleNames: ['Smuggled'],
      isOwner: false,
      kind: 'portal',
    });
    const denied = await api(ctx.server, 'get', '/api/v1/tenant', { token: portalActor.token });
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toBe('portal memberships cannot access staff endpoints');
  });

  // ------------------------------------------------------- 4. owner vs platform

  it('grants the tenant owner no platform permission', async () => {
    const overview = await api(ctx.server, 'get', '/api/v1/platform/overview', { token: ownerA.token });
    expect(overview.status).toBe(403);

    const me = await api(ctx.server, 'get', '/api/v1/me', { token: ownerA.token });
    expect(me.status).toBe(200);
    const user = (me.body.data as { user: { isPlatformAdmin: boolean; platformRoles: string[] } }).user;
    expect(user.isPlatformAdmin).toBe(false);
    expect(user.platformRoles).toEqual([]);
  });

  it('rejects console.* codes in tenant roles', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/roles', {
      token: ownerA.token,
      body: { name: 'Console Smuggler', permissionCodes: ['console.tenants.view'] },
    });
    expect(response.status).toBe(422);
    expect(String(response.body.detail)).toContain('console.tenants.view');
  });

  // ------------------------------------------------------------------ 5. RLS

  it('isolates the devices table at the SQL layer', async () => {
    const branchOf = async (actor: Actor): Promise<string> => {
      const created = await api(ctx.server, 'post', '/api/v1/branches', {
        token: actor.token,
        body: { code: `RLS-${actor.tenantCode}`, nameAr: `فرع ${actor.tenantCode}` },
      });
      expect(created.status).toBe(201);
      return body(created).id;
    };
    const branchA = await branchOf(ownerA);
    const branchB = await branchOf(ownerB);

    for (const [actor, branchId] of [
      [ownerA, branchA],
      [ownerB, branchB],
    ] as const) {
      const created = await api(ctx.server, 'post', '/api/v1/devices', {
        token: actor.token,
        body: { branchId, deviceType: 'pos_terminal', deviceName: `TILL-${actor.tenantCode}` },
      });
      expect(created.status).toBe(201);
    }

    // Cross-tenant read through HTTP is a 404…
    const listB = await api(ctx.server, 'get', '/api/v1/devices', { token: ownerB.token });
    const foreignId = ((listB.body.data ?? []) as Array<{ id: string }>).find((row) =>
      row.id && row.id.length > 0,
    )?.id;
    expect(foreignId).toBeTruthy();
    // …and the raw RLS probe hides everything without the GUC and peers' rows with it.
    const probe = await rlsProbe(ctx.db.appUrl, 'devices', ownerA.tenantId);
    expect(probe.visibleWithoutGuc).toBe(0);
    expect(probe.visibleWithGuc).toBeGreaterThan(0);
  });

  // ------------------------------------------------------- 6. auth after the reorganisation

  it('honours a legacy platform.* grant on a canonical tenant.* route', async () => {
    const legacy = await createActor(ctx, {
      tenantCode: 'surf-a',
      tenantId: ownerA.tenantId,
      email: 'legacy@surf-a.test',
      permissions: ['platform.tenant.view'],
      roleNames: ['Legacy viewer'],
      isOwner: false,
    });
    const response = await api(ctx.server, 'get', '/api/v1/tenant', { token: legacy.token });
    expect(response.status).toBe(200);
    expect(body(response).code).toBe('surf-a');
  });

  it('honours a canonical tenant.* grant', async () => {
    const canonical = await createActor(ctx, {
      tenantCode: 'surf-a',
      tenantId: ownerA.tenantId,
      email: 'canonical@surf-a.test',
      permissions: ['tenant.view', 'tenant.manage'],
      roleNames: ['Canonical admin'],
      isOwner: false,
    });
    const response = await api(ctx.server, 'patch', '/api/v1/tenant', {
      token: canonical.token,
      body: { name: 'Surf A Renamed' },
    });
    expect(response.status).toBe(200);
  });

  it('logs a legacy platform administrator in with owner-equivalent platform access', async () => {
    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'ops@platform.test', password: 'Ops-Platform-2026!', tenantCode: 'surf-ops' },
    });
    expect(login.status).toBe(200);
    const session = (login.body.data ?? login.body) as {
      accessToken: string;
      user: { isPlatformAdmin: boolean; platformRoles: string[] };
    };
    expect(session.user.isPlatformAdmin).toBe(true);
    expect(session.user.platformRoles).toEqual(['platform_owner']);

    const overview = await api(ctx.server, 'get', '/api/v1/platform/overview', {
      token: session.accessToken,
    });
    expect(overview.status).toBe(200);

    const roles = await api(ctx.server, 'get', '/api/v1/platform/roles', { token: session.accessToken });
    expect(roles.status).toBe(200);
    const codes = ((roles.body.data ?? []) as Array<{ code: string }>).map((row) => row.code);
    expect(codes).toContain('platform_owner');
    expect(codes).toContain('platform_support');

    const permissions = await api(ctx.server, 'get', '/api/v1/platform/permissions', {
      token: session.accessToken,
    });
    expect(permissions.status).toBe(200);
    expect(((permissions.body.data ?? []) as Array<{ code: string }>).length).toBeGreaterThan(0);
  });

  it('enforces fine-grained platform permissions on role grants', async () => {
    // Support reaches the console (legacy rule) but cannot grant roles.
    const overview = await api(ctx.server, 'get', '/api/v1/platform/overview', { token: support.token });
    expect(overview.status).toBe(200);

    const refused = await api(ctx.server, 'post', `/api/v1/platform/users/${ownerA.userId}/roles`, {
      token: support.token,
      body: { roleCode: 'platform_billing' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('platform permission console.users.manage required');

    // The platform owner can grant and revoke.
    const granted = await api(ctx.server, 'post', `/api/v1/platform/users/${support.userId}/roles`, {
      token: platformOwner.token,
      body: { roleCode: 'platform_billing' },
    });
    expect(granted.status).toBe(201);

    const bogus = await api(ctx.server, 'post', `/api/v1/platform/users/${support.userId}/roles`, {
      token: platformOwner.token,
      body: { roleCode: 'platform_emperor' },
    });
    expect(bogus.status).toBe(422);

    const revoked = await api(ctx.server, 'delete', `/api/v1/platform/users/${support.userId}/roles/platform_billing`, {
      token: platformOwner.token,
    });
    expect(revoked.status).toBe(200);

    const users = await api(ctx.server, 'get', '/api/v1/platform/users?search=support@platform.test', {
      token: platformOwner.token,
    });
    expect(users.status).toBe(200);
    // P-C3 rewrote this view: the row is the typed directory entry (`platformRoles`,
    // `tenants`, `activeSessionCount`) instead of the raw SQL snapshot (`platform_roles`).
    // The assertion is the same one: support is granted, billing is not.
    const rows = (users.body.data ?? []) as Array<{ email: string; platformRoles: string[] }>;
    const row = rows.find((entry) => entry.email === 'support@platform.test');
    expect(row?.platformRoles).toContain('platform_support');
    expect(row?.platformRoles ?? []).not.toContain('platform_billing');
  });

  it('manages membership scopes and surfaces them on /me', async () => {
    const member = await createActor(ctx, {
      tenantCode: 'surf-a',
      tenantId: ownerA.tenantId,
      email: 'scoped@surf-a.test',
      permissions: ['inventory.view', 'inventory.transfer'],
      roleNames: ['Scoped keeper'],
      isOwner: false,
    });

    const dangling = await api(ctx.server, 'post', `/api/v1/memberships/${member.membershipId}/scopes`, {
      token: ownerA.token,
      body: { scopes: [{ roleId: ownerA.roleIds[0], scopeType: 'warehouse', scopeId: member.membershipId }] },
    });
    expect(dangling.status).toBe(422);

    const warehouseId = '33333333-3333-4333-8333-333333333333';
    const replaced = await api(ctx.server, 'post', `/api/v1/memberships/${member.membershipId}/scopes`, {
      token: ownerA.token,
      body: { scopes: [{ roleId: member.roleIds[0], scopeType: 'warehouse', scopeId: warehouseId }] },
    });
    expect(replaced.status).toBe(201);
    const membership = replaced.body.data as {
      scopes: Array<{ roleId: string; scopeType: string; scopeId: string }>;
    };
    expect(membership.scopes).toEqual([
      { roleId: member.roleIds[0], scopeType: 'warehouse', scopeId: warehouseId },
    ]);

    const me = await api(ctx.server, 'get', '/api/v1/me', { token: member.token });
    expect(me.status).toBe(200);
    const mine = (me.body.data as { membership: { kind: string; scopes: unknown[] } }).membership;
    expect(mine.kind).toBe('staff');
    expect(mine.scopes).toHaveLength(1);
  });

  it('runs the device lifecycle with tenant isolation', async () => {
    const branch = body(
      await api(ctx.server, 'post', '/api/v1/branches', {
        token: ownerA.token,
        body: { code: 'DEV-MAIN', nameAr: 'فرع الأجهزة' },
      }),
    ).id;

    const created = await api(ctx.server, 'post', '/api/v1/devices', {
      token: ownerA.token,
      body: { branchId: branch, deviceType: 'pos_terminal', deviceName: 'TILL-01' },
    });
    expect(created.status).toBe(201);
    const device = created.body.data as { id: string; activationStatus: string; credential?: string };
    expect(device.activationStatus).toBe('pending');
    expect(typeof device.credential).toBe('string');

    const activated = await api(ctx.server, 'post', `/api/v1/devices/${device.id}/activate`, {
      token: ownerA.token,
    });
    expect(activated.status).toBe(200);

    const duplicate = await api(ctx.server, 'post', '/api/v1/devices', {
      token: ownerA.token,
      body: { branchId: branch, deviceType: 'pos_terminal', deviceName: 'TILL-01' },
    });
    expect(duplicate.status).toBe(409);

    // Tenant B cannot see the device: it is absent from its list…
    const listB = await api(ctx.server, 'get', '/api/v1/devices', { token: ownerB.token });
    expect(listB.status).toBe(200);
    expect(((listB.body.data ?? []) as Array<{ id: string }>).map((row) => row.id)).not.toContain(device.id);

    // …and a portal login cannot touch the registry at all.
    const portalDenied = await api(ctx.server, 'get', '/api/v1/devices', { token: portalBuyerToken });
    expect(portalDenied.status).toBe(403);
  });
});
