import { OnboardingPanel } from '../../components/onboarding-panel';
import { readSignupTicket } from '../../lib/signup';

/**
 * P-M4 — `/onboarding`: معالج الاشتراك ثم لوحة الترحيب.
 *
 * والصفحة **خادمية** تُقرأ منها معاملات الرابط مرّة واحدة وتُمرَّر إلى اللوحة، فلا
 * `useSearchParams` في العميل ولا حدود `Suspense` — والنوع يتغيّر بحسب ما وصل:
 *
 *   - `?plan=<code>` وحده: الزائر جاء من صفحة الأسعار ⇒ المعالج بالباقة المسبقة.
 *   - `?email=&token=`: عاد بعد التحقّق ⇒ لوحة الترحيب بالحالة من الخادم.
 *   - `?email=&token=` غير صالحين: يُسقَط إلى المعالج (لا شاشة خطأ: الرمز قد ينتهي بعد ٣٠
 *     دقيقة، والزائر يستحق باباً مفتوحاً لا جداراً).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const ticket = readSignupTicket({ email: first(params.email), token: first(params.token) });
  const planCode = first(params.plan);

  return (
    <div className="grid">
      <section className="hero">
        <h1>اشترك في النظام — أربع خطوات</h1>
        <p>
          اختر الباقة، ثم عرّف منشأتك (الاسم والدولة والعملة والمنطقة الزمنية)، ثم أنشئ حساب المدير، ثم
          أكّد رمز التحقّق الذي يصل بالبريد. تُجهَّز لك الحسابات الافتراضية والفرع الرئيسي والمستودع
          والخزنة تلقائياً، ويُفتح طلب الاشتراك لاعتماد إدارة المنصة.
        </p>
      </section>

      <OnboardingPanel ticket={ticket ?? undefined} presetPlanCode={planCode} />
    </div>
  );
}
