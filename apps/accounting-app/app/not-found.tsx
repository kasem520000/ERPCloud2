import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
      <h1 style={{ margin: 0, fontSize: '22px' }}>الصفحة غير موجودة</h1>
      <p className="muted small">ربما تغيّر المسار أو أن الشاشة لم تُبنَ بعد.</p>
      <Link className="btn" href="/">
        الرئيسية
      </Link>
    </div>
  );
}
