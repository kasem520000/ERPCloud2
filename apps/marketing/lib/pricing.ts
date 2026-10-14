/**
 * P-M3 — «الباقات والأسعار» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * هذا الملف هو **ما بين الـAPI والصفحة**: يقرأ `GET /public/plans` (بلا جلسة، من الخادم كما
 * في `lib/content.ts`) ثم يرتّب ما قرأه لجدول مقارنة. وثلاثة قرارات في مكانها هنا:
 *
 *   1. **لا سعر مكتوب في هذا الملف.** الأسعار والدورة والحقوق كلّها من القاعدة، والمشغّل
 *      يعدّلها من لوحة المنصة فتَظهر. ولو كُتب رقمٌ هنا لَكذبت الصفحة في أول تعديل.
 *   2. **تسميات الجدول القصيرة فقط** («المستخدمون» · «فواتير/شهر») مكتوبة هنا، وهي حرفياً
 *      عناوين جدول المقارنة في نصّ الجزء P-M3؛ وتسمية كل حقٍّ تبقى من الـAPI
 *      (`labelAr`/`labelEn`) — فحقٌّ جديد لا يختفي من الصفحة لأن أحداً نسي إضافته هنا.
 *   3. **الضريبة رقم لا نصّ**: `meta.vatRatePercent` يُقرأ من إعدادات المنصة، والصفحة تقول
 *      ما تقوله القاعدة.
 */
import { Decimal } from 'decimal.js';

import type { Locale } from './i18n';
import { REVALIDATE_SECONDS } from './content';

const apiBase = (
  process.env.API_INTERNAL_BASE ??
  process.env.API_PROXY_TARGET ??
  `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/+$/, '');

export type PlanInterval = 'month' | 'year';

export type PublicPlanEntitlement = {
  kind: 'module' | 'limit' | 'flag';
  key: string;
  value: boolean | number | string;
  labelAr: string;
  labelEn: string;
};

export type PublicPlan = {
  id: string;
  code: string;
  name: string;
  interval: PlanInterval;
  amount: string;
  currency: string;
  monthlyAmount: string;
  annualAmount: string;
  entitlements: PublicPlanEntitlement[];
};

export type PricingData = {
  plans: PublicPlan[];
  /** نسبة ضريبة القيمة المضافة من إعدادات المنصة — والاحتياطي 15٪ (النسبة النظامية). */
  vatRatePercent: number;
};

const fallbackPricing: PricingData = { plans: [], vatRatePercent: 15 };

/** زمن إعادة التحقّق كما في `lib/content.ts`: صفر في التطوير كي يظهر تعديل السعر فوراً. */


/**
 * الباقات العامة — وإن لم يقم الـAPI أو لم تكن هناك باقة، تُعاد قائمةٌ فارغة والصفحة تقول
 * «لا باقات معلنة الآن» بدل أن تسقط: موقعٌ يعرض 500 لأن الخادم تعطّل أسوأ من موقعٍ يقول
 * الحقيقة.
 */
export async function fetchPublicPlans(): Promise<PricingData> {
  try {
    const response = await fetch(`${apiBase}/api/v1/public/plans`, {
      next: { revalidate: REVALIDATE_SECONDS },
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return fallbackPricing;
    const payload = (await response.json()) as {
      data?: PublicPlan[];
      meta?: { vatRatePercent?: number };
    };
    const plans = Array.isArray(payload.data) ? payload.data : [];
    const vatRatePercent = Number(payload.meta?.vatRatePercent ?? fallbackPricing.vatRatePercent);
    return { plans, vatRatePercent: Number.isFinite(vatRatePercent) ? vatRatePercent : 15 };
  } catch {
    return fallbackPricing;
  }
}

// ─────────────────────────────────────────────────────────── تنسيق الأرقام والقيم

/**
 * مبلغٌ بعملته: `199.00` ⇒ «199.00 ر.س». والمنازل اثنتان دائماً — كما في الـAPI.
 *
 * والقراءة بـ`Decimal` لا `Number`: المال في هذا المستودع نصٌّ، و`decimal.js` هي المكتبة
 * المعتمدة للتعامل معه (`lib/format.ts`)، والتحويل إلى `number` يقع في اللحظة الأخيرة
 * للعرض فقط.
 */
export function amountText(valueText: string, currency = 'SAR', locale: Locale = 'ar'): string {
  let rounded: string;
  try {
    rounded = new Decimal(valueText || '0').toFixed(2);
  } catch {
    // قيمةٌ ليست رقماً (`غير رقمي`) لا تُسقط الخلية: تُعرض كما هي مع عملتها.
    return `${valueText} ${currency}`;
  }
  const formatted = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(rounded));
  return locale === 'en' ? `${formatted} ${currency}` : `${formatted} ر.س`;
}

/** عددٌ كبير بفواصل: 20000 ⇒ «20,000» — الجداول تُقرأ بالأرقام لا بالكلمات. */
export function countText(value: number, locale: Locale = 'ar'): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn').format(value);
}

/**
 * قيمة الحجم بالوحدات المفهومة: `20480` م.ب ⇒ «20 GB».
 * والوحدات تُختصر لأن عمود الجدول ضيّق، والقاعدة حسابٌ على 1024 لا على 1000.
 */
export function storageText(megabytes: number, locale: Locale = 'ar'): string {
  const gigabytes = megabytes / 1024;
  const rounded = Number.isInteger(gigabytes) ? `${countText(gigabytes, locale)} GB` : `${gigabytes.toFixed(1)} GB`;
  return rounded;
}

/** القيمة كما تُعرض: رقمٌ بالوحدة، ومنطقيٌّ بعلامة، ونصٌّ كما هو. */
export function entitlementValueText(
  entitlement: PublicPlanEntitlement,
  format: RowFormat,
  locale: Locale = 'ar',
): string {
  if (typeof entitlement.value === 'boolean') return entitlement.value ? '✓' : '—';
  if (typeof entitlement.value === 'string') return entitlement.value || '—';
  if (format === 'storage') return storageText(entitlement.value, locale);
  return countText(entitlement.value, locale);
}

// ─────────────────────────────────────────────────────────── صفوف جدول المقارنة

export type RowFormat = 'count' | 'storage' | 'boolean';

export type ComparisonRow = {
  key: string;
  labelAr: string;
  labelEn: string;
  format: RowFormat;
  /** هل الصف من حقوق الباقات (يختلف بينها) أم من قدرات المنتج المشتركة؟ */
  kind: 'entitlement' | 'capability';
};

/**
 * ترتيب جدول المقارنة وأسماء أعمدته القصيرة. الترتيب مقصود: الحدود اليومية أولاً (المستخدمون
 * ثم الفروع ثم الفواتير) لأن هذه هي الأسئلة الثلاثة التي تُقرأ أولاً، ثم الحدود التشغيلية،
 * ثم **الوحدات** (حزم المنتج) لأنها «هل أحصل على نقطة البيع؟».
 */
const rowCatalogue: readonly Omit<ComparisonRow, 'kind'>[] = [
  { key: 'limits.max_users', labelAr: 'المستخدمون', labelEn: 'Users', format: 'count' },
  { key: 'limits.max_branches', labelAr: 'الفروع', labelEn: 'Branches', format: 'count' },
  { key: 'limits.max_invoices_per_month', labelAr: 'فواتير/شهر', labelEn: 'Invoices / month', format: 'count' },
  { key: 'limits.max_items', labelAr: 'الأصناف', labelEn: 'Items', format: 'count' },
  { key: 'limits.max_whatsapp_per_month', labelAr: 'واتساب/شهر', labelEn: 'WhatsApp / month', format: 'count' },
  { key: 'limits.max_emails_per_month', labelAr: 'بريد/شهر', labelEn: 'E-mails / month', format: 'count' },
  { key: 'limits.max_storage_mb', labelAr: 'التخزين', labelEn: 'Storage', format: 'storage' },
  { key: 'limits.max_api_calls_per_day', labelAr: 'استدعاءات API/يوم', labelEn: 'API calls / day', format: 'count' },
];

/**
 * **بوابات الدفع صفٌّ في الجدول لا حقٌّ في الباقة.** البوابتان السعوديتان (جيديا و NeoLeap)
 * مُنفَّذتان في المنتج لكل منشأة (`apps/api/src/modules/payments/gateways/index.ts:14` ·
 * التسميات في `payments.service.ts:29`)، وليستا مفتاحاً يُشترى — فلو أُضيف لهما مفتاحُ حقٍّ
 * مُخترع لَكان الجدول يقول عن المنتج ما لا يقوله الكود. فيُعرض الصفّ بقيمته الحقيقية
 * (مضمونٌ في كل الباقات) مع بيان مصدره.
 */
export const paymentGatewaysText = { ar: 'جيديا · NeoLeap', en: 'Geidea · NeoLeap' } as const;

export const paymentGatewaysSource = 'apps/api/src/modules/payments/gateways/index.ts:14';

/**
 * صفوف الجدول لعمودٍ واحد من الأعمدة: **كل حقٍّ في الباقة يظهر** — المعروف بترتيبه واسمه
 * القصير، والمجهول باسمه من الـAPI في الذيل. فلا يبتلع الجدول حقًّا أضافه المشغّل من اللوحة.
 */
export function comparisonRows(plans: readonly PublicPlan[]): ComparisonRow[] {
  const known = new Map(rowCatalogue.map((row) => [row.key, row]));
  const seen = new Set<string>();
  const rows: ComparisonRow[] = [];

  for (const plan of plans) {
    for (const entitlement of plan.entitlements) {
      if (seen.has(entitlement.key)) continue;
      seen.add(entitlement.key);
      const catalogue = known.get(entitlement.key);
      rows.push({
        key: entitlement.key,
        // الاسم القصير للحدود المعروفة، واسم الحقّ من الـAPI لما عداه.
        labelAr: catalogue?.labelAr ?? entitlement.labelAr,
        labelEn: catalogue?.labelEn ?? entitlement.labelEn,
        format: catalogue?.format ?? (entitlement.kind === 'module' ? 'boolean' : 'count'),
        kind: 'entitlement',
      });
    }
  }

  const ordered = rowCatalogue
    .map((row) => rows.find((entry) => entry.key === row.key))
    .filter((row): row is ComparisonRow => row !== undefined);
  const rest = rows
    .filter((row) => !rowCatalogue.some((known) => known.key === row.key))
    .sort((a, b) => a.key.localeCompare(b.key));

  return [...ordered, ...rest, { key: 'payments', labelAr: 'بوابات الدفع', labelEn: 'Payment gateways', format: 'boolean', kind: 'capability' }];
}

/** نصّ عمودٍ لصفٍّ: حقوق الباقة من بياناتها، وصفُّ القدرات من ثابتٍ مُوثَّق المصدر. */
export function cellText(
  plan: PublicPlan,
  row: ComparisonRow,
  locale: Locale = 'ar',
): { text: string; source?: string } {
  if (row.kind === 'capability') {
    return { text: paymentGatewaysText[locale], source: paymentGatewaysSource };
  }
  const entitlement = plan.entitlements.find((entry) => entry.key === row.key);
  if (!entitlement) return { text: '—' };
  return { text: entitlementValueText(entitlement, row.format, locale) };
}

// ─────────────────────────────────────────────────────────── الدورة والتوفير

export function plansForInterval(plans: readonly PublicPlan[], interval: PlanInterval): PublicPlan[] {
  return plans.filter((plan) => plan.interval === interval);
}

/** `pro-monthly` و`pro-yearly` باقةٌ واحدة بدورتين — والرمز هو ما يربطهما. */
export function planFamily(plan: Pick<PublicPlan, 'code'>): string {
  return plan.code.replace(/-(monthly|yearly|month|year)$/, '');
}

export type PlanSaving = {
  /** ما يُدفع في السنة على الباقة الشهرية (المبلغ × 12). */
  monthlyAnnualAmount: string;
  yearlyAmount: string;
  /** النسبة الموفَّرة بالسنوي، مقرَّبة إلى أقرب صحيح — `null` إن لم يكن السنوي أرخص. */
  percent: number | null;
};

/**
 * التوفير يُحسب من رقمين حقيقيين للباقتين الشهري والسنوي **من العائلة نفسها**:
 * (شهري × 12 − سنوي) ÷ (شهري × 12). وإن لم تكن السنوية أرخص لا يُعلن توفير — الصمت أصدق من
 * «وفّر 0٪».
 */
export function savingsFor(plan: PublicPlan, plans: readonly PublicPlan[]): PlanSaving | null {
  const monthly = plans.find((entry) => entry.interval === 'month' && planFamily(entry) === planFamily(plan));
  if (!monthly) return null;

  // الحساب على Decimal لا على أرقام عائمة: `499.00 × 12` يجب أن يكون 5988.00 بالضبط.
  const monthlyYearTotal = new Decimal(monthly.amount || '0').times(12);
  const yearlyTotal = new Decimal(plan.amount || '0');
  const monthlyAnnualAmount = fixed(monthlyYearTotal);
  const yearlyAmount = fixed(yearlyTotal);
  if (monthlyYearTotal.lessThanOrEqualTo(0) || yearlyTotal.greaterThanOrEqualTo(monthlyYearTotal)) {
    return { monthlyAnnualAmount, yearlyAmount, percent: null };
  }
  const saved = monthlyYearTotal.minus(yearlyTotal).dividedBy(monthlyYearTotal).times(100);
  return { monthlyAnnualAmount, yearlyAmount, percent: saved.toDecimalPlaces(0).toNumber() };
}

function fixed(value: Decimal): string {
  return value.isFinite() ? value.toFixed(2) : '0.00';
}

// ─────────────────────────────────────────────────────────── أسئلة التسعير

export type PricingFaq = { question: string; answer: string };

/**
 * أسئلة التسعير الثمانية — **أجوبتها من قواعد هذا المستودع لا من خيال تسويقي**:
 *
 *   · الضريبة 15٪ من `billing.tax_rate` (`packages/contracts/src/platform/console.ts:306`) —
 *     وهي مكتوبة في السؤال بلا رقمٍ ثابت، فالرقم المعلن يأتي من `meta.vatRatePercent`.
 *   · الترقية بالتناسب من `platformProration` (`packages/contracts/src/platform/billing.ts`).
 *   · تجاوز الحدّ يُرفض بـ`USAGE_LIMIT_REACHED` (`packages/contracts/src/platform/usage.ts`).
 *   · الدفع يبدأ تحويلاً بنكيّاً وإيصالاً، والبطاقة عبر المزوّد حين يُهيَّأ
 *     (`apps/api/src/modules/platform/billing/billing.service.ts` · الخطة §4 س158).
 *   · الفاتورة الضريبية من مستندات المنصة (`platform_invoices` وبذرة هوية البائع).
 */
const pricingFaqAr: PricingFaq[] = [
  {
    question: 'هل الأسعار تشمل ضريبة القيمة المضافة؟',
    answer: 'لا. الأسعار المعروضة قبل الضريبة، وتُضاف ضريبة القيمة المضافة بالنسبة النظامية عند إصدار فاتورة الاشتراك.',
  },
  {
    question: 'كيف تُحسب فاتورتي إن اشتركت في منتصف الشهر؟',
    answer: 'المدة تبدأ من يوم الاشتراك، وتُحتسب بالتناسب على أيام الشهر الفعلية — لا شهرٌ كامل على أيامٍ لم تُستعمل.',
  },
  {
    question: 'أستطيع تغيير الباقة لاحقاً؟',
    answer: 'نعم. الترقية تُحتسب بالتناسب: ما تبقّى من باقتك الحالية رصيدٌ، والمقابل سعر الباقة الجديدة كاملاً لمدةٍ جديدة تبدأ من يوم التغيير، والفرق يُصدر فاتورةً أو إشعاراً دائناً.',
  },
  {
    question: 'ما الذي يحدث إن تجاوزت حدّ الفواتير أو المستخدمين؟',
    answer: 'الطلبات التي تتجاوز الحدّ تُرفض برمز واضح (`USAGE_LIMIT_REACHED`) ويُنبَّه المشغّل، ثم تُرفع الباقة أو يُرفع الحدّ من لوحة المنصة.',
  },
  {
    question: 'ما طرق الدفع المتاحة؟',
    answer: 'يبدأ الاشتراك بتحويل بنكي وإيصال يُرفع للمنصة، وتُفعَّل المنشأة بعد المراجعة. ويمكن ربط بطاقة عبر مزوّد الدفع حين يُهيَّأ الحساب.',
  },
  {
    question: 'هل أحصل على فاتورة ضريبية؟',
    answer: 'نعم. كل اشتراك يُصدر فاتورةً ضريبية برقم تسلسلي وهوية البائع (الاسم والرقم الضريبي والعنوان)، وتُحفظ للتسوية.',
  },
  {
    question: 'هل بياناتي ملكي إن أوقفت الاشتراك؟',
    answer: 'بياناتك بياناتك. التصدير والنسخ الاحتياطي متاحان من اللوحة، والمنشأة لا تُحذف تلقائياً عند الإيقاف.',
  },
  {
    question: 'هل هناك فترة تجريبية؟',
    answer: 'تُفعَّل التجربة عند الترخيص من المنصة: يبدأ الاشتراك بحالة «تجريبي» بتاريخ انتهاء بلا فاتورة، ثم يتحوّل إلى فاعل عند الدفع.',
  },
];

const pricingFaqEn: PricingFaq[] = [
  {
    question: 'Do prices include VAT?',
    answer: 'No. Prices are shown before tax, and VAT is added at the statutory rate on the subscription invoice.',
  },
  {
    question: 'How is a mid-month subscription charged?',
    answer: 'The period starts on your sign-up day and is prorated over the actual days of that month — never a full month for days you did not use.',
  },
  {
    question: 'Can I change plans later?',
    answer: 'Yes. An upgrade is prorated: what is left of your current plan is credited, the new plan is charged in full for a fresh period starting the day of the change, and the difference becomes an invoice or a credit note.',
  },
  {
    question: 'What happens if I exceed the invoice or user limit?',
    answer: 'Requests beyond the limit are refused with an explicit code (USAGE_LIMIT_REACHED) and the operator is alerted; you then move up a plan or the limit is raised in the console.',
  },
  {
    question: 'Which payment methods are available?',
    answer: 'Subscriptions start with a bank transfer and an uploaded receipt, activated after review. A card can be linked through the payment provider once the account is configured.',
  },
  {
    question: 'Do I get a tax invoice?',
    answer: 'Yes. Every subscription issues a tax invoice with a sequential number and the seller identity (name, tax number, address), kept for reconciliation.',
  },
  {
    question: 'Is my data mine if I stop paying?',
    answer: 'Your data stays yours. Export and backups are available from your workspace, and a suspended tenant is never deleted automatically.',
  },
  {
    question: 'Is there a trial period?',
    answer: 'A trial is granted when the licence is issued from the console: the subscription starts as “trialling” with an end date and no invoice, and turns active once payment is settled.',
  },
];

export function pricingFaq(locale: Locale): PricingFaq[] {
  return locale === 'en' ? pricingFaqEn : pricingFaqAr;
}

// ─────────────────────────────────────────────────────────── بيانات منظَّمة

/**
 * `Product` بأسعاره الحقيقية — لكل دورة عرضٌ مستقل. و`priceValidUntil` غير معلن: تسعيرٌ لا
 * نعرف مدّته لا يُوعد بتاريخ. والرقم من القاعدة لا من نصّ.
 */
export function offersJsonLd(
  plans: readonly PublicPlan[],
  options: { siteUrl: string; path: string; brandName: string; locale: Locale },
): Record<string, unknown> | null {
  if (plans.length === 0) return null;
  const base = options.siteUrl.replace(/\/+$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: options.brandName,
    url: base ? `${base}${options.path}` : options.path,
    ...(plans[0]?.currency ? { priceCurrency: plans[0].currency } : {}),
    offers: plans.map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      url: base ? `${base}${options.path}` : options.path,
      price: plan.amount,
      priceCurrency: plan.currency,
      // الدورة تُعلن كما هي: `month` أو `year` — بلا تحويلٍ إلى نصٍّ تسويقي لا يقيسه محرّك.
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: plan.amount,
        priceCurrency: plan.currency,
        billingIncrement: plan.interval === 'year' ? 12 : 1,
        unitCode: 'MON',
      },
      availability: 'https://schema.org/InStock',
    })),
  };
}
