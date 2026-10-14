import Link from 'next/link';

import { LeadForm } from '../../components/lead-form';

/**
 * P-M6 — «اطلب عرضاً»: مسارٌ حقيقي لا نافذةٌ منبثقة.
 *
 * طلب العرض يختلف عن «تواصل معنا» في السؤال لا في الحقول: هنا يُسأل الزائر **ما يريد أن يراه**،
 * فيصل الطلب إلى اللوحة موسوماً `demo` ومعه ما يُبنى عليه العرض. ومصدرُه يُكتب من الخادم
 * (`demo`) لا من حقلٍ في الاستمارة.
 */
export const metadata = {
  title: 'اطلب عرضاً',
  description: 'عرضٌ مباشر على بياناتك أو على بيانات تجريبية — بلا التزام، وبجلسةٍ واحدة.',
};

export default function DemoPage() {
  return (
    <>
      <section className="card hero-card">
        <h1>اطلب عرضاً</h1>
        <p className="muted">
          الجلسة نصف ساعة: نبني منشأتك أمامك، نُصدر فاتورةً ضريبية، ونُراجع المخزون والتقارير. وإن
          أردت، تبدأ تجربةً بنفسك من <Link href="/onboarding">صفحة الاشتراك</Link> قبل العرض.
        </p>
      </section>
      <LeadForm kind="demo" />
    </>
  );
}
