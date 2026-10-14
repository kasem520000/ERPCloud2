'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { CommentsPanel } from '../../../../components/comments-panel';
import { DataTable, Notice } from '../../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { Badge } from '../../../../components/ui/badge';
import { ApiError, apiData, apiPost } from '../../../../lib/api';
import { accountLabel, listAccounts, postableOf, typeOf, type Account } from '../../../../lib/accounts';
import { type ApprovalRequest } from '../../../../lib/approvals';
import {
  arabicName,
  cashLocationLabel,
  dateTime,
  itemLabel,
  listCashLocations,
  listCostCenters,
  listItems,
  listParties,
  money,
  partyLabel,
  quantity,
  shortDate,
  statusLabel,
  type CashLocation,
  type CostCenter,
  type Item,
  type Party,
} from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

// `discountRate`/`discountAmount` من صفّ `purchase_invoice_lines` نفسه (تُقرأ مع الفاتورة)
// فيُعرض عمود «الخصم» بالمعنى المكتبي: مبلغُ الخصم لا نسبته.
// R8 — «📁 رقم الدفعة» و«🔢 التسلسلي» كما كُتبا على السطر، وحالةُ الدفعة المحسومة معه.
type InvoiceLine = { id: string; lineNo: number; itemId: string; description: string | null; quantity: string; unitPrice: string; discountRate: string; discountAmount: string; net: string; tax: string; total: string; allocatedCost: string; unitCostAtPost: string | null; batchNo?: string | null; serialNos?: string[] | null; lotId?: string | null; costCenterId?: string | null };
type LandedCost = { id: string; costName: string; amount: string; allocationTarget: string; accountId: string | null };
// صفُّ `payment_allocations` كما يعيده `GET /purchase-invoices/:id` (R3 — كان `paidTotal` وحده).
type Payment = { id: string; amount: string; allocatedAt: string; voucherId: string | null };
type Invoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  branchId: string;
  warehouseId: string | null;
  partyId: string;
  supplierReferenceNo: string | null;
  /** R9 — 📊 مركز التكلفة على رأس الفاتورة (والسطر يرثه إن لم يذكر مركزاً). */
  costCenterId?: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  additionalCostTotal: string;
  invoiceDiscount: string;
  createdAt: string;
  postedAt: string | null;
  lines: InvoiceLine[];
  costs: LandedCost[];
  payments: Payment[];
};

export default function PurchaseInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const invoiceId = String(params.id);
  const ocrJobId = searchParams.get('ocrJobId');
  const { can } = useSession();
  const invoice = useQuery<Invoice>(() => apiData<Invoice>(`/purchase-invoices/${invoiceId}`), [invoiceId]);
  const approval = useQuery<ApprovalRequest | null>(() => apiData<ApprovalRequest | null>(`/purchases/invoices/${invoiceId}/approval`), [invoiceId]);
  const items = useQuery<Item[]>(() => listItems(), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  /** R9 — أسماء مراكز التكلفة (الرأس والسطر) لعرضها باسمها لا بمعرّفها. */
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);

  const [settlement, setSettlement] = useState<'credit' | 'cash' | 'bank'>('credit');
  const [settleLocationId, setSettleLocationId] = useState('');
  const [costName, setCostName] = useState('');
  const [costAmountText, setCostAmountText] = useState('');
  const [costTarget, setCostTarget] = useState<'inventory' | 'expense'>('inventory');
  const [costAccountId, setCostAccountId] = useState('');
  const [payAmountText, setPayAmountText] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  if (invoice.status === 'loading') return <Loading />;
  if (invoice.status !== 'success' || !invoice.data) {
    return (
      <Screen title="فاتورة مشتريات" crumbs={['المشتريات']}>
        <ErrorBox message={invoice.error ?? 'تعذّر تحميل الفاتورة'} onRetry={invoice.reload} />
      </Screen>
    );
  }

  const doc = invoice.data;
  const centerName = (id: string | null | undefined): string => {
    const row = (costCenters.data ?? []).find((center) => center.id === id);
    return row ? `${row.code} — ${arabicName(row)}` : '—';
  };
  const invoiceCenter = (costCenters.data ?? []).find((row) => row.id === doc.costCenterId);
  const costCenterLabel = invoiceCenter ? `${invoiceCenter.code} — ${arabicName(invoiceCenter)}` : '';
  const supplier = (suppliers.data ?? []).find((row) => row.id === doc.partyId);
  const dueValue = Number(doc.total) - Number(doc.paidTotal);

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      invoice.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    // The posting engine builds the journal from the branch's posting profile,
    // receives the stock at landed cost, and distributes the additional costs —
    // all in one transaction. The screen only declares how the invoice settles.
    if (settlement !== 'credit' && !settleLocationId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'اختر الصندوق أو البنك الذي سدد المبلغ.');
    }
    const location = (cashLocations.data ?? []).find((row) => row.id === settleLocationId);
    const settlementAccountId = location?.accountId ?? location?.account_id ?? undefined;
    if (settlement !== 'credit' && !settlementAccountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'الموقع المختار غير مربوط بحساب محاسبي.');
    }
    if (doc.costs.some((entry) => entry.allocationTarget === 'expense' && !entry.accountId)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'مصروف مباشر بلا حساب — احذفه وأعده مربوطاً بحساب مصروف.');
    }
    await apiPost(`/purchase-invoices/${doc.id}/post`, {
      settlement,
      settlementAccountId,
      settlementCashLocationId: settleLocationId || undefined,
    });
  }

  return (
    <Screen
      title={`فاتورة مشتريات ${doc.number ?? '(مسودة)'}`}
      subtitle={`${supplier ? partyLabel(supplier) : '—'} — ${statusLabel(doc.status)}`}
      crumbs={['المشتريات', 'العمليات']}
      actions={
        <>
          {/* «🖨️ طباعة» — `frmInvPurch.xaml` L1411 (و«👁️ معاينة» L1416 مؤجَّلة: ورقةُ
              الطباعة نفسها تُعاين في المتصفّح قبل الطبع). */}
          <Link className="btn primary" href={`/print/purchase-invoice/${doc.id}`}>
            🖨️ طباعة
          </Link>
          {ocrJobId && doc.status === 'draft' && doc.lines.length === 0 && (
            <Link className="btn" href={`/purchases/invoices/ocr?job=${encodeURIComponent(ocrJobId)}`}>
              استكمال ربط بنود OCR
            </Link>
          )}
          <Link className="btn" href="/purchases/invoices">
            كل الفواتير
          </Link>
        </>
      }
    >
      <div className="grid cols-2">
        <div className="card">
          <h2>بيانات الفاتورة</h2>
          {approval.data?.status === 'pending' ? <Badge tone="purple" dot>بانتظار موافقة</Badge> : null}
          {approval.data?.status === 'rejected' ? <Badge tone="red" dot>رُفضت — ما زالت مسودة</Badge> : null}
          <dl className="kv">
            <dt>📋 الحالة</dt>
            <dd>{statusLabel(doc.status)}</dd>
            {/* «🔢 الرقم» L366 — رقم المستند نفسه، ويُمنح عند الترحيل (في الديسكتوب `txtNo` للقراءة فقط). */}
            <dt>🔢 الرقم</dt>
            <dd>{doc.number ?? '(مسودة)'}</dd>
            {/* «📊 مركز التكلفة» L467 — يُعرض باسمه كما في الديسكتوب (`Print.cs` L772–774). */}
            {costCenterLabel && (
              <>
                <dt>📊 مركز التكلفة</dt>
                <dd>{costCenterLabel}</dd>
              </>
            )}
            {/* «📋 المرجع» L545 — رقم فاتورة المورد. */}
            <dt>📋 المرجع</dt>
            <dd>{doc.supplierReferenceNo ?? '—'}</dd>
            {/* «📅 التاريخ» L434 و«🕐 وقت الفاتورة» L503. */}
            <dt>📅 التاريخ</dt>
            <dd>{shortDate(doc.createdAt)}</dd>
            <dt>🕐 وقت الفاتورة</dt>
            <dd>{dateTime(doc.createdAt).slice(11)}</dd>
            <dt>الترحيل</dt>
            <dd>{doc.postedAt ? dateTime(doc.postedAt) : '—'}</dd>
            <dt>قبل الضريبة</dt>
            <dd>{money(doc.subtotal, doc.currency)}</dd>
            <dt>الضريبة</dt>
            <dd>{money(doc.taxTotal, doc.currency)}</dd>
            <dt>مصاريف إضافية</dt>
            <dd>{money(doc.additionalCostTotal, doc.currency)}</dd>
            <dt>الإجمالي</dt>
            <dd>
              <strong>{money(doc.total, doc.currency)}</strong>
            </dd>
            <dt>المدفوع</dt>
            <dd>{money(doc.paidTotal, doc.currency)}</dd>
            <dt>المتبقي</dt>
            <dd>{money(dueValue, doc.currency)}</dd>
            {/*
              لوحة ملخّص النافذة `frmInvPurch.xaml` L920–L936 — الثلاثة التي تحسبها
              السحابة من بياناتها. وما بقي منها (الكمية الحالية · التعادل · كمية و/س ·
              آخر شراء/آخر بيع/المتوسط/المنافس · باركود الصنف) مؤجَّلٌ ومُعلَّل في §R3.5.
            */}
            <dt>📊 عدد البنود</dt>
            <dd>{doc.lines.length}</dd>
            <dt>📦 إجمالي الكمية</dt>
            <dd>{quantity(doc.lines.reduce((sum, line) => sum + Number(line.quantity), 0))}</dd>
            <dt>🏷️ خصم الفاتورة</dt>
            <dd>{money(doc.invoiceDiscount ?? '0', doc.currency)}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>الإجراءات</h2>
          <Notice notice={notice} />

          {doc.status === 'draft' && can('purchase.cost.manage') && (
            <>
              <h3>مصروف إضافي (شحن، تخليص…)</h3>
              <div className="form-grid">
                <label className="field">
                  <span>البيان</span>
                  <input className="input" value={costName} onChange={(event) => setCostName(event.target.value)} />
                </label>
                <label className="field">
                  <span>المبلغ</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={costAmountText} onChange={(event) => setCostAmountText(event.target.value)} />
                </label>
                <label className="field">
                  <span>التوزيع</span>
                  <select className="input" value={costTarget} onChange={(event) => setCostTarget(event.target.value as 'inventory' | 'expense')}>
                    <option value="inventory">على تكلفة الأصناف (يُنسب للمخزون)</option>
                    <option value="expense">مصروف مباشر (حساب مصروف)</option>
                  </select>
                </label>
                {costTarget === 'expense' && (
                  <label className="field">
                    <span>حساب المصروف *</span>
                    <select className="input" value={costAccountId} onChange={(event) => setCostAccountId(event.target.value)}>
                      <option value="">— اختر —</option>
                      {(accounts.data ?? [])
                        .filter((row) => postableOf(row) && typeOf(row) === 'expense')
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {accountLabel(row)}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </div>
              <button
                className="btn"
                type="button"
                disabled={busy || !costName.trim() || !costAmountText.trim() || (costTarget === 'expense' && !costAccountId)}
                onClick={() =>
                  run(async () => {
                    await apiPost(`/purchase-invoices/${doc.id}/costs`, {
                      costName: costName.trim(),
                      amount: costAmountText.trim(),
                      allocationTarget: costTarget,
                      accountId: costTarget === 'expense' ? costAccountId : undefined,
                    });
                    setCostName('');
                    setCostAmountText('');
                    setCostAccountId('');
                  }, costTarget === 'inventory' ? 'تمت إضافة المصروف؛ سيوزَّع على تكلفة الأصناف عند الترحيل.' : 'تمت إضافة المصروف المباشر.')
                }
              >
                إضافة المصروف
              </button>
            </>
          )}

          {doc.status === 'draft' && can('purchase.invoice.post') && (
            <>
              <h3>الترحيل</h3>
              {/* «💳 طريقة الدفع» L330 وخياراتها «آجلة»/«نقدية»/«بنك» (`frmInvPurch.xaml.cs` L191–193). */}
              <label className="field">
                <span>💳 طريقة الدفع</span>
                <select className="input" value={settlement} onChange={(event) => setSettlement(event.target.value as 'credit' | 'cash' | 'bank')}>
                  <option value="credit">آجلة</option>
                  <option value="cash">نقدية</option>
                  <option value="bank">بنك</option>
                </select>
              </label>
              {settlement !== 'credit' && (
                <label className="field">
                  {/* «🏦 الصندوق» L340 أو «🏦 البنك» L424 — التسمية تتبدّل مع طريقة الدفع. */}
                  <span>{settlement === 'bank' ? '🏦 البنك' : '🏦 الصندوق'} *</span>
                  <select className="input" value={settleLocationId} onChange={(event) => setSettleLocationId(event.target.value)}>
                    <option value="">— اختر —</option>
                    {(cashLocations.data ?? []).map((row) => (
                      <option key={row.id} value={row.id}>
                        {cashLocationLabel(row)}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">يُقيَّد المبلغ على حساب هذا الموقع وتُسجَّل دفعة بنفس القيمة.</span>
                </label>
              )}
              <button className="btn primary" type="button" disabled={busy} onClick={() => run(post, 'تم ترحيل الفاتورة وأُدخلت البضاعة للمخزون بتكلفتها النهائية.')}>
                {busy ? 'جارٍ الترحيل…' : 'ترحيل الفاتورة'}
              </button>
            </>
          )}

          {doc.status === 'posted' && can('purchase.invoice.pay') && dueValue > 0 && (
            <>
              <h3>سداد للمورد</h3>
              <label className="field">
                <span>المبلغ</span>
                <input className="input" dir="ltr" inputMode="decimal" value={payAmountText} onChange={(event) => setPayAmountText(event.target.value)} />
              </label>
              <button
                className="btn"
                type="button"
                disabled={busy || !payAmountText.trim()}
                onClick={() => run(() => apiPost(`/purchase-invoices/${doc.id}/payments`, { amount: payAmountText.trim(), idempotencyKey: crypto.randomUUID() }), 'تم تسجيل السداد.')}
              >
                تسجيل السداد
              </button>
              <p className="muted small">لتسجيل الصرف نقداً من الصندوق استخدم «سند صرف لمورد» في شاشة السندات.</p>
            </>
          )}

          {doc.status === 'posted' && can('purchase.invoice.void') && (
            <>
              {/* «🗑️ حذف» L1406 — والسحابة تعكسها إلغاءً، كما في نافذة البيع (§R2.5). */}
              <h3>🗑️ إلغاء الفاتورة</h3>
              <label className="field">
                <span>سبب الإلغاء</span>
                <input className="input" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} />
              </label>
              <button
                className="btn danger"
                type="button"
                disabled={busy || !voidReason.trim()}
                onClick={() => run(() => apiPost(`/purchase-invoices/${doc.id}/void`, { reason: voidReason.trim() }), 'تم إلغاء الفاتورة.')}
              >
                🗑️ إلغاء الفاتورة
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card">
        {/* «📋 بنود الفاتورة» — `frmInvPurch.xaml` L665. */}
        <h2>📋 بنود الفاتورة</h2>
        <DataTable
          rows={doc.lines}
          rowKey={(row) => row.id}
          columns={[
            { key: 'no', header: '#', align: 'num', cell: (row) => row.lineNo },
            {
              // «🔍 الصنف» — `frmInvPurch.xaml` L746.
              key: 'item',
              header: '🔍 الصنف',
              cell: (row) => {
                const item = (items.data ?? []).find((entry) => entry.id === row.itemId);
                return item ? itemLabel(item) : (row.description ?? '—');
              },
            },
            // «الكمية» L800 · «السعر» L809 · «المجموع» L818 (المبلغ قبل الخصم).
            { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => quantity(row.quantity) },
            { key: 'price', header: 'السعر', align: 'num', cell: (row) => money(row.unitPrice) },
            { key: 'gross', header: 'المجموع', align: 'num', cell: (row) => money(Number(row.quantity) * Number(row.unitPrice)) },
            // «الخصم» L827 · «الضريبة» L838 (وهي نصيب السطر من خصم الرأس أيضاً — `ItemOper.CalcTotal`).
            { key: 'discount', header: 'الخصم', align: 'num', cell: (row) => money(row.discountAmount) },
            { key: 'net', header: 'الإجمالي', align: 'num', cell: (row) => money(row.net) },
            { key: 'tax', header: 'الضريبة', align: 'num', cell: (row) => money(row.tax) },
            // «الصافي» L847 = `ItemNetPrice` أي السطر بعد الخصم **مع** الضريبة.
            { key: 'total', header: 'الصافي', align: 'num', cell: (row) => money(row.total) },
            { key: 'batch', header: '📁 رقم الدفعة', align: 'ltr', cell: (row) => row.batchNo ?? '—' },
            { key: 'costCenter', header: '📊 مركز التكلفة', cell: (row) => centerName(row.costCenterId ?? doc.costCenterId) },
            {
              key: 'serials',
              header: '🔢 التسلسلي',
              align: 'ltr',
              cell: (row) => (row.serialNos ?? []).join(' · ') || '—',
            },
            // عمودان سحابيان لا نظيرَ لهما في جدول النافذة: الديسكتوب يصهر التكلفة
            // الإضافية في تكلفة الصنف (`ItemAdditonalCos`, `ItemOper.cs:2086`) فلا يُظهرها.
            { key: 'alloc', header: '📦 مصاريف محمّلة', align: 'num', cell: (row) => money(row.allocatedCost) },
            { key: 'unitcost', header: '📦 التكلفة النهائية', align: 'num', cell: (row) => money(row.unitCostAtPost) },
          ]}
        />
      </div>

      {doc.payments.length > 0 && (
        <div className="card">
          {/*
            عمودٌ سحابي لا نظيرَ له في جدول النافذة: الديسكتوب يكتب الدفعة في دفتر
            `Entry` ويُظهر «💰 الرصيد» L489 وحده. وصفوف التخصيص كانت تُكتب في السحابة
            ولا تُقرأ — أُضيفت قراءتها في R3 (`GET /purchase-invoices/:id`).
          */}
          <h2>💵 الدفعات المسدّدة</h2>
          <DataTable
            rows={doc.payments}
            rowKey={(row) => row.id}
            columns={[
              { key: 'at', header: 'التاريخ', align: 'ltr', cell: (row) => dateTime(row.allocatedAt) },
              { key: 'amount', header: 'المبلغ', align: 'num', cell: (row) => money(row.amount, doc.currency) },
              { key: 'voucher', header: 'السند', cell: (row) => row.voucherId ?? 'عند الترحيل' },
            ]}
          />
        </div>
      )}

      {doc.costs.length > 0 && (
        <div className="card">
          <h2>المصاريف الإضافية</h2>
          <DataTable
            rows={doc.costs}
            rowKey={(row) => row.id}
            columns={[
              { key: 'name', header: 'البيان', cell: (row) => row.costName },
              { key: 'target', header: 'التوزيع', cell: (row) => (row.allocationTarget === 'inventory' ? 'على تكلفة الأصناف' : 'مصروف مباشر') },
              { key: 'amount', header: 'المبلغ', align: 'num', cell: (row) => money(row.amount) },
            ]}
          />
        </div>
      )}

      <CommentsPanel entityType="purchase_invoice" entityId={doc.id} />
    </Screen>
  );
}
