'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { einvoiceFilings, einvoiceSettings, type EinvoiceFiling } from '../../lib/accounting';

/**
 * M3 — 🧾 مكتب الزكاة والضريبة (read-only): the seller card as the e-invoicing module
 * sees it, and the filings register with each invoice's submission status. Credentials
 * management and submission stay in the staff panel — this desk watches, it does not
 * touch credentials.
 */
export default function ZatcaPage() {
  const [status, setStatus] = useState('');
  const settings = useQuery(einvoiceSettings, []);
  const filings = useQuery(() => einvoiceFilings(status ? { status } : {}), [status]);

  return (
    <Screen
      title="مكتب الزكاة والضريبة"
      subtitle="بطاقة البائع وسجل الترحيلات — إدارة الاعتماديات من لوحة التحكم"
      crumbs={['المحاسبة', 'مكتب الزكاة والضريبة']}
      actions={
        <select className="input" style={{ width: 170 }} value={status} onChange={(event) => setStatus(event.target.value)} aria-label="حالة الترحيل">
          <option value="">كل الحالات</option>
          <option value="succeeded">ناجحة</option>
          <option value="pending">معلّقة</option>
          <option value="failed">فاشلة</option>
        </select>
      }
    >
      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        {settings.status === 'loading' ? <div className="card"><Loading rows={2} /></div> : null}
        {settings.status === 'success' ? (
          <div className="card">
            <strong>بطاقة البائع</strong>
            <dl style={{ margin: '10px 0 0', display: 'grid', gap: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="muted small">الاسم</dt>
                <dd style={{ margin: 0 }}>{settings.data?.sellerName ?? '—'}</dd>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="muted small">الرقم الضريبي</dt>
                <dd style={{ margin: 0 }} className="num">
                  {settings.data?.vatNumber ?? '—'}
                </dd>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="muted small">البيئة</dt>
                <dd style={{ margin: 0 }}>{settings.data?.environment ?? '—'}</dd>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="muted small">الربط</dt>
                <dd style={{ margin: 0 }}>
                  {settings.data?.linked ? <span className="badge succeeded">مربوط</span> : <span className="badge pending">غير مربوط</span>}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
        {settings.status === 'forbidden' ? <div className="card"><Forbidden /></div> : null}
        {settings.status === 'error' ? <div className="card"><ErrorBox message={settings.error} onRetry={settings.reload} /></div> : null}
      </div>

      {filings.status === 'loading' ? <Loading rows={6} /> : null}
      {filings.status === 'forbidden' ? <Forbidden /> : null}
      {filings.status === 'error' ? <ErrorBox message={filings.error} onRetry={filings.reload} /> : null}
      {filings.status === 'success' && (filings.data ?? []).length === 0 ? <Empty hint="لا توجد ترحيلات." /> : null}
      {filings.status === 'success' && (filings.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الفاتورة</th>
                <th>الحالة</th>
                <th className="num">الإجمالي</th>
                <th className="num">الضريبة</th>
                <th>تاريخ الترحيل</th>
                <th>الخطأ</th>
              </tr>
            </thead>
            <tbody>
              {(filings.data ?? []).map((filing: EinvoiceFiling) => (
                <tr key={filing.id}>
                  <td>{filing.invoiceNumber ?? filing.invoice_number ?? '—'}</td>
                  <td>
                    <span className={`badge ${statusOf(filing)}`}>{statusLabel(statusOf(filing))}</span>
                  </td>
                  <td className="num">{fmt(filing.totalAmount ?? filing.total_amount)}</td>
                  <td className="num">{fmt(filing.vatAmount ?? filing.vat_amount)}</td>
                  <td className="small">{date(filing.submittedAt ?? filing.submitted_at)}</td>
                  <td className="muted small">{filing.errorCode ? `${filing.errorCode}: ${filing.errorMessage ?? ''}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function statusOf(filing: EinvoiceFiling): string {
  return filing.status ?? 'pending';
}
function statusLabel(status: string): string {
  return { succeeded: 'ناجحة', pending: 'معلّقة', failed: 'فاشلة' }[status] ?? status;
}
function date(value?: string | null): string {
  return value ? String(value).replace('T', ' ').slice(0, 16) : '—';
}
function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
