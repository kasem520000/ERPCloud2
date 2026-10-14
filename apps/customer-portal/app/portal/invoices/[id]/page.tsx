'use client';

import Link from 'next/link';
import { use, useState } from 'react';

import { PortalShell } from '../../../../components/portal-shell';
import { fetchInvoice, fetchInvoiceHtml, openPrintWindow } from '../../../../lib/api';
import { dateText, moneyText } from '../../../../lib/format';
import { useAsync } from '../../../../lib/use-async';

const PAYMENT_AR: Record<string, string> = { unpaid: 'غير مسددة', partial: 'مسددة جزئياً', paid: 'مسددة' };
const ZATCA_AR: Record<string, string> = { cleared: 'مصدّقة من هيئة الزكاة', reported: 'مبلّغة للهيئة', signed: 'موقّعة', prepared: 'قيد التجهيز', failed: 'فشل الإرسال' };

function InvoiceDetail({ id }: { id: string }) {
  const [printError, setPrintError] = useState('');
  const detail = useAsync(() => fetchInvoice(id), [id]);

  async function print() {
    setPrintError('');
    try {
      const html = await fetchInvoiceHtml(id);
      if (!openPrintWindow(html)) setPrintError('منع المتصفح فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.');
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : 'تعذّرت الطباعة');
    }
  }

  if (detail.status === 'loading') return <p className="muted">جارٍ تحميل الفاتورة…</p>;
  if (detail.status === 'error' || !detail.data)
    return (
      <section className="card">
        <h1>الفاتورة غير متاحة</h1>
        <p className="muted" role="alert">
          {detail.error || 'المستند غير موجود أو لا يخص حسابك.'}
        </p>
        <Link className="btn" href="/portal/invoices">
          رجوع للفواتير
        </Link>
      </section>
    );

  const { invoice, lines, payments } = detail.data;

  return (
    <>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>فاتورة {invoice.number ?? '—'}</h1>
            <p className="muted">
              {dateText(invoice.posted_at ?? invoice.created_at)} · {invoice.currency}
              {invoice.zatca_status ? ` · ${ZATCA_AR[invoice.zatca_status] ?? invoice.zatca_status}` : ''}
            </p>
          </div>
          <div className="toolbar">
            <span className={`badge ${invoice.payment_status === 'paid' ? 'paid' : 'open'}`}>{PAYMENT_AR[invoice.payment_status] ?? invoice.payment_status}</span>
            <Link className="btn primary" href={`/portal/invoices/${id}/pay`}>
              ادفع
            </Link>
            <button className="btn" type="button" onClick={print}>
              طباعة / حفظ PDF
            </button>
          </div>
        </div>
        {printError ? (
          <p className="muted" role="alert">
            {printError}
          </p>
        ) : null}
      </section>

      <section className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>الصنف</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              <th>السعر</th>
              <th>الخصم</th>
              <th>الصافي</th>
              <th>الضريبة</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.line_no}>
                <td>{line.line_no}</td>
                <td>{line.name}</td>
                <td>{line.unit ?? '—'}</td>
                <td>{line.quantity}</td>
                <td>{moneyText(line.unit_price)}</td>
                <td>{moneyText(line.discount_amount)}</td>
                <td>{moneyText(line.net)}</td>
                <td>{moneyText(line.tax)}</td>
                <td>
                  <strong>{moneyText(line.total)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid cols">
        <section className="card">
          <h2>الإجماليات</h2>
          <table>
            <tbody>
              <tr>
                <td>الصافي قبل الضريبة</td>
                <td>{moneyText(invoice.subtotal)}</td>
              </tr>
              <tr>
                <td>ضريبة القيمة المضافة</td>
                <td>{moneyText(invoice.tax_total)}</td>
              </tr>
              <tr>
                <td>
                  <strong>الإجمالي</strong>
                </td>
                <td>
                  <strong>{moneyText(invoice.total)}</strong>
                </td>
              </tr>
              <tr>
                <td>المسدد</td>
                <td>{moneyText(invoice.paid_total)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>الدفعات على الفاتورة</h2>
          {payments.length === 0 ? (
            <p className="muted">لم تُسجَّل دفعات على هذه الفاتورة.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>الطريقة</th>
                  <th>المبلغ</th>
                  <th>المرجع</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment, index) => (
                  <tr key={`${payment.created_at}-${index}`}>
                    <td>{dateText(payment.created_at ?? '')}</td>
                    <td>{payment.method}</td>
                    <td>{moneyText(payment.amount ?? '0')}</td>
                    <td>{payment.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PortalShell>
      <InvoiceDetail id={id} />
    </PortalShell>
  );
}
