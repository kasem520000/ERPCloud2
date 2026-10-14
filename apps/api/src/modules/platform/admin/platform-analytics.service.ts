import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  analyticsAlertKinds,
  platformFormatAmount,
  platformMonthlyAmount,
  platformParseAmount,
  usageMetricRegistry,
  type AnalyticsAlert,
  type AnalyticsAlertKind,
  type AnalyticsChurnPoint,
  type AnalyticsCohortRow,
  type AnalyticsCohorts,
  type AnalyticsFunnel,
  type AnalyticsFunnelRow,
  type AnalyticsMrrPoint,
  type AnalyticsOverview,
  type AnalyticsUsageByPlan,
  type PlatformUsageGridResponse,
  type UsageMetricKey,
} from '@erp/contracts';
import { withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { UsageService } from '../../usage/index.js';

import { PlatformBillingService } from './platform-billing.service.js';

/**
 * P-C12 — التحليلات (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4): «أن ترى المنصة نفسها كما
 * يراها عملاؤها».
 *
 * القرار الحاكم: **لا رقم يُخترع هنا**. كل مقياس يُقرأ من المسار الذي يملكه أصلاً:
 *
 *   * **MRR · ARR · التحصيل** من `PlatformBillingService.revenue()` (P-C4) — تعريفٌ واحد للسطحين،
 *     فلو حسبتهما هذه الوحدة لظهر في اللوحة رقمان لـ«الإيراد الشهري» يختلفان باختلاف الشاشة.
 *   * **الاستخدام وحدوده** من `UsageService.grid()` (P-C5) — نفس الأرقام التي تعرضها `/usage`
 *     ونفس الحدود التي يُرفض عليها فعلُ العميل فعلاً. وأهمّ من ذلك: `limitSource` و`enforced`
 *     يسافران مع الرقم، فلا يدّعي هذا التقرير حدًّا غير مُطبَّق.
 *   * **التسرّب والقمع والأفواج** تُحسب في القاعدة (تجميعٌ شهري في SQL) ثم تُجمع هنا بـ`bigint`
 *     من `@erp/contracts` (`platformMonthlyAmount` · `platformParseAmount` · `platformFormatAmount`)
 *     — فلا حساب عشريّ في JavaScript ولا نوع `number` يلمس مالاً.
 */
@Injectable()
export class PlatformAnalyticsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    // P-C12: تعريف الإيراد يُقرأ من موضعه الواحد (P-C4) — لا نسخةٌ ثانية هنا.
    private readonly billing: PlatformBillingService,
    // P-C12: الاستخدام وحدوده من موضعهما الواحد (P-C5) — لا استعلام حدودٍ ثانٍ في هذا الملف.
    private readonly usage: UsageService,
  ) {}

  // ================================================================ نطاق القراءة

  /**
   * كل ما تحتاجه الحسابات، في معاملةٍ واحدة بسياق المنصة (`platform_admin` plane).
   *
   * الجداول الثلاثة العابرة للمستأجرين ومغطّاة بسياسة RLS على مستوى المنصة نفسها
   * (`0020` للتراخيص · `0067` لفواتير المبيعات) — فالقراءة العابرة مشروعةٌ هنا **ومقيَّدة في
   * القاعدة**، لا بشرطٍ في الكود يمكن أن يُنسى.
   */
  private async load(windowMonths: number) {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const since = new Date();
      since.setUTCMonth(since.getUTCMonth() - windowMonths);
      const sinceIso = since.toISOString();

      const tenants = (
        await tx.execute(sql`
          SELECT id, code, name, status, created_at::text AS created_at
            FROM tenants
           ORDER BY created_at ASC
        `)
      ).rows as unknown as Array<{
        id: string;
        code: string;
        name: string;
        status: string;
        created_at: string;
      }>;

      const subscriptions = (
        await tx.execute(sql`
          SELECT s.id, s.tenant_id, s.status, s.activated_at, s.canceled_at, s.created_at, s.trial_ends_at,
                 p.code AS plan_code, p.name AS plan_name, p.interval, p.amount, p.currency
            FROM tenant_subscriptions s
            JOIN billing_plans p ON p.id = s.plan_id
           WHERE s.status <> 'pending'
           ORDER BY s.created_at ASC
        `)
      ).rows as unknown as Array<{
        id: string;
        tenant_id: string;
        status: string;
        activated_at: string | null;
        canceled_at: string | null;
        created_at: string;
        trial_ends_at: string | null;
        plan_code: string;
        plan_name: string;
        interval: string;
        amount: string;
        currency: string;
      }>;

      const firstInvoices = (
        await tx.execute(sql`
          SELECT tenant_id, MIN(posted_at)::text AS first_at
            FROM sales_invoices
           WHERE status = 'posted' AND posted_at IS NOT NULL
           GROUP BY tenant_id
        `)
      ).rows as unknown as Array<{ tenant_id: string; first_at: string }>;

      const firstEinvoices = (
        await tx.execute(sql`
          SELECT tenant_id, MIN(posted_at)::text AS first_at
            FROM sales_invoices
           WHERE status = 'posted' AND posted_at IS NOT NULL
             AND zatca_status IN ('reported', 'cleared')
           GROUP BY tenant_id
        `)
      ).rows as unknown as Array<{ tenant_id: string; first_at: string }>;

      const lastInvoices = (
        await tx.execute(sql`
          SELECT tenant_id, MAX(posted_at)::text AS last_at
            FROM sales_invoices
           WHERE status = 'posted' AND posted_at IS NOT NULL
           GROUP BY tenant_id
        `)
      ).rows as unknown as Array<{ tenant_id: string; last_at: string }>;

      const invoiceMonths = (
        await tx.execute(sql`
          SELECT tenant_id, to_char(posted_at, 'YYYY-MM') AS month, count(*)::int AS invoice_count
            FROM sales_invoices
           WHERE status = 'posted' AND posted_at IS NOT NULL AND posted_at >= ${sinceIso}::timestamptz
           GROUP BY 1, 2
        `)
      ).rows as unknown as Array<{ tenant_id: string; month: string; invoice_count: number }>;

      const einvoiceCounts = (
        await tx.execute(sql`
          SELECT tenant_id, count(*)::int AS count
            FROM sales_invoices
           WHERE zatca_status IN ('reported', 'cleared') AND posted_at >= ${sinceIso}::timestamptz
           GROUP BY tenant_id
        `)
      ).rows as unknown as Array<{ tenant_id: string; count: number }>;

      const failingWebhooks = (
        await tx.execute(sql`
          SELECT e.tenant_id, e.url, count(*)::int AS failed
            FROM webhook_deliveries d
            JOIN webhook_endpoints e ON e.id = d.endpoint_id
           WHERE d.status = 'failed' AND d.created_at >= now() - interval '24 hours'
           GROUP BY 1, 2
           ORDER BY 3 DESC
        `)
      ).rows as unknown as Array<{ tenant_id: string; url: string; failed: number }>;

      const overdueInvoices = (
        await tx.execute(sql`
          SELECT i.tenant_id, count(*)::int AS open_count, min(i.due_date::text) AS oldest_due
            FROM platform_invoices i
           WHERE i.status IN ('issued', 'partially_paid')
             AND i.due_date IS NOT NULL AND i.due_date < now()
           GROUP BY i.tenant_id
        `)
      ).rows as unknown as Array<{ tenant_id: string; open_count: number; oldest_due: string }>;

      return {
        tenants,
        subscriptions,
        firstInvoices,
        firstEinvoices,
        lastInvoices,
        invoiceMonths,
        einvoiceCounts,
        failingWebhooks,
        overdueInvoices,
      };
    });
  }

  // ================================================================ أدوات

  /** `YYYY-MM` بمقياس UTC — نفس مقياس `usagePeriodOf()` في P-C5. */
  private monthOf(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private monthStart(key: string): Date {
    return new Date(`${key}-01T00:00:00.000Z`);
  }

  private shiftMonth(key: string, delta: number): string {
    const date = this.monthStart(key);
    date.setUTCMonth(date.getUTCMonth() + delta);
    return this.monthOf(date);
  }

  /** آخر `count` شهراً تنتهي بالشهر الجاري (تصاعدياً). */
  private recentMonths(count: number, now: Date): string[] {
    const current = this.monthOf(now);
    return Array.from({ length: count }, (_, index) => this.shiftMonth(current, index - (count - 1)));
  }

  private daysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  }

  /** نسبةٌ مئوية بمنزلتين — `null` حين لا مقام (الصفر هنا ليس نتيجة، بل غيابُ سؤال). */
  private percent(numerator: number, denominator: number): number | null {
    if (denominator <= 0) return null;
    return Math.round((numerator / denominator) * 10_000) / 100;
  }

  private median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const value =
      sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
    return Math.round(value * 10) / 10;
  }

  private percentile(values: number[], at: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((at / 100) * sorted.length) - 1));
    return Math.round(sorted[index]! * 10) / 10;
  }

  /** المكافئ الشهري للترخيص بالمليمات — `bigint` وحده يلمس المال. */
  private monthlyMinor(row: { amount: string; interval: string }): bigint {
    const text = platformMonthlyAmount(String(row.amount), row.interval === 'year' ? 'year' : 'month');
    return platformParseAmount(text);
  }

  /** الحالة التي تُعدّ «تعاقداً قائماً» في هذا المستودع — نفس ما تعرضه لوحة الإيراد. */
  private static readonly STANDING = ['active', 'past_due'] as const;

  /** الترخيص الحيّ لكل منشأة: يجوز أن يكون `trialing` أو `paused` — والاثنان ليسا إيراداً. */
  private standingByTenant(rows: Array<{ tenant_id: string; status: string; canceled_at: string | null }>) {
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.canceled_at !== null) continue;
      if (['trialing', 'active', 'past_due', 'paused'].includes(row.status)) map.set(row.tenant_id, row.status);
    }
    return map;
  }

  // ================================================================ النظرة العامة

  /**
   * `GET /platform/analytics/overview`
   *
   * `windowMonths` (3..24): نافذة منحنى الإيراد والتسرّب. والقيمة الافتراضية 6 أشهر — نافذةٌ
   * تُظهر انعطافاً ولا تُخفي الشهر الجاري في ضجيج سنة.
   */
  async overview(options: { windowMonths?: number } = {}): Promise<AnalyticsOverview> {
    const now = new Date();
    const windowMonths = Math.min(Math.max(options.windowMonths ?? 6, 3), 24);
    const data = await this.load(windowMonths);
    const revenue = await this.billing.revenue();
    const grid = await this.usage.grid();
    const months = this.recentMonths(windowMonths, now);
    const standing = this.standingByTenant(data.subscriptions);
    const currentMonth = this.monthOf(now);
    const previousMonth = this.shiftMonth(currentMonth, -1);
    const mrrMinor = platformParseAmount(revenue.mrr);

    const newThisMonth = data.tenants.filter((row) => this.monthOf(new Date(row.created_at)) === currentMonth).length;
    const newLastMonth = data.tenants.filter((row) => this.monthOf(new Date(row.created_at)) === previousMonth).length;
    const churnedThisMonth = data.subscriptions.filter(
      (row) => row.canceled_at !== null && this.monthOf(new Date(row.canceled_at)) === currentMonth,
    ).length;
    const churnedLastMonth = data.subscriptions.filter(
      (row) => row.canceled_at !== null && this.monthOf(new Date(row.canceled_at)) === previousMonth,
    ).length;

    // التجربة: الترخيص الذي حمل تاريخ نهاية تجربة، وحُوّل إن صار له تاريخ تفعيل.
    const trialCutoff = new Date(now.getTime() - 90 * 86_400_000);
    const trials = data.subscriptions.filter((row) => row.created_at >= trialCutoff.toISOString());
    const converted = trials.filter((row) => row.activated_at !== null);
    // «تنتهي خلال سبعة أيام» تُقرأ من `trial_ends_at` المكتوب في الترخيص نفسه — لا من
    // تخمينٍ على `created_at`: مدة التجربة يحدّدها مشغّل المنصة وقت المنح، وهي المحفوظة.
    const endingSoon = data.subscriptions.filter((row) => trialingEndsWithin(row, now, 7)).length;

    const contracted = [...standing.values()].filter((status) =>
      (PlatformAnalyticsService.STANDING as readonly string[]).includes(status),
    ).length;

    return {
      generatedAt: now.toISOString(),
      currency: revenue.currency,
      mrr: revenue.mrr,
      arr: revenue.arr,
      arpu: contracted === 0 ? '0.00' : platformFormatAmount(mrrMinor / BigInt(contracted)),
      counts: {
        total: data.tenants.length,
        active: revenue.counts.active,
        trialing: revenue.counts.trialing,
        pastDue: revenue.counts.pastDue,
        paused: revenue.counts.paused,
        canceled: revenue.counts.canceled,
      },
      growth: {
        newThisMonth,
        newLastMonth,
        churnedThisMonth,
        churnedLastMonth,
        netThisMonth: newThisMonth - churnedThisMonth,
      },
      collection: {
        outstanding: revenue.outstanding,
        overdue: revenue.overdue,
        overdueCount: revenue.overdueCount,
        collectedThisMonth: revenue.collectedThisMonth,
      },
      trials: {
        windowDays: 90,
        started: trials.length,
        converted: converted.length,
        conversionRate: this.percent(converted.length, trials.length),
        endingInSevenDays: endingSoon,
      },
      mrrSeries: this.mrrSeries(data.subscriptions, months),
      churn: { windowMonths, points: this.churnPoints(data.subscriptions, months) },
      usageByPlan: this.usageByPlan(data.subscriptions, standing, grid),
      alerts: this.alerts(data, grid, now),
      definitions: {
        mrr: 'المكافئ الشهري للتراخيص المتعاقَدة (`active` و`past_due`) — نفس تعريف شاشة الإيراد.',
        churn: 'بالشعارات: المُلغى في الشهر ÷ المتعاقد في أوّل الشهر · بالمال: القيمة الشهرية للمُلغى ÷ قيمة الأساس نفسه.',
        trial: 'كل ترخيصٍ أُنشئ خلال 90 يوماً وحمل تاريخ تفعيل — والمحوَّل ما صار له تاريخ تفعيل.',
        activity: '«نشِط» في شهر: فاتورة مبيعاتٍ مرحَّلة واحدة على الأقل · «زاتكا»: مستندٌ وصل السلطة.',
      },
    };
  }

  /** منحنى الإيراد: في كل شهر — القائم أوّل الشهر، والمضاف، والساقط، والصافي. */
  private mrrSeries(
    rows: Array<{ amount: string; interval: string; activated_at: string | null; canceled_at: string | null }>,
    months: string[],
  ): AnalyticsMrrPoint[] {
    return months.map((month) => {
      const start = this.monthStart(month).getTime();
      const end = this.monthStart(this.shiftMonth(month, 1)).getTime();
      let base = 0n;
      let added = 0n;
      let churned = 0n;

      for (const row of rows) {
        const value = this.monthlyMinor(row);
        const activated = row.activated_at === null ? null : new Date(row.activated_at).getTime();
        const canceled = row.canceled_at === null ? null : new Date(row.canceled_at).getTime();
        if (activated !== null && activated < end && (canceled === null || canceled >= end)) base += value;
        if (activated !== null && activated >= start && activated < end) added += value;
        if (canceled !== null && canceled >= start && canceled < end) churned += value;
      }

      return {
        month,
        mrr: platformFormatAmount(base),
        newValue: platformFormatAmount(added),
        churnedValue: platformFormatAmount(churned),
        netValue: platformFormatAmount(added - churned),
      };
    });
  }

  /** التسرّب مرّتين — بالشعارات وبالمال — ولكلٍّ مقامُه معروضاً لا مخفياً. */
  private churnPoints(
    rows: Array<{ amount: string; interval: string; activated_at: string | null; canceled_at: string | null }>,
    months: string[],
  ): AnalyticsChurnPoint[] {
    return months.map((month) => {
      const start = this.monthStart(month).getTime();
      const end = this.monthStart(this.shiftMonth(month, 1)).getTime();
      let baseCount = 0;
      let baseValue = 0n;
      let churnedCount = 0;
      let churnedValue = 0n;

      for (const row of rows) {
        const value = this.monthlyMinor(row);
        const activated = row.activated_at === null ? null : new Date(row.activated_at).getTime();
        const canceled = row.canceled_at === null ? null : new Date(row.canceled_at).getTime();
        if (activated !== null && activated < start && (canceled === null || canceled >= start)) {
          baseCount += 1;
          baseValue += value;
        }
        if (canceled !== null && canceled >= start && canceled < end) {
          churnedCount += 1;
          churnedValue += value;
        }
      }

      return {
        month,
        baseCount,
        baseValue: platformFormatAmount(baseValue),
        churnedCount,
        churnedValue: platformFormatAmount(churnedValue),
        // بلا مقام لا نسبة: `null` تقول «لا سؤال» — والصفر يقول «لا تسرّب» وهو غير صحيح.
        logoRate: this.percent(churnedCount, baseCount),
        revenueRate: baseValue === 0n ? null : Math.round(Number((churnedValue * 10_000n) / baseValue)) / 100,
      };
    });
  }

  /**
   * الاستخدام لكل باقة — من شبكة P-C5 نفسها.
   *
   * المتوسط لا الذروة وحدها: ذروةٌ واحدة (عميلٌ بلغ الحدّ) لا تقول شيئاً عن باقةٍ كاملة،
   * والمتوسط هو ما يُبنى عليه قرار «هل نرفع حدّ هذه الباقة». والذروة تُعرض بجانبه لأن
   * المراجعة تحتاج الاثنين.
   */
  private usageByPlan(
    subscriptions: Array<{ tenant_id: string; status: string; canceled_at: string | null; plan_code: string; plan_name: string }>,
    standing: Map<string, string>,
    grid: PlatformUsageGridResponse,
  ): AnalyticsUsageByPlan[] {
    const planOf = new Map<string, { code: string; name: string }>();
    for (const row of subscriptions) {
      if (standing.has(row.tenant_id)) planOf.set(row.tenant_id, { code: row.plan_code, name: row.plan_name });
    }

    const groups = new Map<string, { planCode: string; planName: string; rows: PlatformUsageGridResponse['tenants'] }>();
    for (const row of grid.tenants) {
      const plan = planOf.get(row.tenantId) ?? { code: 'unassigned', name: 'بلا باقة' };
      const entry = groups.get(plan.code) ?? { planCode: plan.code, planName: plan.name, rows: [] };
      entry.rows.push(row);
      groups.set(plan.code, entry);
    }

    return [...groups.values()]
      .sort((left, right) => left.planCode.localeCompare(right.planCode))
      .map((group) => ({
        planCode: group.planCode,
        planName: group.planName,
        tenants: group.rows.length,
        metrics: usageMetricRegistry.map((metric) => {
          const cells = group.rows
            .map((row) => row.metrics.find((entry) => entry.key === metric.key))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
          const used = cells.map((cell) => cell.used);
          const average = used.length === 0 ? 0 : used.reduce((sum, value) => sum + value, 0) / used.length;
          const limits = cells.map((cell) => cell.limit).filter((value): value is number => value !== null);
          const limit = limits.length === 0 ? null : Math.max(...limits);
          return {
            metric: metric.key,
            label: metric.labelAr,
            unit: metric.unitAr,
            limit,
            average: Math.round(average * 100) / 100,
            peak: used.length === 0 ? 0 : Math.max(...used),
            utilization: limit === null || limit <= 0 ? null : Math.round((average / limit) * 10_000) / 100,
          };
        }),
      }));
  }

  /**
   * التنبيهات — ستُّ إشارات، كلٌّ لها مصدرٌ قائم ووجهةٌ في اللوحة. ولا تنبيه بلا مثالٍ بالاسم:
   * «3 عملاء» لا يُتابَع، و«مؤسسة كذا · آخر فاتورة 2026-06-02» يُتابَع.
   */
  private alerts(
    data: Awaited<ReturnType<PlatformAnalyticsService['load']>>,
    grid: PlatformUsageGridResponse,
    now: Date,
  ): AnalyticsAlert[] {
    const tenantName = new Map(data.tenants.map((row) => [row.id, row.name]));
    const nameOf = (tenantId: string) => tenantName.get(tenantId) ?? tenantId;
    const lastInvoice = new Map(data.lastInvoices.map((row) => [row.tenant_id, new Date(row.last_at)]));
    const hasStanding = new Map(data.subscriptions.map((row) => [row.tenant_id, row.status]));

    const build = (
      kind: AnalyticsAlertKind,
      title: string,
      href: string,
      severity: AnalyticsAlert['severity'],
      rows: Array<{ label: string; detail: string }>,
    ): AnalyticsAlert => ({
      kind,
      severity,
      count: rows.length,
      title,
      href,
      examples: rows.slice(0, 5),
    });

    const trialEnding = data.subscriptions
      .filter((row) => trialingEndsWithin(row, now, 7))
      .map((row) => ({
        label: nameOf(row.tenant_id),
        detail: `تجربة تنتهي ${String(row.trial_ends_at).slice(0, 10)}`,
      }));

    const pastDue = data.overdueInvoices.map((row) => ({
      label: nameOf(row.tenant_id),
      detail: `${row.open_count} فاتورة متأخّرة منذ ${String(row.oldest_due).slice(0, 10)}`,
    }));

    const quota = grid.tenants
      .flatMap((row) =>
        row.metrics
          .filter((metric) => metric.limit !== null && metric.limit > 0 && (metric.percentUsed ?? 0) >= 90)
          .map((metric) => ({
            label: row.tenantName,
            detail: `${metric.labelAr}: ${metric.used} من ${metric.limit} (${metric.percentUsed}%) — ${metric.enforced ? 'يُرفض عند الحدّ' : 'يُبلَّغ عنه فقط'}`,
          })),
      )
      .sort((left, right) => right.detail.localeCompare(left.detail, 'ar'));

    const neverActivated = data.tenants
      .filter((row) => this.daysBetween(new Date(row.created_at), now) > 7 && !hasStanding.has(row.id))
      .map((row) => ({
        label: row.name,
        detail: `سُجّل ${row.created_at.slice(0, 10)} بلا ترخيصٍ حَيّ`,
      }));

    const silent = data.tenants
      .filter((row) => {
        if (!hasStanding.has(row.id)) return false;
        const last = lastInvoice.get(row.id);
        return last === undefined || this.daysBetween(last, now) > 30;
      })
      .map((row) => {
        const last = lastInvoice.get(row.id);
        return {
          label: row.name,
          detail: last === undefined ? 'لا فاتورة مرحَّلة بعد' : `آخر فاتورة ${last.toISOString().slice(0, 10)}`,
        };
      });

    const failingHooks = data.failingWebhooks.map((row) => ({
      label: nameOf(row.tenant_id),
      detail: `${row.failed} تسليماً فاشلاً خلال 24 ساعة · ${row.url}`,
    }));

    return [
      build('trial_ending', 'تجارب تنتهي خلال سبعة أيام', '/tenants', 'warning', trialEnding),
      build('past_due', 'فواتير منصةٍ متأخّرة', '/dunning', 'critical', pastDue),
      build('quota_near_limit', 'عملاء عند 90% من حدّهم أو أكثر', '/usage', 'warning', quota),
      build('never_activated', 'منشآت مسجَّلة بلا ترخيص', '/tenants', 'info', neverActivated),
      build('silent_tenant', 'عملاء متعاقدون بلا فاتورة منذ 30 يوماً', '/tenants', 'warning', silent),
      build('webhook_failing', 'عناوين ويب هوك تفشل', '/webhooks', 'critical', failingHooks),
    ].filter((alert) => alert.count > 0 && analyticsAlertKinds.includes(alert.kind));
  }

  // ================================================================ القمع

  /**
   * `GET /platform/analytics/funnel` — سجّل ← فُعِّل ← رحّل ← أرسل.
   *
   * والخطوتان الثالثة والرابعة **فعلُ العميل لا فعلُنا**: تُقرآن من `sales_invoices` (فواتير
   * المستأجر) لا من `platform_invoices` (فاتورتنا عليه) — وإلا لقِسنا تحصيلنا وسمّيناه تفعيله.
   * ومع كل خطوة: **وسيط الأيام** و**المئين 90** من التسجيل إليها، لأن قمعاً يعبره الجميع في
   * شهرٍ ليس كقمعٍ يعبره نصفهم في يوم.
   */
  async funnel(options: { windowDays?: number | null } = {}): Promise<AnalyticsFunnel> {
    const now = new Date();
    const windowDays = options.windowDays ?? null;
    const data = await this.load(Math.max(3, Math.ceil((windowDays ?? 180) / 30) + 1));
    const cutoff = windowDays === null ? null : new Date(now.getTime() - windowDays * 86_400_000);

    const signedUp = data.tenants.filter((row) => cutoff === null || new Date(row.created_at) >= cutoff);
    const signupAt = new Map(signedUp.map((row) => [row.id, new Date(row.created_at)]));

    const firstActivation = new Map<string, string>();
    for (const row of data.subscriptions) {
      if (row.activated_at === null) continue;
      const existing = firstActivation.get(row.tenant_id);
      if (existing === undefined || row.activated_at < existing) firstActivation.set(row.tenant_id, row.activated_at);
    }
    const firstInvoice = new Map(data.firstInvoices.map((row) => [row.tenant_id, row.first_at]));
    const firstEinvoice = new Map(data.firstEinvoices.map((row) => [row.tenant_id, row.first_at]));

    const steps: Array<{
      step: AnalyticsFunnelRow['step'];
      title: string;
      reached: Map<string, string> | null;
    }> = [
      { step: 'signed_up', title: 'سجّل', reached: null },
      { step: 'activated', title: 'فُعِّل له ترخيص', reached: firstActivation },
      { step: 'first_invoice', title: 'رحّل أوّل فاتورة', reached: firstInvoice },
      { step: 'first_einvoice', title: 'أوّل مستند زاتكا', reached: firstEinvoice },
    ];

    const counts = steps.map((entry) =>
      entry.reached === null ? signedUp.length : signedUp.filter((row) => entry.reached!.has(row.id)).length,
    );

    const rows: AnalyticsFunnelRow[] = steps.map((entry, index) => {
      const durations =
        entry.reached === null
          ? []
          : signedUp
              .filter((row) => entry.reached!.has(row.id))
              .map((row) => this.daysBetween(signupAt.get(row.id)!, new Date(entry.reached!.get(row.id)!)));
      const start = counts[0] ?? 0;
      return {
        step: entry.step,
        title: entry.title,
        tenants: counts[index] ?? 0,
        conversionFromPrevious: index === 0 ? null : this.percent(counts[index] ?? 0, counts[index - 1] ?? 0),
        conversionFromStart: this.percent(counts[index] ?? 0, start),
        medianDaysFromSignup: this.median(durations),
        p90DaysFromSignup: this.percentile(durations, 90),
      };
    });

    return { generatedAt: now.toISOString(), windowDays, rows };
  }

  // ================================================================ الأفواج

  /**
   * `GET /platform/analytics/cohorts` — فوجُ التسجيل (أو التفعيل) × الأشهر التالية.
   *
   * وفي كل خليّة **رقمان لا رقم**: كم ما زال **متعاقداً** (ترخيصٌ حَيّ في الشهر)، وكم
   * **استعمل** فعلاً (فاتورة مبيعاتٍ مرحَّلة في الشهر). والفارق بينهما هو ما يهمّ: عميلٌ يدفع
   * ولا يستعمل ليس احتفاظاً.
   */
  async cohorts(options: { months?: number; basis?: 'signup' | 'activation' } = {}): Promise<AnalyticsCohorts> {
    const now = new Date();
    const months = Math.min(Math.max(options.months ?? 6, 3), 12);
    const basis = options.basis ?? 'signup';
    const data = await this.load(months);
    const window = this.recentMonths(months, now);

    const firstActivation = new Map<string, string>();
    for (const row of data.subscriptions) {
      if (row.activated_at === null) continue;
      const existing = firstActivation.get(row.tenant_id);
      if (existing === undefined || row.activated_at < existing) firstActivation.set(row.tenant_id, row.activated_at);
    }

    const invoicesByMonth = new Map<string, Set<string>>();
    for (const row of data.invoiceMonths) {
      const set = invoicesByMonth.get(row.tenant_id) ?? new Set<string>();
      set.add(row.month);
      invoicesByMonth.set(row.tenant_id, set);
    }

    const cohortKeyOf = (tenantId: string, createdAt: string): string | null => {
      const at = basis === 'signup' ? createdAt : firstActivation.get(tenantId);
      if (at === undefined) return null;
      const key = this.monthOf(new Date(at));
      return window.includes(key) ? key : null;
    };

    const rows: AnalyticsCohortRow[] = window.map((cohort) => {
      const members = data.tenants.filter((row) => cohortKeyOf(row.id, row.created_at) === cohort);
      const cells = window.slice(window.indexOf(cohort)).map((month, offset) => {
        const start = this.monthStart(month).getTime();
        const end = this.monthStart(this.shiftMonth(month, 1)).getTime();
        const contracted = members.filter((member) =>
          data.subscriptions.some((row) => {
            if (row.tenant_id !== member.id || row.activated_at === null) return false;
            const activated = new Date(row.activated_at).getTime();
            const canceled = row.canceled_at === null ? null : new Date(row.canceled_at).getTime();
            return activated < end && (canceled === null || canceled >= start);
          }),
        ).length;
        const active = members.filter((member) => invoicesByMonth.get(member.id)?.has(month)).length;
        return {
          offset,
          month,
          size: members.length,
          contracted,
          active,
          contractedRate: this.percent(contracted, members.length) ?? 0,
          activeRate: this.percent(active, members.length) ?? 0,
        };
      });
      return { cohort, size: members.length, cells };
    });

    return { generatedAt: now.toISOString(), basis, months, rows };
  }

  // ================================================================ التصدير

  /**
   * `GET /platform/analytics/export.csv` — سطرٌ لكل منشأة.
   *
   * **يُبنى في الذاكرة ويُرسل نصّاً**: لا ملفٌّ يُكتب على القرص ولا رابطٌ يُشارَك، والترويسة
   * تحمل تاريخ التوليد والنافذة — فملفٌّ يتناقله المشغّلون بلا تاريخٍ يصير مرجعاً كاذباً.
   */
  async exportCsv(options: { days?: number } = {}): Promise<string> {
    const now = new Date();
    const days = Math.min(Math.max(options.days ?? 30, 1), 365);
    const windowMonths = Math.max(3, Math.ceil(days / 30) + 1);
    const data = await this.load(windowMonths);
    const grid = await this.usage.grid();
    const daysAgo = new Date(now.getTime() - days * 86_400_000);
    const lastInvoice = new Map(data.lastInvoices.map((row) => [row.tenant_id, new Date(row.last_at)]));
    const standing = this.standingByTenant(data.subscriptions);
    const planOf = new Map(
      data.subscriptions.map((row) => [
        row.tenant_id,
        { code: row.plan_code, status: row.status, activated: row.activated_at, value: this.monthlyMinor(row), currency: row.currency },
      ]),
    );
    const invoiceCounts = new Map<string, number>();
    for (const row of data.invoiceMonths) {
      invoiceCounts.set(row.tenant_id, (invoiceCounts.get(row.tenant_id) ?? 0) + row.invoice_count);
    }
    const einvoiceCounts = new Map(data.einvoiceCounts.map((row) => [row.tenant_id, row.count]));
    const alerts = this.alerts(data, grid, now);

    const header = [
      'tenant_code',
      'tenant_name',
      'tenant_status',
      'plan_code',
      'subscription_status',
      'activated_at',
      'monthly_value',
      'currency',
      'invoice_count_window',
      'einvoice_count_window',
      'last_invoice_at',
      'days_since_last_invoice',
      'peak_utilization_percent',
      'open_alerts',
    ];

    const lines = data.tenants.map((tenant) => {
      const plan = planOf.get(tenant.id);
      const last = lastInvoice.get(tenant.id);
      const row = grid.tenants.find((entry) => entry.tenantId === tenant.id);
      const utilizations = (row?.metrics ?? [])
        .map((metric) => metric.percentUsed)
        .filter((value): value is number => value !== null);
      const tenantAlerts = alerts.filter((alert) =>
        alert.examples.some((example) => example.label === tenant.name),
      ).length;

      return [
        tenant.code,
        tenant.name,
        tenant.status,
        plan?.code ?? '',
        standing.get(tenant.id) ?? 'none',
        plan?.activated?.slice(0, 10) ?? '',
        plan === undefined ? '0.00' : platformFormatAmount(plan.value),
        plan?.currency ?? '',
        String(invoiceCounts.get(tenant.id) ?? 0),
        String(einvoiceCounts.get(tenant.id) ?? 0),
        last === undefined ? '' : last.toISOString().slice(0, 10),
        last === undefined ? '' : String(this.daysBetween(last, now)),
        utilizations.length === 0 ? '' : String(Math.max(...utilizations)),
        String(tenantAlerts),
      ]
        .map((cell) => csvCell(cell))
        .join(',');
    });

    // الترويسة تعليقٌ يبدأ بـ`#`: تُقرأ في Excel كسطرٍ يُتجاهل، وتُقرأ في أي محرّرٍ كنصّ.
    const preamble = `# platform analytics export · generated ${now.toISOString()} · window ${days} days · since ${daysAgo.toISOString().slice(0, 10)}`;
    return [preamble, header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** مفاتيح المقاييس الثمانية — تقرؤها الشاشة لتقول «أي مقاييس تقيسها هذه الأرقام». */
  metricKeys(): UsageMetricKey[] {
    return usageMetricRegistry.map((metric) => metric.key);
  }
}

/** خلية CSV: تُحيط بالفاصلة والتنصيص والسطر الجديد، وتُضاعف التنصيص (RFC 4180). */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** تجربةٌ تنتهي خلال `days` يوماً من الآن — المصدر `trial_ends_at` وحده. */
function trialingEndsWithin(
  row: { status: string; trial_ends_at: string | null },
  now: Date,
  days: number,
): boolean {
  if (row.status !== 'trialing' || row.trial_ends_at === null) return false;
  const ends = new Date(row.trial_ends_at).getTime();
  return ends >= now.getTime() && ends <= now.getTime() + days * 86_400_000;
}
