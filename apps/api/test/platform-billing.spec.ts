import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  PLATFORM_DUNNING_MAX_ATTEMPTS,
  billingAuditActions,
  platformMonthlyAmount,
  type PlatformDunningRunResult,
  type PlatformInvoice,
  type PlatformInvoiceSummary,
  type PlatformPlan,
  type PlatformPlanChangeResult,
  type PlatformPlanEntitlement,
  type PlatformRevenue,
  type PlatformSubscription,
} from '@erp/contracts';
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
 * P-C4 — «الباقات والتراخيص والفوترة» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * The plan asks for proration, a balanced tax invoice, cancellation, dunning and preventing
 * double collection, in at least fourteen tests. This suite runs eighteen, built around the
 * five ways a billing surface goes wrong:
 *
 * 1. **The numbers do not reconcile** — `subtotal + tax = total`, the proration against the
 *    period it was computed from, and the printed page against the stored document.
 * 2. **A period is charged twice** — a second live licence on one customer, a second draft
 *    for the same period, a payment above what is left, or a collection on a paid invoice:
 *    each is refused by the API with a readable reason.
 * 3. **A number is silently burned** — a draft carries no number, issuing allocates the next
 *    one from the platform series, and voiding keeps it (an auditor reads the sequence).
 * 4. **The ladder is decorative** — dunning records one attempt per step, stops at the cap,
 *    and skips what is paid or not yet due.
 * 5. **It is not gated or not isolated** — plans, licences and documents sit behind three
 *    different platform codes, a tenant session is refused everywhere, and the new tables
 *    obey RLS at the database level.
 *
 * `ActorOptions` has no `platformRoles` field yet — narrowed here, as in the P-C2/P-C3 suites.
 */
type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform billing (P-C4)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let billing: Actor;
  let operations: Actor;
  let auditor: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let customerC: Actor;

  const PLANS = '/api/v1/platform/plans';
  const SUBSCRIPTIONS = '/api/v1/platform/subscriptions';
  const INVOICES = '/api/v1/platform/invoices';
  const DUNNING = '/api/v1/platform/dunning';
  const REVENUE = '/api/v1/platform/revenue';

  /** ثلاث باقات: شهرية رخيصة، شهرية غالية، وسنوية — لتغطية الترقية والتخفيض والتحويل. */
  const starter = { id: '', code: 'pc4-starter', amount: '199.00' };
  const pro = { id: '', code: 'pc4-pro', amount: '499.00' };
  const annual = { id: '', code: 'pc4-annual', amount: '4990.00' };

  const asOwner = (method: 'get' | 'post' | 'patch' | 'put', path: string, body?: unknown) =>
    api(ctx.server, method, path, { token: owner.token, ...(body === undefined ? {} : { body }) });

  const auditRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx
        .select({ action: auditLog.action, entity: auditLog.entity, entityId: auditLog.entityId, meta: auditLog.meta })
        .from(auditLog),
    );

  const createSubscription = async (tenantId: string, planId: string, extra: Record<string, unknown> = {}) => {
    const response = await asOwner('post', SUBSCRIPTIONS, { tenantId, planId, months: 1, ...extra });
    expect(response.status).toBe(201);
    return response.body.data as PlatformSubscription;
  };

  beforeAll(async () => {
    ctx = await createTestApp('platform-billing');

    owner = await createOperator(ctx, {
      tenantCode: 'billing-ops',
      email: 'owner@billing-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    billing = await createOperator(ctx, {
      tenantCode: 'billing-ops',
      tenantId: owner.tenantId,
      email: 'billing@billing-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_billing'],
    });
    operations = await createOperator(ctx, {
      tenantCode: 'billing-ops',
      tenantId: owner.tenantId,
      email: 'operations@billing-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'billing-ops',
      tenantId: owner.tenantId,
      email: 'auditor@billing-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });

    // Three customers, three independent billing histories — a shared tenant would make each
    // test depend on the order of the previous one.
    customerA = await createActor(ctx, {
      tenantCode: 'pc4-cust-a',
      tenantName: 'شركة الألف',
      email: 'owner@pc4-cust-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'pc4-cust-b',
      tenantName: 'شركة الباء',
      email: 'owner@pc4-cust-b.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerC = await createActor(ctx, {
      tenantCode: 'pc4-cust-c',
      tenantName: 'شركة الجيم',
      email: 'owner@pc4-cust-c.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });

    for (const plan of [starter, pro, annual]) {
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
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // ------------------------------------------------------------------ plans

  it('lists the plans with a monthly equivalent and the entitlement catalogue', async () => {
    const listed = await asOwner('get', PLANS);
    expect(listed.status).toBe(200);
    const plans = listed.body.data as PlatformPlan[];

    const monthlyPlan = plans.find((plan) => plan.id === starter.id)!;
    expect(monthlyPlan.amount).toBe('199.00');
    expect(monthlyPlan.monthlyAmount).toBe('199.00');
    expect(monthlyPlan.interval).toBe('month');

    // السعر السنوي يُقرأ شهرياً: 4990 ÷ 12 = 415.83 — أساس MRR، والحساب في العقد لا في الشاشة.
    const yearlyPlan = plans.find((plan) => plan.id === annual.id)!;
    expect(yearlyPlan.monthlyAmount).toBe(platformMonthlyAmount('4990.00', 'year'));
    expect(yearlyPlan.monthlyAmount).toBe('415.83');

    const keys = await asOwner('get', `${PLANS}/entitlement-keys`);
    expect(keys.status).toBe(200);
    const catalogue = keys.body.data as Array<{ key: string; labelAr: string; valueKind: string }>;
    expect(catalogue.map((entry) => entry.key)).toContain('feature.pos');
    expect(catalogue.map((entry) => entry.key)).toContain('limits.max_branches');
    // ولا يُقترح مفتاحٌ ليس حقًّا: إعدادات الهوية والشعار ليست بنوداً في قائمة أسعار.
    expect(catalogue.map((entry) => entry.key)).not.toContain('branding.logo_url');
    expect(catalogue.every((entry) => entry.labelAr.length > 0)).toBe(true);
  });

  it('saves a plan by code — creating once, updating after — and needs a reason to edit', async () => {
    const created = await asOwner('post', PLANS, {
      code: 'pc4-repeat',
      name: 'باقة تُكتب مرتين',
      interval: 'month',
      amount: '250.00',
      currency: 'SAR',
    });
    expect(created.status).toBe(201);
    const first = created.body.data as PlatformPlan;

    // «الحفظ بنفس الرمز يحدّث» — سلوك ما قبل P-C4 محفوظ، فلا تنشأ باقة مكرَّرة بالخطأ.
    const again = await asOwner('post', PLANS, {
      code: 'pc4-repeat',
      name: 'باقة تُكتب مرتين (محدَّثة)',
      interval: 'month',
      amount: '260.00',
      currency: 'SAR',
    });
    expect(again.status).toBe(201);
    const second = again.body.data as PlatformPlan;
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('باقة تُكتب مرتين (محدَّثة)');
    expect(second.amount).toBe('260.00');

    const noReason = await asOwner('patch', `${PLANS}/${first.id}`, { amount: '270.00' });
    expect(noReason.status).toBe(400);

    const patched = await asOwner('patch', `${PLANS}/${first.id}`, {
      amount: '275.00',
      active: false,
      reason: 'تسعير جديد وإيقاف البيع',
    });
    expect(patched.status).toBe(200);
    const after = patched.body.data as PlatformPlan;
    expect(after.amount).toBe('275.00');
    expect(after.active).toBe(false);

    const unknown = await asOwner('patch', `${PLANS}/00000000-0000-4000-8000-000000000000`, {
      amount: '1.00',
      reason: 'باقة ليست موجودة',
    });
    expect(unknown.status).toBe(404);

    const rows = (await auditRows()).filter((row) => row.entityId === first.id);
    const update = rows.find((row) => row.action === billingAuditActions.PLAN_UPDATE)!;
    expect(update).toBeDefined();
    // القرار يُقرأ بعد سنة: من غيّر السعر، وإلى أي سعر، ولماذا.
    expect((update.meta as Record<string, unknown>).reason).toBe('تسعير جديد وإيقاف البيع');
  });

  it('replaces a plan’s entitlements as one set and refuses what the product does not have', async () => {
    const written = await asOwner('put', `${PLANS}/${pro.id}/entitlements`, {
      entitlements: [
        { kind: 'module', key: 'feature.pos', value: true },
        { kind: 'limit', key: 'limits.max_branches', value: 5 },
      ],
      reason: 'الباقة الاحترافية تفتح نقطة البيع وخمسة فروع',
    });
    expect(written.status).toBe(200);
    let entitlements = (written.body.data as PlatformPlan).entitlements;
    expect(entitlements.map((entry) => entry.key).sort()).toEqual(['feature.pos', 'limits.max_branches']);
    const branchLimit = entitlements.find((entry) => entry.key === 'limits.max_branches') as PlatformPlanEntitlement;
    expect(branchLimit.value).toBe(5);
    expect(branchLimit.kind).toBe('limit');
    expect(branchLimit.registry).toBe('platform');
    // الاسم العربي يأتي من الفهرس: الشاشة لا تعرض `feature.pos` للعميل.
    expect(entitlements.every((entry) => entry.labelAr.length > 0)).toBe(true);

    // الاستبدال **مجموعةً كاملة**: ما يُحذف من القائمة يُحذف من الباقة.
    const trimmed = await asOwner('put', `${PLANS}/${pro.id}/entitlements`, {
      entitlements: [{ kind: 'module', key: 'feature.pos', value: true }],
      reason: 'حدّ الفروع صار في إعداد المنصة لا في الباقة',
    });
    expect(trimmed.status).toBe(200);
    entitlements = (trimmed.body.data as PlatformPlan).entitlements;
    expect(entitlements.map((entry) => entry.key)).toEqual(['feature.pos']);

    const unknownKey = await asOwner('put', `${PLANS}/${pro.id}/entitlements`, {
      entitlements: [{ kind: 'module', key: 'feature.telepathy', value: true }],
      reason: 'حقٌّ لا وجود له في المنتج',
    });
    expect(unknownKey.status).toBe(422);

    const wrongValue = await asOwner('put', `${PLANS}/${pro.id}/entitlements`, {
      entitlements: [{ kind: 'module', key: 'feature.pos', value: 'نعم' }],
      reason: 'راية بغير قيمة منطقية',
    });
    expect(wrongValue.status).toBe(422);

    const duplicate = await asOwner('put', `${PLANS}/${pro.id}/entitlements`, {
      entitlements: [
        { kind: 'module', key: 'feature.pos', value: true },
        { kind: 'limit', key: 'limits.max_branches', value: 3 },
        { kind: 'limit', key: 'limits.max_branches', value: 9 },
      ],
      reason: 'حدّ فروع مكرَّر بقيمتين',
    });
    expect(duplicate.status).toBe(422);

    const rows = (await auditRows()).filter((row) => row.action === billingAuditActions.PLAN_ENTITLEMENTS);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect((rows[0]?.meta as Record<string, unknown>).reason).toBeTruthy();
  });

  // ------------------------------------------------------------------ licences

  it('grants a trial whose paid period starts when the trial ends', async () => {
    const trial = await createSubscription(customerC.tenantId, starter.id, {
      months: 1,
      trialDays: 14,
      billingEmail: 'billing@pc4-cust-c.test',
    });
    expect(trial.status).toBe('trialing');
    expect(trial.trialEndsAt).not.toBeNull();
    expect(trial.activatedAt).toBeNull();
    expect(trial.billingEmail).toBe('billing@pc4-cust-c.test');
    // شهرٌ واحد يبدأ من نهاية التجربة: 14 يوماً هدية، ثم فترةٌ مدفوعة كاملة.
    const trialEnds = Date.parse(trial.trialEndsAt!) / 86_400_000;
    const periodStart = Date.parse(trial.currentPeriodStart!) / 86_400_000;
    const periodEnd = Date.parse(trial.currentPeriodEnd!) / 86_400_000;
    expect(Math.round(periodStart - trialEnds)).toBe(0);
    expect(periodEnd - periodStart).toBeGreaterThanOrEqual(28);
    expect(periodEnd - periodStart).toBeLessThanOrEqual(31);
  });

  it('keeps one live licence per customer — the previous one is retired, not deleted', async () => {
    const first = await createSubscription(customerA.tenantId, starter.id);
    expect(first.status).toBe('active');
    expect(first.activatedAt).not.toBeNull();

    const second = await createSubscription(customerA.tenantId, pro.id, { months: 3 });
    expect(second.status).toBe('active');
    expect(second.id).not.toBe(first.id);

    const live = await asOwner('get', `${SUBSCRIPTIONS}?status=active`);
    const mine = (live.body.data as PlatformSubscription[]).filter((row) => row.tenantId === customerA.tenantId);
    expect(mine.map((row) => row.id)).toEqual([second.id]);

    // والسابق محفوظ كملغى: تاريخ الفوترة لا يُمحى ليُرضي قيداً على الفهرس.
    const canceled = await asOwner('get', `${SUBSCRIPTIONS}?status=canceled`);
    const retired = (canceled.body.data as PlatformSubscription[]).find((row) => row.id === first.id)!;
    expect(retired).toBeDefined();
    expect(retired.canceledAt).not.toBeNull();
  });

  it('prorates an upgrade into a tax invoice that balances', async () => {
    const subscription = await createSubscription(customerB.tenantId, starter.id);

    const changed = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/change-plan`, {
      planId: pro.id,
      reason: 'ترقية إلى الباقة الاحترافية',
    });
    expect(changed.status).toBe(200);
    const result = changed.body.data as PlatformPlanChangeResult;

    // المدة كاملة والمتبقّي كلها: الرصيد = سعر الباقة القديمة، والمقابل = سعر الجديدة كاملاً.
    expect(result.proration.periodDays).toBe(result.proration.remainingDays);
    expect(result.proration.fromPlanCode).toBe(starter.code);
    expect(result.proration.toPlanCode).toBe(pro.code);
    expect(result.proration.credit).toBe('199.00');
    expect(result.proration.charge).toBe('499.00');
    expect(result.proration.net).toBe('300.00');
    expect(result.proration.currency).toBe('SAR');
    expect(result.subscription.planId).toBe(pro.id);
    expect(result.subscription.status).toBe('active');
    expect(result.invoiceKind).toBe('invoice');

    const invoice = await asOwner('get', `${INVOICES}/${result.invoiceId}`);
    expect(invoice.status).toBe(200);
    const document = invoice.body.data as PlatformInvoice;
    expect(document.kind).toBe('invoice');
    expect(document.status).toBe('draft');
    expect(document.number).toBeNull();
    expect(document.subtotal).toBe('300.00');
    expect(document.taxAmount).toBe('45.00');
    expect(document.total).toBe('345.00');
    expect(Number(document.subtotal) + Number(document.taxAmount)).toBe(Number(document.total));
    // سطران: مقابل الباقة الجديدة، ورصيد القديمة سالباً — ومجموعهما صافي الحساب.
    expect(document.lines.length).toBe(2);
    const net = document.lines.reduce((sum, line) => sum + Number(line.amount), 0);
    expect(net.toFixed(2)).toBe('300.00');
    expect(document.lines.some((line) => line.kind === 'proration' && Number(line.amount) < 0)).toBe(true);
    expect(document.buyerName).toBe('شركة الباء');

    // الفاتورة المسودّة لا تُحصَّل: المستند قبل الإصدار ليس مطالبة.
    const early = await asOwner('post', `${INVOICES}/${document.id}/pay`, { method: 'bank_transfer' });
    expect(early.status).toBe(422);
  });

  it('turns a downgrade into a credit note with its own series', async () => {
    const subscription = await createSubscription(customerC.tenantId, annual.id, { months: 12 });

    const changed = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/change-plan`, {
      planId: pro.id,
      reason: 'تخفيض من السنوية إلى الشهرية',
    });
    expect(changed.status).toBe(200);
    const result = changed.body.data as PlatformPlanChangeResult;
    expect(result.proration.credit).toBe('4990.00');
    expect(result.proration.charge).toBe('499.00');
    expect(result.proration.net).toBe('-4491.00');
    expect(result.invoiceKind).toBe('credit_note');

    const document = (await asOwner('get', `${INVOICES}/${result.invoiceId}`)).body.data as PlatformInvoice;
    expect(document.kind).toBe('credit_note');
    // الضريبة تتبع إشارة الصافي: إشعار دائن يخصم ضريبته، وإلا اختلّ الإقرار الضريبي.
    expect(document.subtotal).toBe('-4491.00');
    expect(document.taxAmount).toBe('-673.65');
    expect(document.total).toBe('-5164.65');

    const issued = await asOwner('post', `${INVOICES}/${document.id}/issue`, {});
    expect(issued.status).toBe(200);
    const numbered = issued.body.data as PlatformInvoice;
    // سلسلة خاصة بالإشعارات الدائنة: لا تختلط البيعة بعكسها في تسلسلٍ واحد.
    expect(numbered.number).toMatch(/^PCN-\d{5}$/);
  });

  it('refuses a pointless change and one whose plan does not exist', async () => {
    const subscription = await createSubscription(customerA.tenantId, pro.id);
    const same = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/change-plan`, {
      planId: pro.id,
      reason: 'نفس الباقة',
    });
    expect(same.status).toBe(422);
    expect(String(same.body.detail)).toContain('الباقة الحالية');

    const missing = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/change-plan`, {
      planId: '00000000-0000-4000-8000-000000000000',
      reason: 'باقة غير موجودة',
    });
    expect(missing.status).toBe(404);

    const noReason = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/change-plan`, { planId: annual.id });
    expect(noReason.status).toBe(400);
  });

  it('starts the paid period today when a trial changes plan — a trial holds no credit', async () => {
    const trial = await createSubscription(customerA.tenantId, starter.id, { months: 1, trialDays: 14 });
    expect(trial.status).toBe('trialing');

    const changed = await asOwner('post', `${SUBSCRIPTIONS}/${trial.id}/change-plan`, {
      planId: pro.id,
      reason: 'العميل قرّر الاشتراك مبكراً',
    });
    expect(changed.status).toBe(200);
    const result = changed.body.data as PlatformPlanChangeResult;
    // رصيدٌ من مدةٍ لم تُدفع؟ لا: التجربة هدية، والفترة الجديدة تبدأ اليوم بكامل سعرها.
    expect(result.proration.credit).toBe('0.00');
    expect(result.proration.remainingDays).toBe(0);
    expect(result.proration.charge).toBe('499.00');
    expect(result.proration.net).toBe('499.00');

    const document = (await asOwner('get', `${INVOICES}/${result.invoiceId}`)).body.data as PlatformInvoice;
    expect(document.lines.length).toBe(1);
    expect(document.subtotal).toBe('499.00');
    expect(document.taxAmount).toBe('74.85');
    expect(document.total).toBe('573.85');

    const after = await asOwner('get', `${SUBSCRIPTIONS}?status=active`);
    const live = (after.body.data as PlatformSubscription[]).find((row) => row.id === trial.id)!;
    expect(live.status).toBe('active');
    expect(Date.parse(live.currentPeriodStart!)).toBeLessThan(Date.parse(trial.trialEndsAt!));
  });

  // ------------------------------------------------------------------ lifecycle

  it('pauses and resumes, giving the paused days back to the paid period', async () => {
    const subscription = await createSubscription(customerB.tenantId, starter.id);
    const before = subscription.currentPeriodEnd!;

    const paused = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/pause`, {
      reason: 'العميل أوقف نشاطه مؤقتاً',
    });
    expect(paused.status).toBe(200);
    const afterPause = paused.body.data as PlatformSubscription;
    expect(afterPause.status).toBe('paused');
    expect(afterPause.pausedAt).not.toBeNull();

    // لا يُوقَف مرتين، ولا يُوقَف ما هو ملغى.
    const twice = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/pause`, { reason: 'إيقاف مكرَّر' });
    expect(twice.status).toBe(422);

    const resumed = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/resume`, {
      reason: 'عاد النشاط',
    });
    expect(resumed.status).toBe(200);
    const afterResume = resumed.body.data as PlatformSubscription;
    expect(afterResume.status).toBe('active');
    expect(afterResume.resumedAt).not.toBeNull();
    // الأيام التي توقّف فيها العميل تُعاد إلى نهاية المدة — أو يخسر ما دفع ثمنه.
    expect(Date.parse(afterResume.currentPeriodEnd!)).toBeGreaterThanOrEqual(Date.parse(before));

    const resumeAgain = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/resume`, { reason: 'استئناف بلا إيقاف' });
    expect(resumeAgain.status).toBe(422);
  });

  it('cancels at the end of the period or at once, with a written reason', async () => {
    const subscription = await createSubscription(customerB.tenantId, starter.id);

    const atEnd = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/cancel`, {
      reason: 'العميل لن يجدّد',
      atPeriodEnd: true,
    });
    expect(atEnd.status).toBe(200);
    const flagged = atEnd.body.data as PlatformSubscription;
    // إلغاءٌ مؤجّل لا يقطع خدمةً مدفوعة: العلامة تُقرأ، والحالة تبقى حيّة.
    expect(flagged.status).toBe('active');
    expect(flagged.cancelAtPeriodEnd).toBe(true);
    expect(flagged.canceledReason).toBe('العميل لن يجدّد');

    const now = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/cancel`, {
      reason: 'تعثّر السداد',
      atPeriodEnd: false,
    });
    expect(now.status).toBe(200);
    const canceled = now.body.data as PlatformSubscription;
    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).not.toBeNull();
    expect(canceled.cancelAtPeriodEnd).toBe(false);

    const again = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/cancel`, { reason: 'إلغاء مكرَّر' });
    expect(again.status).toBe(422);

    // ولا تُستأنف خدمة ملغاة.
    const resurrect = await asOwner('post', `${SUBSCRIPTIONS}/${subscription.id}/resume`, { reason: 'إحياء ترخيص' });
    expect(resurrect.status).toBe(422);

    const reasons = (await auditRows())
      .filter((row) => row.action === billingAuditActions.SUBSCRIPTION_CANCEL && row.entityId === subscription.id)
      .map((row) => (row.meta as Record<string, unknown>).reason);
    expect(reasons).toContain('العميل لن يجدّد');
  });

  // ------------------------------------------------------------------ invoices

  it('drafts a period invoice, then issues it with a sequential number and a due date', async () => {
    const subscription = await createSubscription(customerB.tenantId, starter.id);

    const draft = await asOwner('post', INVOICES, {
      subscriptionId: subscription.id,
      buyerTaxNumber: '300000000000003',
      note: 'اشتراك شهر',
      reason: 'فاتورة الشهر الجاري',
    });
    expect(draft.status).toBe(201);
    const document = draft.body.data as PlatformInvoice;
    expect(document.status).toBe('draft');
    expect(document.number).toBeNull();
    expect(document.subtotal).toBe('199.00');
    expect(document.taxAmount).toBe('29.85');
    expect(document.total).toBe('228.85');
    expect(document.buyerTaxNumber).toBe('300000000000003');
    expect(document.sellerName.length).toBeGreaterThan(0);
    // الرقم الضريبي للبائع يُنسخ على المستند من إعدادات المنصة لحظة الإنشاء.
    expect(document.sellerTaxNumber).toMatch(/^\d{15}$/);

    // مسودّة ثانية لنفس الفترة = مطالبة مزدوجة بالفاتورة نفسها.
    const duplicate = await asOwner('post', INVOICES, {
      subscriptionId: subscription.id,
      reason: 'نسخة ثانية من نفس الفاتورة',
    });
    expect(duplicate.status).toBe(422);

    const issued = await asOwner('post', `${INVOICES}/${document.id}/issue`, { dueInDays: 15 });
    expect(issued.status).toBe(200);
    const numbered = issued.body.data as PlatformInvoice;
    expect(numbered.number).toMatch(/^PINV-\d{5}$/);
    expect(numbered.status).toBe('issued');
    const days = (Date.parse(numbered.dueDate!) - Date.parse(numbered.issueDate!)) / 86_400_000;
    expect(days).toBe(15);

    const twice = await asOwner('post', `${INVOICES}/${document.id}/issue`, {});
    expect(twice.status).toBe(422);

    // التسلسل يُقرأ من المستند نفسه: الفاتورة التالية تأخذ الرقم التالي.
    const published = (await asOwner('get', `${INVOICES}?status=issued`)).body.data as PlatformInvoiceSummary[];
    const mine = published.find((row) => row.id === document.id)!;
    expect(mine.number).toBe(numbered.number);
  });

  it('takes the VAT rate and the payment terms from the platform settings', async () => {
    const subscription = await createSubscription(customerA.tenantId, starter.id);

    const lowered = await asOwner('put', '/api/v1/platform/settings', { values: { 'billing.tax_rate': 5, 'billing.payment_terms_days': 30 } });
    expect(lowered.status).toBe(200);
    try {
      const draft = await asOwner('post', INVOICES, {
        subscriptionId: subscription.id,
        reason: 'فاتورة بنسبة ضريبة مختلفة',
      });
      expect(draft.status).toBe(201);
      const document = draft.body.data as PlatformInvoice;
      expect(document.taxRate).toBe('5.00');
      expect(document.taxAmount).toBe('9.95');
      expect(document.total).toBe('208.95');

      const issued = await asOwner('post', `${INVOICES}/${document.id}/issue`, {});
      const documentIssued = issued.body.data as PlatformInvoice;
      // P-C8 (استدراك على P-C4): كان القياس `dueDate − Date.now()`، وهو يقيس جزءاً من يومٍ
      // لا عدد أيامٍ — فيسقط بعد الظهر بتوقيت UTC (‎29.4‎ يوماً تُقرَّب إلى 29). القياس
      // الصحيح هو الفرق بين تاريخين، كما في اختبار الإصدار أعلاه تماماً.
      const dueInDays =
        (Date.parse(documentIssued.dueDate!) - Date.parse(documentIssued.issueDate!)) / 86_400_000;
      expect(dueInDays).toBe(30);
    } finally {
      const restored = await asOwner('put', '/api/v1/platform/settings', {
        values: { 'billing.tax_rate': 15, 'billing.payment_terms_days': 14 },
      });
      expect(restored.status).toBe(200);
    }
  });

  it('prevents double collection: partial is allowed, above the remainder is not', async () => {
    const subscription = await createSubscription(customerC.tenantId, starter.id);
    const draft = await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة للتحصيل' });
    const document = draft.body.data as PlatformInvoice;
    const issued = await asOwner('post', `${INVOICES}/${document.id}/issue`, { dueInDays: 10 });
    const billed = Number((issued.body.data as PlatformInvoice).total);
    expect(billed).toBe(228.85);

    const partial = await asOwner('post', `${INVOICES}/${document.id}/pay`, {
      method: 'bank_transfer',
      amount: '100.00',
      reference: 'TRF-9001',
    });
    expect(partial.status).toBe(200);
    const half = partial.body.data as PlatformInvoice;
    expect(half.paidAmount).toBe('100.00');
    expect(half.remaining).toBe('128.85');
    expect(half.status).toBe('issued');
    expect(half.payments.length).toBe(1);
    expect(half.payments[0]?.reference).toBe('TRF-9001');

    // نفس التحويل البنكي مرة أخرى = تحصيل مزدوج: يُرفض، والمتبقّي يُعلَن في الردّ.
    const over = await asOwner('post', `${INVOICES}/${document.id}/pay`, {
      method: 'bank_transfer',
      amount: '200.00',
    });
    expect(over.status).toBe(422);
    expect(String(over.body.detail)).toContain('128.85');

    const settled = await asOwner('post', `${INVOICES}/${document.id}/pay`, { method: 'bank_transfer' });
    expect(settled.status).toBe(200);
    const paid = settled.body.data as PlatformInvoice;
    expect(paid.paidAmount).toBe('228.85');
    expect(paid.remaining).toBe('0.00');
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();

    const again = await asOwner('post', `${INVOICES}/${document.id}/pay`, { method: 'cash' });
    expect(again.status).toBe(422);
  });

  it('voids a draft or an issued document but never a paid one, and the number stays burned', async () => {
    const subscription = await createSubscription(customerA.tenantId, pro.id);

    const voidDraft = await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'مسودّة للإلغاء' });
    const draft = voidDraft.body.data as PlatformInvoice;
    const canceledDraft = await asOwner('post', `${INVOICES}/${draft.id}/void`, { reason: 'أُنشئت بالخطأ' });
    expect(canceledDraft.status).toBe(200);
    expect((canceledDraft.body.data as PlatformInvoice).status).toBe('void');
    expect((canceledDraft.body.data as PlatformInvoice).number).toBeNull();

    // ولا يُحصَّل ملغى.
    const collectVoid = await asOwner('post', `${INVOICES}/${draft.id}/pay`, { method: 'cash' });
    expect(collectVoid.status).toBe(422);

    const second = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة ثانية' }))
      .body.data as PlatformInvoice;
    const issued = (await asOwner('post', `${INVOICES}/${second.id}/issue`, {})).body.data as PlatformInvoice;
    const voided = await asOwner('post', `${INVOICES}/${second.id}/void`, { reason: 'أُلغيت بعد الإصدار' });
    expect(voided.status).toBe(200);
    const after = voided.body.data as PlatformInvoice;
    expect(after.status).toBe('void');
    expect(after.voidReason).toBe('أُلغيت بعد الإصدار');
    // الرقم يبقى على المستند: المدقق يقرأ التسلسل، والإلغاء ليس حذفاً.
    expect(after.number).toBe(issued.number);

    // ومدفوعة لا تُلغى — تُردّ. الإلغاء بعد التحصيل يمحو إيراداً وقع فعلاً.
    const third = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة ثالثة' }))
      .body.data as PlatformInvoice;
    await asOwner('post', `${INVOICES}/${third.id}/issue`, {});
    await asOwner('post', `${INVOICES}/${third.id}/pay`, { method: 'cash' });
    const refuse = await asOwner('post', `${INVOICES}/${third.id}/void`, { reason: 'إلغاء مدفوعة' });
    expect(refuse.status).toBe(422);
    expect(String(refuse.body.detail)).toContain('مدفوعة');
  });

  it('prints the document as a self-contained tax invoice', async () => {
    const subscription = await createSubscription(customerB.tenantId, annual.id, { months: 12 });
    const draft = (await asOwner('post', INVOICES, {
      subscriptionId: subscription.id,
      buyerTaxNumber: '300000000000003',
      reason: 'فاتورة سنوية للطباعة',
    })).body.data as PlatformInvoice;
    const issued = (await asOwner('post', `${INVOICES}/${draft.id}/issue`, { dueInDays: 10 }))
      .body.data as PlatformInvoice;

    const printed = await asOwner('get', `${INVOICES}/${draft.id}/print`);
    expect(printed.status).toBe(200);
    const html = printed.body.html as string;
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(issued.number!);
    expect(html).toContain('ضريبة القيمة المضافة');
    expect(html).toContain('300000000000003');
    expect(html).toContain('شركة الباء');
    // مبلغٌ بالحروف: ورقةٌ ضريبية بلا تفقيط تُعاد إلى البائع.
    expect(html).toContain('لا غير');
    // ورمز ZATCA (TLV: البائع، رقمه الضريبي، الوقت، الإجمالي، الضريبة) — من مُنشئ العميل نفسه.
    expect(html).toContain('<svg');
    // الورقة مكتفية بذاتها: لا رابط ولا خط ولا صورة تُجلب من الشبكة. والفضاء `xmlns`
    // في SVG ليس طلباً — لذلك يُسمح به صريحاً ويُمنع ما سواه.
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('url(http');
    expect(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')).not.toContain('http');
  });

  // ------------------------------------------------------------------ dunning

  it('runs the collection ladder one attempt at a time and stops at the cap', async () => {
    const subscription = await createSubscription(customerC.tenantId, pro.id);
    const draft = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة متأخّرة' }))
      .body.data as PlatformInvoice;
    // إصدار بتاريخ استحقاق في الماضي: المتابعة تقرأ التاريخ المخزَّن لا تخمّنه.
    const overdue = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const issued = (await asOwner('post', `${INVOICES}/${draft.id}/issue`, { dueDate: overdue }))
      .body.data as PlatformInvoice;
    expect(issued.daysOverdue).toBeGreaterThanOrEqual(4);

    const board = await asOwner('get', DUNNING);
    expect(board.status).toBe(200);
    const view = board.body.data as {
      attempts: unknown[];
      ladderDays: number[];
      maxAttempts: number;
      schedule: Array<{ invoiceId: string; activity?: string }>;
    };
    expect(view.ladderDays).toEqual([0, 3, 7]);
    expect(view.maxAttempts).toBe(PLATFORM_DUNNING_MAX_ATTEMPTS);

    const first = await asOwner('post', `${DUNNING}/${subscription.id}/run`, { channel: 'email' });
    expect(first.status).toBe(200);
    const run = first.body.data as PlatformDunningRunResult;
    expect(run.created.length).toBe(1);
    expect(run.created[0]?.attemptNo).toBe(1);
    expect(run.created[0]?.status).toBe('scheduled');
    expect(run.created[0]?.message.length).toBeGreaterThan(10);
    // ترخيص فعّال بفاتورة متأخّرة يصير «متأخّراً» بأثرٍ مكتوب في التدقيق.
    expect(run.subscriptionStatus).toBe('past_due');

    const second = await asOwner('post', `${DUNNING}/${subscription.id}/run`, {
      channel: 'manual',
      invoiceId: draft.id,
    });
    expect((second.body.data as PlatformDunningRunResult).created[0]?.attemptNo).toBe(2);
    expect((second.body.data as PlatformDunningRunResult).created[0]?.status).toBe('sent');

    const third = await asOwner('post', `${DUNNING}/${subscription.id}/run`, { invoiceId: draft.id });
    expect((third.body.data as PlatformDunningRunResult).created[0]?.attemptNo).toBe(3);

    // السقف: المحاولة الرابعة لا تُنشأ، وتقول لماذا.
    const fourth = await asOwner('post', `${DUNNING}/${subscription.id}/run`, { invoiceId: draft.id });
    expect(fourth.status).toBe(200);
    const capped = fourth.body.data as PlatformDunningRunResult;
    expect(capped.created.length).toBe(0);
    expect(capped.skipped[0]?.reason).toContain('استُنفدت');

    const ledger = await asOwner('get', `${DUNNING}?subscriptionId=${subscription.id}`);
    const ledgerView = ledger.body.data as { attempts: Array<{ attemptNo: number; channel: string }> };
    expect(ledgerView.attempts.map((attempt) => attempt.attemptNo).sort()).toEqual([1, 2, 3]);
    expect(ledgerView.attempts.some((attempt) => attempt.channel === 'manual')).toBe(true);
  });

  it('skips what is paid or not yet due', async () => {
    const subscription = await createSubscription(customerA.tenantId, starter.id);
    const draft = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة ستُسدد' }))
      .body.data as PlatformInvoice;
    await asOwner('post', `${INVOICES}/${draft.id}/issue`, { dueInDays: 10 });

    // لم يحن الاستحقاق بعد: لا مطاردة على فاتورة تنتظر.
    const tooEarly = await asOwner('post', `${DUNNING}/${subscription.id}/run`, {});
    expect((tooEarly.body.data as PlatformDunningRunResult).created.length).toBe(0);
    expect((tooEarly.body.data as PlatformDunningRunResult).skipped.length).toBe(0);

    // ثم تُسدَّد قبل استحقاقها، فلا محاولة عليها حتى لو مرّ تاريخها.
    await asOwner('post', `${INVOICES}/${draft.id}/pay`, { method: 'cash' });
    const afterPaid = await asOwner('post', `${DUNNING}/${subscription.id}/run`, {
      invoiceId: draft.id,
    });
    expect((afterPaid.body.data as PlatformDunningRunResult).created.length).toBe(0);
  });

  // ------------------------------------------------------------------ revenue

  it('measures MRR from contracted licences — trials and pauses are not revenue', async () => {
    // نُفرغ العميل من أي ترخيص حيّ أولاً: الفرق المقيس يجب أن يكون أثر حدثٍ واحد — الترخيص
    // الجديد — لا حاصل جمع حدثين (جديدٌ دخل وقديمٌ خرج).
    const liveNow = (await asOwner('get', `${SUBSCRIPTIONS}?status=active`)).body.data as PlatformSubscription[];
    for (const row of liveNow.filter((entry) => entry.tenantId === customerA.tenantId)) {
      await asOwner('post', `${SUBSCRIPTIONS}/${row.id}/cancel`, {
        reason: 'تنظيف قبل قياس الإيراد',
        atPeriodEnd: false,
      });
    }
    const baseline = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;

    // ترخيص سنوي جديد: 4990 سنوياً = 415.83 شهرياً.
    const live = await createSubscription(customerA.tenantId, annual.id, { months: 12 });
    const afterSubscription = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;
    expect(Number(afterSubscription.mrr) - Number(baseline.mrr)).toBeCloseTo(415.83, 2);
    // ARR = MRR × 12 بالحساب الصحيح، لا بضرب كسور عائمة.
    expect(Number(afterSubscription.arr)).toBeCloseTo(Number(afterSubscription.mrr) * 12, 2);
    expect(afterSubscription.counts.active).toBeGreaterThanOrEqual(1);

    // تجربةٌ ليست إيراداً — على عميلٍ جديد تماماً، فلا يُلغي ترخيصاً حيّاً فيُخفي الأثر.
    const trialTenant = await createTenantFixture(ctx.db.ownerUrl, {
      code: 'pc4-revenue-trial',
      name: 'شركة التجربة',
    });
    await createSubscription(trialTenant.id, starter.id, { trialDays: 14 });
    const afterTrial = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;
    expect(afterTrial.mrr).toBe(afterSubscription.mrr);
    expect(afterTrial.counts.trialing).toBeGreaterThanOrEqual(1);

    await asOwner('post', `${SUBSCRIPTIONS}/${live.id}/pause`, { reason: 'إيقاف مؤقت لقياس الأثر' });
    const afterPause = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;
    // الموقوف مؤقتاً يخرج من الإيراد: لا يُطلب مالٌ عن خدمة متوقّفة.
    expect(Number(afterPause.mrr)).toBeCloseTo(Number(baseline.mrr), 2);
    expect(afterPause.counts.paused).toBeGreaterThanOrEqual(1);
  });

  it('reports what is overdue and what was collected', async () => {
    const subscription = await createSubscription(customerC.tenantId, starter.id);
    const draft = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة لمتُردد' }))
      .body.data as PlatformInvoice;
    const overdue = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const issued = (await asOwner('post', `${INVOICES}/${draft.id}/issue`, { dueDate: overdue }))
      .body.data as PlatformInvoice;

    const revenue = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;
    expect(revenue.overdueCount).toBeGreaterThanOrEqual(1);
    // المتأخّر = المتبقّي على فاتورة صادرة تجاوزت استحقاقها، وليس الإجمالي.
    expect(Number(revenue.overdue)).toBeGreaterThanOrEqual(Number(issued.total));
    expect(revenue.upcoming.some((row) => row.invoiceId === draft.id)).toBe(true);

    await asOwner('post', `${INVOICES}/${draft.id}/pay`, { method: 'cash', receivedAt: new Date().toISOString() });
    const collected = (await asOwner('get', REVENUE)).body.data as PlatformRevenue;
    expect(Number(collected.collectedThisMonth)).toBeGreaterThanOrEqual(Number(issued.total));
    expect(collected.upcoming.some((row) => row.invoiceId === draft.id)).toBe(false);
  });

  // ------------------------------------------------------------------ gates

  it('gates plans, licences and documents behind their own codes', async () => {
    // الدعم يرى العملاء ولا يرى باقةً ولا مستنداً... ولا يعدّل ترخيصاً.
    const supportPlans = await api(ctx.server, 'get', PLANS, { token: operations.token });
    expect(supportPlans.status).toBe(403);
    expect(supportPlans.body.detail).toBe('platform permission console.plans.manage required');

    const supportInvoices = await api(ctx.server, 'get', INVOICES, { token: operations.token });
    expect(supportInvoices.status).toBe(403);
    expect(supportInvoices.body.detail).toBe('platform permission console.billing.manage required');

    const supportGrant = await api(ctx.server, 'post', SUBSCRIPTIONS, {
      token: operations.token,
      body: { tenantId: customerA.tenantId, planId: starter.id, months: 1 },
    });
    expect(supportGrant.status).toBe(403);

    // المدقّق يقرأ ولا يكتب — وحتى القراءة ليست مفتوحة: لا `billing.manage` ولا `plans.manage`.
    const auditorPlans = await api(ctx.server, 'get', PLANS, { token: auditor.token });
    expect(auditorPlans.status).toBe(403);
    const auditorRevenue = await api(ctx.server, 'get', REVENUE, { token: auditor.token });
    expect(auditorRevenue.status).toBe(403);
    const auditorInvoice = await api(ctx.server, 'post', INVOICES, {
      token: auditor.token,
      body: { subscriptionId: '00000000-0000-4000-8000-000000000000', reason: 'محاولة إنشاء' },
    });
    expect(auditorInvoice.status).toBe(403);

    // «فوترة المنصة» تحمل الرموز الثلاثة: الباقات والتراخيص والمستندات والمتابعة والإيراد.
    for (const path of [PLANS, `${PLANS}/entitlement-keys`, SUBSCRIPTIONS, INVOICES, DUNNING, REVENUE]) {
      const allowed = await api(ctx.server, 'get', path, { token: billing.token });
      expect(allowed.status, path).toBe(200);
    }

    // وسطح العميل لا يصل إلى أيٍّ منها — لا بالرمز ولا بالاسم.
    for (const path of [PLANS, SUBSCRIPTIONS, INVOICES, DUNNING, REVENUE]) {
      const tenant = await api(ctx.server, 'get', path, { token: customerA.token });
      expect(tenant.status, path).toBe(403);
      const anonymous = await api(ctx.server, 'get', path, {});
      expect(anonymous.status, path).toBe(401);
    }
  });

  // ------------------------------------------------------------------ isolation

  it('keeps the new tables behind RLS — a tenant reads its own documents and nothing else', async () => {
    // مستندٌ لعميلٍ ومستندٌ لآخر: العزل يُقاس بصفَّين لا بادّعاء.
    const subscription = await createSubscription(customerA.tenantId, starter.id);
    const document = (await asOwner('post', INVOICES, { subscriptionId: subscription.id, reason: 'فاتورة عزل' }))
      .body.data as PlatformInvoice;

    const tenantRows = await ctx.handle.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${customerB.tenantId}, true)`);
      const rows = await tx.execute(sql`SELECT id FROM platform_invoices`);
      const sequences = await tx.execute(sql`SELECT COUNT(*)::int AS n FROM platform_invoice_sequences`);
      return { rows: rows.rows.map((row) => String(row.id)), sequences: Number(sequences.rows[0]?.n ?? 0) };
    });
    // شركة الباء لا ترى فاتورة شركة الألف، ولا ترى تسلسل أرقام المنصة أصلاً.
    expect(tenantRows.rows).not.toContain(document.id);
    expect(tenantRows.sequences).toBe(0);

    const platformRows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT id FROM platform_invoices WHERE id = ${document.id}`),
    );
    expect(platformRows.rows.length).toBe(1);

    // وبلا سياق: لا صفَّ واحداً — الطبقة الوسطى تفشل مغلقة لا مفتوحة.
    const noContext = await ctx.handle.db.transaction(async (tx) => tx.execute(sql`SELECT COUNT(*)::int AS n FROM platform_invoices`));
    expect(Number(noContext.rows[0]?.n ?? -1)).toBe(0);
  });

  it('leaves an audit trail a year later can read', async () => {
    const actions = new Set((await auditRows()).map((row) => row.action));
    for (const action of Object.values(billingAuditActions)) {
      expect(actions.has(action), action).toBe(true);
    }

    // المستندات تُسجَّل بكيانها وبمعرّفها، والاختصاص يبقى `platform_console`.
    const issued = (await auditRows()).find((row) => row.action === billingAuditActions.INVOICE_ISSUE)!;
    expect(issued.entity).toBe('platform_invoice');
    expect((issued.meta as Record<string, unknown>).scope).toBe('platform_console');
  });
});
