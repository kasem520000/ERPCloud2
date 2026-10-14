'use client';

import Link from 'next/link';
import { use } from 'react';

import { PortalShell } from '../../../../../components/portal-shell';
import { portalFetch } from '../../../../../lib/api';
import { moneyText } from '../../../../../lib/format';
import { useAsync } from '../../../../../lib/use-async';

type PayView = {
  companyName: string;
  invoice: { id: string; number: string | null; currency: string; total: string; paidTotal: string; remaining: string; paymentStatus: string };
  link: { id: string; provider: string; amount: string; currency: string; url: string; status: string; paidAt: string | null } | null;
};

const providerLabel: Record<string, string> = { moyasar: 'ميسر', hyperpay: 'HyperPay', tap: 'Tap' };
const statusLabel: Record<string, string> = { pending: 'بانتظار الدفع', paid: 'مدفوعة', expired: 'منتهية', failed: 'فشلت' };

function PayPanel({ id }: { id: string }) {
  const view = useAsync(() => portalFetch<PayView>(`/portal/invoices/${id}/payment-link`), [id]);
  if (view.status === 'loading') return <p className="muted">جارٍ تجهيز صفحة الدفع…</p>;
  if (view.status === 'error' || !view.data) {
    return (
      <section className="card">
        <h1>صفحة الدفع غير متاحة</h1>
        <p className="muted">{view.error || 'الفاتورة غير موجودة.'}</p>
        <Link className="btn" href="/portal/invoices">رجوع</Link>
      </section>
    );
  }
  const { companyName, invoice, link } = view.data;
  const mark = (companyName || 'م').trim().slice(0, 1);
  return (
    <section className="card" style={{ maxWidth: 560, marginInline: 'auto' }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <span className="logo" aria-hidden="true" style={{ width: 56, height: 56, fontSize: 24 }}>{mark}</span>
        <div>
          <p className="muted" style={{ margin: 0 }}>الدفع إلى</p>
          <h1 style={{ margin: 0 }}>{companyName || 'المنشأة'}</h1>
        </div>
      </div>
      <p>فاتورة {invoice.number ?? '—'} · المتبقي {moneyText(invoice.remaining)} {invoice.currency}</p>
      {link ? (
        <>
          <p>
            <span className={`badge ${link.status === 'paid' ? 'paid' : link.status === 'pending' ? 'pending' : 'failed'}`}>
              {statusLabel[link.status] ?? link.status}
            </span>{' '}
            عبر {providerLabel[link.provider] ?? link.provider} · {moneyText(link.amount)} {link.currency}
          </p>
          {link.status === 'pending' ? (
            <a className="btn primary" href={link.url} target="_blank" rel="noreferrer">
              ادفع الآن
            </a>
          ) : (
            <p className="muted">{link.status === 'paid' ? 'تم استلام الدفعة وسيظهر سند القبض في حسابك.' : 'اطلب من المنشأة إصدار رابط جديد.'}</p>
          )}
        </>
      ) : (
        <p className="muted">لم تُصدر المنشأة رابط دفع بعد. يمكنك مراجعة الفاتورة أو طلب الرابط من المحاسب.</p>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <Link className="btn" href={`/portal/invoices/${id}`}>تفاصيل الفاتورة</Link>
      </div>
    </section>
  );
}

export default function PortalPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PortalShell>
      <PayPanel id={id} />
    </PortalShell>
  );
}
