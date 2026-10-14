import { describe, expect, it } from 'vitest';

import {
  buildPlatformEntitlementKeys,
  platformAnnualAmount,
  platformDaysOverdue,
  platformDueDate,
  platformEntitlementKindOf,
  platformEntitlementValueFits,
  platformMonthlyAmount,
  platformPlanEntitlementInputSchema,
  publicPlanSchema,
  platformProration,
} from './billing.js';
import { billingDunningLadder, isSellerTaxNumber } from './console.js';

/**
 * قواعد الحساب التي يقوم عليها `/plans` و`/invoices` و`/revenue` — تُختبر هنا بلا قاعدة
 * بيانات، لأن خطأها لا يظهر في شاشة: يظهر في رقمٍ على فاتورة.
 */
describe('P-C4 money and calendar rules', () => {
  it('normalises a yearly price to its monthly equivalent (MRR base)', () => {
    expect(platformMonthlyAmount('499.00', 'month')).toBe('499.00');
    // 4990 ÷ 12 = 415.8333… → HALF_UP بمقياس الفلسين
    expect(platformMonthlyAmount('4990.00', 'year')).toBe('415.83');
    expect(platformAnnualAmount('415.83')).toBe('4989.96');
  });

  it('computes proration from the plan prices, not from a monthly guess', () => {
    const proration = platformProration({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      at: '2026-09-16',
      fromPlan: { code: 'starter-monthly', amount: '199.00', interval: 'month' },
      toPlan: { code: 'pro-monthly', amount: '499.00', interval: 'month' },
      currency: 'SAR',
    });

    expect(proration.periodDays).toBe(29);
    expect(proration.remainingDays).toBe(14);
    // رصيد: 199 × 14/29 = 96.0689… → 96.07 · مقابل: سعر الباقة الجديدة كاملاً (شهرٌ جديد يبدأ الآن)
    expect(proration.credit).toBe('96.07');
    expect(proration.charge).toBe('499.00');
    expect(proration.net).toBe('402.93');
  });

  it('yields a negative net (a credit note) when the customer downgrades', () => {
    const proration = platformProration({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      at: '2026-09-16',
      fromPlan: { code: 'pro-monthly', amount: '499.00', interval: 'month' },
      toPlan: { code: 'starter-monthly', amount: '199.00', interval: 'month' },
      currency: 'SAR',
    });
    // تخفيض: 499 × 14/29 = 240.8965… → 240.90 رصيداً، ومقابل 199.00 ⇒ إشعار دائن.
    expect(proration.credit).toBe('240.90');
    expect(proration.net).toBe('-41.90');

    // آخر يوم في المدة، وباقةٌ مختلفة: الرصيد صفر (لا أيام متبقّية) والمقابل كامل ⇒ فرقٌ
    // موجب. ولا يُصدر المستند إلا إذا كان الفرق ≥ فلساً واحداً (شرط الخدمة).
    const lastDay = platformProration({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      at: '2026-09-30',
      fromPlan: { code: 'pro-monthly', amount: '499.00', interval: 'month' },
      toPlan: { code: 'starter-monthly', amount: '199.00', interval: 'month' },
      currency: 'SAR',
    });
    expect(lastDay.remainingDays).toBe(0);
    expect(lastDay.credit).toBe('0.00');
    expect(lastDay.net).toBe('199.00');
  });

  it('keeps the money scale exact through the parse/format round trip', () => {
    const proration = platformProration({
      periodStart: '2026-01-01',
      periodEnd: '2027-01-01',
      at: '2026-07-01',
      fromPlan: { code: 'pro-yearly', amount: '4990.00', interval: 'year' },
      toPlan: { code: 'pro-monthly', amount: '499.00', interval: 'month' },
      currency: 'SAR',
    });
    // سنة كاملة (365 يوماً) وبقي نصفها: رصيد 4990 × 184/365 = 2515.5068… → 2515.51،
    // والمقابل شهرٌ واحد كامل (499.00) لأن المدة الشهرية الجديدة تبدأ اليوم ⇒ إشعار دائن
    // على الفرق: العميل دفع سنةً ولم يستهلك إلا نصفها.
    expect(proration.periodDays).toBe(365);
    expect(proration.remainingDays).toBe(184);
    expect(proration.credit).toBe('2515.51');
    expect(proration.charge).toBe('499.00');
    expect(proration.net).toBe('-2016.51');
  });

  it('derives the due date and the days overdue', () => {
    expect(platformDueDate('2026-09-17', 14)).toBe('2026-10-01');
    expect(platformDueDate('2026-12-25', 10)).toBe('2027-01-04');
    expect(platformDaysOverdue('2026-09-01', new Date('2026-09-17T10:00:00Z'))).toBe(16);
    expect(platformDaysOverdue('2026-10-01', new Date('2026-09-17T10:00:00Z'))).toBe(0);
    expect(platformDaysOverdue(null)).toBe(0);
  });
});

describe('P-C4 entitlement keys', () => {
  it('maps a key family to its kind', () => {
    expect(platformEntitlementKindOf('feature.pos')).toBe('module');
    expect(platformEntitlementKindOf('limits.max_branches')).toBe('limit');
    expect(platformEntitlementKindOf('branding.sender_name')).toBe('flag');
  });

  it('reads the seller VAT number and the dunning ladder defensively', () => {
    expect(isSellerTaxNumber('300000000000003')).toBe(true);
    expect(isSellerTaxNumber('')).toBe(true);
    expect(isSellerTaxNumber('30000000000003')).toBe(false);
    expect(isSellerTaxNumber('30000000000000x')).toBe(false);
    // سلّم المتابعة: يُرتَّب، يُنقّى من التكرار والسالب، ويُقرأ من نصّ الإعدادات.
    expect(billingDunningLadder(['7', '0', '3', '3'])).toEqual([0, 3, 7]);
    expect(billingDunningLadder(['-1', 'x', '2'])).toEqual([2]);
    expect(billingDunningLadder([])).toEqual([]);
  });

  it('knows every entitlement the product actually has, and nothing else', () => {
    // سجلّ العميل يأتي من `@erp/config` بحقنٍ من الطبقة الأعلى (`contracts` لا يعتمد على
    // `config`)، فهنا سجلٌّ مصغّر بنفس الشكل — والقاعدة المُختبرة هي القاعدة نفسها.
    const keys = buildPlatformEntitlementKeys([
      { key: 'feature.pos', description: 'نقطة البيع', defaultValue: false },
      { key: 'locale.code', description: 'لغة', defaultValue: 'ar' },
      { key: 'limits.max_branches', description: 'نسخة عميل تُتجاهل', defaultValue: 1 },
    ]);
    const byKey = new Map(keys.map((entry) => [entry.key, entry]));

    expect(byKey.get('feature.pos')).toMatchObject({ kind: 'module', valueKind: 'boolean', registry: 'tenant' });
    // سلسلةٌ ليست وحدة (`locale.code`) لا تصير حقًّا: الحقوق وحداتٌ وحدودٌ ورايات.
    expect(byKey.has('locale.code')).toBe(false);
    // ولا هويةُ البائع: `billing.*` إعدادُ المنصة لا حقٌّ في باقة (P-C4).
    expect(byKey.has('billing.seller_name')).toBe(false);
    expect(byKey.has('branding.primary_color')).toBe(false);
    // وحدود سجلّ إعدادات المنصة ذات نطاق العميل تدخل من السجل الثاني (وهو في هذا الملف).
    expect(byKey.get('limits.max_branches')).toMatchObject({ kind: 'limit', valueKind: 'number', registry: 'platform' });
    expect(byKey.get('limits.max_branches')?.max).toBe(10_000);
    expect(byKey.get('limits.max_invoices_per_month')?.max).toBe(10_000_000);
    // ولا شيء خارج السجلّين: مفتاحٌ غير معروف لا يمكن أن يصير حقًّا.
    expect(byKey.has('feature.nope')).toBe(false);
  });

  it('gives every entitlement an English label too — the public pricing page reads both (P-M3)', () => {
    const keys = buildPlatformEntitlementKeys([
      // وصف السجلّ إنجليزيّ (كما في `@erp/config`)، والاسم المكتوب في `tenantFlagLabels` عربيٌّ
      // وإنجليزي — فيُقدَّم المكتوب، ويبقى الوصف احتياطاً.
      { key: 'feature.pos', description: 'Restaurant/retail POS pack.', defaultValue: false },
      { key: 'feature.unknown-pack', description: 'A pack with no label yet.', defaultValue: false },
    ]);
    const byKey = new Map(keys.map((entry) => [entry.key, entry]));

    expect(byKey.get('feature.pos')).toMatchObject({ labelAr: 'نقطة البيع', labelEn: 'Point of sale' });
    // ومفتاحٌ جديد لم تُكتب تسميته بعد لا يُسقط الصفحة: يحمل وصفه في اللغتين بدل الفراغ.
    expect(byKey.get('feature.unknown-pack')).toMatchObject({
      labelAr: 'A pack with no label yet.',
      labelEn: 'A pack with no label yet.',
    });
    // وكل مفتاح من سجلّ إعدادات المنصة له اسمان — الشرط معلَّقٌ على السجلّين معاً.
    expect(keys.every((entry) => entry.labelAr.length > 0 && entry.labelEn.length > 0)).toBe(true);
  });

  it('validates the public plan shape the pricing page consumes, and hides what it must', () => {
    const plan = publicPlanSchema.parse({
      id: '01a0b19f-d890-7398-b02d-d03bed0c9f65',
      code: 'pro-yearly',
      name: 'الباقة الاحترافية (سنوي)',
      interval: 'year',
      amount: '4990.00',
      currency: 'SAR',
      monthlyAmount: '415.83',
      annualAmount: '4990.00',
      entitlements: [
        { kind: 'module', key: 'feature.pos', value: true, labelAr: 'نقطة البيع', labelEn: 'Point of sale' },
      ],
    });
    expect(plan.entitlements[0]!.labelEn).toBe('Point of sale');
    // لا حقلَ مزوّد الدفع في العقد العام: لو أُضيف لَمرّ من هنا فوراً.
    expect(Object.keys(publicPlanSchema.shape)).not.toContain('stripePriceId');
    expect(() => publicPlanSchema.parse({ ...plan, monthlyAmount: 415.83 })).toThrow();
  });

  it('refuses a value that does not fit its key', () => {
    expect(platformEntitlementValueFits('boolean', true)).toBe(true);
    expect(platformEntitlementValueFits('boolean', 1)).toBe(false);
    expect(platformEntitlementValueFits('number', 3)).toBe(true);
    expect(platformEntitlementValueFits('number', '3')).toBe(false);
  });

  it('validates the entitlement input shape', () => {
    expect(platformPlanEntitlementInputSchema.safeParse({ kind: 'module', key: 'feature.pos', value: true }).success).toBe(true);
    expect(platformPlanEntitlementInputSchema.safeParse({ kind: 'nope', key: 'feature.pos', value: true }).success).toBe(false);
    expect(platformPlanEntitlementInputSchema.safeParse({ kind: 'limit', key: '', value: 3 }).success).toBe(false);
  });
});
