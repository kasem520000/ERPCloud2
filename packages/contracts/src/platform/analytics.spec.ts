import { describe, expect, it } from 'vitest';

import {
  analyticsAlertKinds,
  analyticsAlertSchema,
  analyticsCohortBasisSchema,
  analyticsCohortsSchema,
  analyticsDaysQuerySchema,
  analyticsExportColumns,
  analyticsExportQuerySchema,
  analyticsFunnelSchema,
  analyticsFunnelSteps,
  analyticsMonthsQuerySchema,
  analyticsOverviewSchema,
} from './analytics.js';

/**
 * P-C12 — اختبارات عقود التحليلات.
 *
 * القاعدة هنا: **ما لا يُقاس في العقد يُخترع في الواجهة**. فالخطوات الست للتنبيه والقمع
 * قوائمُ مغلقة (لا سلسلةٌ حرّة تُقبل ثم تُترجم في الشاشة)، والأشكال تُقاس بحالاتٍ حقيقية
 * (صفر مقام · بلا حدّ · عملتان مختلفتان)، والنوافذ تُقاس بحدّيها (٣..٢٤ شهراً و٧..٣٦٥ يوماً)
 * لأن نافذةً بلا سقف تجعل النداء ينمو بلا حدّ.
 */
describe('platform analytics contracts (P-C12)', () => {
  describe('catalogue lists', () => {
    it('declares the six alert kinds, each one a real source', () => {
      expect(analyticsAlertKinds).toHaveLength(6);
      expect(analyticsAlertKinds).toContain('trial_ending');
      expect(analyticsAlertKinds).toContain('quota_near_limit');
      expect(analyticsAlertKinds).toContain('webhook_failing');
      // ولا نوعٌ بلا مصدرٍ في القاعدة: الإيقاف أو النموّ ليسا تنبيهين، بل صفٌّ في جدول.
      expect(analyticsAlertKinds).not.toContain('paused_tenant');
    });

    it('declares the four funnel steps in order', () => {
      expect(analyticsFunnelSteps).toEqual(['signed_up', 'activated', 'first_invoice', 'first_einvoice']);
    });

    it('declares the fourteen export columns actually written to the file', () => {
      expect(analyticsExportColumns).toHaveLength(14);
      expect(analyticsExportColumns).toContain('tenant_code');
      expect(analyticsExportColumns).toContain('peak_utilization_percent');
      expect(analyticsExportColumns).toContain('open_alerts');
      // أسماء الأعمدة إنجليزيةٌ للجدول — ولا عمود باسم `mrr` لأن الإيراد ليس لكل منشأة.
      expect(analyticsExportColumns).not.toContain('mrr');
    });
  });

  describe('window schemas', () => {
    it('bounds the months window between three and twenty-four', () => {
      expect(analyticsMonthsQuerySchema.parse('6')).toBe(6);
      expect(analyticsMonthsQuerySchema.parse(24)).toBe(24);
      expect(() => analyticsMonthsQuerySchema.parse(2)).toThrow();
      expect(() => analyticsMonthsQuerySchema.parse(25)).toThrow();
      expect(() => analyticsMonthsQuerySchema.parse('كل-التاريخ')).toThrow();
    });

    it('bounds the days window between seven and three hundred sixty-five', () => {
      expect(analyticsDaysQuerySchema.parse('30')).toBe(30);
      expect(analyticsDaysQuerySchema.parse(365)).toBe(365);
      expect(() => analyticsDaysQuerySchema.parse(6)).toThrow();
      expect(() => analyticsDaysQuerySchema.parse(400)).toThrow();
    });

    it('accepts the two cohort bases and refuses anything else', () => {
      expect(analyticsCohortBasisSchema.parse('signup')).toBe('signup');
      expect(analyticsCohortBasisSchema.parse('activation')).toBe('activation');
      expect(() => analyticsCohortBasisSchema.parse('plan')).toThrow();
    });

    it('defaults the export window and refuses a zero-day file', () => {
      expect(analyticsExportQuerySchema.parse({})).toEqual({});
      expect(analyticsExportQuerySchema.parse({ days: '90' })).toEqual({ days: 90 });
      expect(() => analyticsExportQuerySchema.parse({ days: 0 })).toThrow();
    });
  });

  describe('overview shape', () => {
    const base = {
      generatedAt: '2026-09-17T00:00:00.000Z',
      currency: 'SAR',
      mrr: '1200.00',
      arr: '14400.00',
      arpu: '600.00',
      counts: { total: 4, active: 2, trialing: 1, pastDue: 0, paused: 0, canceled: 1 },
      growth: { newThisMonth: 1, newLastMonth: 0, churnedThisMonth: 1, churnedLastMonth: 0, netThisMonth: 0 },
      collection: { outstanding: '0.00', overdue: '0.00', overdueCount: 0, collectedThisMonth: '600.00' },
      trials: { windowDays: 90, started: 0, converted: 0, conversionRate: null, endingInSevenDays: 0 },
      mrrSeries: [],
      churn: { windowMonths: 6, points: [] },
      usageByPlan: [],
      alerts: [],
      definitions: { mrr: 'تعريف', churn: 'تعريف', trial: 'تعريف', activity: 'تعريف' },
    };

    it('accepts an overview with empty series (a platform that just started)', () => {
      const parsed = analyticsOverviewSchema.parse(base);
      expect(parsed.mrrSeries).toEqual([]);
      expect(parsed.counts.total).toBe(4);
    });

    it('accepts a null trial conversion rate — the honest answer when no trial started', () => {
      expect(analyticsOverviewSchema.parse(base).trials.conversionRate).toBeNull();
      const parsed = analyticsOverviewSchema.parse({
        ...base,
        trials: { windowDays: 90, started: 4, converted: 1, conversionRate: 25, endingInSevenDays: 1 },
      });
      expect(parsed.trials.conversionRate).toBe(25);
    });

    it('refuses a negative count and a fractional one', () => {
      expect(() => analyticsOverviewSchema.parse({ ...base, counts: { ...base.counts, total: -1 } })).toThrow();
      expect(() => analyticsOverviewSchema.parse({ ...base, counts: { ...base.counts, active: 1.5 } })).toThrow();
      expect(analyticsOverviewSchema.parse({ ...base, counts: { ...base.counts, total: 0 } }).counts.total).toBe(0);
    });

    it('accepts a usage row with no limit (a plan without a ceiling) and null utilization', () => {
      const parsed = analyticsOverviewSchema.parse({
        ...base,
        usageByPlan: [
          {
            planCode: 'growth',
            planName: 'النمو',
            tenants: 2,
            metrics: [
              { metric: 'users', label: 'المستخدمون', unit: 'مستخدم', limit: null, average: 3, peak: 5, utilization: null },
            ],
          },
        ],
      });
      expect(parsed.usageByPlan[0]?.metrics[0]?.utilization).toBeNull();
    });

    it('carries the alert title and href — a number without a destination is not actionable', () => {
      const alert = analyticsAlertSchema.parse({
        kind: 'quota_near_limit',
        severity: 'warning',
        count: 1,
        title: 'عملاء عند 90% من حدّهم أو أكثر',
        href: '/usage',
        examples: [{ label: 'مؤسسة النخبة', detail: 'المستخدمون: 9 من 10 (90%)' }],
      });
      expect(alert.href).toBe('/usage');
      expect(alert.examples).toHaveLength(1);
      // ولا أمثلة بلا سقف: خمسةٌ تكفي لبدء المتابعة، وأكثر منها يصير قائمةً لا تنبيهاً.
      expect(() =>
        analyticsAlertSchema.parse({ ...alert, examples: Array.from({ length: 6 }, () => ({ label: 'x', detail: 'y' })) }),
      ).toThrow();
    });
  });

  describe('funnel and cohort shapes', () => {
    it('accepts a funnel whose first step has no previous conversion', () => {
      const parsed = analyticsFunnelSchema.parse({
        generatedAt: '2026-09-17T00:00:00.000Z',
        windowDays: null,
        rows: [
          {
            step: 'signed_up',
            title: 'سجّل',
            tenants: 10,
            conversionFromPrevious: null,
            conversionFromStart: 100,
            medianDaysFromSignup: null,
            p90DaysFromSignup: null,
          },
          {
            step: 'activated',
            title: 'فُعِّل له ترخيص',
            tenants: 6,
            conversionFromPrevious: 60,
            conversionFromStart: 60,
            medianDaysFromSignup: 1.5,
            p90DaysFromSignup: 4,
          },
        ],
      });
      expect(parsed.rows[0]?.conversionFromPrevious).toBeNull();
      expect(parsed.rows[1]?.medianDaysFromSignup).toBe(1.5);
    });

    it('refuses an unknown funnel step', () => {
      expect(() =>
        analyticsFunnelSchema.parse({
          generatedAt: '2026-09-17T00:00:00.000Z',
          windowDays: 90,
          rows: [
            {
              step: 'paid_us',
              title: 'دفع لنا',
              tenants: 1,
              conversionFromPrevious: null,
              conversionFromStart: null,
              medianDaysFromSignup: null,
              p90DaysFromSignup: null,
            },
          ],
        }),
      ).toThrow();
    });

    it('accepts a cohort row with contracted and active differing — the point of the table', () => {
      const parsed = analyticsCohortsSchema.parse({
        generatedAt: '2026-09-17T00:00:00.000Z',
        basis: 'signup',
        months: 6,
        rows: [
          {
            cohort: '2026-04',
            size: 4,
            cells: [
              { offset: 0, month: '2026-04', size: 4, contracted: 4, active: 3, contractedRate: 100, activeRate: 75 },
              { offset: 1, month: '2026-05', size: 4, contracted: 3, active: 1, contractedRate: 75, activeRate: 25 },
            ],
          },
        ],
      });
      const cell = parsed.rows[0]?.cells[1];
      expect(cell?.contracted).toBeGreaterThan(cell?.active ?? 0);
      expect(cell?.size).toBe(4);
    });

    it('refuses a cohort cell without its denominator', () => {
      expect(() =>
        analyticsCohortsSchema.parse({
          generatedAt: '2026-09-17T00:00:00.000Z',
          basis: 'activation',
          months: 3,
          rows: [{ cohort: '2026-07', size: 2, cells: [{ offset: 0, month: '2026-07', contracted: 2, active: 2, contractedRate: 100, activeRate: 100 }] }],
        }),
      ).toThrow();
    });
  });
});
