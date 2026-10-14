'use client';

import { useCallback, useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../lib/api';
import { listParties, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';

/**
 * 🚐 تطبيق المندوب — the rep's own workspace.
 *
 * Everything on this page comes from `GET /van-sales/me`, which derives the rep from the
 * caller's own membership (`memberships → employees → salesmen`) and reads the **official**
 * `stock_balances` of his van warehouse. No id is taken from the URL or the body, so one rep
 * cannot open another's custody — and the server enforces the same thing, not just the UI.
 */
type StockRow = {
  itemId: string;
  itemName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  quantity: string;
  value: string;
  averageCost: string;
};

type PendingReceipt = {
  id: string;
  number: string;
  loadDate: string;
  status: string;
  loadedQty: string;
  receivedQty: string;
  productionBatchNo: string;
  stockTransferId: string | null;
  itemName: string;
  fromWarehouseName: string;
};

type LoadOrder = {
  id: string;
  number: string;
  loadDate: string;
  status: string;
  itemName: string;
  productionBatchNo: string;
  loadedQty: string;
  receivedQty: string;
  soldQty: string;
  bonusQty: string;
  returnedQty: string;
  damagedQty: string;
  shortageQty: string;
  shortageValue: string;
  expectedCash: string;
  collectedCash: string;
  outstandingCash: string;
  /** ما يجب أن يبقى في السيارة حسب المستندات قبل الجرد. */
  expectedRemainingQty: string;
  /** ما أعلنه المندوب فعلياً عند تقديم الإغلاق. */
  actualRemainingQty: string;
  discrepancyQty: string;
  discrepancyNotes: string | null;
  closingSubmittedAt: string | null;
  approvedAt: string | null;
  /** 🧾 تسوية المخزون الرسمية بعد اعتماد المحاسب. */
  stockSettlementStatus?: string;
  stockSettlementNote?: string;
  remainingAction?: 'return_to_main' | 'carry_over' | null;
};

type RepDocument = {
  id: string;
  number: string;
  docDate: string;
  documentKind: string;
  invoiceMode: string;
  paymentMethod: string;
  customerName: string;
  itemName: string;
  soldQty: string;
  bonusQty: string;
  unitPrice: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidAmount: string;
  outstanding: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
};

type CollectionRow = {
  id: string;
  collectedAt: string;
  amount: string;
  reason: string;
  voucherNumber: string | null;
  voucherStatus: string | null;
};

type RepWorkspace = {
  isRep: boolean;
  salesmanId: string | null;
  salesmanName: string | null;
  warehouseId: string | null;
  vehiclePlate: string | null;
  active: boolean;
  message?: string;
  balances: StockRow[];
  custodyKg: string;
  custodyValue: string;
  pendingReceipts: PendingReceipt[];
  loadOrders: LoadOrder[];
  documents: RepDocument[];
  collections: CollectionRow[];
  totals: {
    revenue: string;
    cashSales: string;
    creditSales: string;
    collected: string;
    outstanding: string;
  };
  custody: { expectedKg: string; officialKg: string; pendingClosings: number } | null;
  notifications: Array<{
    id: string;
    type: string;
    read: boolean;
    createdAt: string;
    payload: Record<string, unknown>;
  }>;
};

const LOAD_STATUS_AR: Record<string, string> = {
  draft: 'مسودة',
  pending_receipt: '🚚 بانتظار تأكيد استلامك',
  loaded: '✅ في عهدتك',
  in_route: '🛣️ قيد التوزيع',
  pending_closing: '⏳ إغلاق مُقدَّم بانتظار المحاسب',
  /** اعتُمدت الكميات، لكن رصيد سيارتك الرسمي ما زال يختلف عن جردك — العهدة لم تُغلق بعد. */
  pending_stock_settlement: '🧾 معتَمَد الكميات وبانتظار تسوية المخزون',
  settled: '✔ مُعتمد ومُصفّى ومُسوّى مخزنياً',
  reconciled: '✔ مُطابَق',
  rejected: '❌ مرفوض من قبلك (أُعيدت الكمية رسمياً)',
  canceled: '🗑️ ملغى من المحاسب',
};

/** حالة تسوية المخزون كما تُعرض للمندوب. */
const SETTLEMENT_STATUS_AR: Record<string, string> = {
  pending_transit_decision: '🚦 فرق استلامك بانتظار قرار المحاسب',
  pending_count_decision: '🧾 فرق جردك بانتظار تسوية المحاسب',
  settled_officially: '✅ سُوّي رصيد سيارتك رسمياً',
  blocked_missing_accounts: '⛔ تسويتك متوقفة على إعداد حسابات المحاسبة',
};

export default function VanSalesRepPage() {
  const { can } = useSession();
  const [data, setData] = useState<RepWorkspace | null>(null);
  const [customers, setCustomers] = useState<Party[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string }>();
  const [busy, setBusy] = useState(false);

  // ✅ تأكيد الاستلام
  const [receiptTarget, setReceiptTarget] = useState<PendingReceipt | null>(null);
  const [receiptQty, setReceiptQty] = useState('');
  const [receiptNotes, setReceiptNotes] = useState('');

  // 🧾 إصدار فاتورة بيع
  const [saleLoadOrderId, setSaleLoadOrderId] = useState('');
  const [salePartyId, setSalePartyId] = useState('');
  const [saleWalkIn, setSaleWalkIn] = useState('');
  const [saleQty, setSaleQty] = useState('');
  const [saleBonusQty, setSaleBonusQty] = useState('0');
  const [saleBonusReason, setSaleBonusReason] = useState('');
  const [saleUnitPrice, setSaleUnitPrice] = useState('');
  const [salePayment, setSalePayment] = useState<'cash' | 'card' | 'credit'>('cash');

  // 💵 تحصيل مديونية
  const [collectDocId, setCollectDocId] = useState('');
  const [collectAmount, setCollectAmount] = useState('');

  // 🔒 إغلاق الوردية
  const [closingTarget, setClosingTarget] = useState<LoadOrder | null>(null);
  const [closingReturned, setClosingReturned] = useState('0');
  const [closingDamaged, setClosingDamaged] = useState('0');
  const [closingDamageReason, setClosingDamageReason] = useState('');
  const [closingCash, setClosingCash] = useState('0');
  const [closingActualRemaining, setClosingActualRemaining] = useState('0');
  const [closingNotes, setClosingNotes] = useState('');

  const load = useCallback(async () => {
    const [meRes, custRes] = await Promise.allSettled([
      apiData<RepWorkspace>('/van-sales/me'),
      listParties('customer'),
    ]);
    if (meRes.status === 'fulfilled') setData(meRes.value);
    if (custRes.status === 'fulfilled') setCustomers(custRes.value);
    if (meRes.status === 'rejected') {
      const error = meRes.reason;
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر تحميل مساحة عمل المندوب',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * معرّف فريد لكل إرسال — the same key on a retry returns the same result instead of a
   * second document, which is what makes a flaky mobile connection safe.
   */
  const idempotencyKey = (prefix: string) =>
    `${prefix}:${data?.salesmanId ?? 'rep'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  async function run(action: () => Promise<unknown>, okText: (result: unknown) => string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await action();
      await load();
      setNotice({ kind: 'ok', text: okText(result) });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : 'تعذر تنفيذ العملية',
      });
    } finally {
      setBusy(false);
    }
  }

  const openLoads = (data?.loadOrders ?? []).filter(
    (row) => !['settled', 'canceled', 'rejected'].includes(row.status),
  );

  return (
    <Screen
      title="🚐 تطبيق مندوب التوزيع"
      subtitle="عهدتك وأرصدة سيارتك الرسمية، توريداتك بانتظار التأكيد، فواتيرك وتحصيلاتك، وإغلاق ورديتك — كلها من حسابك أنت."
      crumbs={['توزيع المناديب والمخابز', 'تطبيق المندوب']}
      actions={
        <button type="button" className="btn sm" onClick={() => void load()} disabled={busy}>
          🔄 تحديث
        </button>
      }
    >
      {notice ? <Notice notice={notice} /> : null}

      {data && !data.isRep ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>⚠️ حسابك غير مرتبط ببطاقة مندوب</h2>
          <p className="muted">{data.message}</p>
        </div>
      ) : null}

      {data?.isRep ? (
        <div className="grid gap-4">
          {/* البطاقة والعهدات */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <div className="card">
              <div className="muted small">المندوب</div>
              <strong>{data.salesmanName}</strong>
              <div className="muted small">
                {data.vehiclePlate ? `🚐 ${data.vehiclePlate}` : '🚐 بلا لوحة مسجّلة'}
              </div>
            </div>
            <div className="card">
              <div className="muted small">رصيد سيارتك الرسمي</div>
              <strong style={{ fontSize: 21 }} dir="ltr">{data.custodyKg} kg</strong>
              <div className="muted small" dir="ltr">قيمة: {data.custodyValue} SAR</div>
            </div>
            <div className="card">
              <div className="muted small">مبيعات اليوم (إجمالي)</div>
              <strong style={{ fontSize: 21, color: 'var(--ok)' }} dir="ltr">{data.totals.revenue}</strong>
              <div className="muted small" dir="ltr">
                نقدي {data.totals.cashSales} · آجل {data.totals.creditSales}
              </div>
            </div>
            <div className="card">
              <div className="muted small">المحصّل / المتبقي على العملاء</div>
              <strong style={{ fontSize: 21 }} dir="ltr">{data.totals.collected}</strong>
              <div className="muted small" dir="ltr" style={{ color: 'var(--warn)' }}>
                متبقٍ: {data.totals.outstanding}
              </div>
            </div>
            <div className="card">
              <div className="muted small">حالة العهدة</div>
              <strong style={{ fontSize: 21 }} dir="ltr">{data.custody?.expectedKg ?? '0.0000'} kg</strong>
              <div className="muted small">
                {data.custody?.pendingClosings
                  ? `⏳ ${data.custody.pendingClosings} إغلاق بانتظار المحاسب`
                  : '✅ لا يوجد إغلاق معلّق'}
              </div>
            </div>
          </div>

          {/* 🔔 إشعارات التوريد */}
          {data.notifications.length ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>🔔 إشعارات</h2>
              <ul className="muted small" style={{ margin: 0, paddingInlineStart: 18 }}>
                {data.notifications.slice(0, 6).map((row) => (
                  <li key={row.id}>
                    <b>{String(row.payload.title ?? row.type)}</b>
                    {row.payload.body ? ` — ${String(row.payload.body)}` : ''}
                    {!row.read ? ' (جديد)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ✅ التوريدات بانتظار تأكيدك */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>🚚 توريدات بانتظار تأكيد استلامك ({data.pendingReceipts.length})</h2>
            <p className="muted small" style={{ margin: 0 }}>
              البضاعة المصروفة لك تبقى رسميًّا «تحت التحويل» ولا تدخل رصيد سيارتك إلا بعد تأكيدك. إن وصلك أقل من
              المصروف، سجّل الفرق وسيراجعه المحاسب.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم الأمر</th>
                    <th>التاريخ</th>
                    <th>من مستودع</th>
                    <th>الصنف</th>
                    <th>المصروف</th>
                    <th>دفعة الإنتاج</th>
                    <th>إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pendingReceipts.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr"><b>{row.number}</b></td>
                      <td dir="ltr">{row.loadDate}</td>
                      <td>{row.fromWarehouseName}</td>
                      <td>{row.itemName}</td>
                      <td dir="ltr"><b>{row.loadedQty} kg</b></td>
                      <td dir="ltr">{row.productionBatchNo}</td>
                      <td>
                        <button
                          type="button"
                          className="btn sm primary"
                          disabled={busy || !can('van_sales.view')}
                          onClick={() => {
                            setReceiptTarget(row);
                            setReceiptQty(row.loadedQty);
                            setReceiptNotes('');
                          }}
                        >
                          ✅ تأكيد / تسجيل فرق
                        </button>
                      </td>
                    </tr>
                  ))}
                  {data.pendingReceipts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="muted">لا يوجد توريد بانتظارك.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {/* 📦 أرصدة سيارتك الرسمية */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>📦 أرصدة أصناف سيارتك (من دفتر المخزون الرسمي)</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>البطاقة</th>
                    <th>المستودع</th>
                    <th align="left">الرصيد</th>
                    <th align="left">متوسط التكلفة</th>
                    <th align="left">القيمة</th>
                  </tr>
                </thead>
                <tbody>
                  {data.balances.map((row) => (
                    <tr key={`${row.warehouseId}-${row.itemId}`}>
                      <td>{row.itemName}</td>
                      <td dir="ltr">{row.sku}</td>
                      <td>{row.warehouseName}</td>
                      <td align="left" dir="ltr"><b>{row.quantity}</b></td>
                      <td align="left" dir="ltr">{row.averageCost}</td>
                      <td align="left" dir="ltr">{row.value}</td>
                    </tr>
                  ))}
                  {data.balances.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted">لا يوجد رصيد في سيارتك بعد — أكّد استلام أول توريد.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {/* 🧾 إصدار فاتورة بيع */}
          <form
            className="card"
            style={{ display: 'grid', gap: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  apiPost('/van-sales/documents', {
                    loadOrderId: saleLoadOrderId,
                    partyId: salePartyId || null,
                    customerName: salePartyId ? undefined : saleWalkIn || undefined,
                    paymentMethod: salePayment,
                    soldQty: saleQty,
                    bonusQty: saleBonusQty || '0',
                    bonusReason: saleBonusReason || undefined,
                    unitPrice: saleUnitPrice || undefined,
                    invoiceMode: 'zatca_tax',
                    idempotencyKey: idempotencyKey('rep-sale'),
                  }),
                () => `تم إصدار فاتورة البيع وخصم الكمية من رصيد سيارتك الرسمي.`,
              );
            }}
          >
            <h2 style={{ margin: 0 }}>🧾 تسجيل بيع وإصدار فاتورة</h2>
            <p className="muted small" style={{ margin: 0 }}>
              تُخصم الكمية المباعة والمجانية من رصيد سيارتك الرسمي، وتُصدر فاتورة مبيعات رسمية مرقّمة بالضريبة
              المستحقة. السعر يلتزم بشريحة العميل المعتمدة — وأي تجاوز يحتاج صلاحية اعتماد من الإدارة.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>العهدة / أمر التحميل *</span>
                <select
                  className="input"
                  required
                  value={saleLoadOrderId}
                  onChange={(e) => setSaleLoadOrderId(e.target.value)}
                >
                  <option value="">— اختر —</option>
                  {openLoads.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.number} · {row.itemName} · متبقٍ{' '}
                      {(
                        Number(row.receivedQty) -
                        Number(row.soldQty) -
                        Number(row.bonusQty) -
                        Number(row.returnedQty) -
                        Number(row.damagedQty)
                      ).toFixed(2)}{' '}
                      kg
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>العميل</span>
                <select className="input" value={salePartyId} onChange={(e) => setSalePartyId(e.target.value)}>
                  <option value="">— عميل نقدي (بدون بطاقة) —</option>
                  {customers.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </label>
              {!salePartyId ? (
                <label className="field">
                  <span>اسم العميل النقدي</span>
                  <input
                    className="input"
                    value={saleWalkIn}
                    onChange={(e) => setSaleWalkIn(e.target.value)}
                    placeholder="مثال: بقالة الحي"
                  />
                </label>
              ) : null}
              <label className="field">
                <span>الكمية المباعة *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={saleQty}
                  onChange={(e) => setSaleQty(e.target.value)}
                />
              </label>
              <label className="field">
                <span>سعر الوحدة (اتركه فارغًا لاستخدام شريحة العميل)</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={saleUnitPrice}
                  onChange={(e) => setSaleUnitPrice(e.target.value)}
                />
              </label>
              <label className="field">
                <span>كمية مجانية / بونص</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={saleBonusQty}
                  onChange={(e) => setSaleBonusQty(e.target.value)}
                />
              </label>
              <label className="field">
                <span>سبب البونص</span>
                <input
                  className="input"
                  value={saleBonusReason}
                  onChange={(e) => setSaleBonusReason(e.target.value)}
                  placeholder="مثال: عرض ترويجي متفق عليه"
                />
              </label>
              <label className="field">
                <span>طريقة الدفع</span>
                <select
                  className="input"
                  value={salePayment}
                  onChange={(e) => setSalePayment(e.target.value as 'cash' | 'card' | 'credit')}
                >
                  <option value="cash">نقدًا</option>
                  <option value="card">شبكة</option>
                  <option value="credit">آجل (على حساب العميل)</option>
                </select>
              </label>
            </div>
            <div>
              <button type="submit" className="btn primary" disabled={busy || !can('van_sales.invoice.create')}>
                {busy ? 'جارٍ الإصدار…' : '🧾 اعتماد البيع وإصدار الفاتورة'}
              </button>
            </div>
          </form>

          {/* 🧾 سجل الفواتير والتحصيل */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>🧾 فواتيرك ومستنداتك</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>رقم المستند</th>
                    <th>الفاتورة الرسمية</th>
                    <th>التاريخ</th>
                    <th>العميل</th>
                    <th>مباع / مجاني</th>
                    <th align="left">الإجمالي</th>
                    <th align="left">المدفوع</th>
                    <th align="left">المتبقي</th>
                    <th>تحصيل</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr"><b>{row.number}</b></td>
                      <td dir="ltr">
                        {row.invoiceNumber ?? '—'}
                        {row.invoiceStatus ? <div className="muted small">{row.invoiceStatus}</div> : null}
                      </td>
                      <td dir="ltr">{row.docDate}</td>
                      <td>{row.customerName}</td>
                      <td dir="ltr">
                        {row.soldQty} / {row.bonusQty}
                        {row.documentKind === 'return' ? ' ↩️ مرتجع' : ''}
                      </td>
                      <td align="left" dir="ltr">{row.total}</td>
                      <td align="left" dir="ltr">{row.paidAmount}</td>
                      <td align="left" dir="ltr" style={{ color: Number(row.outstanding) > 0 ? 'var(--warn)' : undefined }}>
                        {row.outstanding}
                      </td>
                      <td>
                        {Number(row.outstanding) > 0 ? (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy || !can('van_sales.collection.create')}
                            onClick={() => {
                              setCollectDocId(row.id);
                              setCollectAmount(row.outstanding);
                            }}
                          >
                            💵 تحصيل
                          </button>
                        ) : (
                          <span className="muted small">مسدّد</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.documents.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="muted">لا توجد فواتير بعد.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {/* 💵 التحصيلات */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>💵 ما حصّلته اليوم</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الوقت</th>
                    <th align="left">المبلغ</th>
                    <th>سند القبض الرسمي</th>
                    <th>البيان</th>
                  </tr>
                </thead>
                <tbody>
                  {data.collections.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{new Date(row.collectedAt).toLocaleString('ar-SA-u-ca-gregory')}</td>
                      <td align="left" dir="ltr"><b>{row.amount}</b></td>
                      <td dir="ltr">
                        {row.voucherNumber ?? '—'}
                        {row.voucherStatus ? <div className="muted small">{row.voucherStatus}</div> : null}
                      </td>
                      <td className="muted small">{row.reason}</td>
                    </tr>
                  ))}
                  {data.collections.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">لا توجد تحصيلات مسجّلة.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {/* 🔒 إغلاق الوردية */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>🔒 إغلاق الوردية وتصفية العهدة</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الأمر</th>
                    <th>الحالة</th>
                    <th>استلمت</th>
                    <th>بعت</th>
                    <th>مجاني</th>
                    <th>متبقٍ بالعهدة</th>
                    <th>نقد متوقع / محصّل</th>
                    <th>إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {data.loadOrders.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr"><b>{row.number}</b></td>
                      <td>
                        {LOAD_STATUS_AR[row.status] ?? row.status}
                        {row.stockSettlementStatus && row.stockSettlementStatus !== 'not_required' ? (
                          <div className="muted small">
                            {SETTLEMENT_STATUS_AR[row.stockSettlementStatus] ?? row.stockSettlementStatus}
                            {row.remainingAction
                              ? ` · المتبقي: ${
                                  row.remainingAction === 'return_to_main'
                                    ? 'أُعيد للمستودع الرئيسي'
                                    : 'بقي عهدة الوردية التالية'
                                }`
                              : ''}
                          </div>
                        ) : null}
                      </td>
                      <td dir="ltr">{row.receivedQty}</td>
                      <td dir="ltr">{row.soldQty}</td>
                      <td dir="ltr">{row.bonusQty}</td>
                      <td dir="ltr">
                        {Number(row.expectedRemainingQty).toFixed(2)}
                        {Number(row.actualRemainingQty) > 0 || row.status === 'settled' ? (
                          <span className="muted small"> / جرد {Number(row.actualRemainingQty).toFixed(2)}</span>
                        ) : null}
                      </td>
                      <td dir="ltr">{row.expectedCash} / {row.collectedCash}</td>
                      <td>
                        {['loaded', 'in_route'].includes(row.status) ? (
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={busy || !can('van_sales.closing.submit')}
                            onClick={() => {
                              setClosingTarget(row);
                              setClosingReturned('0');
                              setClosingDamaged('0');
                              setClosingDamageReason('');
                              setClosingCash(row.collectedCash);
                              // لا يُملأ الجرد الفعلي برقم المستندات: فالمندوب يكتب ما عدّه بيده.
                              setClosingActualRemaining('');
                              setClosingNotes('');
                            }}
                          >
                            🔒 تقديم إغلاق الوردية
                          </button>
                        ) : (
                          <span className="muted small">
                            {row.status === 'pending_closing'
                              ? '⏳ بانتظار اعتماد المحاسب'
                              : row.status === 'pending_stock_settlement'
                                ? '🧾 اعتُمدت كمياتك وبانتظار تسوية المخزون الرسمية — عهدتك لم تُغلق بعد'
                                : row.status === 'rejected'
                                  ? '❌ رفضتَ استلامه وأُعيدت الكمية رسمياً'
                                  : row.status === 'canceled'
                                    ? '🗑️ أُلغي وأُعيدت كميته إلى المستودع'
                                    : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {/* ✅ نافذة تأكيد الاستلام */}
      {receiptTarget ? (
        <div role="dialog" aria-modal="true" className="modal-backdrop" style={backdropStyle}>
          <div className="card" style={dialogStyle}>
            <h2 style={{ marginTop: 0 }}>✅ تأكيد استلام التوريد {receiptTarget.number}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              المصروف من المستودع الرئيسي: <b dir="ltr">{receiptTarget.loadedQty} kg</b> — الصنف:{' '}
              {receiptTarget.itemName}. أكّد الكمية التي استلمتها فعلًا؛ أي فرق يُسجَّل ويصل المحاسب للمراجعة.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>الكمية المستلمة فعلًا *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  required
                  dir="ltr"
                  value={receiptQty}
                  onChange={(e) => setReceiptQty(e.target.value)}
                />
              </label>
              <label className="field">
                <span>ملاحظات / سبب الفرق</span>
                <input
                  className="input"
                  value={receiptNotes}
                  onChange={(e) => setReceiptNotes(e.target.value)}
                  placeholder="مثال: كرتونة تالفة أثناء النقل"
                />
              </label>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      apiPost(`/van-sales/load-orders/${receiptTarget.id}/confirm-receipt`, {
                        receivedQty: receiptQty,
                        notes: receiptNotes || undefined,
                      }),
                    () =>
                      Number(receiptQty) < Number(receiptTarget.loadedQty)
                        ? `تم تسجيل استلام ${receiptQty} kg وفرق ${(
                            Number(receiptTarget.loadedQty) - Number(receiptQty)
                          ).toFixed(2)} kg — أُحيل الفرق إلى المحاسب.`
                        : `تم تأكيد استلام ${receiptQty} kg ودخولها رصيد سيارتك الرسمي.`,
                  ).then(() => setReceiptTarget(null))
                }
              >
                {busy ? 'جارٍ التأكيد…' : '✅ تأكيد الاستلام'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    `سبب رفض استلام التوريد ${receiptTarget.number} — ستُعاد الكمية رسمياً إلى المستودع المصدر ويصل إشعار للمحاسب:`,
                    receiptNotes || '',
                  );
                  if (reason === null) return;
                  void run(
                    () =>
                      apiPost(`/van-sales/load-orders/${receiptTarget.id}/reject-receipt`, {
                        reason: reason.trim() || undefined,
                      }),
                    () =>
                      `❌ رُفض استلام التوريد ${receiptTarget.number} وأُعيدت الكمية رسمياً إلى المستودع المصدر بقيد من ملف الترحيل.`,
                  ).then(() => setReceiptTarget(null));
                }}
              >
                ❌ رفض الاستلام وإعادة الكمية
              </button>
              <button type="button" className="btn" onClick={() => setReceiptTarget(null)}>
                إلغاء
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              الرفض يُقفل المناقلة الرسمية بوضع «الإرجاع»: تعود الكمية إلى المستودع المصدر ولا تدخل عهدتك، ويصل
              المحاسبَ إشعار بسبب الرفض.
            </p>
          </div>
        </div>
      ) : null}

      {/* 💵 نافذة التحصيل */}
      {collectDocId ? (
        <div role="dialog" aria-modal="true" className="modal-backdrop" style={backdropStyle}>
          <div className="card" style={dialogStyle}>
            <h2 style={{ marginTop: 0 }}>💵 تسجيل تحصيل من العميل</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              يُصدر النظام سند قبض رسمي ويربطه بالفاتورة ويحدّث المبلغ المستحق — لا يُكتفى بتسجيل المبلغ في جدول
              التوزيع.
            </p>
            <label className="field">
              <span>المبلغ المحصّل *</span>
              <input
                className="input"
                type="number"
                step="0.01"
                required
                dir="ltr"
                value={collectAmount}
                onChange={(e) => setCollectAmount(e.target.value)}
              />
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      apiPost('/van-sales/collections', {
                        documentId: collectDocId,
                        collectedAmount: collectAmount,
                        idempotencyKey: idempotencyKey('rep-collect'),
                      }),
                    () => `تم تسجيل تحصيل ${collectAmount} ريال وإصدار سند القبض الرسمي.`,
                  ).then(() => setCollectDocId(''))
                }
              >
                {busy ? 'جارٍ التسجيل…' : '💵 تأكيد التحصيل'}
              </button>
              <button type="button" className="btn" onClick={() => setCollectDocId('')}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 🔒 نافذة إغلاق الوردية */}
      {closingTarget ? (
        <div role="dialog" aria-modal="true" className="modal-backdrop" style={backdropStyle}>
          <div className="card" style={dialogStyle}>
            <h2 style={{ marginTop: 0 }}>🔒 تقديم إغلاق وردية ({closingTarget.number})</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              سجّل ما عاد معك سالمًا وما تلف والنقد المحصّل؛ يحسب النظام الفرق بين الرصيد المتوقع والجرد الفعلي ويحيل
              الطلب إلى المحاسب للاعتماد. لا يُغلق الطلب مرتين ولا يُعتمد من قِبل مقدّمه.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>مرتجع سليم للمستودع</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={closingReturned}
                  onChange={(e) => setClosingReturned(e.target.value)}
                />
              </label>
              <label className="field">
                <span>كمية تالفة</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={closingDamaged}
                  onChange={(e) => setClosingDamaged(e.target.value)}
                />
              </label>
              <label className="field">
                <span>سبب التلف</span>
                <input
                  className="input"
                  value={closingDamageReason}
                  onChange={(e) => setClosingDamageReason(e.target.value)}
                />
              </label>
              <label className="field">
                <span>النقد المحصّل</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  dir="ltr"
                  value={closingCash}
                  onChange={(e) => setClosingCash(e.target.value)}
                />
              </label>
              <label className="field">
                <span>المتبقي الفعلي بالجرد في السيارة *</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  dir="ltr"
                  placeholder="عدّ ما في السيارة ثم اكتب الرقم"
                  value={closingActualRemaining}
                  onChange={(e) => setClosingActualRemaining(e.target.value)}
                />
                <span className="muted small">
                  المتوقع حسب المستندات: {Number(closingTarget.expectedRemainingQty).toFixed(2)} كجم. اكتب ما
                  <b> عددتَه فعلياً</b> — الفرق يظهر للمحاسب عجزاً أو فائضاً ويجب تفسيره في الملاحظات. تركه
                  فارغاً يعني أنك لم تُثبت وجود أي كمية في السيارة.
                </span>
              </label>
              <label className="field">
                <span>ملاحظات الجرد</span>
                <input
                  className="input"
                  value={closingNotes}
                  onChange={(e) => setClosingNotes(e.target.value)}
                />
              </label>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || closingActualRemaining.trim() === ''}
                onClick={() =>
                  void run(
                    () =>
                      apiPost(`/van-sales/load-orders/${closingTarget.id}/submit-closing`, {
                        returnedQty: closingReturned,
                        damagedQty: closingDamaged,
                        damageReason: closingDamageReason || undefined,
                        collectedCash: closingCash,
                        actualRemainingQty: closingActualRemaining,
                        closingNotes: closingNotes || undefined,
                      }),
                    () =>
                      'تم تقديم طلب إغلاق الوردية بجردك الفعلي، وهو الآن بانتظار فحص واعتماد المحاسب. إن اختلف رصيد سيارتك الرسمي عن جردك فلن تُغلق عهدتك قبل تسويته رسمياً.',
                  ).then(() => setClosingTarget(null))
                }
              >
                {busy ? 'جارٍ التقديم…' : '🔒 تقديم الإغلاق'}
              </button>
              <button type="button" className="btn" onClick={() => setClosingTarget(null)}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'grid',
  placeItems: 'center',
  padding: 16,
  zIndex: 50,
};

const dialogStyle: React.CSSProperties = {
  width: 'min(720px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  display: 'grid',
  gap: 12,
};
