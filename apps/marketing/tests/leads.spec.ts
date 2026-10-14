import { describe, expect, it } from 'vitest';
import {
  LEAD_HONEYPOT_FIELD,
  leadCreateSchema,
  normalizeLeadEmail,
  subscriberCreateSchema,
  utmFromSearch,
} from '@erp/contracts';

import {
  emptyLeadDraft,
  leadFormConfig,
  leadPayload,
  leadProblemMessage,
  leadSuccessMessage,
  leadUtm,
  leadVerdict,
  sanitizeBranchCount,
  type LeadDraft,
} from '../lib/leads';

/**
 * P-M6 — استمارات الموقع التسويقي (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * ما يُقاس هنا هو **ما لا يحتاج متصفّحاً**: هل تُبنى الحمولة كما يتوقّعها الـAPI؟ هل تُعرض
 * الأخطاء بجانب حقولها؟ هل تُلتقط وسوم الحملة؟ وهل المصيدة تُرسَل فعلاً (فالقاعدة: من لا
 * **يرسل** المصيدة لا يعمل عنده الحرس)؟
 */
describe('marketing lead forms (P-M6)', () => {
  const filled = (overrides: Partial<LeadDraft> = {}): LeadDraft => ({
    ...emptyLeadDraft,
    fullName: 'سالم العمري',
    companyName: 'مؤسسة النور',
    email: 'Salem@Company.TEST',
    phone: '0500000000',
    branchCount: '3',
    message: 'نحتاج فواتير ضريبية وربطاً بالمخزون لثلاثة فروع.',
    acceptsMarketing: true,
    ...overrides,
  });

  it('الاستمارتان: المصدر من الإعداد لا من حقلٍ يرسله الزائر', () => {
    expect(leadFormConfig.form.source).toBe('form');
    expect(leadFormConfig.demo.source).toBe('demo');
    expect(leadFormConfig.demo.headingAr).toBe('اطلب عرضاً');
    // والسؤال يختلف: طلب العرض يسأل عمّا يُراد رؤيته لا عمّا يُحتاج.
    expect(leadFormConfig.demo.messageLabelAr).not.toBe(leadFormConfig.form.messageLabelAr);
  });

  it('الحمولة المبنية تُقبل بمخطّط الـAPI نفسه — البريد مُطبَّعاً والفراغ ساقطاً', () => {
    const payload = leadPayload(filled());
    const parsed = leadCreateSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(payload.email).toBe('salem@company.test');
    expect(payload.branchCount).toBe(3);

    const minimal = leadPayload({ ...emptyLeadDraft, fullName: 'سالم', email: 'a@b.test', message: 'عشرة أحرف على الأقل.' });
    expect(minimal.companyName).toBeUndefined();
    expect(minimal.phone).toBeUndefined();
    expect(minimal.branchCount).toBeUndefined();
    expect(minimal.utm).toBeUndefined();
  });

  it('المصيدة تُرسَل دوماً — ولو لم تُرسَل لما عمل الحرس على الخادم', () => {
    expect(leadPayload(filled())[LEAD_HONEYPOT_FIELD]).toBe('');
    expect(leadPayload(filled({ [LEAD_HONEYPOT_FIELD]: 'http://spam' }))[LEAD_HONEYPOT_FIELD]).toBe('http://spam');
  });

  it('الحكم: رسالةٌ سببٌ بجانب الحقل لا في رأس الاستمارة', () => {
    expect(leadVerdict(filled())).toEqual({ ok: true });

    const noName = leadVerdict(filled({ fullName: 'س' }));
    expect(noName.ok).toBe(false);
    expect(noName.ok === false && noName.field).toBe('fullName');

    const badEmail = leadVerdict(filled({ email: 'salem@' }));
    expect(badEmail.ok === false && badEmail.field).toBe('email');

    const shortMessage = leadVerdict(filled({ message: 'قصيرة' }));
    expect(shortMessage.ok === false && shortMessage.field).toBe('message');
    expect(shortMessage.ok === false && shortMessage.message.length).toBeGreaterThan(4);
  });

  it('حكم المصيدة لا يوقف الزائر: الحقل المخفيّ لا يُقيَّد على العميل', () => {
    // الحكم يقيس ما يملؤه الإنسان؛ والمصيدة قرارُ الخادم (202 صامتة) لأن إيقاف الإرسال عند
    // ملئها يُعلّم الماسح أنها كانت فخّاً.
    expect(leadVerdict(filled({ [LEAD_HONEYPOT_FIELD]: 'x' }))).toEqual({ ok: true });
  });

  it('وسوم الحملة: من الرابط، والمرجع الخارجي وحده يُحتسب', () => {
    const utm = leadUtm({
      search: '?utm_source=google&utm_medium=cpc&utm_campaign=ramadan&utm_term=',
      referrer: 'https://www.google.com/search',
      pathname: '/contact',
      host: 'erp.example',
    });
    expect(utm.source).toBe('google');
    expect(utm.medium).toBe('cpc');
    expect(utm.landingPath).toBe('/contact');
    expect(utm.referrer).toBe('https://www.google.com/search');

    // تنقّل داخلي: `/pricing` → `/contact` ليس مصدر حملة.
    const internal = leadUtm({ referrer: 'https://erp.example/pricing', pathname: '/contact', host: 'erp.example' });
    expect(internal.referrer).toBeUndefined();
    expect(internal.landingPath).toBe('/contact');

    // ولا مرجع مكسور يُسقط الإرسال.
    expect(leadUtm({ referrer: 'not a url', pathname: '/demo' }).referrer).toBeUndefined();
    expect(utmFromSearch('?utm_source=')).toEqual({});
  });

  it('رسائل الأعطال: 429 تقول «انتظر» لا «فشل»، والتحقّق يشير إلى الحقول', () => {
    expect(leadProblemMessage(429)).toContain('انتظر');
    expect(leadProblemMessage(400, 'VALIDATION_FAILED')).toContain('راجع');
    expect(leadProblemMessage(400, 'VALIDATION_FAILED', 'البريد غير صالح')).toContain('البريد');
    expect(leadProblemMessage(0)).toContain('الاتصال');
    expect(leadProblemMessage(500)).toContain('أعد المحاولة');
  });

  it('بعد النجاح: بطاقةٌ فيها المرجع — لا استمارةٌ فارغة تترك الزائر شاكّاً', () => {
    const success = leadSuccessMessage('L-3F9A2C1D4E5F');
    expect(success.reference).toBe('L-3F9A2C1D4E5F');
    expect(success.titleAr).toContain('وصلنا');
    expect(success.bodyAr).toContain('يوم عمل');
  });

  it('عدد الفروع أرقامٌ فقط، والتطبيع يقبل ما يكتبه الناس فعلاً', () => {
    expect(sanitizeBranchCount('12 فرعاً')).toBe('12');
    expect(sanitizeBranchCount('abc')).toBe('');
    expect(normalizeLeadEmail('  SALEM@Company.TEST ')).toBe('salem@company.test');
  });

  it('النشرة: البريد وحده مطلوب، والمصيدة تُرسَل معه', () => {
    const parsed = subscriberCreateSchema.safeParse({ email: 'News@Company.TEST' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBe('news@company.test');
    // الحالة ليست حقلاً يرسله الزائر: تُكتب في الخدمة (`pending`) ولا تُقبل من الإنترنت.
    expect(parsed.success && 'status' in parsed.data).toBe(false);
    expect(subscriberCreateSchema.safeParse({ email: 'bad' }).success).toBe(false);
  });
});
