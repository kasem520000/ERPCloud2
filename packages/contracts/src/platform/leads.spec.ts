import { describe, expect, it } from 'vitest';

import {
  LEAD_HONEYPOT_FIELD,
  isHoneypotFilled,
  isLeadClosed,
  leadCreateSchema,
  leadDedupeKey,
  leadDisplayName,
  leadListQuerySchema,
  leadPatchSchema,
  leadSourceLabelsAr,
  leadSources,
  leadStatusLabelsAr,
  leadStatuses,
  leadTransitionAllowed,
  leadTransitions,
  normalizeLeadEmail,
  publicLeadSources,
  subscriberCreateSchema,
  utmFromSearch,
  utmIsEmpty,
} from './leads.js';

/**
 * عقد العملاء المتوقّعين (P-M6) — ما يُختبَر هنا **ما لا يحتاج قاعدة**: الفهرس، والانتقالات،
 * والتطبيع، والمصيدة، ووسوم الحملة. أمّا السلوك (حفظٌ وإسنادٌ وتحويلٌ ومنعُ تكرار) ففي
 * `apps/api/test/public-leads.spec.ts`، والحماية الحيّة في `scripts/verify-leads.mjs`.
 */
describe('lead contract (P-M6)', () => {
  it('الحالات الخمس والمصادر الخمسة بأسمائها العربية', () => {
    expect(leadStatuses).toEqual(['new', 'contacted', 'qualified', 'won', 'rejected']);
    expect(leadSources).toEqual(['form', 'demo', 'newsletter', 'campaign', 'manual']);
    for (const status of leadStatuses) {
      expect(leadStatusLabelsAr[status]?.length, status).toBeGreaterThan(1);
    }
    for (const source of leadSources) {
      expect(leadSourceLabelsAr[source]?.length, source).toBeGreaterThan(1);
    }
    // العامّ لا يكتب «مباشر» ولا «حملة»: تلك وسومٌ تُكتب من اللوحة أو من مزامنة.
    expect(publicLeadSources).toEqual(['form', 'demo', 'newsletter']);
  });

  it('الانتقالات محدودة، والحالة النهائية لا تعود', () => {
    expect(leadTransitionAllowed('new', 'contacted')).toBe(true);
    expect(leadTransitionAllowed('contacted', 'qualified')).toBe(true);
    expect(leadTransitionAllowed('qualified', 'won')).toBe(true);
    expect(leadTransitionAllowed('won', 'contacted')).toBe(false);
    expect(leadTransitionAllowed('rejected', 'qualified')).toBe(false);
    // والحالة نفسها ليست انتقالاً: تعديل ملاحظةٍ لا يُشترط له أن يكون تغيير حالة.
    expect(leadTransitionAllowed('new', 'new')).toBe(true);
    expect(isLeadClosed('won')).toBe(true);
    expect(isLeadClosed('rejected')).toBe(true);
    expect(isLeadClosed('new')).toBe(false);
    // ولا حلقة: كلُّ انتقالٍ يقود إلى الأمام لا إلى الخلف.
    expect(leadTransitions.won).toHaveLength(0);
    expect(leadTransitions.rejected).toHaveLength(0);
  });

  it('المصيدة: أي محتوى في الحقل المخفيّ يعني طلباً آلياً', () => {
    expect(LEAD_HONEYPOT_FIELD).toBe('website');
    expect(isHoneypotFilled({ email: 'a@b.test' })).toBe(false);
    expect(isHoneypotFilled({ [LEAD_HONEYPOT_FIELD]: '   ' })).toBe(false);
    expect(isHoneypotFilled({ [LEAD_HONEYPOT_FIELD]: 'http://spam.example' })).toBe(true);
  });

  it('التطبيع: عنوانٌ واحد مهما كُتب، والاسم المعروض لا يفرغ', () => {
    expect(normalizeLeadEmail('  Ali@Example.TEST ')).toBe('ali@example.test');
    expect(leadDedupeKey('Ali@Example.TEST')).toBe('ali@example.test');
    expect(leadDisplayName({ fullName: '  سالم  ', email: 'a@b.test' })).toBe('سالم');
    expect(leadDisplayName({ fullName: '   ', companyName: 'مؤسسة النور', email: 'a@b.test' })).toBe('مؤسسة النور');
    expect(leadDisplayName({ email: 'Ali@B.test' })).toBe('ali@b.test');
  });

  it('الاستمارة تقبل ما يُملأ في الموقع وترفض ما لا يُقبل', () => {
    const good = leadCreateSchema.parse({
      fullName: 'سالم العمري',
      email: 'SALEM@Leads.Test',
      message: 'أريد عرضاً لفروعنا الثلاثة قبل نهاية الشهر.',
    });
    expect(good.email).toBe('salem@leads.test');
    expect(good.locale).toBe('ar');
    expect(good.source).toBe('form');
    expect(good.acceptsMarketing).toBe(false);

    expect(leadCreateSchema.safeParse({ fullName: 'س', email: 'x', message: 'قصيرة' }).success).toBe(false);
    // الرسالة بلا حدٍّ أعلى تصير قناةً لبثّ نصٍّ ضخم في جدولنا؛ والحدّ في العقد لا في الشاشة.
    expect(
      leadCreateSchema.safeParse({ fullName: 'سالم', email: 'a@b.test', message: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('تعديل الطلب بلا تغيير يُرفض، وبسببٍ قصيرٍ جداً يُرفض السبب لا الحالة', () => {
    expect(leadPatchSchema.safeParse({}).success).toBe(false);
    expect(leadPatchSchema.safeParse({ status: 'contacted' }).success).toBe(true);
    expect(leadPatchSchema.safeParse({ status: 'contacted', reason: 'س' }).success).toBe(false);
    expect(leadPatchSchema.safeParse({ status: 'contacted', reason: 'اتصلنا ولم يجب' }).success).toBe(true);
  });

  it('`unassigned=false` لا تنقلب إلى «صحيح» (فخّ z.coerce.boolean)', () => {
    expect(leadListQuerySchema.parse({}).unassigned).toBeUndefined();
    expect(leadListQuerySchema.parse({ unassigned: 'true' }).unassigned).toBe(true);
    expect(leadListQuerySchema.parse({ unassigned: 'false' }).unassigned).toBe(false);
    expect(leadListQuerySchema.parse({}).limit).toBeGreaterThan(0);
    expect(leadListQuerySchema.parse({ mine: 'true' }).mine).toBe(true);
  });

  it('النشرة: بريدٌ واحد والباقي افتراضات معلنة', () => {
    const parsed = subscriberCreateSchema.parse({ email: ' NEWS@Leads.Test ' });
    expect(parsed.email).toBe('news@leads.test');
    expect(parsed.source).toBe('newsletter');
    expect(parsed.locale).toBe('ar');
  });

  it('وسوم الحملة تُقرأ من الرابط بحدودٍ قصيرة والفارغ يسقط', () => {
    const utm = utmFromSearch(
      '?utm_source=google&utm_medium=cpc&utm_campaign=ramadan&utm_term=&ref=https://news.example/x&path=/pricing',
    );
    expect(utm).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'ramadan',
      referrer: 'https://news.example/x',
      landingPath: '/pricing',
    });
    expect(utm.term).toBeUndefined();
    expect(utmIsEmpty(utm)).toBe(false);
    expect(utmIsEmpty(utmFromSearch('?foo=bar'))).toBe(true);
    // الحدّ يُقصّ ولا يرفض: وسمُ حملةٍ طويل لا يُسقط طلباً.
    expect(utmFromSearch(`?utm_source=${'x'.repeat(300)}`).source).toHaveLength(80);
  });
});
