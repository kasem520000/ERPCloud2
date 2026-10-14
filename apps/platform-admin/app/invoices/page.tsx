'use client';

import Link from 'next/link';
import { FilePlus2 } from 'lucide-react';
import { useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Table } from '../../components/ui/table';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

const INVOICE_STATUS_TONE: Record<InvoiceStatus, 'blue' | 'purple' | 'green' | 'neutral'> = {
  draft: 'blue',
  issued: 'purple',
  paid: 'green',
  void: 'neutral',
};

/**
 * الفواتير والإشعارات الدائنة — شاشة جديدة يطلبها P-C4 («`/invoices`» في الخطة).
 *
 * الفاتورة هنا **فاتورة المنصة على العميل**، لا فاتورة العميل على عميله: الأولى مستندٌ ضريبي
 * يصدره البائع (المنصة) عن اشتراك، والثانية مستند العميل في دفاتره. ولا يُخلط بينهما في
 * المستودع — لا جدولاً ولا شاشةً ولا رقماً.
 *
 * دورة المستند: **مسودّة** (رقمٌ بلا سطورها لا معنى له، والمسودّة لا تستهلك رقماً ضريبياً) ←
 * **إصدار** (يُخصَّص الرقم المتسلسل وتاريخ الاستحقاق) ← **تحصيل** (دفعة كاملة أو جزئية) ←
 * **مدفوعة**، أو **ملغاة** بسببٍ مكتوب. والإلغاء لا يُعيد الرقم: المدقق يقرأ التسلسل.
 *
 * ولأن التحصيل يدوي أولاً: «تحويل بنكي» بطريقة الدفع والمرجع ومرفق الإيصال، وبطاقةٌ لاحقاً عبر
 * بوابات السعودية القائمة (`geidea`/`neoleap`) — الحقلان محفوظان في الجدول من الآن.
 */

type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';
type InvoiceKind = 'invoice' | 'credit_note';
type PaymentMethod = 'bank_transfer' | 'cash' | 'card' | 'other';

type InvoiceSummary = {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  remaining: string;
  daysOverdue: number;
  buyerTaxNumber: string | null;
};

type InvoiceLine = {
  lineNo: number;
  kind: 'subscription' | 'proration' | 'discount' | 'adjustment';
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
};

type Payment = {
  id: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
  receiptFileId: string | null;
  gateway: string | null;
  status: string;
  receivedAt: string;
  recordedByLabel: string | null;
  note: string | null;
};

type Invoice = InvoiceSummary & { lines: InvoiceLine[]; payments: Payment[]; voidReason: string | null; note: string | null; periodStart: string | null; periodEnd: string | null; subscriptionId: string | null };

type Subscription = {
  id: string;
  status: string;
  tenantName: string;
  tenantCode: string;
  planName: string;
  amount: string;
  currency: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'مسودّة',
  issued: 'صادرة',
  paid: 'مدفوعة',
  void: 'ملغاة',
};

const KIND_LABEL: Record<InvoiceKind, string> = { invoice: 'فاتورة', credit_note: 'إشعار دائن' };

const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: 'تحويل بنكي',
  cash: 'نقداً',
  card: 'بطاقة',
  other: 'أخرى',
};

function money(value: string, currency: string): string {
  return `${Number(value).toLocaleString('ar-SA', { minimumFractionDigits: 2 })} ${currency}`;
}

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('ar-SA') : '—';
}

export default function InvoicesPage() {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Invoice>();
  const [payTarget, setPayTarget] = useState<InvoiceSummary>();
  const [issueTarget, setIssueTarget] = useState<InvoiceSummary>();
  const [voidTarget, setVoidTarget] = useState<InvoiceSummary>();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (kind) params.set('kind', kind);
  const query = params.toString();

  const invoices = useQuery<InvoiceSummary[]>(
    () => apiData<InvoiceSummary[]>(`/platform/invoices${query ? `?${query}` : ''}`),
    [status, kind],
  );

  async function openDetail(id: string) {
    setMessage(undefined);
    try {
      setDetail(await apiData<Invoice>(`/platform/invoices/${id}`));
    } catch (error) {
      setMessage({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  const rows = invoices.data ?? [];
  const totals = rows.reduce(
    (accumulator, row) => {
      return {
        billed: accumulator.billed + Number(row.total),
        paid: accumulator.paid + Number(row.paidAmount),
        remaining: accumulator.remaining + Number(row.remaining),
      };
    },
    { billed: 0, paid: 0, remaining: 0 },
  );

  return (
    <Screen
      title="الفواتير والإشعارات الدائنة"
      subtitle="فواتير المنصة على عملائها: ضريبة القيمة المضافة 15٪، ورقم متسلسل عند الإصدار، وتحصيل يدوي أولاً."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <>
          <div style={{ width: 150 }}>
            <Select label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">كل الحالات</option>
              {(Object.keys(STATUS_LABEL) as InvoiceStatus[]).map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABEL[key]}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ width: 150 }}>
            <Select label="النوع" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">النوعان</option>
              {(Object.keys(KIND_LABEL) as InvoiceKind[]).map((key) => (
                <option key={key} value={key}>
                  {KIND_LABEL[key]}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" icon={<FilePlus2 size={14} />} onClick={() => setCreating(!creating)}>
            {creating ? 'إغلاق' : 'فاتورة جديدة'}
          </Button>
        </>
      }
    >
      {creating && (
        <CreateForm
          onDone={(created) => {
            setCreating(false);
            setMessage({ kind: 'ok', text: `أُنشئت المسودّة ${created.number ?? ''} — أصدرها لتخصيص رقم ضريبي.` });
            invoices.reload();
            void openDetail(created.id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {issueTarget && (
        <IssueForm
          invoice={issueTarget}
          onDone={(issued) => {
            setIssueTarget(undefined);
            setMessage({ kind: 'ok', text: `صدرت الفاتورة برقم ${issued.number}.` });
            invoices.reload();
            void openDetail(issued.id);
          }}
          onCancel={() => setIssueTarget(undefined)}
        />
      )}
      {payTarget && (
        <PayForm
          invoice={payTarget}
          onDone={(settled) => {
            setPayTarget(undefined);
            setMessage({
              kind: 'ok',
              text: settled.status === 'paid' ? 'اكتمل سداد الفاتورة.' : `سُجِّلت الدفعة، والمتبقّي ${settled.remaining} ${settled.currency}.`,
            });
            invoices.reload();
            void openDetail(settled.id);
          }}
          onCancel={() => setPayTarget(undefined)}
        />
      )}
      {voidTarget && (
        <VoidForm
          invoice={voidTarget}
          onDone={() => {
            setVoidTarget(undefined);
            setMessage({ kind: 'ok', text: 'أُلغيت الفاتورة، والسبب مسجَّل، ورقمها محفوظ في التسلسل.' });
            invoices.reload();
          }}
          onCancel={() => setVoidTarget(undefined)}
        />
      )}
      {message && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
            message.kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
          }`}
        >
          {message.text}
        </div>
      )}

      {invoices.status === 'loading' && <Loading />}
      {invoices.status === 'error' && <ErrorBox message={invoices.error} onRetry={invoices.reload} />}
      {invoices.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا فواتير بعد" detail="أصدر فاتورة من ترخيص قائم، أو من زر «فاتورة جديدة»." />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[
                { label: 'عدد المستندات', value: String(rows.length), cls: 'text-ink' },
                { label: 'المفوتر', value: totals.billed.toLocaleString('en-US', { minimumFractionDigits: 2 }), cls: 'text-ink' },
                { label: 'المحصَّل', value: totals.paid.toLocaleString('en-US', { minimumFractionDigits: 2 }), cls: 'text-ok' },
                { label: 'المتبقّي', value: totals.remaining.toLocaleString('en-US', { minimumFractionDigits: 2 }), cls: 'text-warn' },
              ].map((stat) => (
                <div key={stat.label} className="rounded-[10px] border border-line bg-surface px-4 py-3 shadow-1">
                  <p className="m-0 text-[12px] font-bold text-muted">{stat.label}</p>
                  <p className={`m-0 mt-1 font-mono text-[19px] font-bold ${stat.cls}`} dir="ltr">{stat.value}</p>
                </div>
              ))}
            </div>
            <div className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-1">
              <Table
                rows={rows}
                rowKey={(row) => row.id}
                dense
                columns={[
                  { key: 'number', header: 'الرقم', ltr: true, cell: (row) => <span className="font-mono text-[12px]">{row.number ?? '—'}</span> },
                  {
                    key: 'tenant',
                    header: 'العميل',
                    cell: (row) => (
                      <span className="block">
                        <span className="block text-[13px] font-bold text-ink">{row.tenantName}</span>
                        <span className="block font-mono text-[11px] text-muted" dir="ltr">{row.tenantCode}</span>
                      </span>
                    ),
                  },
                  { key: 'kind', header: 'النوع', cell: (row) => <span className="text-[12.5px] text-muted">{KIND_LABEL[row.kind]}</span> },
                  {
                    key: 'status',
                    header: 'الحالة',
                    cell: (row) => (
                      <span className="block">
                        <Badge tone={INVOICE_STATUS_TONE[row.status]} dot>{STATUS_LABEL[row.status]}</Badge>
                        {row.daysOverdue > 0 && row.status === 'issued' && (
                          <span className="mt-0.5 block text-[11px] font-semibold text-danger">متأخّرة {row.daysOverdue} يوماً</span>
                        )}
                      </span>
                    ),
                  },
                  { key: 'issue', header: 'الإصدار', ltr: true, cell: (row) => <span className="font-mono text-[11.5px] text-muted">{dateText(row.issueDate)}</span> },
                  { key: 'due', header: 'الاستحقاق', ltr: true, cell: (row) => <span className="font-mono text-[11.5px] text-muted">{dateText(row.dueDate)}</span> },
                  { key: 'total', header: 'الإجمالي', numeric: true, ltr: true, cell: (row) => <span className="font-mono text-[12px] font-bold">{money(row.total, row.currency)}</span> },
                  { key: 'paid', header: 'المدفوع', numeric: true, ltr: true, cell: (row) => <span className="font-mono text-[12px] text-ok-ink">{money(row.paidAmount, row.currency)}</span> },
                  { key: 'remaining', header: 'المتبقّي', numeric: true, ltr: true, cell: (row) => <span className={`font-mono text-[12px] ${Number(row.remaining) > 0 ? 'font-bold text-warn-ink' : 'text-muted'}`}>{money(row.remaining, row.currency)}</span> },
                  {
                    key: 'actions',
                    header: '',
                    numeric: true,
                    cell: (row) => (
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button variant="secondary" size="sm" onClick={() => void openDetail(row.id)}>تفاصيل</Button>
                        {row.status === 'draft' && (
                          <Button variant="secondary" size="sm" onClick={() => setIssueTarget(row)}>إصدار</Button>
                        )}
                        {row.status === 'issued' && row.kind === 'invoice' && (
                          <Button variant="secondary" size="sm" onClick={() => setPayTarget(row)}>تحصيل</Button>
                        )}
                        {(row.status === 'draft' || row.status === 'issued') && (
                          <Button variant="danger" size="sm" onClick={() => setVoidTarget(row)}>إلغاء</Button>
                        )}
                        <Link href={`/invoices/${row.id}/print`}>
                          <Button variant="secondary" size="sm">طباعة</Button>
                        </Link>
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </>
        ))}

      {detail && <DetailCard invoice={detail} onClose={() => setDetail(undefined)} />}
    </Screen>
  );
}

function DetailCard({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>
          {KIND_LABEL[invoice.kind]} <span dir="ltr">{invoice.number ?? '— مسودّة —'}</span>
        </h2>
        <div className="row">
          <Link className="btn sm" href={`/invoices/${invoice.id}/print`}>
            طباعة
          </Link>
          <button className="btn sm" type="button" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
      <dl className="kv">
        <dt>العميل</dt>
        <dd>
          {invoice.tenantName} <span className="muted small" dir="ltr">{invoice.tenantCode}</span>
        </dd>
        <dt>الفترة</dt>
        <dd dir="ltr">
          {dateText(invoice.periodStart)} ← {dateText(invoice.periodEnd)}
        </dd>
        <dt>الرقم الضريبي للمشتري</dt>
        <dd dir="ltr">{invoice.buyerTaxNumber ?? '—'}</dd>
        <dt>الإجمالي قبل الضريبة</dt>
        <dd>
          {money(invoice.subtotal, invoice.currency)} · الضريبة ({Number(invoice.taxRate)}٪) {money(invoice.taxAmount, invoice.currency)}
        </dd>
        <dt>الإجمالي</dt>
        <dd>{money(invoice.total, invoice.currency)}</dd>
        <dt>المدفوع</dt>
        <dd>{money(invoice.paidAmount, invoice.currency)}</dd>
        <dt>المتبقّي</dt>
        <dd>{money(invoice.remaining, invoice.currency)}</dd>
        {invoice.voidReason && (
          <>
            <dt>سبب الإلغاء</dt>
            <dd>{invoice.voidReason}</dd>
          </>
        )}
      </dl>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>البند</th>
            <th className="num">الكمية</th>
            <th className="num">السعر</th>
            <th className="num">المبلغ</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.lineNo}>
              <td>{line.lineNo}</td>
              <td>{line.description}</td>
              <td className="num">{line.quantity}</td>
              <td className="num">{Number(line.unitPrice).toLocaleString('ar-SA', { minimumFractionDigits: 2 })}</td>
              <td className="num">{Number(line.amount).toLocaleString('ar-SA', { minimumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {invoice.payments.length > 0 && (
        <>
          <h2>الدفعات</h2>
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>الطريقة</th>
                <th>المرجع</th>
                <th>الإيصال</th>
                <th className="num">المبلغ</th>
                <th>سجّلها</th>
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((payment) => (
                <tr key={payment.id}>
                  <td dir="ltr">{payment.receivedAt.slice(0, 10)}</td>
                  <td>
                    {METHOD_LABEL[payment.method]}
                    {payment.gateway && <span className="muted small"> · {payment.gateway}</span>}
                  </td>
                  <td dir="ltr">{payment.reference ?? '—'}</td>
                  <td dir="ltr" className="small">
                    {payment.receiptFileId ?? '—'}
                  </td>
                  <td className="num">{money(payment.amount, invoice.currency)}</td>
                  <td>{payment.recordedByLabel ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function CreateForm({ onDone, onCancel }: { onDone: (invoice: Invoice) => void; onCancel: () => void }) {
  const subscriptions = useQuery<Subscription[]>(() => apiData<Subscription[]>('/platform/subscriptions'), []);
  const live = (subscriptions.data ?? []).filter((row) => ['trialing', 'active', 'past_due'].includes(row.status));
  const [subscriptionId, setSubscriptionId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [buyerTaxNumber, setBuyerTaxNumber] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const chosen = subscriptionId || live[0]?.id || '';
  const chosenRow = live.find((row) => row.id === chosen);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await apiPost<Invoice>('/platform/invoices', {
        subscriptionId: chosen,
        ...(periodStart ? { periodStart } : {}),
        ...(periodEnd ? { periodEnd } : {}),
        ...(buyerTaxNumber.trim() ? { buyerTaxNumber: buyerTaxNumber.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        reason: reason.trim(),
      });
      onDone(created);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>فاتورة اشتراك — مسودّة</h2>
      <p className="muted small">
        تُنشأ مسودّة بلا رقم: الرقم الضريبي يُخصَّص عند الإصدار. والمبلغ يأتي من باقة الترخيص، والضريبة تُحسب لكل سطر
        ثم تُجمع — فلا يفترق مجموع السطور عن إجمالي الفاتورة.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>الترخيص *</span>
          <select className="input" value={chosen} onChange={(event) => setSubscriptionId(event.target.value)} required>
            <option value="">اختر ترخيصاً…</option>
            {live.map((row) => (
              <option key={row.id} value={row.id}>
                {row.tenantName} — {row.planName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>من تاريخ</span>
          <input
            className="input"
            dir="ltr"
            type="date"
            value={periodStart || (chosenRow?.currentPeriodStart?.slice(0, 10) ?? '')}
            onChange={(event) => setPeriodStart(event.target.value)}
          />
        </label>
        <label className="field">
          <span>إلى تاريخ</span>
          <input
            className="input"
            dir="ltr"
            type="date"
            value={periodEnd || (chosenRow?.currentPeriodEnd?.slice(0, 10) ?? '')}
            onChange={(event) => setPeriodEnd(event.target.value)}
          />
        </label>
        <label className="field">
          <span>الرقم الضريبي للمشتري (15 رقماً، اختياري)</span>
          <input
            className="input"
            dir="ltr"
            inputMode="numeric"
            value={buyerTaxNumber}
            onChange={(event) => setBuyerTaxNumber(event.target.value)}
            placeholder="300000000000003"
          />
        </label>
        <label className="field">
          <span>ملاحظة (اختياري)</span>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label className="field">
          <span>السبب *</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !chosen}>
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء المسودّة'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function IssueForm({
  invoice,
  onDone,
  onCancel,
}: {
  invoice: InvoiceSummary;
  onDone: (issued: Invoice) => void;
  onCancel: () => void;
}) {
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueInDays, setDueInDays] = useState(14);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const issued = await apiPost<Invoice>(`/platform/invoices/${invoice.id}/issue`, {
        issueDate,
        dueInDays,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(issued);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>إصدار الفاتورة — {invoice.tenantName}</h2>
      <p className="muted small">
        الإصدار يخصّص الرقم التالي في تسلسل المنصة ويحدّد تاريخ الاستحقاق. المسودّة بلا رقم؛ وبعد الإصدار لا يُعاد
        الرقم ولا يُحذف المستند — يُلغى بسببٍ مكتوب.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>تاريخ الإصدار *</span>
          <input className="input" dir="ltr" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required />
        </label>
        <label className="field">
          <span>مهلة السداد (أيام)</span>
          <input
            className="input"
            dir="ltr"
            type="number"
            min={0}
            max={180}
            value={dueInDays}
            onChange={(event) => setDueInDays(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>ملاحظة (اختياري)</span>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الإصدار…' : `إصدار ${money(invoice.total, invoice.currency)}`}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function PayForm({
  invoice,
  onDone,
  onCancel,
}: {
  invoice: InvoiceSummary;
  onDone: (settled: Invoice) => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [valueText, setValueText] = useState(invoice.remaining);
  const [reference, setReference] = useState('');
  const [receiptFileId, setReceiptFileId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const overpaid = Number(valueText) > Number(invoice.remaining);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const settled = await apiPost<Invoice>(`/platform/invoices/${invoice.id}/pay`, {
        method,
        amount: valueText,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(receiptFileId.trim() ? { receiptFileId: receiptFileId.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(settled);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>تحصيل — {invoice.number ?? invoice.tenantName}</h2>
      <p className="muted small">
        المتبقّي {money(invoice.remaining, invoice.currency)}. الدفعة الجزئية مسموحة، وما يزيد على المتبقّي مرفوض —
        تحصيلٌ مزدوج لنفس التحويل البنكي يضاعف المدفوع ولا يصحّح نفسه.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>طريقة الدفع *</span>
          <select className="input" value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
            {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((key) => (
              <option key={key} value={key}>
                {METHOD_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>المبلغ *</span>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            value={valueText}
            onChange={(event) => setValueText(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>المرجع (رقم الحوالة/الإيصال)</span>
          <input className="input" dir="ltr" value={reference} onChange={(event) => setReference(event.target.value)} />
        </label>
        <label className="field">
          <span>مرفق الإيصال (معرّف ملف، اختياري)</span>
          <input className="input" dir="ltr" value={receiptFileId} onChange={(event) => setReceiptFileId(event.target.value)} />
        </label>
        <label className="field">
          <span>ملاحظة (اختياري)</span>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      {overpaid && <p className="alert warn">المبلغ يتجاوز المتبقّي — سيُرفض في الخادم.</p>}
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || overpaid}>
          {busy ? 'جارٍ التسجيل…' : 'تسجيل الدفعة'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function VoidForm({ invoice, onDone, onCancel }: { invoice: InvoiceSummary; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await apiPost(`/platform/invoices/${invoice.id}/void`, { reason: reason.trim() });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>إلغاء المستند — {invoice.number ?? 'مسودّة'}</h2>
      <p className="muted small">
        {invoice.status === 'paid'
          ? 'الفاتورة مدفوعة: تُردّ دفعاتها ولا تُلغى.'
          : 'الإلغاء بسببٍ مكتوب. الرقم المتسلسل يبقى محفوظاً — المدقق يقرأه، والإلغاء ليس حذفاً.'}
      </p>
      <div className="form-grid">
        <label className="field">
          <span>السبب *</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn danger" type="submit" disabled={busy}>
          {busy ? 'جارٍ الإلغاء…' : 'إلغاء المستند'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إغلاق
        </button>
      </div>
    </form>
  );
}
