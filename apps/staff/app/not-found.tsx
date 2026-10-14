import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="state">
      <h2>الصفحة غير موجودة</h2>
      <p className="muted">تحقق من الرابط أو اختر شاشة من القائمة الجانبية.</p>
      <Link className="btn primary" href="/">
        العودة للرئيسية
      </Link>
    </div>
  );
}
