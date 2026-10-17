import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type PublicPlan } from '@erp/contracts';
import { auditLog, withPlatformAdminTx } from '@erp/database';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  createTenantFixture,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * M7 — تغليف المنتج: الحزم العمودية الأربع (جملة · تصنيع · مصنع أغذية · بيع متجول).
 *
 * الجهاز (باقات + حقوق + رايات) كان قائماً من P-C4/P-C5، وهذه السرب يقيس الحلقة
 * التي أضافها M7 — أن ما يُشترى يُفتح فعلاً:
 *
 *   1. **الكتالوج** — رمزا المتجر الناقصان (wholesale/food_factory) يظهران بسعرَيهما،
 *      وشاشات مصنع الأغذية هي شاشات التصنيع والتوزيع نفسها فلا يُقفل شيءٌ على أحد؛
 *   2. **الباقات مزروعة** — الأربع تظهر في صفحة الأسعار العامة بحقوقها وأسمائها
 *      العربية من سجلّ المنتج لا من ترجمةٍ في الواجهة؛
 *   3. **الإصدار يفتح** — ترخيصٌ على باقة حزمة يقلب رايتها للمستأجر (والتجربة
 *      تجربةُ الحزمة فتفتحها أيضاً)، مع سجلّ تدقيقٍ لكل حزمةٍ تُفتح؛
 *   4. **فتحٌ لا إغلاق** — باقةٌ أرخص أو أُخرى لا تسحب حزمةً مفتوحة: التخفيض قرارٌ
 *      يدوي كما كان؛
 *   5. **كل مسارات الحياة حيّة** — طلب التفعيل وموافقته، وترقية الباقة، كلاهماما يفتح
 *      حزم الباقة الجديدة.
 */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('vertical packs (M7) — codes, plans, and opening what was bought', () => {
  let ctx: TestApp;
  let owner: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let customerC: Actor;

  const PLANS = '/api/v1/platform/plans';
  const SUBSCRIPTIONS = '/api/v1/platform/subscriptions';
  const PACK_CODES = ['pack_wholesale', 'pack_manufacturing', 'pack_food_factory', 'pack_van_sales'] as const;
  const packPlanIds = new Map<string, string>();

  const asOwner = (method: 'get' | 'post', path: string, body?: unknown) =>
    api(ctx.server, method, path, { token: owner.token, ...(body === undefined ? {} : { body }) });

  const flagsOf = async (tenantId: string): Promise<Map<string, { enabled: boolean; isDefault: boolean }>> => {
    const response = await asOwner('get', `/api/v1/platform/tenants/${tenantId}/flags`);
    expect(response.status).toBe(200);
    const flags = (response.body.data as { flags: Array<{ key: string; enabled: boolean; isDefault: boolean }> }).flags;
    return new Map(flags.map((flag) => [flag.key, { enabled: flag.enabled, isDefault: flag.isDefault }]));
  };

  const grant = async (tenantId: string, planCode: string, extra: Record<string, unknown> = {}) => {
    const response = await asOwner('post', SUBSCRIPTIONS, { tenantId, planId: packPlanIds.get(planCode), months: 1, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data as { id: string; planCode: string };
  };

  beforeAll(async () => {
    ctx = await createTestApp('vertical-packs');
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: 'm7-ops',
      email: 'owner@m7-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    customerA = await createActor(ctx, {
      tenantCode: 'm7-cust-a',
      tenantName: 'مصنع الألف للأغذية',
      email: 'owner@m7-cust-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'm7-cust-b',
      tenantName: 'مؤسسة الباء للجملة',
      email: 'owner@m7-cust-b.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerC = await createActor(ctx, {
      tenantCode: 'm7-cust-c',
      tenantName: 'شركة الجيم للتصنيع',
      email: 'owner@m7-cust-c.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });

    // الباقات الأربع مزروعة بالترحيل 0133 — تُقرأ أرقامها كما يقرؤها المشغّل.
    const listed = await asOwner('get', PLANS);
    expect(listed.status).toBe(200);
    for (const row of listed.body.data as Array<{ id: string; code: string }>) {
      if ((PACK_CODES as readonly string[]).includes(row.code)) packPlanIds.set(row.code, row.id);
    }
    expect(packPlanIds.size).toBe(4);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('lists the two missing marketplace codes with their prices, gating nothing new', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/marketplace/apps', { token: customerA.token });
    expect(response.status).toBe(200);
    const apps = response.body.data as {
      apps: Array<{ code: string; category: string; monthlyPrice: string; enabled: boolean; screens: string[] }>;
      gatedHrefs: string[];
    };
    const wholesale = apps.apps.find((app) => app.code === 'wholesale');
    const foodFactory = apps.apps.find((app) => app.code === 'food_factory');
    expect(wholesale).toMatchObject({ category: 'sector', monthlyPrice: '149.0000', enabled: false, screens: [] });
    expect(foodFactory).toMatchObject({ category: 'sector', monthlyPrice: '199.0000', enabled: false });

    // شاشات مصنع الأغذية شاشاتُ التصنيع والبيع المتجول نفسها: لا يُقفَل على مستأجرٍ
    // قائمٍ شيءٌ لم يكن مقفلاً — الرمز الجديد يضيف طريقاً لفتحها لا قفلاً جديداً.
    for (const href of foodFactory!.screens) {
      const preExistingGates = ['/manufacturing/orders', '/inventory/production', '/van-sales'];
      expect(preExistingGates, `food_factory must reuse already-gated screens only: ${href}`).toContain(href);
    }
    expect(apps.gatedHrefs).not.toContain('/sales');
  });

  it('seeds the four pack plans where the pricing page reads them', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/public/plans');
    expect(response.status).toBe(200);
    const plans = response.body.data as PublicPlan[];
    const byCode = new Map(plans.map((plan) => [plan.code, plan]));

    const expected: Record<string, { flag: string; labelAr: string; maxUsers: number; amount: string }> = {
      pack_wholesale: { flag: 'feature.wholesale', labelAr: 'الجملة والتوزيع', maxUsers: 15, amount: '149.00' },
      pack_manufacturing: { flag: 'feature.manufacturing', labelAr: 'التصنيع والإنتاج', maxUsers: 15, amount: '149.00' },
      pack_food_factory: { flag: 'feature.food_factory', labelAr: 'مصنع الأغذية', maxUsers: 20, amount: '199.00' },
      pack_van_sales: { flag: 'feature.van_sales', labelAr: 'البيع المتجول', maxUsers: 10, amount: '129.00' },
    };
    for (const [code, want] of Object.entries(expected)) {
      const plan = byCode.get(code);
      expect(plan, code).toBeDefined();
      expect(plan!.amount).toBe(want.amount);
      expect(plan!.currency).toBe('SAR');
      const flagRow = plan!.entitlements.find((entry) => entry.key === want.flag);
      expect(flagRow, `${code} must open its pack`).toMatchObject({ kind: 'module', value: true, labelAr: want.labelAr });
      const limitRow = plan!.entitlements.find((entry) => entry.key === 'limits.max_users');
      expect(limitRow).toMatchObject({ kind: 'limit', value: want.maxUsers });
    }
  });

  it('opens the pack when a licence is granted — and records who opened it', async () => {
    const before = await flagsOf(customerA.tenantId);
    expect(before.get('feature.food_factory')).toMatchObject({ enabled: false, isDefault: true });

    const granted = await grant(customerA.tenantId, 'pack_food_factory');
    expect(granted.planCode).toBe('pack_food_factory');

    const after = await flagsOf(customerA.tenantId);
    expect(after.get('feature.food_factory')).toMatchObject({ enabled: true, isDefault: false });
    expect(after.get('feature.wholesale')?.enabled).toBe(false);

    // والمستأجر يرى ما فُتح له من إعداداته هو، لا من لوحة المنصة وحدها.
    const settings = await api(ctx.server, 'get', '/api/v1/settings', { token: customerA.token });
    expect(settings.status).toBe(200);
    expect((settings.body.data as { settings: Record<string, unknown> }).settings['feature.food_factory']).toBe(true);

    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx
        .select({ action: auditLog.action, entityId: auditLog.entityId, meta: auditLog.meta })
        .from(auditLog)
        .where(eq(auditLog.entityId, `${customerA.tenantId}:feature.food_factory`)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('tenant.flag');
    expect((rows[0]?.meta as Record<string, unknown>).planCode).toBe('pack_food_factory');
  });

  it('a trial is a trial of the pack — and opening is additive, never closing', async () => {
    const trialed = await grant(customerA.tenantId, 'pack_van_sales', { trialDays: 14 });
    expect(trialed.planCode).toBe('pack_van_sales');

    const flags = await flagsOf(customerA.tenantId);
    expect(flags.get('feature.van_sales')).toMatchObject({ enabled: true, isDefault: false });
    // باقة البيع المتجول لا تحمل حزمة مصنع الأغذية — وما فُتح بترخيصٍ سابقٍ لا يُسحب.
    expect(flags.get('feature.food_factory')?.enabled).toBe(true);
  });

  it('approving an activation request opens the plan the customer asked for', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/billing/activation-requests', {
      token: customerB.token,
      body: { planId: packPlanIds.get('pack_wholesale'), notes: 'M7' },
    });
    expect(created.status).toBe(201);
    const requestId = (created.body.data as { id: string }).id;

    const reviewed = await api(ctx.server, 'post', `/api/v1/billing/activation-requests/${requestId}/review`, {
      token: owner.token,
      body: { approve: true, notes: 'مقبول' },
    });
    expect(reviewed.status).toBe(201);

    const flags = await flagsOf(customerB.tenantId);
    expect(flags.get('feature.wholesale')).toMatchObject({ enabled: true, isDefault: false });
    expect(flags.get('feature.food_factory')?.enabled).toBe(false);
  });

  it('changing the plan opens the new plan’s packs without closing the old ones', async () => {
    const granted = await grant(customerC.tenantId, 'pack_wholesale');
    expect((await flagsOf(customerC.tenantId)).get('feature.wholesale')?.enabled).toBe(true);

    const changed = await asOwner('post', `${SUBSCRIPTIONS}/${granted.id}/change-plan`, {
      planId: packPlanIds.get('pack_manufacturing'),
      reason: 'ترقية M7',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const flags = await flagsOf(customerC.tenantId);
    expect(flags.get('feature.manufacturing')).toMatchObject({ enabled: true, isDefault: false });
    // التخفيض يدوي: الباقة الجديدة لا تسحب ما فتحته القديمة.
    expect(flags.get('feature.wholesale')?.enabled).toBe(true);
  });
});
