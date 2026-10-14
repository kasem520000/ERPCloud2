import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionRegistry } from '@erp/contracts';

import { ALL_PLATFORM_PERMISSIONS, createActor, createRoleFixture, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/** RBAC allow/deny, membership management and the permission registry (API_CONTRACT §1–2). */

describe('RBAC and access management', () => {
  let ctx: TestApp;
  let admin: Actor;
  let viewer: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('rbac');
    admin = await createActor(ctx, {
      tenantCode: 'rbac',
      email: 'admin@rbac.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    viewer = await createActor(ctx, {
      tenantCode: 'rbac',
      email: 'viewer@rbac.test',
      permissions: ['platform.tenant.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('allows a route the caller has permission for and denies one it does not', async () => {
    const allowed = await api(ctx.server, 'get', '/api/v1/tenant', { token: viewer.token });
    expect(allowed.status).toBe(200);
    expect((allowed.body.data as Record<string, unknown>).code).toBe('rbac');

    const denied = await api(ctx.server, 'patch', '/api/v1/tenant', {
      token: viewer.token,
      body: { name: 'Renamed by viewer' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    // Controllers declare the canonical `tenant.*` spelling; the viewer holds the legacy
    // `platform.tenant.view` grant, which authorises `tenant.view` through the alias map.
    expect(denied.body.detail).toBe('permission tenant.manage required');

    const permitted = await api(ctx.server, 'patch', '/api/v1/tenant', {
      token: admin.token,
      body: { name: 'RBAC Trading Co.' },
    });
    expect(permitted.status).toBe(200);
    expect((permitted.body.data as Record<string, unknown>).name).toBe('RBAC Trading Co.');
  });

  it('expands the effective permission set on GET /me', async () => {
    const me = await api(ctx.server, 'get', '/api/v1/me', { token: viewer.token });
    expect(me.status).toBe(200);

    const data = me.body.data as {
      permissions: string[];
      membership: { roles: Array<{ name: string }>; branchScope: unknown; tenantCode: string };
      user: { email: string };
    };
    expect(data.user.email).toBe('viewer@rbac.test');
    expect(data.membership.tenantCode).toBe('rbac');
    expect(data.membership.roles.map((role) => role.name)).toContain('Viewer');
    expect(data.permissions).toEqual(['platform.tenant.view']);
  });

  it('serves the permission registry that the permissions table is seeded from', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/permissions', { token: admin.token });
    expect(response.status).toBe(200);

    const data = response.body.data as Array<{ code: string; module: string; description: string }>;
    expect(data).toHaveLength(permissionRegistry.length);
    expect(data.map((entry) => entry.code)).toContain('platform.tenant.view');
    expect(data.every((entry) => entry.description.length > 0)).toBe(true);
  });

  describe('memberships', () => {
    it('invites a user by e-mail, lists it, patches it and soft-deletes it', async () => {
      const roleId = viewer.roleIds[0] as string;

      const created = await api(ctx.server, 'post', '/api/v1/memberships', {
        token: admin.token,
        body: { email: 'invitee@rbac.test', fullName: 'Invitee', roleIds: [roleId] },
      });
      expect(created.status).toBe(201);
      const membership = created.body.data as { id: string; status: string; roles: unknown[] };
      expect(membership.status).toBe('invited');
      expect(membership.roles).toHaveLength(1);

      const list = await api(ctx.server, 'get', '/api/v1/memberships?limit=200', {
        token: admin.token,
      });
      expect(list.status).toBe(200);
      const ids = (list.body.data as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(membership.id);
      expect((list.body.meta as Record<string, unknown>).total).toBeGreaterThanOrEqual(3);

      const one = await api(ctx.server, 'get', `/api/v1/memberships/${membership.id}`, {
        token: admin.token,
      });
      expect(one.status).toBe(200);

      const patched = await api(ctx.server, 'patch', `/api/v1/memberships/${membership.id}`, {
        token: admin.token,
        body: { displayName: 'Renamed Invitee', status: 'active' },
      });
      expect(patched.status).toBe(200);
      expect((patched.body.data as { displayName: string }).displayName).toBe('Renamed Invitee');

      const removed = await api(ctx.server, 'delete', `/api/v1/memberships/${membership.id}`, {
        token: admin.token,
      });
      expect(removed.status).toBe(204);

      const afterDelete = await api(ctx.server, 'get', `/api/v1/memberships/${membership.id}`, {
        token: admin.token,
      });
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body.code).toBe('NOT_FOUND');
    });

    it('rejects an invitation carrying a role from another tenant', async () => {
      const foreignRole = await createRoleFixture(ctx.db.ownerUrl, {
        tenantId: (await createActor(ctx, { tenantCode: 'rbac-foreign', email: 'x@rbac-foreign.test' }))
          .tenantId,
        name: 'Foreign',
        permissionCodes: ['platform.tenant.view'],
      });

      const response = await api(ctx.server, 'post', '/api/v1/memberships', {
        token: admin.token,
        body: { email: 'sneaky@rbac.test', roleIds: [foreignRole.id] },
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a second membership for the same user', async () => {
      const roleId = viewer.roleIds[0] as string;
      const first = await api(ctx.server, 'post', '/api/v1/memberships', {
        token: admin.token,
        body: { email: 'twice@rbac.test', roleIds: [roleId] },
      });
      expect(first.status).toBe(201);

      const second = await api(ctx.server, 'post', '/api/v1/memberships', {
        token: admin.token,
        body: { email: 'twice@rbac.test', roleIds: [roleId] },
      });
      expect(second.status).toBe(400);
    });

    it('protects the last active owner membership', async () => {
      const response = await api(ctx.server, 'patch', `/api/v1/memberships/${admin.membershipId}`, {
        token: admin.token,
        body: { status: 'suspended' },
      });
      expect(response.status).toBe(422);
      expect(String(response.body.detail)).toMatch(/at least one active owner/i);
    });

    it('rejects a disallowed filter with FILTER_NOT_ALLOWED', async () => {
      const response = await api(ctx.server, 'get', '/api/v1/memberships?filter[secret]=1', {
        token: admin.token,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('FILTER_NOT_ALLOWED');
    });

    it('honours the membership branch scope on X-Branch-Id', async () => {
      const inScope = '11111111-1111-7111-8111-111111111111';
      const outOfScope = '22222222-2222-7222-8222-222222222222';
      const scoped = await createActor(ctx, {
        tenantCode: 'rbac-branch',
        email: 'scoped@rbac.test',
        permissions: ALL_PLATFORM_PERMISSIONS,
        branchScope: [inScope],
      });

      const allowed = await api(ctx.server, 'get', '/api/v1/tenant', {
        token: scoped.token,
        headers: { 'X-Branch-Id': inScope },
      });
      expect(allowed.status).toBe(200);

      const denied = await api(ctx.server, 'get', '/api/v1/tenant', {
        token: scoped.token,
        headers: { 'X-Branch-Id': outOfScope },
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN');
    });
  });

  describe('roles', () => {
    it('creates, renames and re-permissions a role, and validates permission codes', async () => {
      const created = await api(ctx.server, 'post', '/api/v1/roles', {
        token: admin.token,
        body: {
          name: 'Auditor',
          description: 'Read-only',
          permissionCodes: ['platform.tenant.view', 'accounting.reports.view'],
        },
      });
      expect(created.status).toBe(201);
      const role = created.body.data as { id: string; permissionCodes: string[]; isSystem: boolean };
      // Writes normalise legacy `platform.*` spellings to canonical `tenant.*`, so the
      // database converges on the canonical namespace (reads accept both spellings).
      expect([...role.permissionCodes].sort()).toEqual(
        ['tenant.view', 'accounting.reports.view'].sort(),
      );
      expect(role.isSystem).toBe(false);

      const renamed = await api(ctx.server, 'put', `/api/v1/roles/${role.id}`, {
        token: admin.token,
        body: { name: 'Senior Auditor' },
      });
      expect(renamed.status).toBe(200);
      expect((renamed.body.data as { name: string }).name).toBe('Senior Auditor');

      const replaced = await api(ctx.server, 'post', `/api/v1/roles/${role.id}/permissions`, {
        token: admin.token,
        body: { permissionCodes: ['platform.audit.view'] },
      });
      expect(replaced.status).toBe(201);
      expect((replaced.body.data as { permissionCodes: string[] }).permissionCodes).toEqual([
        'tenant.audit.view',
      ]);

      const unknown = await api(ctx.server, 'post', '/api/v1/roles', {
        token: admin.token,
        body: { name: 'Bogus', permissionCodes: ['not.a.permission'] },
      });
      expect(unknown.status).toBe(422);
      expect(String(unknown.body.detail)).toContain('not.a.permission');
    });

    it('keeps system role names immutable but allows a description change', async () => {
      const systemRole = await createRoleFixture(ctx.db.ownerUrl, {
        tenantId: admin.tenantId,
        name: 'Owner',
        permissionCodes: ['platform.tenant.view'],
        isSystem: true,
      });

      const list = await api(ctx.server, 'get', '/api/v1/roles?filter[isSystem]=true', {
        token: admin.token,
      });
      const listed = list.body.data as Array<{ id: string; name: string }>;
      expect(listed.map((row) => row.id)).toEqual([systemRole.id]);

      const rename = await api(ctx.server, 'put', `/api/v1/roles/${systemRole.id}`, {
        token: admin.token,
        body: { name: 'Hijacked' },
      });
      expect(rename.status).toBe(422);
      expect(rename.body.code).toBe('VALIDATION_FAILED');
      expect(String(rename.body.detail)).toMatch(/immutable/i);

      const describe = await api(ctx.server, 'put', `/api/v1/roles/${systemRole.id}`, {
        token: admin.token,
        body: { description: 'Still the owner role' },
      });
      expect(describe.status).toBe(200);
      expect((describe.body.data as { name: string }).name).toBe('Owner');
    });
  });
});
