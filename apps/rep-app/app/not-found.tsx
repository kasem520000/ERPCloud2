import Link from 'next/link';

/**
 * M5 — the rep app's 404: same shape as the accounting app's (M3), phone-sized.
 */
export default function NotFound() {
  return (
    <div className="boot">
      <div className="boot-card" style={{ padding: '24px' }}>
        <span className="logo big">ERP</span>
        <h1 style={{ fontSize: '20px', margin: 0 }}>الشاشة غير موجودة</h1>
        <p className="muted small">راجع شريط التنقل السفلي — تطبيق المندوب خمس شاشات أساسية.</p>
        <Link href="/" className="btn">
          الرئيسية
        </Link>
      </div>
    </div>
  );
}
