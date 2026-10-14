'use client';

import { useEffect, useState } from 'react';

import { money } from '../../lib/lookups';
import { SupplierError, readSupplierSession, supplierFetch, writeSupplierSession } from '../../lib/supplier-portal';

type Invoice = { id: string; number: string | null; paymentStatus: string; currency: string; total: string; paidTotal: string };
type Payment = { id: string; number: string | null; day: string; value: string; currency: string };
type Quote = { id: string; number: string; title: string; note: string; status: string; offer: string | null; responseNote: string | null };

const STATUS: Record<string, string> = { open: 'بانتظار الرد', responded: 'تم الرد', closed: 'مغلق' };

export default function SupplierPortalPage() {
  const [token, setToken] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [tenantCode, setTenantCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [offers, setOffers] = useState<Record<string, { offer: string; note: string }>>({});
  const [referenceNo, setReferenceNo] = useState('');
  const [declared, setDeclared] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    const stored = readSupplierSession()?.token;
    setToken(stored);
    setReady(true);
    if (stored) {
      load(stored).catch(() => {
        writeSupplierSession(undefined);
        setToken(undefined);
        setError('انتهت الجلسة. ادخل من جديد.');
      });
    }
  }, []);

  async function load(current = token) {
    if (!current) return;
    const [invoiceRows, paymentRows, quoteRows] = await Promise.all([
      supplierFetch<Invoice[]>('/supplier-portal/invoices', {}, current),
      supplierFetch<Payment[]>('/supplier-portal/payments', {}, current),
      supplierFetch<Quote[]>('/supplier-portal/quotations', {}, current),
    ]);
    setInvoices(invoiceRows);
    setPayments(paymentRows);
    setQuotes(quoteRows);
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await supplierFetch<{ token: string }>('/supplier-portal/auth/login', {
        method: 'POST',
        body: JSON.stringify({ tenantCode, email, password }),
      });
      writeSupplierSession(session.token);
      setToken(session.token);
      setPassword('');
      await load(session.token);
    } catch (caught) {
      setError(caught instanceof SupplierError ? caught.message : 'تعذّر الدخول');
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    writeSupplierSession(undefined);
    setToken(undefined);
    setInvoices([]);
    setPayments([]);
    setQuotes([]);
  }

  async function respond(row: Quote) {
    const draft = offers[row.id] ?? { offer: '', note: '' };
    setBusy(true);
    setError('');
    try {
      await supplierFetch(`/supplier-portal/quotations/${row.id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ price: draft.offer, note: draft.note }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof SupplierError ? caught.message : 'تعذّر إرسال الرد');
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await supplierFetch('/supplier-portal/invoices', {
        method: 'POST',
        body: JSON.stringify({ referenceNo, declaredTotal: declared, note }),
      });
      setReferenceNo('');
      setDeclared('');
      setNote('');
      setError('');
      await load();
    } catch (caught) {
      setError(caught instanceof SupplierError ? caught.message : 'تعذّر رفع الفاتورة');
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <div className="boot">جارٍ التحميل…</div>;

  if (!token) {
    return (
      <div className="boot">
        <form className="auth-card" onSubmit={login}>
          <span className="logo-mark">م</span>
          <h1>بوابة الموردين</h1>
          <p className="muted">فواتيرك ومدفوعاتك وطلبات عروض الأسعار. الدخول لا يفتح شاشات الموظفين.</p>
          {error ? <p className="alert danger">{error}</p> : null}
          <label className="field">
            <span>رمز المنشأة</span>
            <input className="input" value={tenantCode} onChange={(event) => setTenantCode(event.target.value)} required />
          </label>
          <label className="field">
            <span>البريد</span>
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label className="field">
            <span>كلمة المرور</span>
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الدخول…' : 'دخول'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <main className="public-page">
      <div className="public-wrap">
        <header className="row" style={{ justifyContent: 'space-between' }}>
          <span className="row">
            <span className="logo-mark">م</span>
            <strong>بوابة الموردين</strong>
          </span>
          <button className="btn sm" type="button" onClick={logout}>
            خروج
          </button>
        </header>
        {error ? <p className="alert danger">{error}</p> : null}

        <section className="card">
          <h2>فواتير الشراء</h2>
          {invoices.length === 0 ? <p className="muted">لا توجد فواتير مرحّلة باسمكم.</p> : null}
          {invoices.map((row) => (
            <p key={row.id}>
              {row.number ?? '—'} — {money(row.total, row.currency)} — مسدّد {money(row.paidTotal, row.currency)} — {row.paymentStatus}
            </p>
          ))}
        </section>

        <section className="card">
          <h2>المدفوعات</h2>
          {payments.length === 0 ? <p className="muted">لا توجد سندات صرف مرحّلة.</p> : null}
          {payments.map((row) => (
            <p key={row.id}>
              {row.number ?? '—'} — {row.day} — {money(row.value, row.currency)}
            </p>
          ))}
        </section>

        <section className="card">
          <h2>طلبات عروض الأسعار</h2>
          {quotes.length === 0 ? <p className="muted">لا توجد طلبات مفتوحة.</p> : null}
          {quotes.map((row) => (
            <article key={row.id} className="card tight">
              <strong>
                {row.number} — {row.title}
              </strong>
              <p className="muted small">{row.note || 'بلا ملاحظة'} — {STATUS[row.status] ?? row.status}</p>
              {row.status === 'open' ? (
                <div className="form-grid">
                  <label className="field">
                    <span>السعر</span>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={offers[row.id]?.offer ?? ''}
                      onChange={(event) =>
                        setOffers((current) => ({ ...current, [row.id]: { offer: event.target.value, note: current[row.id]?.note ?? '' } }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>ملاحظة</span>
                    <input
                      className="input"
                      value={offers[row.id]?.note ?? ''}
                      onChange={(event) =>
                        setOffers((current) => ({ ...current, [row.id]: { offer: current[row.id]?.offer ?? '', note: event.target.value } }))
                      }
                    />
                  </label>
                  <button className="btn primary" type="button" disabled={busy} onClick={() => respond(row)}>
                    إرسال الرد
                  </button>
                </div>
              ) : (
                <p>
                  العرض: {row.offer ? money(row.offer) : '—'} {row.responseNote ? `— ${row.responseNote}` : ''}
                </p>
              )}
            </article>
          ))}
        </section>

        <form className="card" onSubmit={upload}>
          <h2>رفع فاتورة</h2>
          <p className="muted small">التقديم يصل إلى الموظف ولا يُرحَّل في الدفاتر حتى يقيّده.</p>
          <div className="form-grid">
            <label className="field">
              <span>رقم الفاتورة *</span>
              <input className="input" value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} required />
            </label>
            <label className="field">
              <span>الإجمالي *</span>
              <input className="input" inputMode="decimal" value={declared} onChange={(event) => setDeclared(event.target.value)} required />
            </label>
            <label className="field">
              <span>ملاحظة</span>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الإرسال…' : 'إرسال الفاتورة'}
          </button>
        </form>
      </div>
    </main>
  );
}
