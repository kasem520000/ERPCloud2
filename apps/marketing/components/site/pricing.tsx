/**
 * P-M3 — جدول الباقات والأسعار (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **ولماذا لا حالة في المتصفح؟** مبدّل شهري/سنوي كان يمكن أن يكون `useState`، فاختير أن
 * يكون **رابطاً**: `/pricing` للشهري و`/pricing?interval=year` للسنوي. السبب ليس ذوقاً:
 * بالحالة يبقى جدول السنة في المتصفح وحده، فلا يراه محرّك بحث ولا يشارك أحدٌ رابطَ الباقة
 * السنوية؛ وبالرابط يصير كل وجهٍ صفحةً حقيقية على الخادم. فالمكوّن هنا **بلا حالة** كل ما في
 * الموقع (لا `'use client'` في صفحة أسعار).
 *
 * ثلاث قواعد تحكم ما يُعرض:
 *
 *   1. **لا رقم مكتوب هنا**: كل سعرٍ وحقٍّ يأتي في `data` من `GET /public/plans` — تعديل
 *      المشغّل للسعر يظهر فوراً، ولو كان الرقم في الكود لَكذبت الصفحة.
 *   2. **لا شارة «الأكثر اختياراً»** ولا تقييمٌ ولا عدّاد عملاء: هذه الصفحة لا تُعلن رقماً لا
 *      تملك مصدره (المبدأ §3.1 في الخطة).
 *   3. **الحقوق الغائبة تُكتب «—»** لا تُخفى: جدولٌ يُسقط صفّاً يبدو وكأن الجميع يملكه.
 */
import Link from 'next/link';

import { t, type Locale } from '../../lib/i18n';
import {
  amountText,
  cellText,
  comparisonRows,
  paymentGatewaysSource,
  plansForInterval,
  pricingFaq,
  savingsFor,
  type PlanInterval,
  type PricingData,
} from '../../lib/pricing';

export function PricingView({
  locale,
  data,
  interval = 'month',
}: {
  locale: Locale;
  data: PricingData;
  /** الدورة المعروضة — من الرابط (`?interval=year`) لا من حالةٍ في المتصفح. */
  interval?: PlanInterval;
}) {
  const monthly = plansForInterval(data.plans, 'month');
  const yearly = plansForInterval(data.plans, 'year');
  const plans = interval === 'year' ? yearly : monthly;

  if (data.plans.length === 0) {
    return (
      <div className="grid">
        <header className="page-head">
          <h1>{t(locale, 'pricing.title')}</h1>
          <p className="muted">{t(locale, 'pricing.subtitle')}</p>
        </header>
        <p className="empty-state" role="status">
          {t(locale, 'pricing.empty')}
        </p>
        <section className="cta-block">
          <Link className="btn primary" href="/contact" data-goal="request_demo">
            {t(locale, 'cta.talk')}
          </Link>
        </section>
      </div>
    );
  }

  const rows = comparisonRows(plans);
  const yearlySaving = yearly.map((plan) => savingsFor(plan, data.plans)).find((saving) => saving?.percent != null) ?? null;

  return (
    <div className="grid">
      <header className="page-head">
        <h1>{t(locale, 'pricing.title')}</h1>
        <p className="muted">{t(locale, 'pricing.subtitle')}</p>
      </header>

      {/* ── مبدّل الدورة: رابطان لا زرّان — كل وجهٍ صفحةٌ يفهرسها محرّك البحث */}
      <div className="chip-row" role="group" aria-label={t(locale, 'pricing.interval.label')}>
        {(['month', 'year'] as const).map((option) => (
          <Link
            key={option}
            className={option === interval ? 'chip active' : 'chip'}
            aria-current={option === interval ? 'true' : undefined}
            href={option === 'month' ? '/pricing' : '/pricing?interval=year'}
          >
            {t(locale, option === 'month' ? 'pricing.interval.month' : 'pricing.interval.year')}
          </Link>
        ))}
        {yearlySaving?.percent ? (
          // النصّ يُبنى في سلسلةٍ واحدة: الرقم وعلامة النسبة عقدةٌ واحدة في الواجهة وفي HTML.
          <span className="badge ready">{`${t(locale, 'pricing.save')} ${yearlySaving.percent}%`}</span>
        ) : null}
      </div>

      {/* ── بطاقات الباقات: الباقة الثانية هي «المميزة» — الوسطى إن وجدت ثلاث، والرفيعة (pro)
          مع باقتين — إطارٌ متدرّج وشارة. التمييز جماليّ لا رقمٌ: لا رقم مبيعات ولا تقييم. */}
      <section className="plan-grid" aria-label={t(locale, 'pricing.compare.title')}>
        {plans.map((plan, index) => {
          const featured = plans.length >= 2 && index === 1;
          return (
            <article className={featured ? 'card plan-card featured' : 'card plan-card'} key={plan.id}>
              {featured ? <span className="plan-badge">{t(locale, 'pricing.featured')}</span> : null}
              <h3>{plan.name}</h3>
              <p className="plan-price">{amountText(plan.amount, plan.currency, locale)}</p>
            <p className="muted">
              {t(locale, plan.interval === 'year' ? 'pricing.perYear' : 'pricing.perMonth')}
            </p>
            {plan.interval === 'year' ? (
              <p className="muted">
                {t(locale, 'pricing.equivalent')} {amountText(plan.monthlyAmount, plan.currency, locale)}
              </p>
            ) : null}
              <Link className="btn primary" href={`/onboarding?plan=${encodeURIComponent(plan.code)}`} data-goal="signup_start">
                {t(locale, 'pricing.choose')}
              </Link>
            </article>
          );
        })}
      </section>

      {/* ── جدول المقارنة: الباقة × الحقوق */}
      <section className="section">
        <div className="table-wrap">
          <table className="compare">
            <caption>{t(locale, 'pricing.compare.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(locale, 'pricing.compare.feature')}</th>
                {plans.map((plan) => (
                  <th scope="col" key={plan.id}>
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    {locale === 'en' ? row.labelEn : row.labelAr}
                    {row.kind === 'capability' ? <span className="muted"> · {t(locale, 'pricing.compare.everyPlan')}</span> : null}
                  </th>
                  {plans.map((plan) => {
                    const cell = cellText(plan, row, locale);
                    return (
                      <td key={`${plan.id}-${row.key}`} title={cell.source ?? undefined}>
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="source-line" dir="ltr">
          GET /public/plans · {paymentGatewaysSource}
        </p>
      </section>

      {/* ── الضريبة: الرقم من إعدادات المنصة (`billing.tax_rate`) لا من نصٍّ هنا */}
      <p className="plan-note" role="note">
        {`${t(locale, 'pricing.note.vat')} ${data.vatRatePercent}%`}
      </p>

      {/* ── أسئلة التسعير — أجوبتها من قواعد المنتج في هذا المستودع */}
      <section className="section">
        <div className="section-heading">
          <h2>{t(locale, 'pricing.faq.title')}</h2>
        </div>
        <div className="faq-list">
          {pricingFaq(locale).map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p className="muted">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="section cta-final">
        <h2>{t(locale, 'pricing.final.title')}</h2>
        <p className="muted">{t(locale, 'pricing.final.body')}</p>
        <div className="row">
          <Link className="btn primary" href="/onboarding" data-goal="signup_start">
            {t(locale, 'cta.start')}
          </Link>
          <Link className="btn ghost" href="/contact" data-goal="request_demo">
            {t(locale, 'cta.talk')}
          </Link>
        </div>
      </section>
    </div>
  );
}
