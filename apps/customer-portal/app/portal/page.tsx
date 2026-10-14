'use client';

import Link from 'next/link';
import { Decimal } from 'decimal.js';

import { Kpi } from '../../components/card';
import { PortalShell, usePortalProfile } from '../../components/portal-shell';
import { fetchInvoices, fetchPayments } from '../../lib/api';
import { dateText, moneyText } from '../../lib/format';
import { useAsync } from '../../lib/use-async';

const STATUS_AR: Record<string, string> = { unpaid: 'غير مسددة', partial: 'مسددة جزئياً', paid: 'مسددة', posted: 'مرحّلة', draft: 'مسودة', voided: 'ملغاة' };

function Dashboard() {
  const { profile } = usePortalProfile();
  const invoices = useAsync(() => fetchInvoices(), []);
  const payments = useAsync(() => fetchPayments(), []);

  const rows = invoices.data ?? [];
  const outstanding = rows.reduce((sum, invoice) => sum.plus(new Decimal(invoice.total || '0').minus(invoice.paid_total || '0')), new Decimal(0));
  const overdueCount = rows.filter((invoice) => invoice.payment_status !== 'paid').length;
  const lastPayment = (payments.data ?? [])[0];

  return (
    <>
      <section>
        <h1>لوحة الحساب</h1>
        <p className="muted">ملخص تعاملك مع {profile?.company.nameAr || 'المورد'} — الفواتير الصادرة لك والمبالغ المسددة.</p>
      </section>

      <div className="grid cols">
        <Kpi label="الرصيد المستحق" value={moneyText(profile?.balance ?? '0')} hint="حسب دفاتر المورد" />
        <Kpi label="غير المسدد من الفواتير" value={moneyText(outstanding.toFixed(2))} hint={`${overdueCount} فاتورة مفتوحة`} />
        <Kpi label="عدد الفواتير" value={String(rows.length)} hint="الفواتير المرحّلة الصادرة لك" />
        <Kpi label="آخر دفعة" value={lastPayment ? moneyText(lastPayment.amount) : '—'} hint={lastPayment ? dateText(lastPayment.day) : 'لا توجد دفعات مسجلة'} />
      </div>

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>أحدث الفواتير</h2>
          <Link className="btn" href="/portal/invoices">
            عرض الكل
          </Link>
        </div>
        {invoices.status === 'loading' ? (
          <p className="muted">جارٍ التحميل…</p>
        ) : invoices.status === 'error' ? (
          <p className="muted" role="alert">
            {invoices.error}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted">لم تصدر لك فواتير بعد.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>الرقم</th>
                <th>التاريخ</th>
                <th>الإجمالي</th>
                <th>المسدد</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/portal/invoices/${invoice.id}`}>{invoice.number ?? '—'}</Link>
                  </td>
                  <td>{dateText(invoice.posted_at ?? invoice.created_at)}</td>
                  <td>{moneyText(invoice.total)}</td>
                  <td>{moneyText(invoice.paid_total)}</td>
                  <td>
                    <span className={`badge ${invoice.payment_status === 'paid' ? 'paid' : 'open'}`}>{STATUS_AR[invoice.payment_status] ?? invoice.payment_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export default function PortalDashboardPage() {
  return (
    <PortalShell>
      <Dashboard />
    </PortalShell>
  );
}
