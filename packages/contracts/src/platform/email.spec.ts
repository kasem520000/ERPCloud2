import { describe, expect, it } from 'vitest';

import { DomainError } from '../problem.js';

import {
  emailEventRegistry,
  emailEvents,
  emailRetrySchema,
  emailSettingsPatchKeys,
  emailSettingsUpdateSchema,
  emailTemplateCreateSchema,
  emailTemplateSeeds,
  emailVariablesIn,
  renderEmailTemplate,
  tenantEmailTemplateUpdateSchema,
} from './email.js';

/**
 * عقد خدمة البريد (P-C6). ما يُختبَر هنا **ما لا يحتاج قاعدة**: الفهرس، والبذور، والتصيير.
 * أما السلوك (حجرٌ يمنع، حصةٌ ترفض، إعادة إرسال) ففي `apps/api/test/platform-email.spec.ts`.
 */
describe('email event registry (P-C6)', () => {
  it('freezes the twenty-two events the plan lists', () => {
    // ثمانية عشر نصّاً في خطة P-C6، وتاسعَ عشرَ أضافه P-M4: `signup.verify` — رمز تحقّق
    // التسجيل الذاتي، ولا سبيل لإنشاء حسابٍ من الموقع بلا حدثٍ يحمل الرمز.
    // وعشرونَ وحادي وعشرونَ أضافهما P-M6: `lead.received` (وصلنا طلبك) و`subscriber.confirm`
    // (رابط التأكيد المزدوج) — فاستمارةُ تواصلٍ لا تُجيب ولا نشرةٌ تُشترط بلا حدثَين.
    // والثاني والعشرون أضافه P-M7: `campaign.message` — نصُّ الحملة ظرفٌ لا محتوى
    // (المحتوى في صفّ الحملة)، وهو حدثُ منصّةٍ كسابقَيه.
    expect(emailEvents).toHaveLength(23);
    expect(new Set(emailEvents).size).toBe(23);
    expect(emailEventRegistry.find((entry) => entry.event === 'comment.mention')?.scope).toBe('tenant');
    expect(emailEvents).toContain('portal.access.grant');
    expect(emailEvents).toContain('subscription.payment_failed');
    expect(emailEvents).toContain('announcement');
    // التقرير الأسبوعي حدثُ منصّة: لا يُحتسب على حصّة أي منشأة (وإلا لظهر في فاتورتها).
    expect(emailEventRegistry.find((entry) => entry.event === 'report.weekly')?.scope).toBe('platform');
    // وكذلك رمز التسجيل: الزائر ليس عميلاً بعد، فلا حصّة عميلٍ تُحتسب عليه.
    expect(emailEventRegistry.find((entry) => entry.event === 'signup.verify')?.scope).toBe('platform');
    // وكذلك حدثا P-M6: الزائر لم يُصبح عميلاً بعد، فلا حصّة عميلٍ تُحتسب عليهما.
    expect(emailEventRegistry.find((entry) => entry.event === 'lead.received')?.scope).toBe('platform');
    expect(
      emailEventRegistry.find((entry) => entry.event === 'subscriber.confirm')?.scope,
    ).toBe('platform');
  });

  it('gives every event a unique key, an Arabic label and variables', () => {
    const keys = emailEventRegistry.map((entry) => entry.event);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of emailEventRegistry) {
      expect(entry.labelAr.length).toBeGreaterThan(1);
      expect(entry.variables.length).toBeGreaterThan(0);
      // كل حدثٍ يخاطب إنساناً باسمه — إلا اثنين، ولكلٍّ سببه:
      //   * التقرير الأسبوعي: وجهتُه عناوين مشغّلين بلا أسماء معروفة.
      //   * رسالة الحملة: التحية في **متن الحملة** (`{{name}}` في نصّ المشغّل)، والقالب
      //     ظرفٌ يضيف رابط إلغاء الاشتراك — ولو خاطب باسمه لَظهرت التحية مرّتين.
      if (entry.event !== 'report.weekly' && entry.event !== 'campaign.message') {
        expect(entry.variables).toContain('name');
      }
      // المتغيّرات لاتينية صغيرة: `{{invoiceNo}}` يُقرأ بشكلين ويُكتب بشكلين.
      for (const variable of entry.variables) expect(variable).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('email template seeds (P-C6)', () => {
  it('has an Arabic and an English seed for every event', () => {
    for (const event of emailEvents) {
      for (const locale of ['ar', 'en'] as const) {
        const seed = emailTemplateSeeds.find((entry) => entry.event === event && entry.locale === locale);
        expect(seed, `${event}/${locale} must have a seed`).toBeDefined();
        expect(seed?.subject.length ?? 0).toBeGreaterThan(1);
        expect(seed?.body.length ?? 0).toBeGreaterThan(10);
      }
    }
  });

  it('never uses a variable outside the event catalogue', () => {
    for (const seed of emailTemplateSeeds) {
      const definition = emailEventRegistry.find((entry) => entry.event === seed.event);
      const allowed = new Set(definition?.variables ?? []);
      const used = emailVariablesIn(seed.subject, seed.body);
      const unknown = used.filter((name) => !allowed.has(name));
      expect(unknown, `${seed.event}/${seed.locale} uses unknown variables`).toEqual([]);
      // وكل متغيّر معلَن مُستعمل فعلاً: متغيّرٌ لا يظهر في أي نصٍّ زخرفةٌ تُربك المحرّر.
      const unused = [...allowed].filter((name) => !used.includes(name));
      expect(unused, `${seed.event}/${seed.locale} declares unused variables`).toEqual([]);
    }
  });
});

describe('renderEmailTemplate (P-C6)', () => {
  it('replaces {{variables}} with their values', () => {
    const rendered = renderEmailTemplate('فاتورة {{invoice_no}} بمبلغ {{amount}}', {
      invoice_no: 'PINV-00042',
      amount: '499.00',
    });
    expect(rendered).toBe('فاتورة PINV-00042 بمبلغ 499.00');
  });

  it('tolerates spacing inside the braces', () => {
    expect(renderEmailTemplate('مرحباً {{ name }}', { name: 'سارة' })).toBe('مرحباً سارة');
  });

  it('names every missing variable in one explicit error', () => {
    let error: DomainError | undefined;
    try {
      renderEmailTemplate('{{name}} — {{amount}} — {{due}}', { name: 'سارة' }, 'invoice.created');
    } catch (caught) {
      error = caught as DomainError;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.status).toBe(400);
    const detail = (error?.details as { missing?: string[] } | undefined)?.missing ?? [];
    expect(detail.sort()).toEqual(['amount', 'due']);
    expect(error?.message).toContain('{{amount}}');
    expect(error?.message).toContain('{{due}}');
  });

  it('refuses a variable the event does not declare', () => {
    let error: DomainError | undefined;
    try {
      renderEmailTemplate('{{name}} {{secret}}', { name: 'سارة', secret: 'x' }, 'user.invite');
    } catch (caught) {
      error = caught as DomainError;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.status).toBe(400);
    expect(error?.message).toContain('{{secret}}');
  });

  it('treats an empty string as missing rather than rendering a hole', () => {
    expect(() => renderEmailTemplate('{{tenant}}', { tenant: '' }, 'user.invite')).toThrow(DomainError);
  });
});

describe('emailVariablesIn (P-C6)', () => {
  it('returns unique variables in order of appearance', () => {
    expect(emailVariablesIn('{{b}} {{a}} {{b}}', '{{c}}')).toEqual(['b', 'a', 'c']);
  });

  it('ignores braces that are not variables', () => {
    expect(emailVariablesIn('{ سعر } و {{ok}}')).toEqual(['ok']);
  });
});

describe('email payload schemas (P-C6)', () => {
  it('refuses an unknown field in a tenant template override', () => {
    expect(tenantEmailTemplateUpdateSchema.safeParse({ event: 'user.invite', body: 'x' }).success).toBe(false);
    expect(tenantEmailTemplateUpdateSchema.safeParse({ body: 'x' }).success).toBe(true);
    expect(tenantEmailTemplateUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an empty settings update and a bad sending domain', () => {
    expect(emailSettingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(emailSettingsUpdateSchema.safeParse({ sendingDomain: 'not a domain' }).success).toBe(false);
    expect(emailSettingsUpdateSchema.safeParse({ sendingDomain: 'erp.example.com' }).success).toBe(true);
    expect(emailSettingsUpdateSchema.safeParse({ provider: 'sendgrid' }).success).toBe(false);
  });
});

describe('مخططات الحمولة للبريد', () => {
  it('إنشاء القالب يفرض الحدث واللغة، والسبب مطلوب', () => {
    const base = { subject: 'موضوع', body: 'نصّ', reason: 'سبب التعديل' };
    expect(emailTemplateCreateSchema.safeParse({ ...base, event: 'user.invite' }).success).toBe(true);
    expect(
      emailTemplateCreateSchema.safeParse({ ...base, event: 'user.invite', locale: 'en' }).success,
    ).toBe(true);
    expect(emailTemplateCreateSchema.safeParse(base).success).toBe(false);
    expect(
      emailTemplateCreateSchema.safeParse({ ...base, event: 'حدث_غير_معروف' }).success,
    ).toBe(false);
  });

  it('إعدادات البريد: `reason` وحده ليس تعديلاً، والحقول المعلَنة هي المسموح', () => {
    expect(emailSettingsUpdateSchema.safeParse({ reason: 'سبب طويل كفاية' }).success).toBe(false);
    expect(emailSettingsUpdateSchema.safeParse({ dailyLimit: 50, reason: 'سقف مؤقت' }).success).toBe(true);
    expect(emailSettingsUpdateSchema.safeParse({ provider: 'console' }).success).toBe(true);
    expect(emailSettingsUpdateSchema.safeParse({ provider: 'ses' }).success).toBe(false);
    expect(emailSettingsUpdateSchema.safeParse({ unknownField: 1 }).success).toBe(false);
    expect(emailSettingsPatchKeys).toContain('monthlyLimit');
  });

  it('سبب إعادة المحاولة مطلوب ولا يقبل نصّاً قصيراً', () => {
    expect(emailRetrySchema.safeParse({ reason: 'أُصلح المزوّد' }).success).toBe(true);
    expect(emailRetrySchema.safeParse({}).success).toBe(false);
    expect(emailRetrySchema.safeParse({ reason: 'لا' }).success).toBe(false);
  });
});
