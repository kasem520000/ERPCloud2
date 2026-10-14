import Link from 'next/link';

import { SmartLogin } from '../../components/smart-login';

export default function LoginPage() {
  return <div className="grid"><section className="card"><h1>تسجيل الدخول</h1>
    <p className="muted">سجّل الدخول مرة واحدة وسنوجّهك تلقائياً: موظفو المنشأة إلى لوحة الإدارة، وعملاء المورد إلى بوابة العملاء.</p>
    <SmartLogin />
    <p className="muted">ليس لديك حساب؟ <Link href="/onboarding">أنشئ منشأتك</Link></p>
  </section></div>;
}
