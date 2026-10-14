import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_WIDE_SCOPE_ID } from '@erp/contracts';

import {
  assignRoleFixture,
  createMembershipFixture,
  createRoleFixture,
  createTenantFixture,
  createUserFixture,
  type Actor,
} from './fixtures.js';
import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_TENANT_PERMISSIONS,
  createActor,
  hashPassword,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-02 — مسارات إدارة العضويّات والأدوار تسمح بمنح دور المالك (`Owner`) وبتحرير صفوف
 * صلاحيات الأدوار النظامية.
 *
 * يُثبت هنا بطلباتٍ مباشرة إلى API (لا عبر واجهة مخفية):
 *   1. **سالب**: مدير عضويات لا يمنح دور المالك عند الإنشاء ولا عند التعديل (422).
 *   2. **سالب**: أدوار عضويّة المالك نفسها لا تُعاد تشكيلها من مسار العضويّات.
 *   3. **موجب**: إسناد دور مخصّص عادي ما زال يعمل.
 *   4. **سالب**: مدير أدوار لا يغيّر صفوف صلاحيات دور نظامي — لا عبر `PUT /roles/:id`
 *      ولا عبر `POST /roles/:id/permissions` — والصلاحيات تبقى كما هي (فحصٌ بعد المحاولة).
 *   5. **موجب**: الدور المخصّص تُستبدل صلاحياته.
 *   6. **موجب**: نقل الملكية يبقى متاحاً عبر مسار المنصّة المستقلّ والمدقّق، ولا يفقد آخر مالك.
 */

const PASSWORD = 'Tr0ubador&Horse9';

describe('AUD-02 — حماية دور المالك والأدوار النظامية (API_CONTRACT §2)', () => {
  let ctx: TestApp;
  let tenantId = '';
  let ownerMembershipId = '';
  let ownerRoleId = '';
  let cashierRoleId = '';
  let customRoleId = '';
  let manager: Actor;
  let member: Actor;
  let platformAdmin: Actor;

  const call = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    options: { token: string; body?: unknown; headers?: Record<string, string> },
  ) => api(ctx.server, method, `/api/v1${path}`, options);

  const data = (response: { body: Record<string, unknown> }) =>
    (response.body.data ?? response.body) as Record<string, any>;

  beforeAll(async () => {
    ctx = await createTestApp('audit-rbac');

    const tenant = await createTenantFixture(ctx.db.ownerUrl, { code: 'audit-rbac', name: 'Audit RBAC' });
    tenantId = tenant.id;

    const ownerUser = await createUserFixture(ctx.db.ownerUrl, {
      email: 'owner@audit-rbac.test',
      fullName: 'Audit Owner',
      passwordHash: await hashPassword(PASSWORD),
    });
    // The tenant's owner role: a system role carrying the full canonical tenant set —
    // the shape both the baseline seed (`*` expanded) and the console provisioning path
    // create in `role_permissions` (the `*` wildcard itself has no registry row).
    const ownerRole = await createRoleFixture(ctx.db.ownerUrl, {
      tenantId,
      name: 'Owner',
      isSystem: true,
      permissionCodes: ALL_TENANT_PERMISSIONS,
    });
    ownerRoleId = ownerRole.id;
    const cashierRole = await createRoleFixture(ctx.db.ownerUrl, {
      tenantId,
      name: 'Cashier',
      isSystem: true,
      permissionCodes: ['sales.view'],
    });
    cashierRoleId = cashierRole.id;

    const ownerMembership = await createMembershipFixture(ctx.db.ownerUrl, {
      tenantId,
      userId: ownerUser.id,
      displayName: 'Audit Owner',
      status: 'active',
      isOwner: true,
    });
    ownerMembershipId = ownerMembership.id;
    await assignRoleFixture(ctx.db.ownerUrl, ownerMembership.id, ownerRole.id);

    const managerRole = await createRoleFixture(ctx.db.ownerUrl, {
      tenantId,
      name: 'Membership manager',
      permissionCodes: ['tenant.membership.manage', 'tenant.role.manage'],
    });
    manager = await createActor(ctx, {
      tenantId,
      tenantCode: 'audit-rbac',
      email: 'manager@audit-rbac.test',
      permissions: ['tenant.membership.manage', 'tenant.role.manage'],
      roleNames: ['Membership manager'],
      isOwner: false,
    });

    member = await createActor(ctx, {
      tenantId,
      tenantCode: 'audit-rbac',
      email: 'member@audit-rbac.test',
      permissions: [],
      roleNames: ['Staff'],
      isOwner: false,
    });

    platformAdmin = await createActor(ctx, {
      tenantCode: 'audit-rbac-console',
      email: 'operator@audit-rbac.test',
      isPlatformAdmin: true,
      platformRoles: ['platform_owner'],
    });

    void managerRole;

    const custom = await call('post', '/roles', {
      token: manager.token,
      body: { name: `Custom ${randomUUID().slice(0, 8)}`, permissionCodes: ALL_TENANT_PERMISSIONS.slice(0, 3) },
    });
    expect(custom.status).toBe(201);
    customRoleId = String(data(custom).id);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('سالبة: مدير العضويّات لا يمنح دور المالك عند الإنشاء', async () => {
    const response = await call('post', '/memberships', {
      token: manager.token,
      body: { email: 'promoted@audit-rbac.test', roleIds: [ownerRoleId] },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('OWNER_ROLE_NOT_ASSIGNABLE');
  });

  it('سالبة: مدير العضويّات لا يمنح دور المالك عند تعديل عضوية قائمة', async () => {
    const response = await call('patch', `/memberships/${member.membershipId}`, {
      token: manager.token,
      body: { roleIds: [ownerRoleId] },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('OWNER_ROLE_NOT_ASSIGNABLE');
  });

  it('سالبة: أدوار عضويّة المالك لا تُعاد تشكيلها من مسار العضويّات', async () => {
    const response = await call('patch', `/memberships/${ownerMembershipId}`, {
      token: manager.token,
      body: { roleIds: [customRoleId] },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('OWNER_ROLE_NOT_ASSIGNABLE');

    // الملكية ما زالت قائمة ولم تُنزع.
    const read = await call('get', `/memberships/${ownerMembershipId}`, { token: manager.token });
    expect(read.status).toBe(200);
    expect(data(read).isOwner).toBe(true);
  });

  it('موجبة: إسناد دور مخصّص عادي ما زال يعمل', async () => {
    const response = await call('patch', `/memberships/${member.membershipId}`, {
      token: manager.token,
      body: { roleIds: [customRoleId] },
    });

    expect(response.status).toBe(200);
    const roles = (data(response).roles ?? []) as Array<{ id: string }>;
    expect(roles.map((role) => role.id)).toEqual([customRoleId]);
  });

  it('سالبة: صلاحيات دور نظامي غير قابلة للتعديل (PUT و permissions) والقيمة لا تتغيّر', async () => {
    const viaPut = await call('put', `/roles/${ownerRoleId}`, {
      token: manager.token,
      body: { permissionCodes: ['sales.view'] },
    });
    expect(viaPut.status).toBe(422);
    expect(viaPut.body.code).toBe('SYSTEM_ROLE_PERMISSIONS_IMMUTABLE');

    const viaPermissions = await call('post', `/roles/${ownerRoleId}/permissions`, {
      token: manager.token,
      body: { permissionCodes: ['sales.view'] },
    });
    expect(viaPermissions.status).toBe(422);
    expect(viaPermissions.body.code).toBe('SYSTEM_ROLE_PERMISSIONS_IMMUTABLE');

    const cashier = await call('post', `/roles/${cashierRoleId}/permissions`, {
      token: manager.token,
      body: { permissionCodes: ['sales.invoice.create'] },
    });
    expect(cashier.status).toBe(422);
    expect(cashier.body.code).toBe('SYSTEM_ROLE_PERMISSIONS_IMMUTABLE');

    const read = await call('get', `/roles/${ownerRoleId}`, { token: manager.token });
    expect(data(read).permissionCodes, 'the rejected edits changed nothing').toEqual(
      [...ALL_TENANT_PERMISSIONS].sort(),
    );
  });

  it('موجبة: الدور المخصّص تُستبدل صلاحياته', async () => {
    const response = await call('post', `/roles/${customRoleId}/permissions`, {
      token: manager.token,
      body: { permissionCodes: ['sales.view'] },
    });

    expect(response.status).toBe(201);
    expect(data(response).permissionCodes).toEqual(['sales.view']);
  });

  it('موجبة: نقل الملكية عبر مسار المنصّة المستقلّ يعمل ولا يفقد آخر مالك', async () => {
    const transfer = await call('post', `/platform/tenants/${tenantId}/owner/transfer`, {
      token: platformAdmin.token,
      body: { membershipId: member.membershipId, reason: 'Audit acceptance test' },
    });
    expect(transfer.status).toBe(200);

    const previousOwner = await call('get', `/memberships/${ownerMembershipId}`, { token: manager.token });
    expect(data(previousOwner).isOwner).toBe(false);
    expect(data(previousOwner).status, 'the previous owner stays an active member').toBe('active');

    const newOwner = await call('get', `/memberships/${member.membershipId}`, { token: manager.token });
    expect(data(newOwner).isOwner).toBe(true);
  });

  it('AUD-03: إنفاذ membership_role_scopes على الفروع والمستودعات ومواقع النقد مع دلالة UNION', async () => {
    const orgAdmin = await createActor(ctx, {
      tenantId,
      tenantCode: 'audit-rbac',
      email: 'org-admin@audit-rbac.test',
      permissions: [...ALL_ORGANIZATION_PERMISSIONS, 'tenant.membership.manage', 'tenant.role.manage'],
      roleNames: ['Org Admin'],
      isOwner: false,
    });

    const b1Res = await call('post', '/branches', {
      token: orgAdmin.token,
      body: { code: 'BR-SC1', nameAr: 'فرع النطاق 1' },
    });
    expect(b1Res.status).toBe(201);
    const branch1Id = String(data(b1Res).id);

    const b2Res = await call('post', '/branches', {
      token: orgAdmin.token,
      body: { code: 'BR-SC2', nameAr: 'فرع النطاق 2' },
    });
    expect(b2Res.status).toBe(201);
    const branch2Id = String(data(b2Res).id);

    const w1Res = await call('post', '/warehouses', {
      token: orgAdmin.token,
      body: { branchId: branch1Id, code: 'WH-SC1', name: 'مستودع 1' },
    });
    expect(w1Res.status).toBe(201);
    const warehouse1Id = String(data(w1Res).id);

    const w2Res = await call('post', '/warehouses', {
      token: orgAdmin.token,
      body: { branchId: branch1Id, code: 'WH-SC2', name: 'مستودع 2' },
    });
    expect(w2Res.status).toBe(201);
    const warehouse2Id = String(data(w2Res).id);

    const c1Res = await call('post', '/cash-locations', {
      token: orgAdmin.token,
      body: {
        branchId: branch1Id,
        kind: 'bank',
        name: 'بنك النطاق 1',
        bank: { bankName: 'Al Rajhi', iban: 'SA0380000000608010167519' },
      },
    });
    expect(c1Res.status).toBe(201);
    const cash1Id = String(data(c1Res).id);

    const c2Res = await call('post', '/cash-locations', {
      token: orgAdmin.token,
      body: {
        branchId: branch1Id,
        kind: 'bank',
        name: 'بنك النطاق 2',
        bank: { bankName: 'SNB', iban: 'SA4420000001234567891234' },
      },
    });
    expect(c2Res.status).toBe(201);
    const cash2Id = String(data(c2Res).id);

    const scopedUser = await createActor(ctx, {
      tenantId,
      tenantCode: 'audit-rbac',
      email: 'scoped-operator@audit-rbac.test',
      permissions: ALL_ORGANIZATION_PERMISSIONS,
      roleNames: ['Scoped Role A'],
      isOwner: false,
      unconfiguredScopes: true,
    });
    const roleAId = scopedUser.roleIds[0]!;

    // 0) حالة عدم وجود إعدادات نطاق بالكلية (دور جديد غير مهيأ — 0 صفوف في membership_role_scopes):
    // لا يُمنح وصول شامل ضمني؛ القوائم تعود فارغة، والقراءة المباشرة 404، وترويسة X-Branch-Id تُرفض بـ403:
    const meUnconfigured = await call('get', '/me', { token: scopedUser.token });
    expect(meUnconfigured.status).toBe(200);
    expect((data(meUnconfigured).membership as { scopes: unknown[] }).scopes).toEqual([]);

    const unconfiguredBranches = await call('get', '/branches?limit=50', { token: scopedUser.token });
    expect(unconfiguredBranches.status).toBe(200);
    expect(unconfiguredBranches.body.data).toEqual([]);
    expect((await call('get', `/branches/${branch1Id}`, { token: scopedUser.token })).status).toBe(404);
    expect(
      (
        await call('get', '/branches', {
          token: scopedUser.token,
          headers: { 'x-branch-id': branch1Id },
        })
      ).status,
    ).toBe(403);

    const unconfiguredWarehouses = await call('get', '/warehouses?limit=50', { token: scopedUser.token });
    expect(unconfiguredWarehouses.status).toBe(200);
    expect(unconfiguredWarehouses.body.data).toEqual([]);
    expect((await call('get', `/warehouses/${warehouse1Id}`, { token: scopedUser.token })).status).toBe(404);

    const unconfiguredCash = await call('get', '/cash-locations?limit=50', { token: scopedUser.token });
    expect(unconfiguredCash.status).toBe(200);
    expect(unconfiguredCash.body.data).toEqual([]);
    expect((await call('get', `/cash-locations/${cash1Id}`, { token: scopedUser.token })).status).toBe(404);

    // تقييد الدور A على الفرع 1 والمستودع 1 والبنك 1 فقط:
    const putScopes = await call('post', `/memberships/${scopedUser.membershipId}/scopes`, {
      token: orgAdmin.token,
      body: {
        scopes: [
          { roleId: roleAId, scopeType: 'branch', scopeId: branch1Id },
          { roleId: roleAId, scopeType: 'warehouse', scopeId: warehouse1Id },
          { roleId: roleAId, scopeType: 'cash_location', scopeId: cash1Id },
        ],
      },
    });
    expect(putScopes.status).toBe(201);

    // 1) الفروع: يرى branch1 فقط، وbranch2 يرجع 404 عند القراءة المباشرة و403 في ترويسة X-Branch-Id:
    const branchList = await call('get', '/branches?limit=50', { token: scopedUser.token });
    expect(branchList.status).toBe(200);
    expect((branchList.body.data as Array<{ id: string }>).map((b) => b.id)).toEqual([branch1Id]);

    const readB1 = await call('get', `/branches/${branch1Id}`, { token: scopedUser.token });
    expect(readB1.status).toBe(200);
    const readB2 = await call('get', `/branches/${branch2Id}`, { token: scopedUser.token });
    expect(readB2.status).toBe(404);

    const headerAllowed = await call('get', '/branches', {
      token: scopedUser.token,
      headers: { 'x-branch-id': branch1Id },
    });
    expect(headerAllowed.status).toBe(200);
    const headerDenied = await call('get', '/branches', {
      token: scopedUser.token,
      headers: { 'x-branch-id': branch2Id },
    });
    expect(headerDenied.status).toBe(403);

    // 2) المستودعات (كلاهما في الفرع 1 المسموح): يرى warehouse1 فقط ويرفض warehouse2 (404 قراءة وتعديلاً):
    const whList = await call('get', '/warehouses?limit=50', { token: scopedUser.token });
    expect(whList.status).toBe(200);
    expect((whList.body.data as Array<{ id: string }>).map((w) => w.id)).toEqual([warehouse1Id]);

    expect((await call('get', `/warehouses/${warehouse1Id}`, { token: scopedUser.token })).status).toBe(200);
    expect((await call('get', `/warehouses/${warehouse2Id}`, { token: scopedUser.token })).status).toBe(404);
    expect(
      (
        await call('patch', `/warehouses/${warehouse2Id}`, {
          token: scopedUser.token,
          body: { name: 'Hijacked WH' },
        })
      ).status,
    ).toBe(404);

    // 3) مواقع النقد (كلاهما في الفرع 1 المسموح): يرى cash1 فقط ويرفض cash2 (404 قراءة وتعديلاً):
    const cashList = await call('get', '/cash-locations?limit=50', { token: scopedUser.token });
    expect(cashList.status).toBe(200);
    expect((cashList.body.data as Array<{ id: string }>).map((c) => c.id)).toEqual([cash1Id]);

    expect((await call('get', `/cash-locations/${cash1Id}`, { token: scopedUser.token })).status).toBe(200);
    expect((await call('get', `/cash-locations/${cash2Id}`, { token: scopedUser.token })).status).toBe(404);
    expect(
      (
        await call('patch', `/cash-locations/${cash2Id}`, {
          token: scopedUser.token,
          body: { name: 'Hijacked Bank' },
        })
      ).status,
    ).toBe(404);

    // 4) دور ثانٍ غير مهيأ (بلا صفوف نطاق) لا يلغي تقييد الدور الأول ولا يوسّع الوصول إلى warehouse2:
    const secondRole = await createRoleFixture(ctx.db.ownerUrl, {
      tenantId,
      name: 'Unconfigured WH Role',
      permissionCodes: ['organization.warehouse.view'],
    });
    await assignRoleFixture(ctx.db.ownerUrl, scopedUser.membershipId, secondRole.id);

    const whListWithUnconfiguredRole = await call('get', '/warehouses?limit=50', {
      token: scopedUser.token,
    });
    expect(whListWithUnconfiguredRole.status).toBe(200);
    expect((whListWithUnconfiguredRole.body.data as Array<{ id: string }>).map((w) => w.id)).toEqual([
      warehouse1Id,
    ]);
    expect((await call('get', `/warehouses/${warehouse2Id}`, { token: scopedUser.token })).status).toBe(404);

    // 5) دلالة UNION للنطاقات المحددة صراحةً: منح الدور الثاني نطاق warehouse2 صراحةً يفتح (W1 ∪ W2):
    const putSpecificUnion = await call('post', `/memberships/${scopedUser.membershipId}/scopes`, {
      token: orgAdmin.token,
      body: {
        scopes: [
          { roleId: roleAId, scopeType: 'branch', scopeId: branch1Id },
          { roleId: roleAId, scopeType: 'warehouse', scopeId: warehouse1Id },
          { roleId: secondRole.id, scopeType: 'warehouse', scopeId: warehouse2Id },
          { roleId: roleAId, scopeType: 'cash_location', scopeId: cash1Id },
        ],
      },
    });
    expect(putSpecificUnion.status).toBe(201);

    const whListSpecificUnion = await call('get', '/warehouses?limit=50', { token: scopedUser.token });
    expect(whListSpecificUnion.status).toBe(200);
    expect(
      (whListSpecificUnion.body.data as Array<{ id: string }>).map((w) => w.id).sort(),
    ).toEqual([warehouse1Id, warehouse2Id].sort());
    expect((await call('get', `/warehouses/${warehouse2Id}`, { token: scopedUser.token })).status).toBe(200);

    // 6) الوصول الشامل الصريح (TENANT_WIDE_SCOPE_ID): منح الدور الثاني وصولاً شاملاً صريحاً للفروع والمستودعات يفتح كل الفروع والمستودعات:
    const putExplicitTenantWide = await call('post', `/memberships/${scopedUser.membershipId}/scopes`, {
      token: orgAdmin.token,
      body: {
        scopes: [
          { roleId: roleAId, scopeType: 'branch', scopeId: branch1Id },
          { roleId: secondRole.id, scopeType: 'branch', scopeId: TENANT_WIDE_SCOPE_ID },
          { roleId: roleAId, scopeType: 'warehouse', scopeId: warehouse1Id },
          { roleId: secondRole.id, scopeType: 'warehouse', scopeId: TENANT_WIDE_SCOPE_ID },
          { roleId: roleAId, scopeType: 'cash_location', scopeId: cash1Id },
        ],
      },
    });
    expect(putExplicitTenantWide.status).toBe(201);

    const branchListAfterExplicitWide = await call('get', '/branches?limit=50', { token: scopedUser.token });
    expect(branchListAfterExplicitWide.status).toBe(200);
    const allVisibleBranches = (branchListAfterExplicitWide.body.data as Array<{ id: string }>).map(
      (b) => b.id,
    );
    expect(allVisibleBranches).toContain(branch1Id);
    expect(allVisibleBranches).toContain(branch2Id);

    const whListAfterExplicitWide = await call('get', '/warehouses?limit=50', { token: scopedUser.token });
    expect(whListAfterExplicitWide.status).toBe(200);
    const allVisibleWh = (whListAfterExplicitWide.body.data as Array<{ id: string }>).map((w) => w.id);
    expect(allVisibleWh).toContain(warehouse1Id);
    expect(allVisibleWh).toContain(warehouse2Id);
  });
});
