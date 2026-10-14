import { ChangePasswordForm } from '../../../components/forms';

export default function ChangePasswordPage() {
  return (
    <section className="card">
      <h1>تغيير كلمة المرور</h1>
      <p className="muted">كلمة المرور المؤقتة التي زوّدك بها المورد تُستخدم مرة واحدة. اختر كلمة مرور من 12 حرفاً على الأقل.</p>
      <ChangePasswordForm />
    </section>
  );
}
