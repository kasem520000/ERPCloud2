import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  analyticsExportColumns,
  usageMetricRegistry,
  type AnalyticsCohorts,
  type AnalyticsFunnel,
  type AnalyticsOverview,
  type PlatformPlan,
  type PlatformRevenue,
  type PlatformSubscription,
} from '@erp/contracts';
import { auditLog, newId, withPlatformAdminTx } from '@erp/database';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C12 — «التحليلات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الخطة تطلب ثمانية اختبارات على الأقل؛ هذا الملف يقيس ما يُفسد تقريراً لا ما يُجمّله:
 *
 * 1. **الرقم يخالف السطح الآخر** — `mrr` و`arr` هنا يجب أن يطابقا `/platform/revenue` حرفاً
 *    بحرف: تعريفٌ واحد للإيراد، فلو اختلفا فثمّ حسابٌ ثانٍ تسلّل إلى الوحدة.
 * 2. **القمع يكذب** — الخطوات مرتّبة متناقصة أبداً، والخطوة الأولى بلا «نسبة من السابقة»،
 *    والزمن يُقاس من التسجيل (وسيط ومئين 90) لا يُهمَل.
 * 3. **التسرّب بوجهٍ واحد** — بالشعارات وبالمال، ولكلٍّ مقامه؛ وإلغاءٌ واحد يجب أن يظهر في
 *    الاثنين (عدداً وقيمة).
 * 4. **الفوج يخلط «متعاقد» بـ«مستخدِم»** — الخليّة تحمل الرقمين، وكلاهما لا يتجاوز حجم الفوج.
 * 5. **التنبيه بلا مصدر أو بلا وجهة** — كل نوعٍ له مصدرٌ في القاعدة (عميلٌ لم يُفعَّل بعد 30
 *    يوماً · رخيصٌ صامت · ويب هوك يفشل) وكل تنبيهٍ له مسارٌ في اللوحة، ولا تنبيه بعدد صفر.
 * 6. **الملف يخالف عقده** — سطر ترويسة الـCSV يُقارَن حرفاً بحرف بـ`analyticsExportColumns`.
 * 7. **القراءة تكتب** — نداءُ نظرةٍ عامة لا يُنشئ صف تدقيق، فالوحدة كلها `GET`.
 *
 * والبيانات المزروعة نوعان، وهذا مقصود: **التراخيص عبر الـAPI الحقيقي** (P-C4) لأن مسار
 * التفعيل والتجربة والإلغاء هو ما تُقاس عليه الأرقام، و**الفاتورة المرحَّلة قيدٌ مباشر** لأن
 * أسئلة هذا الجزء قراءةٌ لا ترحيل (ترحيل الفاتورة نفسها مقيسٌ في سبيك المبيعات): ما يهمّنا
 * هنا أن `sales_invoices.posted_at` و`zatca_status` يُقرآن صحيحاً.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform analytics (P-C12)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let support: Actor;
  let customer: Actor;

  const OVERVIEW = '/api/v1/platform/analytics/overview';
  const FUNNEL = '/api/v1/platform/analytics/funnel';
  const COHORTS = '/api/v1/platform/analytics/cohorts';
  const EXPORT = '/api/v1/platform/analytics/export.csv';
  const PLANS = '/api/v1/platform/plans';
  const SUBSCRIPTIONS = '/api/v1/platform/subscriptions';

  const monthly = { id: '', code: 'pc12-monthly', amount: '199.00' };
  const annual = { id: '', code: 'pc12-annual', amount: '4990.00' };

  const asOwner = (method: 'get' | 'post', path: string, body?: unknown) =>
    api(ctx.server, method, path, { token: owner.token, ...(body === undefined ? {} : { body }) });

  /** ترخيصٌ حقيقي عبر P-C4 — بلا كتابة مستقلّة في جدول التراخيص. */
  const grant = async (tenantId: string, planId: string, extra: Record<string, unknown> = {}) => {
    const response = await asOwner('post', SUBSCRIPTIONS, { tenantId, planId, months: 12, ...extra });
    expect(response.status).toBe(201);
    return response.body.data as PlatformSubscription;
  };

  /** فرعٌ وفاتورة مبيعاتٍ مرحَّلة — قيدٌ مباشر يشرحه رأس الملف. */
  const seedPostedInvoice = async (
    tenantId: string,
    options: { daysAgo: number; zatca: 'reported' | null; number: string },
  ) => {
    await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      // الفرع الافتراضي يُنشئه تجهيز المنشأة أصلاً، وفرعان افتراضيان ممنوعان بفهرسٍ فريد —
      // فالحاصل يُعاد استعماله، ويُنشأ فرعٌ غير افتراضي فقط عند غيابه.
      const existing = (
        await tx.execute(sql`SELECT id FROM branches WHERE tenant_id = ${tenantId}::uuid LIMIT 1`)
      ).rows as Array<{ id: string }>;
      const [branch] =
        existing.length > 0
          ? existing
          : ((
              await tx.execute(sql`
                INSERT INTO branches (id, tenant_id, code, name_ar, is_default)
                VALUES (${newId()}, ${tenantId}::uuid, ${'b-' + options.number}, ${'فرع ' + options.number}, false)
                RETURNING id
              `)
            ).rows as Array<{ id: string }>);
      await tx.execute(sql`
        INSERT INTO sales_invoices (id, tenant_id, branch_id, kind, status, number, currency,
                                    subtotal, tax_total, total, posted_at, zatca_status)
        VALUES (${newId()}, ${tenantId}::uuid, ${branch!.id}::uuid, 'sale', 'posted', ${options.number}, 'SAR',
                100, 15, 115, now() - make_interval(days => ${options.daysAgo}::int), ${options.zatca})
      `);
    });
  };

  const auditCount = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.select({ id: auditLog.id }).from(auditLog),
    ).then((rows) => rows.length);

  beforeAll(async () => {
    ctx = await createTestApp('platform-analytics');

    owner = await createOperator(ctx, {
      tenantCode: 'analytics-ops',
      email: 'owner@analytics-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: 'analytics-ops',
      tenantId: owner.tenantId,
      email: 'operations@analytics-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_operations'],
    });
    support = await createOperator(ctx, {
      tenantCode: 'analytics-ops',
      tenantId: owner.tenantId,
      email: 'support@analytics-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });

    customer = await createActor(ctx, {
      tenantCode: 'pc12-cust',
      tenantName: 'شركة العملاء',
      email: 'owner@pc12-cust.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });

    for (const plan of [monthly, annual]) {
      const created = await asOwner('post', PLANS, {
        code: plan.code,
        name: `باقة ${plan.code}`,
        interval: plan === annual ? 'year' : 'month',
        amount: plan.amount,
        currency: 'SAR',
      });
      expect(created.status).toBe(201);
      plan.id = (created.body.data as PlatformPlan).id;
    }

    // ألفا: متعاقدة ونشطة (فاتورة + مستند زاتكا) · دلتا: متعاقدة صامتة بلا فاتورة.
    await grant(customer.tenantId, monthly.id);
    const delta = await createActor(ctx, {
      tenantCode: 'pc12-delta',
      tenantName: 'شركة دلتا',
      email: 'owner@pc12-delta.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    await grant(delta.tenantId, monthly.id);

    // بيتا: تجربةٌ لم تُحوَّل بعد.
    const beta = await createActor(ctx, {
      tenantCode: 'pc12-beta',
      tenantName: 'شركة بيتا',
      email: 'owner@pc12-beta.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    await grant(beta.tenantId, annual.id, { trialDays: 5 });

    // غاما: سُجّلت قبل ثلاثين يوماً ولم تُفعَّل (تنبيه «منشأة بلا ترخيص»).
    const gamma = await createActor(ctx, {
      tenantCode: 'pc12-gamma',
      tenantName: 'شركة غاما',
      email: 'owner@pc12-gamma.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`UPDATE tenants SET created_at = now() - interval '30 days' WHERE id = ${gamma.tenantId}::uuid`),
    );

    // إبسيلون: ترخيصٌ أُلغي هذا الشهر (تسرّبٌ بالشعارات وبالمال معاً).
    const epsilon = await createActor(ctx, {
      tenantCode: 'pc12-epsilon',
      tenantName: 'شركة إبسيلون',
      email: 'owner@pc12-epsilon.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    const epsilonSubscription = await grant(epsilon.tenantId, monthly.id);
    const canceled = await asOwner('post', `${SUBSCRIPTIONS}/${epsilonSubscription.id}/cancel`, {
      reason: 'لم يُكمل الدفع',
    });
    // الإلغاء فعلٌ على موردٍ قائم لا إنشاء ⇒ 200 لا 201.
    expect(canceled.status).toBe(200);

    // زيتا: ترخيصٌ بدأ الشهر الماضي وأُلغي الآن — تسرّبٌ له **مقام** (فلا نسبة من صفر).
    const zeta = await createActor(ctx, {
      tenantCode: 'pc12-zeta',
      tenantName: 'شركة زيتا',
      email: 'owner@pc12-zeta.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    const zetaSubscription = await grant(zeta.tenantId, monthly.id);
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(
        sql`UPDATE tenant_subscriptions SET activated_at = now() - interval '45 days' WHERE id = ${zetaSubscription.id}::uuid`,
      ),
    );
    const zetaCanceled = await asOwner('post', `${SUBSCRIPTIONS}/${zetaSubscription.id}/cancel`, {
      reason: 'انتقل إلى منافس',
    });
    expect(zetaCanceled.status).toBe(200);

    await seedPostedInvoice(customer.tenantId, { daysAgo: 2, zatca: 'reported', number: 'PC12-1' });
    await seedPostedInvoice(customer.tenantId, { daysAgo: 40, zatca: 'reported', number: 'PC12-2' });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------ الأبواب

  it('opens for the owner and the operator, and refuses support, customers and strangers', async () => {
    const asOwnerCall = await asOwner('get', OVERVIEW);
    expect(asOwnerCall.status).toBe(200);
    expect((asOwnerCall.body.data as AnalyticsOverview).definitions.mrr).toContain('المكافئ الشهري');

    const asOperator = await api(ctx.server, 'get', OVERVIEW, { token: operations.token });
    expect(asOperator.status).toBe(200);

    // الدعم يقرأ التذاكر لا الإيراد: الرمز `console.analytics.view` ليس له.
    const asSupport = await api(ctx.server, 'get', OVERVIEW, { token: support.token });
    expect(asSupport.status).toBe(403);

    const asCustomer = await api(ctx.server, 'get', OVERVIEW, { token: customer.token });
    expect(asCustomer.status).toBe(403);

    const anonymous = await api(ctx.server, 'get', OVERVIEW);
    expect(anonymous.status).toBe(401);
  });

  // ------------------------------------------------------------------ الإيراد

  it('mirrors the billing revenue board — one definition of MRR and ARR', async () => {
    const overview = (await asOwner('get', OVERVIEW)).body.data as AnalyticsOverview;
    const revenueCall = await asOwner('get', '/api/v1/platform/revenue');
    expect(revenueCall.status).toBe(200);
    const revenue = revenueCall.body.data as PlatformRevenue;

    expect(overview.mrr).toBe(revenue.mrr);
    expect(overview.arr).toBe(revenue.arr);
    expect(overview.currency).toBe(revenue.currency);
    expect(overview.counts.active).toBe(revenue.counts.active);
    expect(overview.counts.trialing).toBe(revenue.counts.trialing);
    expect(overview.collection.outstanding).toBe(revenue.outstanding);

    // والترخيص الشهري 199 مع ترخيصٍ حيّ ⇒ الإيراد ليس صفراً، وARR = 12 × MRR.
    expect(Number(overview.mrr)).toBeGreaterThan(0);
    expect(overview.arr).toBe((Number(overview.mrr) * 12).toFixed(2));
    expect(overview.arpu).not.toBe('0.00');
    expect(overview.definitions.churn).toContain('بالشعارات');
  });

  it('counts tenants and growth from the tenants table itself', async () => {
    const overview = (await asOwner('get', OVERVIEW)).body.data as AnalyticsOverview;
    const tenants = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS count FROM tenants`),
    );
    // الاسم يتجنّب مفردات المال عمداً: قاعدة eslint تصطاد المعرّفات المسمّاة بها حتى في
    // العدّ — وهو محقّ، فعدد المنشآت ليس مبلغاً.
    const tenantCount = (tenants.rows[0] as { count: number }).count;

    expect(overview.counts.total).toBe(tenantCount);
    // سبع منشآت على الأقل في هذا السبيك، وواحدة منها (غاما) أُرجِع تاريخ تسجيلها 30 يوماً
    // عمداً — فحدّ الشهر يُقاس: هي في الإجمالي ولا تُحتسب نموّاً لهذا الشهر.
    expect(overview.counts.total).toBeGreaterThanOrEqual(7);
    expect(overview.growth.newThisMonth).toBeGreaterThanOrEqual(5);
    expect(overview.growth.newThisMonth).toBeLessThan(overview.counts.total);
    expect(overview.growth.netThisMonth).toBe(overview.growth.newThisMonth - overview.growth.churnedThisMonth);
  });

  // ------------------------------------------------------------------ التسرّب

  it('measures churn twice — logos and money — and both see the same cancellation', async () => {
    const overview = (await asOwner('get', OVERVIEW)).body.data as AnalyticsOverview;
    const points = overview.churn.points;
    expect(points.length).toBe(overview.churn.windowMonths);

    const current = points.at(-1)!;
    expect(current.churnedCount).toBeGreaterThanOrEqual(2);
    expect(Number(current.churnedValue)).toBeGreaterThan(0);
    // ومقامٌ حقيقي: ترخيصٌ بدأ الشهر الماضي وأُلغي الآن ⇒ النسبة ليست `null`.
    expect(current.baseCount).toBeGreaterThanOrEqual(1);
    expect(current.logoRate).not.toBeNull();
    expect(current.logoRate!).toBeGreaterThan(0);
    expect(current.revenueRate).not.toBeNull();
    expect(current.revenueRate!).toBeGreaterThan(0);
    // وشهرٌ لم يكن فيه متعاقدون أصلاً يعطي `null` لا صفراً — والمثال في أقدم نقطةٍ بالنافذة.
    expect(points[0]!.baseCount).toBe(0);
    expect(points[0]!.logoRate).toBeNull();
    expect(points[0]!.revenueRate).toBeNull();

    // والقيمة تُقرأ من نفس المنحنى: الساقط في الشهر الجاري يظهر في `mrrSeries` كذلك.
    const series = overview.mrrSeries.at(-1)!;
    expect(Number(series.churnedValue)).toBeGreaterThan(0);
    expect(series.churnedValue).toBe(current.churnedValue);
    // و`mrr` القائم في الشهر الجاري يطابق لوحة الإيراد — لا منحنى بمعزلٍ عن التعريف.
    expect(series.mrr).toBe(overview.mrr);
  });

  // ------------------------------------------------------------------ القمع

  it('walks the activation funnel in order, monotonic, with medians from signup', async () => {
    const funnelCall = await asOwner('get', FUNNEL);
    expect(funnelCall.status).toBe(200);
    const funnel = funnelCall.body.data as AnalyticsFunnel;

    expect(funnel.rows.map((row) => row.step)).toEqual([
      'signed_up',
      'activated',
      'first_invoice',
      'first_einvoice',
    ]);
    expect(funnel.rows[0]!.conversionFromPrevious).toBeNull();
    expect(funnel.rows[0]!.tenants).toBeGreaterThanOrEqual(6);

    for (let index = 1; index < funnel.rows.length; index += 1) {
      expect(funnel.rows[index]!.tenants).toBeLessThanOrEqual(funnel.rows[index - 1]!.tenants);
      expect(funnel.rows[index]!.conversionFromPrevious).not.toBeNull();
    }

    // الخطوات الأربع كلها مأهولة في هذا السبيك: تفعيل · فاتورة · زاتكا.
    const activated = funnel.rows[1]!;
    const invoiced = funnel.rows[2]!;
    const einvoiced = funnel.rows[3]!;
    expect(activated.tenants).toBeGreaterThanOrEqual(3);
    expect(invoiced.tenants).toBeGreaterThanOrEqual(1);
    expect(einvoiced.tenants).toBeGreaterThanOrEqual(1);
    expect(invoiced.tenants).toBeLessThanOrEqual(einvoiced.tenants + 1);
    expect(activated.medianDaysFromSignup).not.toBeNull();
    expect(activated.p90DaysFromSignup!).toBeGreaterThanOrEqual(activated.medianDaysFromSignup!);

    // ونافذةٌ ضيّقة تحجب من سُجّل قبلها — والعدّ يتغيّر معها.
    const narrowCall = await asOwner('get', `${FUNNEL}?days=30`);
    expect(narrowCall.status).toBe(200);
    const narrow = narrowCall.body.data as AnalyticsFunnel;
    expect(narrow.windowDays).toBe(30);
    expect(narrow.rows[0]!.tenants).toBeLessThan(funnel.rows[0]!.tenants);
  });

  // ------------------------------------------------------------------ الأفواج

  it('keeps contracted and active apart in every cohort cell', async () => {
    const cohortCall = await asOwner('get', `${COHORTS}?months=3`);
    expect(cohortCall.status).toBe(200);
    const cohorts = cohortCall.body.data as AnalyticsCohorts;

    expect(cohorts.basis).toBe('signup');
    expect(cohorts.rows).toHaveLength(3);
    expect(cohorts.rows.map((row) => row.cells.length)).toEqual([3, 2, 1]);
    expect(cohorts.rows.every((row) => row.cells[0]!.offset === 0)).toBe(true);

    for (const row of cohorts.rows) {
      for (const cell of row.cells) {
        expect(cell.size).toBe(row.size);
        expect(cell.contracted).toBeLessThanOrEqual(cell.size);
        expect(cell.active).toBeLessThanOrEqual(cell.size);
        expect(cell.activeRate).toBeLessThanOrEqual(100);
      }
    }

    // الشهر الجاري: عميلٌ له فاتورة مرحَّلة ⇒ «استعمل» أكبر من صفر، وفوجه هو فوج التسجيل.
    const currentMonth = cohorts.rows.at(-1)!;
    expect(currentMonth.size).toBeGreaterThanOrEqual(5);
    expect(currentMonth.cells[0]!.active).toBeGreaterThanOrEqual(1);

    // وفوج التفعيل يُقاس من تاريخ التفعيل لا التسجيل — ويظهر بالوسم نفسه.
    const activation = (await asOwner('get', `${COHORTS}?basis=activation`)).body.data as AnalyticsCohorts;
    expect(activation.basis).toBe('activation');
    expect(activation.rows.reduce((sum, row) => sum + row.cells[0]!.active, 0)).toBeGreaterThanOrEqual(1);
  });

  // ------------------------------------------------------------------ الاستخدام والتنبيهات

  it('reads usage per plan from the usage grid, with eight metrics per plan', async () => {
    const overview = (await asOwner('get', OVERVIEW)).body.data as AnalyticsOverview;
    expect(overview.usageByPlan.length).toBeGreaterThanOrEqual(1);

    for (const group of overview.usageByPlan) {
      expect(group.metrics.map((metric) => metric.metric)).toEqual(
        usageMetricRegistry.map((metric) => metric.key),
      );
      for (const metric of group.metrics) {
        expect(metric.peak).toBeGreaterThanOrEqual(0);
        // بلا حدٍّ مُطبَّق: `limit` و`utilization` يصرّحان بذلك (`null`) ولا يدّعيان سقفاً.
        if (metric.limit === null) expect(metric.utilization).toBeNull();
      }
    }

    const monthlyGroup = overview.usageByPlan.find((group) => group.planCode === monthly.code);
    expect(monthlyGroup?.planName).toBe(`باقة ${monthly.code}`);
    // ولا شرطَ اشتراكٍ إلزامياً: منشأةٌ بلا ترخيص تظهر في مجموعة «بلا باقة» لا تُسقط من التقرير.
    const tenantsInPlans = overview.usageByPlan.reduce((sum, group) => sum + group.tenants, 0);
    expect(tenantsInPlans).toBeGreaterThanOrEqual(overview.counts.total - 1);
  });

  it('raises only sourced, addressed and non-empty alerts', async () => {
    const overview = (await asOwner('get', OVERVIEW)).body.data as AnalyticsOverview;
    const alerts = overview.alerts;

    expect(alerts.every((alert) => alert.count > 0)).toBe(true);
    expect(overview.trials.endingInSevenDays).toBeGreaterThanOrEqual(1);
    expect(new Set(alerts.map((alert) => alert.kind)).size).toBe(alerts.length);
    expect(alerts.every((alert) => alert.href.startsWith('/'))).toBe(true);
    expect(alerts.every((alert) => alert.examples.length <= 5)).toBe(true);
    expect(alerts.every((alert) => alert.examples.length === Math.min(alert.count, 5))).toBe(true);

    const neverActivated = alerts.find((alert) => alert.kind === 'never_activated');
    expect(neverActivated?.examples.map((example) => example.label)).toContain('شركة غاما');

    const silent = alerts.find((alert) => alert.kind === 'silent_tenant');
    expect(silent?.examples.map((example) => example.label)).toContain('شركة دلتا');

    // والتجربة القائمة لها مسار متابعة، لا رقمٌ في جدول.
    expect(alerts.find((alert) => alert.kind === 'trial_ending')?.href).toBe('/tenants');
  });

  // ------------------------------------------------------------------ الملف

  it('writes a CSV whose header is exactly the contract columns, one line per tenant', async () => {
    const exported = await asOwner('get', `${EXPORT}?days=30`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');

    const lines = exported.text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
    expect(lines[0]!.startsWith('# platform analytics export')).toBe(true);
    expect(lines[1]).toBe(analyticsExportColumns.join(','));

    const tenants = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS count FROM tenants`),
    );
    expect(lines.length).toBe(2 + (tenants.rows[0] as { count: number }).count);

    // وسطر العميل يحمل معرّفه واسمه العربي ومفتاح باقةٍ حقيقياً.
    const row = lines.find((line) => line.startsWith('pc12-cust,'))!;
    expect(row).toContain('شركة العملاء');
    expect(row).toContain(monthly.code);
  });

  // ------------------------------------------------------------------ الحدود والقراءة

  it('refuses windows outside the contract and never writes a row', async () => {
    expect((await asOwner('get', `${OVERVIEW}?months=2`)).status).toBe(400);
    expect((await asOwner('get', `${OVERVIEW}?months=25`)).status).toBe(400);
    expect((await asOwner('get', `${FUNNEL}?days=6`)).status).toBe(400);
    expect((await asOwner('get', `${FUNNEL}?days=400`)).status).toBe(400);
    expect((await asOwner('get', `${COHORTS}?basis=plan`)).status).toBe(400);
    expect((await asOwner('get', `${EXPORT}?days=0`)).status).toBe(400);

    const before = await auditCount();
    expect((await asOwner('get', OVERVIEW)).status).toBe(200);
    expect((await asOwner('get', COHORTS)).status).toBe(200);
    expect((await asOwner('get', EXPORT)).status).toBe(200);
    expect(await auditCount()).toBe(before);
  });
});
