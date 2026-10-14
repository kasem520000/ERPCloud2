import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  platformSettingDefinitions,
  tenantAuditActions,
  platformSettingsForScope,
  tenantFlagLabels,
  type PlatformTenantDetailResponse,
  type PlatformTenantHealthResponse,
  type PlatformTenantUsageResponse,
  type TenantBrandingResponse,
  type TenantFlagsResponse,
  type TenantNotesResponse,
  type TenantSettingsResponse,
} from '@erp/contracts';
import { auditLog, newId, withPlatformAdminTx, withTenantTx } from '@erp/database';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C2 — «العملاء في العمق» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * The plan asks for a customer card and at least twelve tests. This suite runs twenty-one,
 * built around the four ways a card can be wrong:
 *
 * 1. **It lies** — the counters, the plan, the owner and «آخر نشاط» must come from the
 *    customer's own rows, and the invoices counter must be the customer's, not the platform's.
 * 2. **It leaks** — a tenant session must be refused everywhere, and one customer's note must
 *    not be reachable through another customer's id.
 * 3. **It acts without a trace** — suspension, ownership transfer, flags, settings and notes
 *    each write an audit row *with the reason the operator typed*.
 * 4. **It is not gated** — reading needs `console.tenants.view`, changing the customer needs
 *    `console.tenants.manage`, and changing what the product does for them (limits, packs,
 *    branding) needs `console.settings.manage`.
 *
 * Two tests at the end are regressions for defects this part found by *running* the code
 * rather than by reading it (see the last section).
 */

/** `ActorOptions` has no `platformRoles` field yet — the console suites need it, so it is
 * narrowed here instead of widening the shared fixture contract from a feature part. */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform tenant card (P-C2)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let customer: Actor;
  let secondMember: Actor;
  let otherCustomer: Actor;

  const OPERATOR_TENANT = 'tenantcard-ops';
  const CARD = () => `/api/v1/platform/tenants/${customer.tenantId}`;

  beforeAll(async () => {
    ctx = await createTestApp('platform-tenants');

    customer = await createActor(ctx, {
      tenantCode: 'card-a',
      tenantName: 'شركة البطاقة',
      email: 'owner@card-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    // A second membership inside the *same* tenant: the target of `owner/transfer`.
    secondMember = await createActor(ctx, {
      tenantCode: 'card-a',
      tenantId: customer.tenantId,
      email: 'accountant@card-a.test',
      permissions: [],
      roleNames: ['Accountant'],
      isOwner: false,
    });
    otherCustomer = await createActor(ctx, {
      tenantCode: 'card-b',
      tenantName: 'شركة أخرى',
      email: 'owner@card-b.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });

    owner = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'owner@tenantcard-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'operations@tenantcard-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'auditor@tenantcard-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_auditor'],
    });

    // One branch and one invoice inside the customer, written through the tenant plane —
    // the very rows the counters, the usage tab and the queue page must find.
    await withTenantTx(ctx.handle.db, customer.tenantId, async (tx) => {
      const branch = newId();
      await tx.execute(sql`
        INSERT INTO branches (id, tenant_id, code, name_ar, is_default)
        VALUES (${branch}, ${customer.tenantId}, 'BR-CARD', 'الفرع الرئيسي', true)
      `);
      await tx.execute(sql`
        INSERT INTO sales_invoices (id, tenant_id, branch_id, status, currency)
        VALUES (${newId()}, ${customer.tenantId}, ${branch}, 'posted', 'SAR')
      `);
      // A queue row for this customer — the row the console's queue page could never see
      // before this part (no `platform_admin_plane` policy on `outbox_jobs`).
      await tx.execute(sql`
        INSERT INTO outbox_jobs (id, tenant_id, queue, type, status)
        VALUES (${newId()}, ${customer.tenantId}, 'notifications', 'invoice.posted', 'pending')
      `);
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------- 1. the card

  it('returns the card with its owner, its members and real counters', async () => {
    const response = await api(ctx.server, 'get', CARD(), { token: owner.token });
    expect(response.status).toBe(200);
    const card = response.body.data as PlatformTenantDetailResponse;

    expect(card.tenant.code).toBe('card-a');
    expect(card.tenant.name).toBe('شركة البطاقة');
    expect(card.tenant.status).toBe('active');
    expect(card.tenant.baseCurrency).toBe('SAR');
    expect(card.tenant.owner?.email).toBe('owner@card-a.test');
    expect(card.tenant.userCount).toBe(2);
    expect(card.tenant.branchCount).toBe(1);
    expect(card.tenant.invoicesLast30Days).toBe(1);
    expect(card.tenant.invoicesLifetime).toBe(1);
    expect(card.tenant.lastLoginAt).toBeNull(); // the fixture never logged in
    expect(card.members.map((member) => member.email).sort()).toEqual([
      'accountant@card-a.test',
      'owner@card-a.test',
    ]);
    expect(card.members.filter((member) => member.isOwner)).toHaveLength(1);
    expect(card.subscriptions).toEqual([]);
    expect(card.noteCount).toBe(0);

    // …and nothing of the other customer leaked into this answer.
    expect(JSON.stringify(card)).not.toContain('card-b');
  });

  it('answers 404 for an unknown customer and 400 for a malformed identifier', async () => {
    const missing = await api(ctx.server, 'get', `/api/v1/platform/tenants/${newId()}`, {
      token: owner.token,
    });
    expect(missing.status).toBe(404);

    const malformed = await api(ctx.server, 'get', '/api/v1/platform/tenants/not-a-uuid', {
      token: owner.token,
    });
    expect(malformed.status).toBe(400);
  });

  // ------------------------------------------------------------------ 2. the usage

  it('reports usage against the platform default written through the P-C1 settings page', async () => {
    // The platform-wide default is written by the console itself, not by a fixture: the
    // usage tab must read what «الإعدادات» wrote.
    const written = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'limits.max_users': 4 } },
    });
    expect(written.status).toBe(200);

    const response = await api(ctx.server, 'get', `${CARD()}/usage`, { token: owner.token });
    expect(response.status).toBe(200);
    const usage = response.body.data as PlatformTenantUsageResponse;

    // P-C5: the card's usage list is the eight-metric registry, not three hand-picked cups.
    expect(usage.metrics.map((metric) => metric.key)).toEqual([
      'users',
      'branches',
      'items',
      'invoices_per_month',
      'storage_mb',
      'api_calls_per_day',
      'whatsapp_per_month',
      'email_sends_per_month',
    ]);
    const users = usage.metrics.find((metric) => metric.key === 'users');
    expect(users?.used).toBe(2);
    expect(users?.limit).toBe(4);
    expect(users?.limitSource).toBe('platform');
    expect(users?.percentUsed).toBe(50);
    expect(users?.labelAr).toBe('المستخدمون');
    // الحدّ الذي كتبه مشغّل يُطبَّق فعلاً — ولذلك `enforced` صحيحة ووسم الوحدة حاضر.
    expect(users?.enforced).toBe(true);
    expect(users?.state).toBe('ok');
    expect(users?.unitAr).toBe('مستخدم');
    expect(users?.enforcedAtAr).toContain('عضوية');

    const branches = usage.metrics.find((metric) => metric.key === 'branches');
    expect(branches?.used).toBe(1);
    // Nothing overrode the branches limit anywhere → the catalogue default answers.
    expect(branches?.limit).toBe(1);
    expect(branches?.limitSource).toBe('default');
    // والمغلّف الافتراضي يُبلَّغ عنه ولا يمنع: الحالة صلبة والتنفيذ معطَّل.
    expect(branches?.state).toBe('hard');
    expect(branches?.enforced).toBe(false);

    const invoices = usage.metrics.find((metric) => metric.key === 'invoices_per_month');
    expect(invoices?.used).toBe(1);
    expect(invoices?.periodStart).not.toBeNull();

    expect(usage.invoicesPerDay).toHaveLength(30);
    expect(usage.invoicesPerDay.at(-1)?.count).toBe(1);
    expect(usage.invoicesPerDay.slice(0, 29).every((day) => day.count === 0)).toBe(true);
  });

  it('lets a customer override win, then hands it back to the platform value on null', async () => {
    const path = `${CARD()}/settings/limits.max_users`;

    const written = await api(ctx.server, 'put', path, { token: owner.token, body: { value: 9 } });
    expect(written.status).toBe(200);
    const override = (written.body.data as TenantSettingsResponse).settings.find(
      (setting) => setting.key === 'limits.max_users',
    );
    expect(override?.value).toBe(9);
    expect(override?.source).toBe('tenant');

    const usage = await api(ctx.server, 'get', `${CARD()}/usage`, { token: owner.token });
    const users = (usage.body.data as PlatformTenantUsageResponse).metrics.find(
      (metric) => metric.key === 'users',
    );
    expect(users?.limit).toBe(9);
    expect(users?.limitSource).toBe('tenant');

    const removed = await api(ctx.server, 'put', path, { token: owner.token, body: { value: null } });
    const back = (removed.body.data as TenantSettingsResponse).settings.find(
      (setting) => setting.key === 'limits.max_users',
    );
    expect(back?.value).toBe(4); // the platform row, not the catalogue default (5)
    expect(back?.source).toBe('platform');
  });

  // --------------------------------------------------------------- 3. the settings

  it('lists exactly the tenant-scoped half of the catalogue', async () => {
    const response = await api(ctx.server, 'get', `${CARD()}/settings`, { token: owner.token });
    expect(response.status).toBe(200);
    const body = response.body.data as TenantSettingsResponse;

    expect(body.tenantId).toBe(customer.tenantId);
    expect(body.settings.map((setting) => setting.key)).toEqual(
      platformSettingsForScope('tenant').map((definition) => definition.key),
    );
    // Nothing platform-only leaked in: the maintenance switch is not a customer's business.
    const keys = body.settings.map((setting) => setting.key);
    expect(keys).not.toContain('platform.maintenance');
    expect(keys).not.toContain('support.email');

    const branding = body.settings.find((setting) => setting.key === 'branding.primary_color');
    const definition = platformSettingDefinitions.find(
      (entry) => entry.key === 'branding.primary_color',
    );
    expect(branding?.value).toBe(definition?.defaultValue);
    expect(branding?.source).toBe('default');
    expect(branding?.kind).toBe('color');
  });

  it('refuses a platform-only key and a value of the wrong kind with 422', async () => {
    const platformOnly = await api(ctx.server, 'put', `${CARD()}/settings/platform.maintenance`, {
      token: owner.token,
      body: { value: true },
    });
    expect(platformOnly.status).toBe(422);
    expect(String(platformOnly.body.detail)).toContain('ليس إعداداً لعميل');

    const invalid = await api(
      ctx.server,
      'put',
      `${CARD()}/settings/branding.primary_color`,
      { token: owner.token, body: { value: 'blue' } },
    );
    expect(invalid.status).toBe(422);
    expect(String(invalid.body.detail)).toContain('#rrggbb');

    const unknown = await api(ctx.server, 'put', `${CARD()}/settings/nope.nope`, {
      token: owner.token,
      body: { value: 1 },
    });
    expect(unknown.status).toBe(422);
  });

  it('writes an audit row naming the key and the diff', async () => {
    await api(ctx.server, 'put', `${CARD()}/settings/limits.max_branches`, {
      token: owner.token,
      body: { value: 3 },
    });

    const rows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, entityId: auditLog.entityId, before: auditLog.before, after: auditLog.after, meta: auditLog.meta })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, customer.tenantId), eq(auditLog.entity, 'tenant_setting')))
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );
    expect(rows[0]?.action).toBe('tenant.setting');
    expect(rows[0]?.entityId).toBe(`${customer.tenantId}:limits.max_branches`);
    expect(rows[0]?.before).toEqual({ value: 1 }); // the catalogue default it replaced
    expect(rows[0]?.after).toEqual({ value: 3 });
  });

  // ------------------------------------------------------------------ 4. the flags

  it('lists the four feature packs and flips one, on the record', async () => {
    const before = await api(ctx.server, 'get', `${CARD()}/flags`, { token: owner.token });
    expect(before.status).toBe(200);
    const flagsBefore = before.body.data as TenantFlagsResponse;
    expect(flagsBefore.tenantId).toBe(customer.tenantId);
    expect(flagsBefore.flags.map((flag) => flag.key)).toEqual([
      'feature.pos',
      'feature.projects',
      'feature.hrm',
      'feature.niche',
    ]);
    expect(flagsBefore.flags.every((flag) => flag.enabled === false && flag.isDefault)).toBe(true);
    expect(flagsBefore.flags[0]?.labelAr).toBe(tenantFlagLabels['feature.pos']?.labelAr);

    const flip = await api(ctx.server, 'put', `${CARD()}/flags`, {
      token: owner.token,
      body: { values: { 'feature.pos': true } },
    });
    expect(flip.status).toBe(200);
    const pos = (flip.body.data as TenantFlagsResponse).flags.find(
      (flag) => flag.key === 'feature.pos',
    );
    expect(pos?.enabled).toBe(true);
    expect(pos?.isDefault).toBe(false);

    // The customer's own settings endpoint reads the same row — one store, not two.
    const asTenant = await api(ctx.server, 'get', '/api/v1/settings', { token: customer.token });
    expect(asTenant.status).toBe(200);
    const tenantView = asTenant.body.data as { settings: Record<string, unknown> };
    expect(tenantView.settings['feature.pos']).toBe(true);

    const audited = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, before: auditLog.before, after: auditLog.after })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, customer.tenantId), eq(auditLog.entity, 'tenant_flag')))
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );
    expect(audited[0]?.action).toBe('tenant.flag');
    expect(audited[0]?.before).toEqual({ enabled: false });
    expect(audited[0]?.after).toEqual({ enabled: true });

    const flipBack = await api(ctx.server, 'put', `${CARD()}/flags`, {
      token: owner.token,
      body: { values: { 'feature.pos': false } },
    });
    const restored = (flipBack.body.data as TenantFlagsResponse).flags.find(
      (flag) => flag.key === 'feature.pos',
    );
    expect(restored?.enabled).toBe(false);
    // …and the row is gone, not left behind repeating the default: `isDefault` is what the
    // tab prints, and a row that says «false» when the registry already says «false» would
    // make the customer look configured.
    expect(restored?.isDefault).toBe(true);
    expect(restored?.updatedAt).toBeNull();
  });

  it('refuses an unknown flag and an empty flip with 422', async () => {
    const unknown = await api(ctx.server, 'put', `${CARD()}/flags`, {
      token: owner.token,
      body: { values: { 'feature.nope': true } },
    });
    expect(unknown.status).toBe(422);
    expect(String(unknown.body.detail)).toContain('راية غير معروفة');

    const empty = await api(ctx.server, 'put', `${CARD()}/flags`, {
      token: owner.token,
      body: { values: {} },
    });
    expect(empty.status).toBe(422);
  });

  // --------------------------------------------------------------- 5. the branding

  it('round-trips the identity of the customer and rejects a non-https logo', async () => {
    const initial = await api(ctx.server, 'get', `${CARD()}/branding`, { token: owner.token });
    expect(initial.status).toBe(200);
    expect((initial.body.data as TenantBrandingResponse).primaryColor).toBe('#0f172a');

    const written = await api(ctx.server, 'put', `${CARD()}/branding`, {
      token: owner.token,
      body: {
        primaryColor: '#1A2B3C',
        senderName: 'شركة البطاقة',
        logoUrl: 'https://cdn.example.test/logo.png',
      },
    });
    expect(written.status).toBe(200);
    const branding = written.body.data as TenantBrandingResponse;
    // Lower-cased by the catalogue validator: «#1A2B3C» and «#1a2b3c» are one colour.
    expect(branding.primaryColor).toBe('#1a2b3c');
    expect(branding.senderName).toBe('شركة البطاقة');
    expect(branding.logoUrl).toBe('https://cdn.example.test/logo.png');
    expect(branding.updatedBy).toBe(owner.userId);
    expect(branding.updatedAt).not.toBeNull();

    const rejected = await api(ctx.server, 'put', `${CARD()}/branding`, {
      token: owner.token,
      body: { logoUrl: 'javascript:alert(1)' },
    });
    expect(rejected.status).toBe(422);
    expect(String(rejected.body.detail)).toContain('https://');

    // The store is `platform_settings` — the plan's «الإعدادات» table — and 0066 already
    // lets a tenant read *its own* rows, so the customer's own shell can pick the colour up
    // (wiring that read into the tenant UI is not this part's scope; this proves the hook).
    const asTenant = await withTenantTx(ctx.handle.db, customer.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT key, value::text AS raw FROM platform_settings
         WHERE tenant_id = ${customer.tenantId} AND key = 'branding.primary_color'
      `);
      return rows.rows as Array<{ key: string; raw: string }>;
    });
    expect(asTenant).toHaveLength(1);
    expect(JSON.parse(String(asTenant[0]?.raw))).toBe('#1a2b3c');
  });

  // ------------------------------------------------------- 6. the lifecycle writes

  it('renames a customer, records the diff, and refuses a code another customer holds', async () => {
    const renamed = await api(ctx.server, 'patch', CARD(), {
      token: owner.token,
      body: { name: 'شركة البطاقة المحدودة', timezone: 'Asia/Riyadh', currency: 'sar' },
    });
    expect(renamed.status).toBe(200);
    const overview = renamed.body.data as { name: string; timezone: string; baseCurrency: string };
    expect(overview.name).toBe('شركة البطاقة المحدودة');
    expect(overview.timezone).toBe('Asia/Riyadh');
    expect(overview.baseCurrency).toBe('SAR'); // upper-cased on write

    const clash = await api(ctx.server, 'patch', CARD(), {
      token: owner.token,
      body: { code: otherCustomer.tenantCode },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('TENANT_CODE_TAKEN');

    const empty = await api(ctx.server, 'patch', CARD(), { token: owner.token, body: {} });
    expect(empty.status).toBe(400);

    const audited = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ before: auditLog.before, after: auditLog.after, entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, customer.tenantId),
            eq(auditLog.entity, 'tenant'),
            eq(auditLog.action, 'update'),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );
    expect(audited[0]?.entityId).toBe(customer.tenantId);
    expect(audited[0]?.before).toMatchObject({ name: 'شركة البطاقة' });
    expect(audited[0]?.after).toMatchObject({ name: 'شركة البطاقة المحدودة' });
    // The audit row belongs to the customer whose name changed, not to the platform.
    expect(audited[0]?.after).not.toHaveProperty('status');
  });

  it('suspends and reactivates with a reason that lands on the customer’s own trail', async () => {
    const withoutReason = await api(ctx.server, 'post', `${CARD()}/status`, {
      token: owner.token,
      body: { status: 'suspended' },
    });
    expect(withoutReason.status).toBe(400);

    const suspended = await api(ctx.server, 'post', `${CARD()}/status`, {
      token: owner.token,
      body: { status: 'suspended', reason: 'فاتورة متأخرة منذ تسعين يوماً' },
    });
    expect(suspended.status).toBe(200);
    expect((suspended.body.data as { status: string }).status).toBe('suspended');

    const again = await api(ctx.server, 'post', `${CARD()}/status`, {
      token: owner.token,
      body: { status: 'suspended', reason: 'نفس الحالة مرة أخرى' },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TENANT_STATUS_UNCHANGED');

    // The suspension is visible to the health tab while it lasts.
    const health = await api(ctx.server, 'get', `${CARD()}/health`, { token: owner.token });
    expect(
      (health.body.data as PlatformTenantHealthResponse).findings.map((finding) => finding.text),
    ).toContain('الحساب موقوف.');

    const reactivated = await api(ctx.server, 'post', `${CARD()}/status`, {
      token: owner.token,
      body: { status: 'active', reason: 'سُدّدت الفاتورة' },
    });
    expect(reactivated.status).toBe(200);
    expect((reactivated.body.data as { status: string }).status).toBe('active');

    const rows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ before: auditLog.before, after: auditLog.after, meta: auditLog.meta })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, customer.tenantId), eq(auditLog.action, 'tenant.status')))
        .orderBy(desc(auditLog.createdAt))
        .limit(2),
    );
    const suspension = rows.find((row) => (row.meta as { reason?: string }).reason?.includes('متأخرة'));
    expect(suspension?.before).toEqual({ status: 'active' });
    expect(suspension?.after).toEqual({ status: 'suspended' });
    expect((suspension?.meta as { scope?: string }).scope).toBe('platform_console');
  });

  it('transfers ownership to another member and refuses the impossible ones', async () => {
    const toOutsider = await api(ctx.server, 'post', `${CARD()}/owner/transfer`, {
      token: owner.token,
      body: { membershipId: newId(), reason: 'عضو غير موجود' },
    });
    expect(toOutsider.status).toBe(404);

    // The other customer's member is not a member *here*.
    const foreign = await api(ctx.server, 'post', `${CARD()}/owner/transfer`, {
      token: owner.token,
      body: { membershipId: otherCustomer.membershipId, reason: 'عضو من عميل آخر' },
    });
    expect(foreign.status).toBe(404);

    const toCurrentOwner = await api(ctx.server, 'post', `${CARD()}/owner/transfer`, {
      token: owner.token,
      body: { membershipId: customer.membershipId, reason: 'هو المالك أصلاً' },
    });
    expect(toCurrentOwner.status).toBe(409);
    expect(toCurrentOwner.body.code).toBe('TENANT_OWNER_UNCHANGED');

    const transferred = await api(ctx.server, 'post', `${CARD()}/owner/transfer`, {
      token: owner.token,
      body: { membershipId: secondMember.membershipId, reason: 'انتقال المالك إلى المحاسب' },
    });
    expect(transferred.status).toBe(200);
    expect((transferred.body.data as { owner: { email: string } }).owner.email).toBe(
      'accountant@card-a.test',
    );

    const owners = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM memberships
         WHERE tenant_id = ${customer.tenantId} AND is_owner AND deleted_at IS NULL
      `),
    );
    expect(Number(owners.rows[0]?.n)).toBe(1);

    // Back to the first owner, so the rest of the suite reads one stable card.
    const back = await api(ctx.server, 'post', `${CARD()}/owner/transfer`, {
      token: owner.token,
      body: { membershipId: customer.membershipId, reason: 'إعادة المالك الأصلي' },
    });
    expect((back.body.data as { owner: { email: string } }).owner.email).toBe('owner@card-a.test');
  });

  // ------------------------------------------------------------------ 7. the notes

  it('stores operator notes with their author, and deletes a note without erasing the record', async () => {
    const created = await api(ctx.server, 'post', `${CARD()}/notes`, {
      token: owner.token,
      body: { body: 'اتصلنا بالعميل بخصوص الحد الشهري.' },
    });
    expect(created.status).toBe(201);
    const note = created.body.data as { id: string; authorLabel: string; authorUserId: string };
    expect(note.authorLabel.length).toBeGreaterThan(0);
    expect(note.authorUserId).toBe(owner.userId);

    const listed = await api(ctx.server, 'get', `${CARD()}/notes`, { token: owner.token });
    expect((listed.body.data as TenantNotesResponse).total).toBe(1);

    // A note belongs to one customer: asking for it under another one is a 404.
    const foreign = await api(
      ctx.server,
      'delete',
      `/api/v1/platform/tenants/${otherCustomer.tenantId}/notes/${note.id}`,
      { token: owner.token },
    );
    expect(foreign.status).toBe(404);

    const deleted = await api(ctx.server, 'delete', `${CARD()}/notes/${note.id}`, {
      token: owner.token,
    });
    expect(deleted.status).toBe(200);
    expect((deleted.body.data as { deleted: boolean }).deleted).toBe(true);

    const emptied = await api(ctx.server, 'get', `${CARD()}/notes`, { token: owner.token });
    expect((emptied.body.data as TenantNotesResponse).total).toBe(0);

    // …and the body is still readable in the audit trail.
    const rows = await withPlatformAdminTx(ctx.handle.db, async (tx) =>
      tx
        .select({ action: auditLog.action, before: auditLog.before })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, customer.tenantId), eq(auditLog.entity, 'tenant_note')))
        .orderBy(desc(auditLog.createdAt))
        .limit(2),
    );
    expect(rows.map((row) => row.action).sort()).toEqual(['delete', 'tenant.note']);
    expect(rows.find((row) => row.action === 'delete')?.before).toEqual({
      body: 'اتصلنا بالعميل بخصوص الحد الشهري.',
    });
  });

  // ----------------------------------------------------------------- 8. the health

  it('summarises health from the customer’s own rows', async () => {
    // Drive one limit to its ceiling, so «الصحة» has something concrete to warn about:
    // the customer has one branch and the ceiling is one branch.
    const ceiling = await api(ctx.server, 'put', `${CARD()}/settings/limits.max_branches`, {
      token: owner.token,
      body: { value: 1 },
    });
    expect(ceiling.status).toBe(200);

    const response = await api(ctx.server, 'get', `${CARD()}/health`, { token: owner.token });
    expect(response.status).toBe(200);
    const health = response.body.data as PlatformTenantHealthResponse;

    expect(health.tenantId).toBe(customer.tenantId);
    expect(health.subscriptionState).toBe('none'); // the fixture holds no licence
    expect(health.currentPeriodEnd).toBeNull();
    expect(health.outbox).toEqual({ pending: 1, published: 0, dead: 0, lastFailureAt: null });
    expect(health.status).toBe('attention');
    const texts = health.findings.map((finding) => finding.text);
    expect(texts).toContain('لا يوجد اشتراك فعّال لهذا العميل.');
    expect(texts).toContain('الفروع بلغ الحدّ (1 من 1) — limits.max_branches.');
    expect(health.findings.every((finding) => ['info', 'warn', 'danger'].includes(finding.severity))).toBe(true);
  });

  // ------------------------------------------------------- 9. what running it found

  it('shows the customer’s outbox job on the queue page (it was always empty before)', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/jobs/outbox', {
      token: owner.token,
    });
    expect(response.status).toBe(200);
    const page = response.body.data as {
      items: Array<{ tenantId: string; tenantCode: string | null; status: string }>;
      total: number;
    };
    expect(page.total).toBeGreaterThanOrEqual(1);
    const row = page.items.find((item) => item.tenantId === customer.tenantId);
    expect(row).toBeDefined();
    expect(row?.tenantCode).toBe('card-a');
    expect(row?.status).toBe('pending');
  });

  it('leaves no RLS policy casting an empty app.tenant_id to uuid', async () => {
    // The defect this part found by running the console: on a pooled connection that had
    // served *any* tenant transaction, `current_setting('app.tenant_id', true)` reads back
    // as `''` (never NULL again — measured, and asserted in the next test), so a policy
    // written without `nullif` raises `invalid input syntax for type uuid: ""` for every
    // platform-plane read. Migration 0067 rewrites them; this keeps them rewritten.
    const result = await ctx.handle.pool.query<{ tablename: string; policyname: string }>(`
      SELECT tablename, policyname FROM pg_policies
       WHERE (qual LIKE '%current_setting(''app.tenant_id''%' AND qual NOT ILIKE '%nullif%')
          OR (with_check LIKE '%current_setting(''app.tenant_id''%' AND with_check NOT ILIKE '%nullif%')
       ORDER BY tablename, policyname
    `);
    expect(result.rows).toEqual([]);
  });

  it('reads a tenant table on the platform plane from a connection poisoned with an empty GUC', async () => {
    const client = await ctx.handle.pool.connect();
    try {
      // What `withTenantTx` leaves behind on a pooled connection: after the transaction
      // ends — commit *or* rollback — the GUC is no longer NULL, it is the empty string.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [customer.tenantId]);
      await client.query('COMMIT');
      const poison = await client.query<{ value: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS value`,
      );
      expect(poison.rows[0]?.value).toBe('');

      // The same statement the card runs, on the same connection: it must answer, not raise.
      await client.query(`SELECT set_config('app.is_platform_admin', 'on', false)`);
      const rows = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sales_invoices WHERE tenant_id = $1`,
        [customer.tenantId],
      );
      expect(rows.rows[0]?.n).toBe(1);
    } finally {
      await client.query(`SELECT set_config('app.is_platform_admin', 'off', false)`);
      client.release();
    }
  });

  // -------------------------------------------------------------------- 10. RBAC

  it('denies a tenant session every route of the card', async () => {
    for (const [method, path] of [
      ['get', CARD()],
      ['get', `${CARD()}/usage`],
      ['get', `${CARD()}/settings`],
      ['get', `${CARD()}/flags`],
      ['get', `${CARD()}/branding`],
      ['get', `${CARD()}/health`],
      ['get', `${CARD()}/notes`],
      ['patch', CARD()],
    ] as const) {
      const response = await api(ctx.server, method, path, { token: customer.token });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets operations read the card but not change the customer', async () => {
    const read = await api(ctx.server, 'get', CARD(), { token: operations.token });
    expect(read.status).toBe(200);
    const usage = await api(ctx.server, 'get', `${CARD()}/usage`, { token: operations.token });
    expect(usage.status).toBe(200);

    for (const [method, path, body] of [
      ['patch', CARD(), { name: 'اسم جديد تماماً' }],
      ['post', `${CARD()}/status`, { status: 'suspended', reason: 'لأنني أستطيع' }],
      ['post', `${CARD()}/notes`, { body: 'ملاحظة' }],
      [
        'post',
        `${CARD()}/owner/transfer`,
        { membershipId: customer.membershipId, reason: 'نقل الملكية' },
      ],
    ] as const) {
      const response = await api(ctx.server, method, path, { token: operations.token, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.detail).toBe('platform permission console.tenants.manage required');
    }

    // …and the customer is untouched: a refused request changes nothing.
    const after = await api(ctx.server, 'get', CARD(), { token: owner.token });
    expect((after.body.data as PlatformTenantDetailResponse).tenant.name).toBe(
      'شركة البطاقة المحدودة',
    );
  });

  it('keeps the settings and the packs behind console.settings.manage', async () => {
    // `platform_billing` manages licences and reads customers, but must not switch a
    // customer's packs or move their limits.
    const billing = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'billing@tenantcard-ops.test',
      permissions: [],
      roleNames: ['Console'],
      isOwner: false,
      platformRoles: ['platform_billing'],
    });

    const flags = await api(ctx.server, 'put', `${CARD()}/flags`, {
      token: billing.token,
      body: { values: { 'feature.pos': true } },
    });
    expect(flags.status).toBe(403);
    expect(flags.body.detail).toBe('platform permission console.settings.manage required');

    for (const [method, path, body] of [
      ['put', `${CARD()}/settings/limits.max_users`, { value: 50 }],
      ['put', `${CARD()}/branding`, { senderName: 'محاولة' }],
    ] as const) {
      const response = await api(ctx.server, method, path, { token: billing.token, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.detail).toBe('platform permission console.settings.manage required');
    }
  });

  it('confines the auditor to reading: the card yes, a note no', async () => {
    const card = await api(ctx.server, 'get', CARD(), { token: auditor.token });
    expect(card.status).toBe(200);
    const notes = await api(ctx.server, 'get', `${CARD()}/notes`, { token: auditor.token });
    expect(notes.status).toBe(200);

    for (const [method, path, body] of [
      ['post', `${CARD()}/notes`, { body: 'ملاحظة من مدقّق' }],
      ['put', `${CARD()}/flags`, { values: { 'feature.pos': true } }],
      ['put', `${CARD()}/settings/limits.max_users`, { value: 1 }],
    ] as const) {
      const response = await api(ctx.server, method, path, { token: auditor.token, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('declares its own audit vocabulary in the shared contract', () => {
    // The screens colour-code by action, and the P-C1 audit filter narrows by name: an
    // action that is not in this catalogue is an action nobody can find later.
    expect(Object.values(tenantAuditActions)).toEqual([
      'tenant.status',
      'tenant.owner_transfer',
      'tenant.flag',
      'tenant.note',
      'tenant.setting',
    ]);
    expect(tenantFlagLabels['feature.hrm']?.labelAr).toBe('الرواتب والموظفون');
  });
});
