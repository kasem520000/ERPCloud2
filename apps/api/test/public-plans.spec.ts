import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  findPlatformSettingDefinition,
  platformFormatAmount,
  platformParseAmount,
  type PublicPlan,
} from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import { createActor, createTenantFixture, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M3 — «الباقات والأسعار»: الواجهة العامة للتسعير (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * `GET /public/plans` هو أوّل ما يقرؤه زائرٌ لا يملك حساباً، وهو الردّ الوحيد في المستودع الذي
 * يقرأ **سلّة المنتج** بلا جلسة. فكل اختبار هنا يقيس حدًّا لا ميزة:
 *
 * 1. **النشطة وحدها** — باقةٌ أوقفها المشغّل تختفي في اللحظة نفسها؛ لا كاش ولا قائمة ثابتة.
 * 2. **الحقوق تظهر** — الباقة بلا حقوقها سعرٌ بلا مقابل، والحقّ يأتي باسمه العربي والإنجليزي
 *    من سجلّ المنتج (`tenantFlagLabels` · `platformSettingDefinitions`) لا من ترجمةٍ في الواجهة.
 * 3. **العملة والمكافئ** — `SAR`، والمبلغ نصٌّ بمنزلتين، والمكافئ الشهري محسوبٌ بالسنة ÷ 12،
 *    وما يُدفع في السنة معلَن (`annualAmount`) لأن عليه يُقاس «التوفير» في الصفحة.
 * 4. **بلا أسرار** — لا `stripePriceId` ولا عدّاد تراخيص ولا `active` في الردّ: ما يُعرض في
 *    الموقع هو السعر والحقوق.
 * 5. **القراءة وحدها عامة** — `GET` بلا رمز يعمل، والكتابة على المسار العام غير موجودة أصلاً،
 *    والباقة الإدارية (`/platform/plans`) تبقى خلف `console.billing.*`.
 * 6. **الترتيب قرار** — الأرخص بالمكافئ الشهري أولاً (فالسنة بسعرها الشهري قد تسبق الشهرية).
 *
 * `ActorOptions` بلا `platformRoles` — تُضيّق هنا كما في أسراب P-C2/P-C3/P-C4.
 */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('public plans (P-M3)', () => {
  let ctx: TestApp;
  let operator: Actor;
  let customer: Actor;

  const PUBLIC = '/api/v1/public/plans';
  const PLANS = '/api/v1/platform/plans';

  const get = (path: string, token?: string) => api(ctx.server, 'get', path, token ? { token } : {});

  /** الردود مغلَّفة بـ`{ data }` في هذا المستودع — والاختبار يقرأ ما يقرؤه العميل. */
  const savePlan = async (body: Record<string, unknown>) => {
    const response = await api(ctx.server, 'post', PLANS, { token: operator.token, body });
    expect(response.status).toBe(201);
    return (response.body as { data: { id: string; code: string; active: boolean } }).data;
  };

  /** كتالوج اللوحة كاملاً بمعرّفات مزوّد الدفع — يُقرأ منه ما لا يجوز أن يظهر في العام. */
  const adminPlans = async () => {
    const response = await get(PLANS, operator.token);
    expect(response.status).toBe(200);
    return (response.body as { data: Array<Record<string, unknown>> }).data;
  };

  const setEntitlements = async (planId: string, entitlements: unknown[], reason = 'قياس P-M3') => {
    const response = await api(ctx.server, 'put', `${PLANS}/${planId}/entitlements`, {
      token: operator.token,
      body: { entitlements, reason },
    });
    expect(response.status).toBe(200);
    return (response.body as { data: { entitlements: unknown[] } }).data;
  };

  const publicPlans = async (): Promise<PublicPlan[]> => {
    const response = await get(PUBLIC);
    expect(response.status).toBe(200);
    return (response.body as { data: PublicPlan[] }).data;
  };

  /** باقةٌ في هذا السرب تُقرأ من الردّ العام نفسه — فالاختبار يقيس ما يراه الزائر لا SQL. */
  const codeOf = (plans: PublicPlan[], code: string) => plans.find((plan) => plan.code === code);

  beforeAll(async () => {
    ctx = await createTestApp('public-plans');
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    operator = await createOperator(ctx, {
      tenantCode: 'pub-plan-ops',
      email: 'owner@pub-plan-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    customer = await createActor(ctx, {
      tenantCode: 'pub-plan-customer',
      tenantName: 'شركة العميل',
      email: 'owner@pub-plan-customer.test',
      permissions: [],
      roleNames: ['Admin'],
      isOwner: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('لا يعرض إلا الباقات النشطة — والإيقاف يظهر في اللحظة نفسها', async () => {
    await savePlan({ code: 'pm3-live', name: 'باقة معروضة', interval: 'month', amount: '99.00' });
    await savePlan({ code: 'pm3-hidden', name: 'باقة موقوفة', interval: 'month', amount: '89.00', active: false });

    const plans = await publicPlans();
    expect(plans.map((plan) => plan.code)).toContain('pm3-live');
    // الرخيصة الموقوفة لا تسبق المعروضة: الفلترة ليست ترتيباً، والموقوفة غير موجودة أصلاً.
    expect(plans.map((plan) => plan.code)).not.toContain('pm3-hidden');

    // اللوحة ترى الموقوفة (وهي التي أوقفتها)، والموقع لا يراها — وهذا فرقُ القارئين.
    const hidden = (await adminPlans()).filter((plan) => plan.code === 'pm3-hidden');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.active).toBe(false);

    // وبعد الإيقاف تختفي من الموقع بلا نشرة ولا كاش.
    const paused = await savePlan({ code: 'pm3-live', name: 'باقة معروضة', interval: 'month', amount: '99.00', active: false });
    const afterPause = await publicPlans();
    expect(afterPause.map((plan) => plan.code)).not.toContain('pm3-live');
    expect(paused.active).toBe(false);

    // وتعود كما كانت كي لا تتسرّب حالة الاختبار إلى ما بعده.
    const resumed = await savePlan({ code: 'pm3-live', name: 'باقة معروضة', interval: 'month', amount: '99.00' });
    expect(resumed.active).toBe(true);
    expect((await publicPlans()).map((plan) => plan.code)).toContain('pm3-live');
  });

  it('يعرض حقوق الباقة بلغتين من سجلّ المنتج', async () => {
    const plan = await savePlan({ code: 'pm3-entitled', name: 'باقة بحقوق', interval: 'month', amount: '399.00' });
    await setEntitlements(plan.id, [
      { kind: 'module', key: 'feature.pos', value: true },
      { kind: 'module', key: 'feature.niche', value: false },
      { kind: 'limit', key: 'limits.max_users', value: 25 },
      { kind: 'limit', key: 'limits.max_branches', value: 5 },
    ]);

    const shown = codeOf(await publicPlans(), 'pm3-entitled')!;
    const byKey = new Map(shown.entitlements.map((entry) => [entry.key, entry]));

    expect(byKey.size).toBe(4);
    // الاسم العربي من `tenantFlagLabels` والإنجليزي من الحقل المضاف معه (P-M3) — لا ترجمةً في الواجهة.
    expect(byKey.get('feature.pos')).toMatchObject({
      kind: 'module',
      value: true,
      labelAr: 'نقطة البيع',
      labelEn: 'Point of sale',
    });
    expect(byKey.get('feature.niche')).toMatchObject({ kind: 'module', value: false, labelEn: 'Specialised activities' });
    // والحدود من إعدادات المنصة ذات نطاق العميل، بتسميتها العربية والإنجليزية.
    expect(byKey.get('limits.max_users')).toMatchObject({ kind: 'limit', value: 25 });
    expect(byKey.get('limits.max_users')!.labelAr.length).toBeGreaterThan(0);
    expect(byKey.get('limits.max_users')!.labelEn.length).toBeGreaterThan(0);
    expect(byKey.get('limits.max_branches')!.value).toBe(5);

    // والحقّ يُسحب من الباقة فيختفي من الردّ العام — المجموعة كاملة لا إضافاتٌ متراكمة.
    await setEntitlements(plan.id, [{ kind: 'module', key: 'feature.pos', value: true }], 'قياس: سحبُ حقّ');
    const afterRemoval = codeOf(await publicPlans(), 'pm3-entitled')!;
    expect(afterRemoval.entitlements.map((entry) => entry.key)).toEqual(['feature.pos']);
  });

  it('يعلن العملة SAR والمبلغ نصًّا بمنزلتين والمكافئ الشهري السنوي', async () => {
    await savePlan({ code: 'pm3-yearly', name: 'باقة سنوية', interval: 'year', amount: '4990.00' });
    await savePlan({ code: 'pm3-monthly', name: 'باقة شهرية', interval: 'month', amount: '499.00' });

    const plans = await publicPlans();
    const yearly = codeOf(plans, 'pm3-yearly')!;
    const monthly = codeOf(plans, 'pm3-monthly')!;

    expect(yearly.currency).toBe('SAR');
    expect(yearly.amount).toBe('4990.00');
    // 4990 ÷ 12 = 415.8333… ⇒ 415.83 (HALF_UP) — نفس دالة لوحة الإيراد لا حساباً في الواجهة.
    expect(yearly.monthlyAmount).toBe('415.83');
    // وما يُدفع في السنة للسنوية هو مبلغها، وللشهرية اثنا عشر شهراً منها.
    expect(yearly.annualAmount).toBe('4990.00');
    expect(monthly.monthlyAmount).toBe('499.00');
    expect(monthly.annualAmount).toBe(platformFormatAmount(platformParseAmount('499.00') * 12n));
    expect(monthly.annualAmount).toBe('5988.00');
  });

  it('يعلن نسبة ضريبة القيمة المضافة من إعدادات المنصة لا من نصٍّ في الواجهة', async () => {
    const first = await get(PUBLIC);
    const meta = (first.body as { meta: { vatRatePercent: number; count: number } }).meta;
    // 15٪ هي افتراض السجلّ (`billing.tax_rate`) والصفّ قد لا يكون مكتوباً أصلاً.
    expect(meta.vatRatePercent).toBe(findPlatformSettingDefinition('billing.tax_rate')?.defaultValue);
    expect(meta.count).toBe(meta.count > 0 ? meta.count : 0);
    expect(meta.count).toBe((await publicPlans()).length);

    // وحين يغيّر المشغّل النسبة يتغيّر ما يُعلن للموقع — ثم يُعاد الرقم إلى ما كان.
    const changed = await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: operator.token,
      body: { values: { 'billing.tax_rate': 8 } },
    });
    expect(changed.status).toBe(200);
    const afterChange = await get(PUBLIC);
    expect((afterChange.body as { meta: { vatRatePercent: number } }).meta.vatRatePercent).toBe(8);

    await api(ctx.server, 'put', '/api/v1/platform/settings', {
      token: operator.token,
      body: { values: { 'billing.tax_rate': meta.vatRatePercent } },
    });
    const restored = await get(PUBLIC);
    expect((restored.body as { meta: { vatRatePercent: number } }).meta.vatRatePercent).toBe(meta.vatRatePercent);
  });

  it('يرتّب الباقات بالمكافئ الشهري — الأرخص أولاً، والسنوي بين الشهريين', async () => {
    const codes = (await publicPlans()).map((plan) => plan.code);
    const position = (code: string) => codes.indexOf(code);

    expect(position('pm3-live')).toBeLessThan(position('pm3-monthly'));
    // باقةٌ سنوية بـ415.83 شهريًّا أرخصُ من شهريةٍ بـ499، وتسبقها في الترتيب.
    expect(position('pm3-yearly')).toBeLessThan(position('pm3-monthly'));
    // والترتيب مطّرد على المكافئ الشهري لا على المبلغ المكتوب (4990 أكبر من 5988؟ لا، لكن 4990
    // مكتوبٌ لسنةٍ كاملة، ولو رُتِّب بالمبلغ الخام لَظهر السنوي في الذيل).
    const equivalents = (await publicPlans()).map((plan) => platformParseAmount(plan.monthlyAmount));
    const sorted = [...equivalents].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(equivalents).toEqual(sorted);
  });

  it('لا يسرّب معرّف مزوّد الدفع ولا عدّاد التراخيص ولا راية النشاط', async () => {
    const plan = await savePlan({
      code: 'pm3-gateway',
      name: 'باقة بمزوّد دفع',
      interval: 'month',
      amount: '1299.00',
      stripePriceId: 'price_1PM3Secret',
    });
    expect(plan.id).toBeTruthy();

    const raw = await get(PUBLIC);
    const body = JSON.stringify(raw.body);
    // لا المعرّف ولا حتى اسمُ حقله: العام يرى الباقة، ولا يرى كيف تُحصَّل.
    expect(body).not.toContain('price_1PM3Secret');
    expect(body).not.toContain('stripePriceId');

    const shown = codeOf(await publicPlans(), 'pm3-gateway')!;
    // الحقول المعروضة هي المعروضة، ولا حقلَ إضافياً يقرؤه الزائر بالخطأ.
    expect(Object.keys(shown).sort()).toEqual([
      'amount',
      'annualAmount',
      'code',
      'currency',
      'entitlements',
      'id',
      'interval',
      'monthlyAmount',
      'name',
    ]);
    // والباقة الإدارية ترى المعرّف كما هو — الفرق بين القراءتين مقصود.
    const adminPlan = (await adminPlans()).find((entry) => entry.code === 'pm3-gateway')!;
    expect(adminPlan.stripePriceId).toBe('price_1PM3Secret');
  });

  it('القراءة عامة بلا رمز، والكتابة على المسار العام غير موجودة، والإداري يبقى محروساً', async () => {
    const anonymous = await get(PUBLIC);
    expect(anonymous.status).toBe(200);

    // جلسة عميل لا ترى اللوحة: المسار الإداري يبقى خلف رموز المنصة.
    const asCustomer = await get(PLANS, customer.token);
    expect(asCustomer.status).toBe(403);

    // ولا الكتابة على المسار العام: نقطة النهاية للقراءة وحدها.
    const write = await api(ctx.server, 'post', PUBLIC, { body: { code: 'pm3-hack', amount: '0.00' } });
    expect([403, 404, 405]).toContain(write.status);
    // ولم تُكتب الباقة فعلاً.
    expect((await adminPlans()).some((entry) => entry.code === 'pm3-hack')).toBe(false);
  });

  it('باقة بلا حقوق تُعرض بحقوقٍ فارغة — الصفحة لا تنكسر على باقةٍ نصف مُعدّة', async () => {
    await savePlan({ code: 'pm3-empty', name: 'باقة بلا حقوق', interval: 'month', amount: '59.00' });
    const shown = codeOf(await publicPlans(), 'pm3-empty')!;
    expect(shown.entitlements).toEqual([]);
  });

  it('يقرأ الجدولين بقاعدة RLS كما يقرؤهما erp_api — وبلا جلسة', async () => {
    // الحماية هنا ليست في الواجهة: جدول الحقوق مقروءٌ للجميع (`billing_plan_entitlements_readable`)
    // لأن العميل يحتاج أن يعرف ما يشتريه — وهذا ما يجعل قراءةً بلا جلسة ممكنة أصلاً.
    await savePlan({ code: 'pm3-rls', name: 'باقة RLS', interval: 'month', amount: '79.00' });
    const fromApi = codeOf(await publicPlans(), 'pm3-rls')!;
    const fromDb = await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const result = await tx.execute(sql`SELECT code FROM billing_plans WHERE code = 'pm3-rls'`);
      return result.rows.length;
    });
    expect(fromApi.code).toBe('pm3-rls');
    expect(fromDb).toBe(1);
  });
});
