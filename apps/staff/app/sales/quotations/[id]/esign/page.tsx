'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { Notice } from '../../../../../components/data-view';
import { Screen } from '../../../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../../../lib/api';
import { money } from '../../../../../lib/lookups';
import { useQuery } from '../../../../../lib/use-query';

type Quotation = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  currency: string;
  total: string;
};

export default function QuotationEsignPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const quotation = useQuery<Quotation>(() => apiData<Quotation>(`/sales/invoices/${id}`), [id]);
  const [signerEmail, setSignerEmail] = useState('');
  const [signerName, setSignerName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  const [issued, setIssued] = useState<{ href: string; previewOtp?: string } | undefined>();

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<{ token: string; previewOtp?: string }>('/esign/requests', {
        entityType: 'sales_quotation',
        entityId: id,
        signerEmail: signerEmail.trim(),
        signerName: signerName.trim() || undefined,
        message: message.trim() || undefined,
      });
      const href = `${window.location.origin}/esign/${created.token}`;
      setIssued({ href, previewOtp: created.previewOtp });
      setNotice({ kind: 'ok', text: 'أُنشئ طلب التوقيع وأُرسل الرابط بالبريد إن كان الإرسال متاحاً.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const row = quotation.data;

  return (
    <Screen
      title="إرسال للتوقيع"
      subtitle="يصل العميل رابطاً صالحاً لسبعة أيام. يرسم توقيعه ويدخل رمز البريد. ليس توقيعاً مؤهلاً قانونياً."
      crumbs={['المبيعات', 'عرض سعر', 'توقيع']}
      actions={
        <Link className="btn" href={`/sales/quotations/${id}`}>
          العودة للعرض
        </Link>
      }
    >
      <Notice notice={notice} />
      {row && row.kind === 'quotation' ? (
        <p className="muted">
          {row.number ?? 'عرض سعر'} — {money(row.total, row.currency)} — {row.status === 'draft' ? 'مفتوح' : row.status}
        </p>
      ) : null}

      <form className="card" onSubmit={send}>
        <div className="form-grid">
          <label className="field">
            <span>بريد الموقّع *</span>
            <input className="input" type="email" value={signerEmail} onChange={(event) => setSignerEmail(event.target.value)} required />
          </label>
          <label className="field">
            <span>اسم الموقّع</span>
            <input className="input" value={signerName} onChange={(event) => setSignerName(event.target.value)} />
          </label>
          <label className="field">
            <span>رسالة</span>
            <input className="input" value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={busy || row?.status !== 'draft'}>
          {busy ? 'جارٍ الإرسال…' : 'إرسال الرابط'}
        </button>
      </form>

      {issued ? (
        <section className="card">
          <h2>الرابط</h2>
          <p className="muted small">انسخه إذا لم يصل البريد. في وضع التطوير يظهر الرمز هنا لأن نص الرسالة لا يُطبع.</p>
          <input className="input" readOnly value={issued.href} onFocus={(event) => event.currentTarget.select()} />
          {issued.previewOtp ? <p>رمز التحقق: {issued.previewOtp}</p> : null}
        </section>
      ) : null}
    </Screen>
  );
}
