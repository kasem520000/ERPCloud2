import { LeadForm } from '../../components/lead-form';

/**
 * P-M6 — «تواصل معنا» صارت استمارةً حقيقية.
 *
 * كانت قبل P-M6 رابطَ `mailto:` يُقسّم الرسالة على بريد الموظّف: لا تُسجَّل، ولا تُتابع،
 * وتضيع إن لم يفتح أحدٌ بريده. صارت الآن صفّاً في طابور العملاء المتوقّعين يُقرأ في اللوحة،
 * مع مصيدةٍ ومحدّد معدّل ورسالة استلامٍ فيها مرجع.
 *
 * والمسار ثابت (`/contact`) لأنه في خريطة الموقع وفي روابط التذييل منذ P-M1.
 */
export const metadata = {
  title: 'تواصل معنا',
  description: 'اكتب ما تحتاجه وسيتواصل معك فريق المنصة — عرضٌ على بياناتك أو بيانات تجريبية.',
};

export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  // الباقة المُمرَّرة من صفحة الأسعار (`/onboarding?plan=` و`/contact?plan=`) تُملأ في الحقل
  // اختيارياً — الشكل نفسه الذي يستعمله `/blog` و`/help` (وعدٌ لا كائن: Next 15).
  const { plan } = await searchParams;
  return <LeadForm kind="form" presetPlan={plan} />;
}
