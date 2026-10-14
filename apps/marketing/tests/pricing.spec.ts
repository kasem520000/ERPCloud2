import { describe, expect, it } from 'vitest';

import {
  amountText,
  cellText,
  comparisonRows,
  countText,
  entitlementValueText,
  offersJsonLd,
  paymentGatewaysSource,
  paymentGatewaysText,
  planFamily,
  plansForInterval,
  pricingFaq,
  savingsFor,
  storageText,
  type PublicPlan,
} from '../lib/pricing';

/**
 * P-M3 — «الباقات والأسعار»: ما يقرؤه الزائر من جدول المقارنة
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * الاختبار هنا **خالص الحكم على البيانات**: بلا قاعدة بيانات وبلا خادم، لأن كل ما يُقاس
 * تحويلٌ من ردّ `/public/plans` إلى جدول. وما يحتاج قاعدة وخادماً (أن الباقة الموقوفة تختفي،
 * وأن السعر المعلن هو سعر القاعدة) يُقاس في `apps/api/test/public-plans.spec.ts` وفي
 * `scripts/verify-pricing.mjs` على خادمٍ يعمل.
 */

const plan = (over: Partial<PublicPlan> & Pick<PublicPlan, 'code'>): PublicPlan => ({
  id: `id-${over.code}`,
  name: over.name ?? over.code,
  interval: 'month',
  amount: '199.00',
  currency: 'SAR',
  monthlyAmount: '199.00',
  annualAmount: '2388.00',
  entitlements: [],
  ...over,
});

const limit = (key: string, value: number, labelAr = key, labelEn = key) => ({
  kind: 'limit' as const,
  key,
  value,
  labelAr,
  labelEn,
});

const pack = (key: string, value: boolean, labelAr: string, labelEn: string) => ({
  kind: 'module' as const,
  key,
  value,
  labelAr,
  labelEn,
});

const starter = plan({
  code: 'starter-monthly',
  name: 'الباقة الأساسية',
  entitlements: [limit('limits.max_users', 5, 'حدّ المستخدمين الافتراضي', 'Default user limit'), limit('limits.max_storage_mb', 2048)],
});

const pro = plan({
  code: 'pro-monthly',
  name: 'الباقة الاحترافية',
  amount: '499.00',
  monthlyAmount: '499.00',
  annualAmount: '5988.00',
  entitlements: [
    limit('limits.max_users', 25, 'حدّ المستخدمين الافتراضي', 'Default user limit'),
    pack('feature.pos', true, 'نقطة البيع', 'Point of sale'),
    pack('feature.niche', false, 'الأنشطة المتخصصة', 'Specialised activities'),
  ],
});

const proYearly = plan({
  code: 'pro-yearly',
  name: 'الباقة الاحترافية (سنوي)',
  interval: 'year',
  amount: '4990.00',
  monthlyAmount: '415.83',
  annualAmount: '4990.00',
  entitlements: pro.entitlements,
});

describe('marketing pricing table (P-M3)', () => {
  it('مبدّل الدورة يقسم الباقات بالدورة المعلنة', () => {
    const plans = [starter, pro, proYearly];
    expect(plansForInterval(plans, 'month').map((entry) => entry.code)).toEqual(['starter-monthly', 'pro-monthly']);
    expect(plansForInterval(plans, 'year').map((entry) => entry.code)).toEqual(['pro-yearly']);
  });

  it('يعرف الباقة الشهرية ونظيرها السنوي بالرمز لا بالفهرسة', () => {
    expect(planFamily({ code: 'pro-monthly' })).toBe(planFamily({ code: 'pro-yearly' }));
    expect(planFamily({ code: 'starter-monthly' })).not.toBe(planFamily({ code: 'pro-monthly' }));
  });

  it('يحسب التوفير من رقمين حقيقيين، ويسكت إن لم تكن السنوية أرخص', () => {
    const saving = savingsFor(proYearly, [starter, pro, proYearly])!;
    expect(saving.monthlyAnnualAmount).toBe('5988.00');
    expect(saving.yearlyAmount).toBe('4990.00');
    // (5988 − 4990) ÷ 5988 = 16.66…% ⇒ 17٪
    expect(saving.percent).toBe(17);

    // باقة سنوية بلا نظير شهري: لا توفير معلَن (لا رقم ننسبه إلى شيء).
    expect(savingsFor(proYearly, [proYearly])).toBeNull();
    // ونظيرٌ شهري ليس أرخص من السنوي: تُذكر الأرقام بلا نسبة.
    const expensiveYear = plan({ code: 'pro-yearly', interval: 'year', amount: '9999.00' });
    expect(savingsFor(expensiveYear, [pro, expensiveYear])?.percent).toBeNull();
  });

  it('كل حقٍّ في الباقة يظهر في الجدول — وصفوف المنتج المشتركة في ذيله', () => {
    const rows = comparisonRows([pro]);
    const keys = rows.map((row) => row.key);

    // الحدود الثمانية لها ترتيبها المعلن، والوحدات تأتي بعدها.
    expect(keys.indexOf('limits.max_users')).toBeLessThan(keys.indexOf('feature.pos'));
    expect(keys).toContain('feature.niche');
    // صفّ بوابات الدفع آخر صفّ، وهو صفّ قدرات المنتج لا حقٌّ في الباقة.
    const last = rows[rows.length - 1]!;
    expect(last.key).toBe('payments');
    expect(last.kind).toBe('capability');
    expect(rows.filter((row) => row.kind === 'entitlement').every((row) => row.kind === 'entitlement')).toBe(true);
  });

  it('حقٌّ جديد لا يسقط من الجدول: يظهر باسمه من الـAPI وبترتيبٍ ثابت', () => {
    const custom = plan({
      code: 'custom-monthly',
      entitlements: [limit('limits.max_warehouses', 3, 'حدّ المستودعات', 'Default warehouse limit')],
    });
    const rows = comparisonRows([custom, pro]);
    const row = rows.find((entry) => entry.key === 'limits.max_warehouses')!;

    // الاسم من الـAPI لا من قائمةٍ في الواجهة — وهذا ما يجعل إضافة حدٍّ في اللوحة تظهر هنا.
    expect(row.labelAr).toBe('حدّ المستودعات');
    expect(row.labelEn).toBe('Default warehouse limit');
    expect(row.format).toBe('count');
    expect(cellText(custom, row).text).toBe('3');
  });

  it('الخلية تُكتب بالوحدة الصحيحة وبـ«—» لما لا تملكه الباقة', () => {
    const rows = comparisonRows([starter, pro]);
    const users = rows.find((row) => row.key === 'limits.max_users')!;
    const storage = rows.find((row) => row.key === 'limits.max_storage_mb')!;
    const pos = rows.find((row) => row.key === 'feature.pos')!;

    expect(cellText(pro, users).text).toBe('25');
    expect(cellText(starter, users).text).toBe('5');
    // 2048 م.ب ⇒ 2 GB (قسمة على 1024 لا على 1000).
    expect(cellText(starter, storage).text).toBe('2 GB');
    // الباقة الأساسية لا تملك الوحدة: الشرطة لا الفراغ — الجدول يُظهر الغياب.
    expect(cellText(starter, pos).text).toBe('—');
    expect(cellText(pro, pos).text).toBe('✓');
  });

  it('بوابات الدفع صفٌّ بقدر المنتج الحقيقي ومصدره مذكور', () => {
    const rows = comparisonRows([starter, pro]);
    const gateways = rows.find((row) => row.key === 'payments')!;
    const cell = cellText(starter, gateways);

    expect(cell.text).toBe(paymentGatewaysText.ar);
    expect(cell.source).toBe(paymentGatewaysSource);
    // المصدر ملفٌّ حقيقي في المستودع (لا اسمٌ مُخترَع) — يُقاس على الاسم نفسه.
    expect(paymentGatewaysSource).toMatch(/^apps\/api\/src\/modules\/payments\/gateways\/index\.ts:\d+$/);
    // وهي مضمونة في الباقة الأدنى كما في الأعلى: القدرة في المنتج لا في السلّة.
    expect(cellText(pro, gateways).text).toBe(cell.text);
  });

  it('الأرقام تُنسَّق للعرض: مبالغ بمنزلتين، وحدود بفواصل، وتخزين بالغيغابايت', () => {
    expect(amountText('199.00', 'SAR', 'ar')).toBe('199.00 ر.س');
    expect(amountText('4990.00', 'SAR', 'en')).toBe('4,990.00 SAR');
    expect(countText(20000, 'ar')).toBe('20,000');
    expect(storageText(2048, 'ar')).toBe('2 GB');
    expect(storageText(1536, 'ar')).toBe('1.5 GB');
    // وقيمةٌ غريبة لا تُسقط الخلية: تعود كما هي.
    expect(amountText('غير رقمي', 'SAR', 'ar')).toBe('غير رقمي SAR');
  });

  it('حقٌّ منطقي وحقٌّ نصّي يُعرضان بلا كسر', () => {
    expect(entitlementValueText(pack('feature.pos', true, 'أ', 'A'), 'boolean')).toBe('✓');
    expect(entitlementValueText(pack('feature.pos', false, 'أ', 'A'), 'boolean')).toBe('—');
    expect(
      entitlementValueText(
        { kind: 'flag', key: 'x', value: 'manual', labelAr: 'أ', labelEn: 'A' },
        'boolean',
      ),
    ).toBe('manual');
  });

  it('أسئلة التسعير ثمانية بلغتين، ولا رقم ضريبة مكتوب فيها', () => {
    for (const locale of ['ar', 'en'] as const) {
      const items = pricingFaq(locale);
      expect(items).toHaveLength(8);
      expect(items.every((item) => item.question.length > 5 && item.answer.length > 20)).toBe(true);
    }
    // النسبة تُقرأ من `meta.vatRatePercent`؛ ولو كُتبت في نصّ السؤال لكذبت عند تغييرها.
    expect(pricingFaq('ar')[0]!.answer).not.toMatch(/15\s?٪|15%/);
  });

  it('البيانات المنظَّمة تُبنى من الباقات نفسها — عرضٌ لكل باقة ودورةٌ معلنة', () => {
    const jsonLd = offersJsonLd([starter, pro, proYearly], {
      siteUrl: 'https://erp.example.sa',
      path: '/pricing',
      brandName: 'ERP',
      locale: 'ar',
    })!;
    const offers = jsonLd.offers as Array<Record<string, unknown>>;

    expect(jsonLd['@type']).toBe('Product');
    expect(offers).toHaveLength(3);
    expect(offers[0]).toMatchObject({ price: '199.00', priceCurrency: 'SAR' });
    const yearlyOffer = offers.find((offer) => offer.name === 'الباقة الاحترافية (سنوي)') as {
      priceSpecification: { billingIncrement: number; unitCode: string };
    };
    expect(yearlyOffer.priceSpecification.billingIncrement).toBe(12);
    expect(yearlyOffer.priceSpecification.unitCode).toBe('MON');
    // بلا باقات لا بيانات منظَّمة مُختلقة.
    expect(offersJsonLd([], { siteUrl: '', path: '/pricing', brandName: 'ERP', locale: 'ar' })).toBeNull();
  });
});
