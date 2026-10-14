import { describe, expect, it } from 'vitest';

import {
  PUBLIC_EVENTS_ACCEPTED_AR,
  SITE_ANALYTICS_COLLECTED,
  SITE_ANALYTICS_NEVER,
  SITE_EVENTS_MAX_BATCH,
  SITE_EVENTS_RETENTION_DAYS,
  publicEventsBatchSchema,
  siteAnalyticsDaysSchema,
  siteAnalyticsQuerySchema,
  siteEventLabelsAr,
  siteEventMetaKeys,
  siteEventNames,
  siteEventSchema,
  siteGoalNames,
  siteConversionPct,
} from './site-analytics.js';

/**
 * P-M10 — سبيك القياس. يقيس ما لا يجوز أن يُخترع في الشاشة ولا في المتصفّح:
 * المفردات المغلقة · صرامة الحدث (لا حقلَ هويّة) · حدود الدفعة والنافذة · حساب النسبة.
 */

const visitor = '7c9f1a2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c';

const event = (extra: Record<string, unknown> = {}) => ({
  name: 'page_view',
  path: '/pricing',
  locale: 'ar',
  visitor,
  ...extra,
});

describe('P-M10 — مفردات القياس', () => {
  it('كل هدفٍ في القمع حدثٌ معروف لا اسمٌ ثالث', () => {
    expect(siteGoalNames.every((goal) => (siteEventNames as readonly string[]).includes(goal))).toBe(true);
  });

  it('ولكل حدثٍ تسميةٌ عربية تُعرض في اللوحة', () => {
    for (const name of siteEventNames) {
      expect(siteEventLabelsAr[name]?.length ?? 0).toBeGreaterThan(2);
    }
  });

  it('ومفاتيح الوصف قائمةٌ مغلقة (لا حقلَ حرّاً يصير سجلاً شخصياً)', () => {
    expect([...siteEventMetaKeys]).toEqual(['experiment', 'variant', 'plan', 'source', 'goal']);
  });

  it('وحدثٌ بمفتاحٍ خارج العقد يُردّ (لا يُخزَّن بصمت)', () => {
    const parsed = siteEventSchema.safeParse(event({ email: 'someone@example.com' }));
    expect(parsed.success).toBe(false);
  });

  it('وحدثٌ بمفتاح وصفٍ معروف يُقبل', () => {
    const parsed = siteEventSchema.safeParse(event({ meta: { experiment: 'hero', variant: 'b' } }));
    expect(parsed.success).toBe(true);
  });

  it('ومعرّف الزائر UUID لا نصّ حرّ', () => {
    expect(siteEventSchema.safeParse(event({ visitor: 'زائر-١' })).success).toBe(false);
  });

  it('والدفعة محدودة العدد ومحدودة الحجم', () => {
    const events = Array.from({ length: SITE_EVENTS_MAX_BATCH + 1 }, () => event());
    expect(publicEventsBatchSchema.safeParse({ events }).success).toBe(false);
    expect(publicEventsBatchSchema.safeParse({ events: [event()] }).success).toBe(true);
    expect(publicEventsBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('ودفعةٌ بمفتاحٍ خارج العقد تُردّ كذلك', () => {
    expect(publicEventsBatchSchema.safeParse({ events: [event()], ip: '10.0.0.1' }).success).toBe(false);
  });

  it('ونافذة القياس محدودة بين أسبوعٍ وسنة', () => {
    expect(siteAnalyticsQuerySchema.parse({})).toEqual({ days: 30 });
    expect(siteAnalyticsQuerySchema.parse({ days: '7' })).toEqual({ days: 7 });
    expect(siteAnalyticsQuerySchema.safeParse({ days: 3 }).success).toBe(false);
    expect(siteAnalyticsQuerySchema.safeParse({ days: 400 }).success).toBe(false);
    // والحقل المفرد يعمل على `@Query('days')` كما هو (نصّاً من الرابط ⇒ عدداً).
    expect(siteAnalyticsDaysSchema.parse('30')).toBe(30);
    expect(siteAnalyticsDaysSchema.safeParse('6').success).toBe(false);
  });

  it('والنسبة تُحسب بمنزلةٍ واحدة وبمقامٍ صفريّ آمن', () => {
    expect(siteConversionPct(3, 8)).toBe(37.5);
    expect(siteConversionPct(0, 0)).toBe(0);
    expect(siteConversionPct(5, 0)).toBe(0);
  });

  it('والوعد المطبوع يقول ما يُجمع وما لا يُجمع', () => {
    expect(PUBLIC_EVENTS_ACCEPTED_AR.length).toBeGreaterThan(5);
    expect(SITE_ANALYTICS_NEVER).toContain('عنوان IP');
    expect(SITE_ANALYTICS_NEVER).toContain('البريد الإلكتروني أو الاسم أو الهاتف');
    expect(SITE_ANALYTICS_COLLECTED.some((line) => line.includes('عشوائي'))).toBe(true);
    expect(SITE_EVENTS_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });

  it('وليس في الحدث حقلٌ يحمل قيمة شخصية (تُقاس الأسماء لا النوايا)', () => {
    const shape = Object.keys((siteEventSchema as unknown as { shape: Record<string, unknown> }).shape);
    // الحقول الخمسة **كلّها** معروفة: ما زاد عليها يُردّ في `parse` (والسبيك السابق يقيسه).
    expect(shape.sort()).toEqual(['locale', 'meta', 'name', 'path', 'visitor']);
    for (const forbidden of ['email', 'phone', 'fullName', 'ip', 'userAgent', 'referrer', 'address']) {
      expect(shape).not.toContain(forbidden);
    }
  });
});
