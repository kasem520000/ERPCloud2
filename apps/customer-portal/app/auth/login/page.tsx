import { LoginForm } from '../../../components/forms';

export default function LoginPage() { return <section className="card"><h1>تسجيل الدخول</h1><p className="muted">رموز الدخول تحفظ في الذاكرة أثناء الجلسة؛ لا يتم تخزينها في localStorage عند نمط cookie.</p><LoginForm /></section>; }
