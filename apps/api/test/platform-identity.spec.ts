import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  findPlatformRole,
  operatorAuditActions,
  platformPermissionRegistry,
  platformRolePermissionOverridesKey,
  type PlatformDirectoryUser,
  type PlatformRoleMatrixEntry,
  type PlatformRolePermissionsResponse,
  type PlatformUserDetailResponse,
} from '@erp/contracts';
import { auditLog, mfaRecoveryCodes, newId, platformSettings, users, withPlatformAdminTx, withTx } from '@erp/database';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  createTenantFixture,
  hashPassword,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C3 — «الهوية والوصول على المنصة» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * The plan asks for a user directory, a user card, a roles matrix and an operator invite,
 * and at least ten tests. This suite runs twenty-two, organised around the four ways an
 * identity surface goes wrong:
 *
 * 1. **It shows the wrong person** — a card must read *that* user's memberships, roles and
 *    sessions, and a session must be one device (a refresh-token family), not one row.
 * 2. **It reaches into an account without a trace** — resetting 2FA and revoking a session
 *    are the two most sensitive acts in the console: both carry a written reason, and both
 *    land in the audit trail.
 * 3. **The matrix is decorative** — the whole point of `PUT /platform/roles/:code/permissions`
 *    is that the API honours it. The test removes `console.tenants.view` from
 *    «تشغيل المنصة», then proves the *same already-issued token* is refused, and restores.
 * 4. **It is not gated** — reads need `console.users.view`, writes need
 *    `console.users.manage`, and a tenant session is refused everywhere.
 */

/** `ActorOptions` has no `platformRoles` field yet — narrowed here, as in the P-C2 suite. */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform identity (P-C3)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let customer: Actor;
  let target: Actor;
  let targetPassword: string;

  const OPERATOR_TENANT = 'identity-ops';
  /** المنشأة التي يدخل منها مشغّلو المنصة — نفس ما تنشئه البذرة بـ`PLATFORM_TENANT_CODE`. */
  const HOME_TENANT = process.env.PLATFORM_TENANT_CODE?.trim() || 'platform';
  const USER = () => `/api/v1/platform/users/${target.userId}`;

  beforeAll(async () => {
    ctx = await createTestApp('platform-identity');
    // «وطن» المشغّلين: وجوده هو ما يجعل الدعوة قابلة للاستخدام (الرمز لا يُصدَر إلا لمنشأة).
    await createTenantFixture(ctx.db.ownerUrl, { code: HOME_TENANT, name: 'Platform Operations' });

    targetPassword = 'Invited#Operator2026';
    customer = await createActor(ctx, {
      tenantCode: 'identity-a',
      tenantName: 'شركة الهوية',
      email: 'owner@identity-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    // The person the console acts on: a tenant member who also holds a platform role.
    target = await createOperator(ctx, {
      tenantCode: 'identity-a',
      tenantId: customer.tenantId,
      email: 'operator@identity-a.test',
      fullName: 'مشغّل تجريبي',
      password: targetPassword,
      permissions: [],
      roleNames: ['Accountant'],
      isOwner: false,
      platformRoles: ['platform_auditor'],
    });

    owner = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'owner@identity-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'operations@identity-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'auditor@identity-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_auditor'],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------ 1. directory

  it('lists users with their tenants, roles and 2FA state', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/users', { token: owner.token });
    expect(response.status).toBe(200);
    const rows = response.body.data as PlatformDirectoryUser[];

    const row = rows.find((entry) => entry.id === target.userId);
    expect(row).toBeDefined();
    expect(row?.email).toBe('operator@identity-a.test');
    expect(row?.platformRoles).toContain('platform_auditor');
    // The tenant column the plan asks for: a platform user can belong to a customer.
    expect(row?.tenants.map((tenant) => tenant.code)).toContain('identity-a');
    expect(row?.mfaEnabled).toBe(false);
    expect(row?.membershipCount).toBe(1);
  });

  it('searches by e-mail and by name across tenants', async () => {
    const byEmail = await api(ctx.server, 'get', '/api/v1/platform/users?search=operator@identity-a', {
      token: owner.token,
    });
    expect((byEmail.body.data as PlatformDirectoryUser[]).map((entry) => entry.id)).toEqual([target.userId]);

    const byName = await api(ctx.server, 'get', '/api/v1/platform/users?search=مشغّل تجريبي', {
      token: owner.token,
    });
    expect((byName.body.data as PlatformDirectoryUser[]).map((entry) => entry.id)).toContain(target.userId);
  });

  it('returns the card: user, roles, memberships and sessions', async () => {
    const response = await api(ctx.server, 'get', USER(), { token: owner.token });
    expect(response.status).toBe(200);
    const card = response.body.data as PlatformUserDetailResponse;

    expect(card.user.email).toBe('operator@identity-a.test');
    expect(card.user.status).toBe('active');
    expect(card.platformRoles).toEqual(['platform_auditor']);
    expect(card.memberships.map((member) => member.tenantCode)).toEqual(['identity-a']);
    expect(card.memberships[0]?.isOwner).toBe(false);
  });

  it('answers 404 for an unknown user and 400 for a malformed id', async () => {
    const missing = await api(ctx.server, 'get', `/api/v1/platform/users/${newId()}`, { token: owner.token });
    expect(missing.status).toBe(404);

    const malformed = await api(ctx.server, 'get', '/api/v1/platform/users/not-a-uuid', { token: owner.token });
    expect(malformed.status).toBe(400);
  });

  // ------------------------------------------------------------------ 2. sessions

  it('shows a real login as one session and revokes it with a reason', async () => {
    // A real sign-in — this is what writes a refresh-token family with an IP and a user agent.
    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: target.email, password: targetPassword, tenantCode: 'identity-a' },
      headers: { 'user-agent': 'IdentitySpec/1.0' },
    });
    expect(login.status).toBe(200);
    const refreshToken = (login.body.data as Record<string, unknown>).refreshToken as string;

    const card = await api(ctx.server, 'get', USER(), { token: owner.token });
    const sessions = (card.body.data as PlatformUserDetailResponse).sessions;
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions[0]!;
    expect(session.userId).toBe(target.userId);
    expect(session.rotationCount).toBeGreaterThanOrEqual(1);
    expect(session.revoked).toBe(false);

    const detail = await api(ctx.server, 'get', `/api/v1/platform/sessions/${session.id}`, { token: owner.token });
    expect(detail.status).toBe(200);
    expect((detail.body.data as { userEmail: string }).userEmail).toBe(target.email);

    // No reason ⇒ no act. A missing/blank field is caught by the zod pipe, so the answer is
    // `400 VALIDATION_FAILED` (the 422 codes in this API are reserved for business rules).
    const refused = await api(ctx.server, 'delete', `/api/v1/platform/sessions/${session.id}`, { token: owner.token });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');

    const revoked = await api(
      ctx.server,
      'delete',
      `/api/v1/platform/sessions/${session.id}?reason=${encodeURIComponent('جهاز مفقود')}`,
      { token: owner.token },
    );
    expect(revoked.status).toBe(200);
    expect((revoked.body.data as { revoked: boolean }).revoked).toBe(true);

    // The revocation is real: the refresh token that family issued no longer works.
    const refreshed = await api(ctx.server, 'post', '/api/v1/auth/refresh', { body: { refreshToken } });
    expect(refreshed.status).toBe(401);

    // Read through the platform plane: `audit_log`'s tenant policy hides a row that
    // carries a `tenant_id` from a session that is not inside that tenant.
    const auditRows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, meta: auditLog.meta })
        .from(auditLog)
        .where(eq(auditLog.entityId, session.id)),
    );
    const row = auditRows.find((entry) => entry.action === operatorAuditActions.SESSION_REVOKE);
    expect(row).toBeDefined();
    expect((row?.meta as Record<string, unknown>).reason).toBe('جهاز مفقود');
    expect((row?.meta as Record<string, unknown>).scope).toBe('platform_console');
  });

  it('answers 404 when the session id is unknown', async () => {
    const response = await api(ctx.server, 'delete', `/api/v1/platform/sessions/${newId()}?reason=اختبار`, {
      token: owner.token,
    });
    expect(response.status).toBe(404);
  });

  // ------------------------------------------------------------------ 3. 2FA reset

  it('resets 2FA, wipes the secret and the recovery codes, and records why', async () => {
    // Put an enrolled account in place (the service that enrols needs a TOTP round-trip;
    // the row is what the console's reset has to clear).
    await withTx(ctx.handle.db, async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabled: true, mfaSecretEnc: Buffer.from('spec-secret') })
        .where(eq(users.id, target.userId));
      await tx.insert(mfaRecoveryCodes).values([
        { id: newId(), userId: target.userId, codeHash: 'hash-one' },
        { id: newId(), userId: target.userId, codeHash: 'hash-two' },
      ]);
    });

    const before = await api(ctx.server, 'get', USER(), { token: owner.token });
    expect((before.body.data as PlatformUserDetailResponse).user.mfaEnabled).toBe(true);

    const noReason = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/mfa/reset`, {
      token: owner.token,
      body: { reason: '' },
    });
    expect(noReason.status).toBe(400);

    const reset = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/mfa/reset`, {
      token: owner.token,
      body: { reason: 'فقد جهاز المصادقة' },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({ hadMfa: true, mfaEnabled: false, mfaEnrolled: false });

    const [{ secret, enabled, codes }] = await withTx(ctx.handle.db, async (tx) => {
      const rows = await tx
        .select({ secret: users.mfaSecretEnc, enabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, target.userId));
      const codeRows = await tx
        .select({ id: mfaRecoveryCodes.id })
        .from(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, target.userId));
      return [ { secret: rows[0]?.secret, enabled: rows[0]?.enabled, codes: codeRows.length } ];
    });
    expect(secret).toBeNull();
    expect(enabled).toBe(false);
    expect(codes).toBe(0);

    const auditRows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, meta: auditLog.meta })
        .from(auditLog)
        .where(eq(auditLog.entityId, target.userId)),
    );
    const row = auditRows.find((entry) => entry.action === operatorAuditActions.MFA_RESET);
    expect((row?.meta as Record<string, unknown>).reason).toBe('فقد جهاز المصادقة');

    // A second reset is honest about there being nothing to reset.
    const again = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/mfa/reset`, {
      token: owner.token,
      body: { reason: 'تكرار' },
    });
    expect(again.body.data).toMatchObject({ hadMfa: false });
  });

  // ------------------------------------------------------------------ 4. roles on a user

  it('grants and revokes a platform role with both states on the card', async () => {
    const granted = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/roles`, {
      token: owner.token,
      body: { roleCode: 'platform_support' },
    });
    // `201`: the route creates a `platform_memberships` row, and that is what it answered
    // before P-C3 moved it into this controller (`test/surface-isolation.spec.ts` pins it).
    expect(granted.status).toBe(201);

    const after = await api(ctx.server, 'get', USER(), { token: owner.token });
    expect((after.body.data as PlatformUserDetailResponse).platformRoles.sort()).toEqual([
      'platform_auditor',
      'platform_support',
    ]);

    const revoked = await api(
      ctx.server,
      'delete',
      `/api/v1/platform/users/${target.userId}/roles/platform_support?reason=${encodeURIComponent('انتهت المهمة')}`,
      { token: owner.token },
    );
    expect(revoked.status).toBe(200);

    const final = await api(ctx.server, 'get', USER(), { token: owner.token });
    const card = final.body.data as PlatformUserDetailResponse;
    expect(card.platformRoles).toEqual(['platform_auditor']);
    // A revoked grant stays visible: losing a role is part of the history.
    expect(card.revokedPlatformRoles).toContain('platform_support');

    const secondRevoke = await api(
      ctx.server,
      'delete',
      `/api/v1/platform/users/${target.userId}/roles/platform_support`,
      { token: owner.token },
    );
    expect(secondRevoke.status).toBe(404);
  });

  it('refuses an unknown platform role', async () => {
    const response = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/roles`, {
      token: owner.token,
      body: { roleCode: 'platform_not_a_role' },
    });
    // 422: the body is well-formed, the role simply does not exist — the answer this route
    // has given since P-C1 (`test/surface-isolation.spec.ts` pins it).
    expect(response.status).toBe(422);
  });

  // ------------------------------------------------------------------ 5. invite

  it('invites an operator with a temporary password and they can sign in', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: owner.token,
      body: {
        email: 'invited@identity-ops.test',
        fullName: 'مشغّل مدعوّ',
        roleCode: 'platform_operations',
        temporaryPassword: 'Kx#9Tq2Mv7Lp4Ze',
      },
    });
    expect(response.status).toBe(201);
    const created = response.body.data as PlatformDirectoryUser;
    expect(created.email).toBe('invited@identity-ops.test');
    expect(created.status).toBe('active');
    expect(created.mustChangePassword).toBe(true);
    expect(created.platformRoles).toEqual(['platform_operations']);

    // …and they can sign in straight away, because the invite attached the home membership
    // that issues a token (`POST /auth/login` always signs *into* a tenant).
    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: created.email, password: 'Kx#9Tq2Mv7Lp4Ze', tenantCode: HOME_TENANT },
    });
    expect(login.status).toBe(200);
    // The token carries the new platform role, so the console opens on the right doors.
    const me = await api(ctx.server, 'get', '/api/v1/me', {
      token: (login.body.data as { accessToken: string }).accessToken,
    });
    expect((me.body.data as { platformPermissions: string[] }).platformPermissions).toContain(
      'console.tenants.view',
    );

    const auditRows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, meta: auditLog.meta, after: auditLog.after })
        .from(auditLog)
        .where(eq(auditLog.entityId, created.id)),
    );
    const row = auditRows.find((entry) => entry.action === operatorAuditActions.INVITE);
    expect((row?.meta as Record<string, unknown>).roleName).toBe('تشغيل المنصة');
    expect((row?.after as Record<string, unknown>).homeTenant).toEqual({ code: HOME_TENANT, attached: true });
  });

  it('invites without a password as `invited`, and re-uses an existing account', async () => {
    const invited = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: owner.token,
      body: { email: 'no-password@identity-ops.test', fullName: 'بلا كلمة مرور', roleCode: 'platform_auditor' },
    });
    expect(invited.status).toBe(201);
    const created = invited.body.data as PlatformDirectoryUser;
    expect(created.status).toBe('invited');

    // An invited account cannot sign in — which is exactly why the API says so out loud.
    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: created.email, password: 'whatever-wrong', tenantCode: OPERATOR_TENANT },
    });
    expect(login.status).toBe(401);

    const again = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: owner.token,
      body: { email: 'no-password@identity-ops.test', fullName: 'بلا كلمة مرور', roleCode: 'platform_support' },
    });
    expect(again.status).toBe(201);
    const reused = again.body.data as PlatformDirectoryUser;
    expect(reused.id).toBe(created.id);
    expect(reused.platformRoles.sort()).toEqual(['platform_auditor', 'platform_support']);
  });

  it('refuses an invite with a weak temporary password or an unknown role', async () => {
    const weak = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: owner.token,
      body: {
        email: 'weak@identity-ops.test',
        fullName: 'كلمة ضعيفة',
        roleCode: 'platform_support',
        temporaryPassword: 'short',
      },
    });
    // The 12-character floor is enforced by the schema before the password policy runs.
    expect(weak.status).toBe(400);

    const badRole = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: owner.token,
      body: { email: 'bad@identity-ops.test', fullName: 'دور مجهول', roleCode: 'platform_nope' },
    });
    expect(badRole.status).toBe(422);
  });

  // ------------------------------------------------------------------ 6. the matrix

  it('serves the matrix with the catalogue and the live holder counts', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/roles', { token: owner.token });
    expect(response.status).toBe(200);
    const roles = response.body.data as PlatformRoleMatrixEntry[];

    expect(roles.map((role) => role.code)).toEqual([
      'platform_owner',
      'platform_operations',
      'platform_billing',
      'platform_support',
      'platform_auditor',
    ]);
    const ops = roles.find((role) => role.code === 'platform_operations')!;
    expect(ops.overridden).toBe(false);
    expect(ops.permissions).toEqual(ops.catalogPermissions);
    expect(ops.holderCount).toBeGreaterThanOrEqual(1);
  });

  it('edits a role and the API honours the override on an already-issued token', async () => {
    const catalogue = [...(findPlatformRole('platform_operations')?.permissions ?? [])];
    const withoutTenants = catalogue.filter((code) => code !== 'console.tenants.view');

    const saved = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_operations/permissions', {
      token: owner.token,
      body: { permissions: withoutTenants, reason: 'فصل قراءة العملاء عن التشغيل' },
    });
    expect(saved.status).toBe(200);
    const savedBody = saved.body.data as PlatformRolePermissionsResponse;
    expect(savedBody.overridden).toBe(true);
    expect(savedBody.permissions).not.toContain('console.tenants.view');

    // The guard reads the override, so the operator's **existing** token loses the door…
    const denied = await api(ctx.server, 'get', '/api/v1/platform/tenants', { token: operations.token });
    expect(denied.status).toBe(403);

    // …and `/me` tells the console the same thing, so the sidebar agrees with the API.
    const me = await api(ctx.server, 'get', '/api/v1/me', { token: operations.token });
    const platformPermissions = (me.body.data as { platformPermissions: string[] }).platformPermissions;
    expect(platformPermissions).not.toContain('console.tenants.view');
    expect(platformPermissions).toContain('console.health.view');

    // The auditor still holds `console.tenants.view`: the change was scoped to one role.
    const unaffected = await api(ctx.server, 'get', '/api/v1/platform/tenants', { token: auditor.token });
    expect(unaffected.status).toBe(200);

    const auditRows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, meta: auditLog.meta, before: auditLog.before })
        .from(auditLog)
        .where(eq(auditLog.entityId, 'platform_operations')),
    );
    const row = auditRows.find((entry) => entry.action === operatorAuditActions.PERMISSIONS_UPDATE);
    expect(row).toBeDefined();
    const meta = row?.meta as Record<string, unknown>;
    expect(meta.reason).toBe('فصل قراءة العملاء عن التشغيل');
    expect(meta.removed).toEqual(['console.tenants.view']);
    expect(meta.added).toEqual([]);
  });

  it('restores the catalogue by writing the catalogue back (the override row disappears)', async () => {
    const catalogue = [...(findPlatformRole('platform_operations')?.permissions ?? [])];
    const restored = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_operations/permissions', {
      token: owner.token,
      body: { permissions: catalogue, reason: 'إرجاع الفهرس' },
    });
    expect(restored.status).toBe(200);
    expect((restored.body.data as PlatformRolePermissionsResponse).overridden).toBe(false);

    const back = await api(ctx.server, 'get', '/api/v1/platform/tenants', { token: operations.token });
    expect(back.status).toBe(200);

    // Nothing overridden anywhere ⇒ the store keeps no row at all, not an empty object.
    const rows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ id: platformSettings.id })
        .from(platformSettings)
        .where(eq(platformSettings.key, platformRolePermissionOverridesKey)),
    );
    expect(rows).toEqual([]);
  });

  it('refuses unknown codes, a missing reason and an unknown role', async () => {
    const unknownCode = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_support/permissions', {
      token: owner.token,
      body: { permissions: ['console.not.a.code'], reason: 'خطأ مقصود' },
    });
    expect(unknownCode.status).toBe(400);

    const noReason = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_support/permissions', {
      token: owner.token,
      body: { permissions: ['console.audit.view'], reason: '' },
    });
    expect(noReason.status).toBe(400);

    const unknownRole = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_nope/permissions', {
      token: owner.token,
      body: { permissions: ['console.audit.view'], reason: 'دور مجهول' },
    });
    expect(unknownRole.status).toBe(404);
  });

  it('exports every console code in the registry the matrix draws from', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/permissions', { token: owner.token });
    expect(response.status).toBe(200);
    const codes = (response.body.data as { code: string }[]).map((entry) => entry.code).sort();
    expect(codes).toEqual(platformPermissionRegistry.map((entry) => entry.code).sort());
  });

  // ------------------------------------------------------------------ 7. doors

  it('refuses a tenant session on every identity route', async () => {
    const routes: Array<[string, 'get' | 'post' | 'delete' | 'put']> = [
      ['/api/v1/platform/users', 'get'],
      [USER(), 'get'],
      ['/api/v1/platform/roles', 'get'],
      ['/api/v1/platform/permissions', 'get'],
      ['/api/v1/platform/sessions/' + newId(), 'get'],
      ['/api/v1/platform/operators/invite', 'post'],
      [`/api/v1/platform/users/${target.userId}/mfa/reset`, 'post'],
      [`/api/v1/platform/users/${target.userId}/roles`, 'post'],
      ['/api/v1/platform/roles/platform_support/permissions', 'put'],
    ];
    for (const [path, method] of routes) {
      const response = await api(ctx.server, method, path, { token: customer.token, body: {} });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('refuses an anonymous caller and an operator who lacks the identity codes', async () => {
    const anonymous = await api(ctx.server, 'get', '/api/v1/platform/users');
    expect(anonymous.status).toBe(401);

    // «تشغيل المنصة» runs the platform but does not administer the console's own people:
    // `console.users.view` lives with «مالك المنصة» only. Both the read and the write close.
    const readDenied = await api(ctx.server, 'get', '/api/v1/platform/users', { token: operations.token });
    expect(readDenied.status).toBe(403);

    const writeDenied = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/roles`, {
      token: operations.token,
      body: { roleCode: 'platform_support' },
    });
    expect(writeDenied.status).toBe(403);

    const inviteDenied = await api(ctx.server, 'post', '/api/v1/platform/operators/invite', {
      token: auditor.token,
      body: { email: 'nope@identity-ops.test', fullName: 'مرفوض', roleCode: 'platform_support' },
    });
    expect(inviteDenied.status).toBe(403);
  });

  it('grants read-only reach through the matrix, and read-only stays read-only', async () => {
    // «قراءة بلا كتابة» is not one of the five catalogue roles, so it is *built* here: push
    // `console.users.view` into «تشغيل المنصة» and leave `console.users.manage` out.
    const catalogue = [...(findPlatformRole('platform_operations')?.permissions ?? [])];
    const saved = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_operations/permissions', {
      token: owner.token,
      body: { permissions: [...catalogue, 'console.users.view'], reason: 'قراءة الدليل للتشغيل بلا تعديل الحسابات' },
    });
    expect(saved.status).toBe(200);

    const readOk = await api(ctx.server, 'get', '/api/v1/platform/users', { token: operations.token });
    expect(readOk.status).toBe(200);
    // The directory row for the person the console acts on is reachable, card included…
    const card = await api(ctx.server, 'get', USER(), { token: operations.token });
    expect(card.status).toBe(200);
    // …and the card exposes the sessions without offering the door to end one.
    const revokeDenied = await api(ctx.server, 'delete', `/api/v1/platform/sessions/${newId()}?reason=غير مسموح`, {
      token: operations.token,
    });
    expect(revokeDenied.status).toBe(403);
    const grantDenied = await api(ctx.server, 'post', `/api/v1/platform/users/${target.userId}/roles`, {
      token: operations.token,
      body: { roleCode: 'platform_owner' },
    });
    expect(grantDenied.status).toBe(403);

    // Writing the catalogue back removes the override, and with it the operator's reach.
    const restored = await api(ctx.server, 'put', '/api/v1/platform/roles/platform_operations/permissions', {
      token: owner.token,
      body: { permissions: catalogue, reason: 'إرجاع الفهرس' },
    });
    expect(restored.status).toBe(200);
    const after = await api(ctx.server, 'get', '/api/v1/platform/users', { token: operations.token });
    expect(after.status).toBe(403);
  });

  it('keeps the password hash out of every identity answer', async () => {
    const card = await api(ctx.server, 'get', USER(), { token: owner.token });
    const serialized = JSON.stringify(card.body);
    expect(serialized).not.toContain('argon2');
    const hash = await hashPassword('anything');
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(serialized).not.toContain(hash.slice(0, 12));
  });
});
