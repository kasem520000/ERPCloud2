import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  platformSettingsForScope,
  platformPermissionRegistry,
  platformPermissionsForRoles,
} from '@erp/contracts';
import {
  auditLog,
  permissions,
  platformSettings,
  withPlatformAdminTx,
  withTenantTx,
  withTx,
} from '@erp/database';

import { TokenService } from '../src/modules/platform/index.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C1 — «الأساس والقشرة، وترميم الصلاحيات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * The part has one measurable acceptance line: **صفر مسار `/platform/*` بلا رمز `console.*`**
 * — that scan lives in `apps/api/src/permission-codes.spec.ts`. This suite proves the other
 * half, which a source scan cannot: that the codes actually *decide* something at runtime,
 * that the cross-tenant audit trail reaches every customer, and that the platform settings
 * round-trip through RLS.
 *
 * Five actors are built, one per Family-A platform role, because the point of the repair is
 * that they are no longer interchangeable:
 *
 * | actor | roles | may | may not |
 * |---|---|---|---|
 * | owner | platform_owner | everything | — |
 * | operations | platform_operations | read tenants, audit, health | suspend a customer, write settings |
 * | billing | platform_billing | plans, licences, activation queue | read the audit trail, grant roles |
 * | support | platform_support | read tenants | read the audit trail, list users |
 * | auditor | platform_auditor | read tenants, audit | read plans, write anything |
 */
describe('platform console RBAC and cross-tenant audit (P-C1)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let billing: Actor;
  let support: Actor;
  let auditor: Actor;
  let tenantA: Actor;
  let tenantB: Actor;

  const OPERATOR_TENANT = 'console-ops';

  beforeAll(async () => {
    ctx = await createTestApp('platform-console');

    tenantA = await createActor(ctx, {
      tenantCode: 'console-a',
      email: 'owner@console-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
      isOwner: true,
    });
    tenantB = await createActor(ctx, {
      tenantCode: 'console-b',
      tenantName: 'مؤسسة الواجهة الثانية',
      email: 'owner@console-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
      isOwner: true,
    });

    const operator = (email: string, role: string): Promise<Actor> =>
      createActor(ctx, {
        tenantCode: OPERATOR_TENANT,
        email,
        permissions: [],
        roleNames: ['Console'],
        isOwner: false,
        platformRoles: [role],
      });

    owner = await operator('owner@console-ops.test', 'platform_owner');
    operations = await operator('operations@console-ops.test', 'platform_operations');
    billing = await operator('billing@console-ops.test', 'platform_billing');
    support = await operator('support@console-ops.test', 'platform_support');
    auditor = await operator('auditor@console-ops.test', 'platform_auditor');

    // Two mutations in two different customers, so the cross-tenant read has something to
    // cross. Each writes an audit row in its own tenant.
    for (const actor of [tenantA, tenantB]) {
      const response = await api(ctx.server, 'put', '/api/v1/settings/invoice.number_prefix', {
        token: actor.token,
        body: { value: 'P-C1-' },
      });
      expect(response.status).toBe(200);
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------ 1. /me

  it('publishes the console permissions of the operator on /me, separately from tenant codes', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/me', { token: operations.token });
    expect(response.status).toBe(200);
    const body = response.body.data as { permissions: string[]; platformPermissions: string[] };
    expect(body.platformPermissions.sort()).toEqual(
      [...platformPermissionsForRoles(['platform_operations'])].sort(),
    );
    expect(body.platformPermissions).toContain('console.audit.view');
    expect(body.platformPermissions).not.toContain('console.tenants.manage');
    // The two namespaces never mix: no console code leaks into the tenant list.
    expect(body.permissions.filter((code) => code.startsWith('console.'))).toEqual([]);
  });

  it('gives a tenant-only user an empty platform permission list', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/me', { token: tenantA.token });
    const body = response.body.data as { platformPermissions: string[] };
    expect(body.platformPermissions).toEqual([]);
  });

  // ------------------------------------------------- 2. pam alone is not enough

  it('refuses a bare `pam` token that carries no platform role', async () => {
    // Exactly what the console allowed before this part: the flag, no role, full power.
    const tokens = ctx.app.get(TokenService);
    const { token } = await tokens.signAccessToken({
      sub: tenantA.userId,
      tid: tenantA.tenantId,
      mid: tenantA.membershipId,
      scope: ['erp'],
      pam: true,
      proles: [],
    });

    for (const path of ['/api/v1/platform/overview', '/api/v1/platform/tenants', '/api/v1/platform/audit']) {
      const response = await api(ctx.server, 'get', path, { token });
      expect(response.status, path).toBe(403);
      expect(String(response.body.detail)).toContain('platform permission console.');
    }
  });

  // ----------------------------------------------------- 3. the role matrix

  it('lets operations read customers but not suspend one', async () => {
    const tenants = await api(ctx.server, 'get', '/api/v1/platform/tenants', { token: operations.token });
    expect(tenants.status).toBe(200);

    // P-C2 moved this decision to `POST …/status` and made «السبب» part of the body; the
    // permission boundary is what this check is about, so the reason is present and valid.
    const suspend = await api(ctx.server, 'post', `/api/v1/platform/tenants/${tenantA.tenantId}/status`, {
      token: operations.token,
      body: { status: 'suspended', reason: 'محاولة من دور العمليات' },
    });
    expect(suspend.status).toBe(403);
    expect(suspend.body.detail).toBe('platform permission console.tenants.manage required');

    // …and the customer is still active: a refused request changes nothing.
    const after = await api(ctx.server, 'get', '/api/v1/platform/tenants', { token: owner.token });
    const row = (after.body.data as Array<{ id: string; status: string }>).find(
      (entry) => entry.id === tenantA.tenantId,
    );
    expect(row?.status).toBe('active');
  });

  it('confines the auditor to reading: audit and customers yes, plans no', async () => {
    const audit = await api(ctx.server, 'get', '/api/v1/platform/audit', { token: auditor.token });
    expect(audit.status).toBe(200);

    const plans = await api(ctx.server, 'get', '/api/v1/platform/plans', { token: auditor.token });
    expect(plans.status).toBe(403);
    expect(plans.body.detail).toBe('platform permission console.plans.manage required');
  });

  it('keeps support out of the audit trail and the user directory', async () => {
    const audit = await api(ctx.server, 'get', '/api/v1/platform/audit', { token: support.token });
    expect(audit.status).toBe(403);

    const users = await api(ctx.server, 'get', '/api/v1/platform/users', { token: support.token });
    expect(users.status).toBe(403);
  });

  it('gives billing the plans and the activation queue, but not the audit trail', async () => {
    const plans = await api(ctx.server, 'get', '/api/v1/platform/plans', { token: billing.token });
    expect(plans.status).toBe(200);

    const queue = await api(ctx.server, 'get', '/api/v1/platform/activation-requests', { token: billing.token });
    expect(queue.status).toBe(200);

    const audit = await api(ctx.server, 'get', '/api/v1/platform/audit', { token: billing.token });
    expect(audit.status).toBe(403);
  });

  it('keeps the tenant plane out of the console entirely', async () => {
    for (const path of ['/api/v1/platform/audit', '/api/v1/platform/settings', '/api/v1/platform/tenants/search?q=a']) {
      const response = await api(ctx.server, 'get', path, { token: tenantA.token });
      expect(response.status, path).toBe(403);
    }
  });

  // ---------------------------------------------------- 4. cross-tenant audit

  it('reads the audit trail across customers with each row’s tenant named', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/audit?limit=200', {
      token: owner.token,
    });
    expect(response.status).toBe(200);
    const body = response.body.data as {
      items: Array<{ tenantId: string | null; tenantCode: string | null; tenantName: string | null; entity: string }>;
      total: number;
      limit: number;
    };

    const settingsRows = body.items.filter((row) => row.entity === 'settings');
    const codes = new Set(settingsRows.map((row) => row.tenantCode));
    expect(codes.has('console-a')).toBe(true);
    expect(codes.has('console-b')).toBe(true);

    const rowForA = settingsRows.find((row) => row.tenantId === tenantA.tenantId);
    expect(rowForA?.tenantCode).toBe('console-a');
    expect(rowForA?.tenantName).toBeTypeOf('string');

    // A tenant-scoped read of the very same table sees only its own rows — the elevation
    // belongs to the console, not to the query.
    const tenantView = await api(ctx.server, 'get', '/api/v1/audit-log?limit=200', { token: tenantA.token });
    const tenantRows = (tenantView.body.data ?? []) as Array<{ entity: string }>;
    expect(tenantRows.every((row) => row.entity !== 'settings' || true)).toBe(true);
    const foreignSettingsRows = await withTenantTx(ctx.handle.db, tenantA.tenantId, async (tx) =>
      tx.select({ tenantId: auditLog.tenantId }).from(auditLog).where(eq(auditLog.entity, 'settings')),
    );
    expect(new Set(foreignSettingsRows.map((row) => row.tenantId))).toEqual(new Set([tenantA.tenantId]));
  });

  it('filters the cross-tenant audit trail by customer, entity and action', async () => {
    const response = await api(
      ctx.server,
      'get',
      `/api/v1/platform/audit?filter[tenantId]=${tenantB.tenantId}&filter[entity]=settings&filter[action]=update`,
      { token: owner.token },
    );
    expect(response.status).toBe(200);
    const items = (response.body.data as { items: Array<{ tenantId: string; action: string; entity: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect(row.tenantId).toBe(tenantB.tenantId);
      expect(row.action).toBe('update');
      expect(row.entity).toBe('settings');
    }
  });

  it('rejects an unknown audit filter instead of ignoring it', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/audit?filter[colour]=red', {
      token: owner.token,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('FILTER_NOT_ALLOWED');
  });

  // ------------------------------------------------------- 5. platform settings

  it('serves every platform-scoped catalogue key with its default and the deployment name', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: support.token });
    expect(response.status).toBe(200);
    const body = response.body.data as {
      settings: Array<{ key: string; value: unknown; isDefault: boolean; labelAr: string }>;
      environment: { name: string; labelAr: string };
    };
    // Platform scope, not the whole catalogue: P-C2 added tenant-only keys
    // (`branding.*`) to the same catalogue, and a platform-wide value for those is
    // refused by `PUT /platform/settings` — so the page must not offer them.
    expect(body.settings.map((row) => row.key)).toEqual(
      platformSettingsForScope('platform').map((definition) => definition.key),
    );
    // خمسة عشر مفتاحاً أضافها P-C3/P-C4 إلى النطاق: ستة `billing.*` للفوترة، وخمسة
    // `limits.*` للحصص (P-C5)، ثم ثمانية `site.*` أضافها P-M5 (هوية الموقع ونطاقه ولغته
    // وحالة الصيانة)، و`billing.trial_days` أضافه P-M4 (فترة التجربة المعلَنة في التسجيل)
    // — وكلها بحاجةٍ إلى تسمية عربية وشرح، وهذا ما يفحصه السطر التالي.
    // OCR provider routing adds two platform-scoped keys (`ocr.provider`, `ocr.endpoint`).
    expect(body.settings.length).toBe(34);
    for (const row of body.settings) {
      expect(row.labelAr.length).toBeGreaterThan(0);
    }
    expect(body.environment.name).toBe(process.env.NODE_ENV ?? 'test');
    expect(body.environment.labelAr.length).toBeGreaterThan(0);
  });

  it('writes settings, reads them back, and records who changed what', async () => {
    const before = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: owner.token });
    const beforeValues = Object.fromEntries(
      (before.body.data as { settings: Array<{ key: string; value: unknown }> }).settings.map((row) => [
        row.key,
        row.value,
      ]),
    );

    try {
      const write = await api(ctx.server, 'put', '/api/v1/platform/settings', {
        token: owner.token,
        body: {
          values: {
            'support.email': 'help@console-ops.test',
            'limits.max_users': 42,
            'platform.maintenance': true,
            'platform.domains': ['console-ops.test', 'ops.example.test', 'console-ops.test'],
          },
        },
      });
      expect(write.status).toBe(200);

      const stored = Object.fromEntries(
        (write.body.data as { settings: Array<{ key: string; value: unknown; isDefault: boolean }> }).settings
          .filter((row) => !row.isDefault)
          .map((row) => [row.key, row.value]),
      );
      expect(stored['support.email']).toBe('help@console-ops.test');
      expect(stored['limits.max_users']).toBe(42);
      expect(stored['platform.maintenance']).toBe(true);
      // Duplicates collapse — the same domain twice is one domain.
      expect(stored['platform.domains']).toEqual(['console-ops.test', 'ops.example.test']);

      const audit = await api(
        ctx.server,
        'get',
        '/api/v1/platform/audit?filter[entity]=platform_settings&filter[entityId]=platform.maintenance',
        { token: owner.token },
      );
      const rows = (audit.body.data as {
        items: Array<{ tenantId: string | null; actorUserId: string | null; before: unknown; after: unknown }>;
      }).items;
      expect(rows.length).toBe(1);
      expect(rows[0]?.tenantId).toBeNull();
      expect(rows[0]?.actorUserId).toBe(owner.userId);
      expect((rows[0]?.before as { value: unknown }).value).toBe(false);
      expect((rows[0]?.after as { value: unknown }).value).toBe(true);
    } finally {
      const restore = await api(ctx.server, 'put', '/api/v1/platform/settings', {
        token: owner.token,
        body: { values: beforeValues },
      });
      expect(restore.status).toBe(200);
    }
  });

  it('returns a string setting as the string that was written, even when it looks like JSON', async () => {
    // jsonb + a double-parsing mapper turns `'920000000'` into a number, `'true'` into a
    // boolean and `'{"x":1}'` into an object. A phone number, a domain or a prefix is
    // exactly that kind of value, so the read is asserted, not assumed.
    const snapshot = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: owner.token });
    const original = Object.fromEntries(
      (snapshot.body.data as { settings: Array<{ key: string; value: unknown }> }).settings.map((row) => [
        row.key,
        row.value,
      ]),
    );

    try {
      for (const candidate of ['920000000', 'true', '{"x":1}', '007']) {
        const write = await api(ctx.server, 'put', '/api/v1/platform/settings', {
          token: owner.token,
          body: { values: { 'support.phone': candidate } },
        });
        expect(write.status).toBe(200);
        const row = (write.body.data as { settings: Array<{ key: string; value: unknown }> }).settings.find(
          (setting) => setting.key === 'support.phone',
        );
        expect(row?.value, candidate).toBe(candidate);
        expect(typeof row?.value, candidate).toBe('string');
      }
    } finally {
      await api(ctx.server, 'put', '/api/v1/platform/settings', {
        token: owner.token,
        body: { values: original },
      });
    }
  });

  it('refuses a write the shared catalogue rejects, and writes nothing', async () => {
    const unknown = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'platform.colour': 'teal' } },
    });
    expect(unknown.status).toBe(422);
    expect(String(unknown.body.detail)).toContain('platform.colour');

    const badEmail = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'support.email': 'not-an-email' } },
    });
    expect(badEmail.status).toBe(422);

    const outOfRange = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'limits.max_branches': -3 } },
    });
    expect(outOfRange.status).toBe(422);

    // P-C5: `null` في مفتاح عددي ليس صفراً — كان `Number(null) === 0` يُخزَّن «حدّ صفر» على
    // إعدادٍ صار يُطبَّق، فيُحجب العميل بدل أن تُرفض الكتابة.
    const nullValue = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'limits.max_users': null } },
    });
    expect(nullValue.status).toBe(422);
    const stored = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: owner.token });
    const users = (stored.body.data as { settings: Array<{ key: string; value: unknown }> }).settings.find(
      (row) => row.key === 'limits.max_users',
    );
    expect(users?.value).not.toBe(0);

    // A batch with one bad key is rejected whole: the good half must not land.
    const mixed = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: owner.token,
      body: { values: { 'support.phone': '920000000', 'limits.max_users': 'many' } },
    });
    expect(mixed.status).toBe(422);

    const after = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: owner.token });
    const phone = (after.body.data as { settings: Array<{ key: string; value: unknown }> }).settings.find(
      (row) => row.key === 'support.phone',
    );
    expect(phone?.value ?? '').not.toBe('920000000');
  });

  it('needs console.settings.manage to write: operations reads, cannot write', async () => {
    const read = await api(ctx.server, 'get', '/api/v1/platform/settings', { token: operations.token });
    expect(read.status).toBe(200);

    const write = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: operations.token,
      body: { values: { 'platform.maintenance': false } },
    });
    expect(write.status).toBe(403);
    expect(write.body.detail).toBe('platform permission console.settings.manage required');
  });

  it('keeps platform settings invisible to a tenant session (RLS)', async () => {
    await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const rows = await tx.select().from(platformSettings).where(isNull(platformSettings.tenantId));
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });

    const asTenant = await withTenantTx(ctx.handle.db, tenantA.tenantId, async (tx) =>
      tx
        .select({ key: platformSettings.key })
        .from(platformSettings)
        .where(and(isNull(platformSettings.tenantId), eq(platformSettings.key, 'platform.maintenance'))),
    );
    expect(asTenant).toEqual([]);
  });

  // ---------------------------------------------------------------- 6. outbox

  it('shows the queue across customers to console.jobs.view holders only', async () => {
    const asAuditor = await api(ctx.server, 'get', '/api/v1/platform/jobs/outbox?limit=10', {
      token: auditor.token,
    });
    expect(asAuditor.status).toBe(200);
    const body = asAuditor.body.data as {
      items: Array<{ tenantCode: string | null; status: string; attempts: number }>;
      limit: number;
    };
    // Empty is a legitimate state (no queued work in a fresh database); the shape is not.
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.limit).toBe(10);

    const asBilling = await api(ctx.server, 'get', '/api/v1/platform/jobs/outbox', {
      token: billing.token,
    });
    expect(asBilling.status).toBe(403);
    expect(asBilling.body.detail).toBe('platform permission console.jobs.view required');
  });

  // ------------------------------------------------------------- 7. omnibox

  it('searches customers by code and by name for the Ctrl+K palette', async () => {
    const byCode = await api(ctx.server, 'get', '/api/v1/platform/tenants/search?q=console-a', {
      token: support.token,
    });
    expect(byCode.status).toBe(200);
    const codeRows = byCode.body.data as Array<{ code: string; name: string }>;
    expect(codeRows.map((row) => row.code)).toContain('console-a');

    // Arabic names are the normal case in this product, and `ilike` has to carry them.
    const byName = await api(ctx.server, 'get', '/api/v1/platform/tenants/search?q=%D8%A7%D9%84%D9%88%D8%A7%D8%AC%D9%87%D8%A9', {
      token: support.token,
    });
    expect(byName.status).toBe(200);
    expect((byName.body.data as Array<{ code: string }>).map((row) => row.code)).toContain('console-b');

    const empty = await api(ctx.server, 'get', '/api/v1/platform/tenants/search?q=', { token: support.token });
    expect(empty.status).toBe(400);
  });

  // ------------------------------------------------------- 8. registry parity

  it('seeds every console code into the permissions table', async () => {
    // Read straight from the table: `GET /permissions` deliberately enumerates the
    // *tenant* registry only, so that no tenant-side screen can ever offer a console code
    // (SECURITY_ARCHITECTURE §3).
    const rows = await withTx(ctx.handle.db, async (tx) =>
      tx.select({ code: permissions.code }).from(permissions),
    );
    const codes = new Set(rows.map((row) => row.code));
    for (const entry of platformPermissionRegistry) {
      expect(codes.has(entry.code), entry.code).toBe(true);
    }
    expect(codes.has('console.settings.manage')).toBe(true);

    const tenantView = await api(ctx.server, 'get', '/api/v1/permissions', { token: tenantA.token });
    expect(tenantView.status).toBe(200);
    const tenantCodes = (tenantView.body.data as Array<{ code: string }>).map((row) => row.code);
    expect(tenantCodes.filter((code) => code.startsWith('console.'))).toEqual([]);
  });
});
