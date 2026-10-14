'use client';

import { Decimal } from 'decimal.js';

import { Kpi } from '../../../components/card';
import { PortalShell } from '../../../components/portal-shell';
import { fetchPayments } from '../../../lib/api';
import { dateText, moneyText } from '../../../lib/format';
import { useAsync } from '../../../lib/use-async';

const METHOD_AR: Record<string, string> = { cash: 'نقداً', cheque: 'شيك', bank_transfer: 'تحويل بنكي', card: 'شبكة/بطاقة' };
const KIND_AR: Record<string, string> = { receipt: 'سند قبض', payment: 'سند صرف' };

function Payments() {
  const payments = useAsync(() => fetchPayments(), []);
  const rows = payments.data ?? [];
  const receiptsTotal = rows.filter((row) => row.kind === 'receipt').reduce((sum, row) => sum.plus(row.amount || '0'), new Decimal(0));

  return (
    <>
      <section>
        <h1>المدفوعات</h1>
        <p className="muted">السندات المرحّلة المسجلة على حسابك لدى المورد.</p>
      </section>

      <div className="grid cols">
        <Kpi label="إجمالي المقبوض منك" value={moneyText(receiptsTotal.toFixed(2))} hint={`${rows.length} سند`} />
        <Kpi label="آخر سند" value={rows[0] ? moneyText(rows[0].amount) : '—'} hint={rows[0] ? dateText(rows[0].day) : 'لا توجد سندات'} />
      </div>

      <section className="card" style={{ overflowX: 'auto' }}>
        {payments.status === 'loading' ? (
          <p className="muted">جارٍ تحميل السندات…</p>
        ) : payments.status === 'error' ? (
          <p className="muted" role="alert">
            {payments.error}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted">لم تُسجَّل أي سندات على حسابك بعد.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>الرقم</th>
                <th>التاريخ</th>
                <th>النوع</th>
                <th>طريقة الدفع</th>
                <th>المبلغ</th>
                <th>المرجع</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.number ?? '—'}</td>
                  <td>{dateText(row.day)}</td>
                  <td>{KIND_AR[row.kind] ?? row.kind}</td>
                  <td>{METHOD_AR[row.method] ?? row.method}</td>
                  <td>
                    <strong>{moneyText(row.amount)}</strong>
                  </td>
                  <td>{(row as unknown as Record<string, string>).reference_no ?? (row as unknown as Record<string, string>).cheque_no ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export default function PaymentsPage() {
  return (
    <PortalShell>
      <Payments />
    </PortalShell>
  );
}
