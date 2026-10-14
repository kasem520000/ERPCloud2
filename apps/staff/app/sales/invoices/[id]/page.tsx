'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  MessageCircle,
  Minus,
  Package,
  Plus,
  Printer,
  Trash2,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';

import { CommentsPanel } from '../../../../components/comments-panel';
import { ZatcaQrSvg, buildZatcaTlvBase64, printThermalReceipt80mm } from '../../../../components/zatca-qr-svg';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { DonutCardChart } from '../../../../components/ui/chart';
import { Reveal } from '../../../../components/ui/count-up';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Input, Labeled } from '../../../../components/ui/input';
import { Modal } from '../../../../components/ui/modal';
import { SkeletonCard } from '../../../../components/ui/skeleton';
import { Table } from '../../../../components/ui/table';
import { ApiError, apiData, apiList, apiPatch, apiPost } from '../../../../lib/api';
import {
  arabicName,
  cashLocationLabel,
  dateTime,
  itemLabel,
  listCashLocations,
  listCostCenters,
  listItems,
  listParties,
  listUnits,
  money,
  partyLabel,
  quantity,
  shortDate,
  type CashLocation,
  type CostCenter,
  type Item,
  type Party,
  type Unit,
} from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { type ApprovalRequest } from '../../../../lib/approvals';
import { useQuery } from '../../../../lib/use-query';
import {
  ATTACHMENT_STATUS_LABELS,
  sendWhatsapp,
  whatsappMessages,
  WHATSAPP_STATUS_LABELS,
  type WhatsappMessageRow,
} from '../../../../lib/whatsapp';

type InvoiceLine = {
  id: string;
  lineNo: number;
  itemId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  discountAmount?: string | null;
  net: string;
  tax: string;
  total: string;
  batchNo?: string | null;
  serialNos?: string[] | null;
  lotId?: string | null;
  costCenterId?: string | null;
};
type Payment = { id: string; method: string; amount: string; reference: string | null; createdAt: string };
type Invoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  branchId: string;
  warehouseId: string | null;
  partyId: string | null;
  referenceInvoiceId?: string | null;
  invoiceDiscount?: string | null;
  costCenterId?: string | null;
  cashCustomerName: string | null;
  cashCustomerMobile: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  paymentStatus: string;
  createdAt: string;
  postedAt: string | null;
  qrCode?: string | null;
  taxInvoiceType?: 'standard' | 'simplified';
  taxInvoiceTypeLabelAr?: string;
  partyName?: string | null;
  partyTaxNo?: string | null;
  lines: InvoiceLine[];
  payments: Payment[];
};

/** شريط التقدم: مسودة ← مرحّلة ← مدفوعة. */
function PaymentProgress({ doc }: { doc: Invoice }) {
  const steps = [
    { label: 'مسودة', done: true, current: doc.status === 'draft' },
    { label: 'مرحّلة', done: doc.status !== 'draft', current: doc.status === 'posted' && doc.paymentStatus !== 'paid' },
    { label: 'مدفوعة', done: doc.paymentStatus === 'paid', current: false },
  ];
  return (
    <div className="flex items-center gap-0" dir="rtl">
      {steps.map((step, i) => {
        const next = steps[i + 1];
        return (
        <div key={step.label} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5 min-w-16">
            <span
              className={`grid place-items-center size-7 rounded-full text-[11px] font-bold border-2 transition-all duration-300 ${
                step.done
                  ? 'bg-ok border-ok text-on-accent'
                  : step.current
                    ? 'bg-brand border-brand text-on-accent shadow-[0_0_0_4px_var(--focus-ring)]'
                    : 'bg-surface border-line-strong text-muted'
              }`}
            >
              {step.done ? <CheckCircle2 size={14} /> : i + 1}
            </span>
            <span className={`text-[11.5px] font-bold ${step.done || step.current ? 'text-ink' : 'text-muted'}`}>
              {step.label}
            </span>
          </div>
          {next ? (
            <span className={`h-0.5 w-10 sm:w-16 -mt-5 rounded-full transition-colors duration-300 ${next.done || next.current ? 'bg-ok' : 'bg-surface-3'}`} />
          ) : null}
        </div>
        );
      })}
    </div>
  );
}

export default function SalesInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const invoiceId = String(params.id);
  const { can } = useSession();

  const invoice = useQuery<Invoice>(() => apiData<Invoice>(`/sales/invoices/${invoiceId}`), [invoiceId]);
  const approval = useQuery<ApprovalRequest | null>(() => apiData<ApprovalRequest | null>(`/sales/invoices/${invoiceId}/approval`), [invoiceId]);
  const items = useQuery<Item[]>(() => listItems(), []);
  const parties = useQuery<Party[]>(() => listParties('customer'), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  const units = useQuery<Unit[]>(() => listUnits(), []);
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);

  const [settlement, setSettlement] = useState<'credit' | 'cash' | 'bank'>('credit');
  const [settleLocationId, setSettleLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();
  const [payAmountText, setPayAmountText] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payLocationId, setPayLocationId] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [waMessage, setWaMessage] = useState('');
  const [waAttach, setWaAttach] = useState(true);
  const [waBusy, setWaBusy] = useState(false);
  const [payProvider, setPayProvider] = useState('moyasar');
  const paymentLinks = useQuery<Array<{ id: string; provider: string; amount: string; currency: string; linkUrl: string; status: string; voucherId: string | null }>>(
    () => apiList(`/payments/links?invoice_id=${invoiceId}`),
    [invoiceId],
  );
  const [glassesLine, setGlassesLine] = useState<InvoiceLine | null>(null);
  const sent = useQuery<WhatsappMessageRow[]>(
    () => whatsappMessages({ invoiceId, limit: 20 }).then((view) => view.messages),
    [invoiceId],
  );

  // بيانات النظارات: يُسأل كل سطر عن قسمه الطباعة؛ يُعرض زر على السطر إن وجد.
  const glasses = useQuery<Record<string, boolean>>(async () => {
    const map: Record<string, boolean> = {};
    for (const line of invoice.data?.lines ?? []) {
      try {
        const d = await apiData<{ right?: Record<string, string>; left?: Record<string, string>; rows?: unknown[] }>(
          `/optics/invoice-lines/${line.id}/print-section`,
        );
        map[line.id] = Boolean(
          (d.right && Object.keys(d.right).length > 0) || (d.left && Object.keys(d.left).length > 0) || (d.rows?.length ?? 0) > 0,
        );
      } catch {
        map[line.id] = false;
      }
    }
    return map;
  }, [invoice.data?.lines]);

  if (invoice.status === 'loading') {
    return (
      <div className="grid gap-4">
        <SkeletonCard lines={2} />
        <div className="grid gap-4 xl:grid-cols-2">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={6} />
        </div>
      </div>
    );
  }

  if (invoice.status !== 'success' || !invoice.data) {
    return (
      <EmptyState
        tone="red"
        icon={<Package size={30} strokeWidth={1.5} />}
        title="تعذر تحميل الفاتورة"
        description={invoice.error ?? 'خطأ غير معروف'}
        action={<Button variant="primary" onClick={invoice.reload}>إعادة المحاولة</Button>}
      />
    );
  }

  const doc = invoice.data;
  const invoiceCenter = (costCenters.data ?? []).find((row) => row.id === doc.costCenterId);
  const costCenterLabel = invoiceCenter ? `${invoiceCenter.code} — ${arabicName(invoiceCenter)}` : '';
  const party = (parties.data ?? []).find((row) => row.id === doc.partyId);
  const partyName = party
    ? partyLabel(party)
    : ((doc as { partyName?: string | null }).partyName ?? doc.cashCustomerName ?? 'عميل عام');
  const partyTaxNo = String(
    party?.taxNo ?? party?.tax_no ?? (doc as { partyTaxNo?: string | null }).partyTaxNo ?? '',
  ).trim();
  const isStandardTaxInvoice = Boolean(
    partyTaxNo &&
      party?.name !== 'عميل عام' &&
      party?.code !== 'CUST-GEN' &&
      (doc as { partyName?: string | null }).partyName !== 'عميل عام',
  );
  const taxInvoiceTypeLabel =
    (doc as { taxInvoiceTypeLabelAr?: string }).taxInvoiceTypeLabelAr ??
    (isStandardTaxInvoice ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة');
  const referenceNumber = (doc as { customerReference?: string | null }).customerReference ?? null;
  const invoiceDiscountValue = Number(doc.invoiceDiscount ?? 0) || 0;
  const grossTotal = Number(doc.subtotal) + invoiceDiscountValue;
  const discountTotal = invoiceDiscountValue;
  const dueValue = Math.max(0, Number(doc.total) - Number(doc.paidTotal));
  const previewPhone = doc.cashCustomerMobile ?? party?.phone ?? '';

  function unitOf(row: InvoiceLine): string {
    const item = (items.data ?? []).find((entry) => entry.id === row.itemId);
    const unitId = item?.baseUnitId ?? item?.base_unit_id;
    const unit = (units.data ?? []).find((entry) => entry.id === unitId);
    return unit ? arabicName(unit) : '—';
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: success });
      invoice.reload();
    } catch (err) {
      setNotice({ kind: 'danger', text: err instanceof Error ? err.message : 'حدث خطأ غير متوقع.' });
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (settlement !== 'credit' && !settleLocationId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'اختر الصندوق أو البنك الذي استلم المبلغ.');
    }
    const location = (cashLocations.data ?? []).find((row) => row.id === settleLocationId);
    const settlementAccountId =
      (location as { accountId?: string; account_id?: string } | undefined)?.accountId ??
      (location as { accountId?: string; account_id?: string } | undefined)?.account_id ??
      undefined;
    if (settlement !== 'credit' && !settlementAccountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'الموقع المختار غير مربوط بحساب محاسبي.');
    }
    await apiPost(`/sales/invoices/${doc.id}/post`, {
      settlement,
      settlementAccountId,
      settlementCashLocationId: settleLocationId || undefined,
    });
  }

  /** تعديل كمية سطر في المسودة عبر PATCH (المحرّك يعيد احتساب الإجماليات). */
  function nudgeQty(line: InvoiceLine, delta: number) {
    const next = Math.max(0, Number(line.quantity) + delta);
    void run(
      () =>
        apiPatch(`/sales/invoices/${doc.id}`, {
          lines: doc.lines.map((l) => (l.id === line.id ? { ...l, quantity: String(next) } : l)),
        }),
      'تم تحديث الكميات.',
    );
  }

  const timeline = [
    { label: 'إنشاء الفاتورة', at: doc.createdAt, done: true },
    ...(doc.postedAt ? [{ label: 'الترحيل المحاسبي والمخزني', at: doc.postedAt, done: true }] : []),
    ...(doc.payments ?? [])
      .map((payment) => ({
        label: `دفعة ${money(payment.amount, doc.currency)} (${payment.method === 'cash' ? 'نقداً' : payment.method === 'card' ? 'شبكة' : 'بنك'})`,
        at: payment.createdAt,
        done: true,
      })),
  ];

  return (
    <div className="grid gap-4">
      {/* ------------------------------------------------ header card */}
      <Reveal>
        <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-1">
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none opacity-60"
            style={{
              backgroundImage:
                'radial-gradient(90rem 26rem at 110% -30%, rgb(37 99 235 / 0.08), transparent 55%), radial-gradient(circle, var(--line-strong) 1px, transparent 1px)',
              backgroundSize: 'auto, 16px 16px',
            }}
          />
          <div className="relative">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Link href="/sales/invoices" className="inline-flex items-center gap-1 text-[12.5px] font-bold text-muted hover:text-brand-600 transition-colors">
                  <ArrowRight size={13} /> كل الفواتير
                </Link>
                <div className="flex flex-wrap items-center gap-3 mt-1.5">
                  <h1 className="m-0 text-[30px] font-bold text-ink tracking-tight leading-none" dir="ltr">
                    {doc.number ?? 'مسودة'}
                  </h1>
                  <Badge tone={doc.kind === 'quotation' ? 'purple' : 'blue'} dot>
                    {doc.kind === 'quotation' ? 'عرض أسعار' : taxInvoiceTypeLabel}
                  </Badge>
                  <Badge tone={doc.status === 'posted' ? 'green' : doc.status === 'voided' ? 'red' : 'amber'} dot>
                    {doc.status === 'posted' ? 'مرحّلة' : doc.status === 'voided' ? 'ملغاة' : 'مسودة'}
                  </Badge>
                  {doc.status === 'posted' ? (
                    <Badge tone={doc.paymentStatus === 'paid' ? 'blue' : 'amber'}>
                      {doc.paymentStatus === 'paid' ? 'مسدّدة' : 'غير مسدّدة'}
                    </Badge>
                  ) : null}
                  {approval.data?.status === 'pending' ? <Badge tone="purple" dot>بانتظار موافقة</Badge> : null}
                  {approval.data?.status === 'rejected' ? <Badge tone="red" dot>رُفضت — ما زالت مسودة</Badge> : null}
                </div>
                <p className="m-0 mt-2 text-[13px] text-muted">
                  {partyName} · {shortDate(doc.createdAt)}
                  {referenceNumber ? <span className="text-muted"> · مرجع: <span dir="ltr">{referenceNumber}</span></span> : null}
                  {costCenterLabel ? <span className="text-muted"> · مركز التكلفة: {costCenterLabel}</span> : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/print/sales-invoice/${doc.id}`}>
                  <Button variant="primary" icon={<Printer size={15} />}>
                    طباعة
                  </Button>
                </Link>
                {can('sales.invoice.void') && doc.status === 'posted' ? (
                  <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setVoidOpen(true)}>
                    إلغاء الفاتورة
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-5">
              <PaymentProgress doc={doc} />
            </div>
          </div>
        </section>
      </Reveal>

      {notice ? (
        <div
          className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-semibold ${
            notice.kind === 'ok'
              ? 'border-ok-line bg-ok-soft text-ok-ink'
              : notice.kind === 'danger'
                ? 'border-danger-line bg-danger-soft text-danger-ink'
                : 'border-warn-line bg-warn-soft text-warn-ink'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* ------------------------------------------------ two columns */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-5 items-start">
        {/* lines */}
        <Reveal delay={0.1} className="xl:col-span-3">
          <section className="rounded-xl border border-line bg-surface shadow-1">
            <header className="flex items-center justify-between px-4 pt-4 pb-2">
              <h3 className="m-0 text-[15px] font-bold text-ink">الأصناف ({doc.lines.length})</h3>
              {doc.status === 'draft' && can('sales.invoice.create') ? (
                <span className="text-[11.5px] text-muted font-semibold">± تعديل الكمية (مسودة)</span>
              ) : null}
            </header>
            <Table
              rows={doc.lines}
              rowKey={(row) => row.id}
              dense
              columns={[
                { key: 'no', header: '#', numeric: true, cell: (row) => row.lineNo, width: 44 },
                {
                  key: 'item',
                  header: 'الصنف',
                  cell: (row) => {
                    const item = (items.data ?? []).find((entry) => entry.id === row.itemId);
                    return (
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="font-bold text-ink truncate">{item ? itemLabel(item) : (row.description ?? '—')}</span>
                        {glasses.data?.[row.id] ? (
                          <button
                            type="button"
                            onClick={() => setGlassesLine(row)}
                            className="text-[10.5px] font-bold text-brand bg-brand-soft border border-brand-line rounded-full px-2 py-0.5 hover:bg-brand-soft transition-colors flex-none"
                          >
                            👓 بيانات
                          </button>
                        ) : null}
                      </span>
                    );
                  },
                },
                {
                  key: 'qty',
                  header: 'الكمية',
                  numeric: true,
                  cell: (row) =>
                    doc.status === 'draft' && can('sales.invoice.create') ? (
                      <span className="inline-flex items-center gap-1.5" dir="ltr">
                        <button
                          type="button"
                          onClick={() => nudgeQty(row, -1)}
                          className="grid place-items-center size-6 rounded-md border border-line text-muted hover:bg-surface-3 hover:text-ink transition-colors"
                          aria-label="إنقاص"
                        >
                          <Minus size={12} />
                        </button>
                        <span className="min-w-8 text-center font-bold">{quantity(row.quantity)}</span>
                        <button
                          type="button"
                          onClick={() => nudgeQty(row, 1)}
                          className="grid place-items-center size-6 rounded-md border border-line text-muted hover:bg-surface-3 hover:text-ink transition-colors"
                          aria-label="زيادة"
                        >
                          <Plus size={12} />
                        </button>
                      </span>
                    ) : (
                      quantity(row.quantity)
                    ),
                },
                { key: 'unit', header: 'الوحدة', cell: (row) => unitOf(row), width: 80 },
                { key: 'price', header: 'السعر', numeric: true, cell: (row) => money(row.unitPrice) },
                {
                  key: 'discount',
                  header: 'الخصم',
                  numeric: true,
                  cell: (row) => (Number(row.discountAmount ?? '0') > 0 ? money(row.discountAmount ?? '0') : '—'),
                },
                { key: 'total', header: 'الصافي', numeric: true, cell: (row) => <b>{money(row.total)}</b> },
              ]}
            />
          </section>
        </Reveal>

        {/* financials */}
        <Reveal delay={0.18} className="xl:col-span-2">
          <div className="grid gap-4">
            <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
              <h3 className="m-0 text-[15px] font-bold text-ink mb-3">الملخص المالي</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 m-0 text-[13px]">
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">المجموع (قبل الخصم)</dt>
                  <dd className="m-0 font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(grossTotal, doc.currency)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">الخصم</dt>
                  <dd className="m-0 font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(discountTotal, doc.currency)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">الإجمالي (قبل الضريبة)</dt>
                  <dd className="m-0 font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(doc.subtotal, doc.currency)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">ضريبة القيمة المضافة</dt>
                  <dd className="m-0 font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(doc.taxTotal, doc.currency)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">المدفوع</dt>
                  <dd className="m-0 font-bold text-ok" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(doc.paidTotal, doc.currency)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted font-semibold text-[11.5px]">المتبقي</dt>
                  <dd className={`m-0 font-bold ${dueValue > 0 ? 'text-warn' : 'text-ok'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(dueValue, doc.currency)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 pt-3 border-t border-dashed border-line flex items-center justify-between">
                <span className="text-[13px] font-bold text-muted">الصافي</span>
                <span className="text-[28px] font-bold text-ink tracking-tight" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {money(doc.total, doc.currency)}
                </span>
              </div>

              <div className="mt-4 pt-3 border-t border-line flex flex-col items-center gap-2">
                <ZatcaQrSvg
                  payload={
                    doc.qrCode ||
                    buildZatcaTlvBase64({
                      sellerName: 'ERP Cloud KSA',
                      vatNo: '300000000000003',
                      timestampIso: doc.postedAt ?? doc.createdAt,
                      total: doc.total,
                      tax: doc.taxTotal,
                    })
                  }
                  size={136}
                  label={doc.taxInvoiceTypeLabelAr ? `باركود ${doc.taxInvoiceTypeLabelAr} (ZATCA QR)` : 'باركود الفاتورة الضريبية (ZATCA QR)'}
                />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    const qrPayload =
                      doc.qrCode ||
                      buildZatcaTlvBase64({
                        sellerName: 'ERP Cloud KSA',
                        vatNo: '300000000000003',
                        timestampIso: doc.postedAt ?? doc.createdAt,
                        total: doc.total,
                        tax: doc.taxTotal,
                      });
                    printThermalReceipt80mm({
                      companyName: 'ERP Cloud KSA',
                      taxNo: '300000000000003',
                      invoiceNumber: doc.number ?? doc.id.slice(0, 8),
                      invoiceTypeLabel: doc.taxInvoiceTypeLabelAr || 'فاتورة ضريبية مبسطة',
                      issuedAt: dateTime(doc.postedAt ?? doc.createdAt),
                      customerName: party ? partyLabel(party) : doc.cashCustomerName || 'عميل عام',
                      paymentMethodLabel: doc.paymentStatus === 'paid' ? 'مدفوعة' : 'آجل',
                      lines: doc.lines.map((line) => {
                        const foundItem = (items.data ?? []).find((entry) => entry.id === line.itemId);
                        return {
                          name: line.description || (foundItem ? itemLabel(foundItem) : 'صنف'),
                          quantity: line.quantity,
                          unitPrice: line.unitPrice,
                          total: line.total,
                        };
                      }),
                      subtotal: doc.subtotal,
                      discount: doc.invoiceDiscount ?? '0',
                      taxTotal: doc.taxTotal,
                      total: doc.total,
                      paidAmount: doc.paidTotal,
                      qrPayload,
                    });
                  }}
                >
                  🧾 طباعة إيصال كاشير حراري (80mm)
                </button>
              </div>

              {Number(doc.taxTotal) > 0 || Number(doc.subtotal) > 0 ? (
                <div className="mt-4">
                  <p className="m-0 mb-1 text-[11.5px] font-bold text-muted">توزيع الضريبة</p>
                  <DonutCardChart
                    data={[
                      { name: 'قبل الضريبة', value: Number(doc.subtotal) },
                      { name: 'الضريبة', value: Number(doc.taxTotal), color: 'var(--warn)' },
                    ]}
                    height={150}
                    formatter={(v) => money(v)}
                    centerValue={money(doc.total)}
                    centerLabel="الصافي"
                  />
                </div>
              ) : null}
            </section>

            {/* actions */}
            <section className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3">
              <h3 className="m-0 text-[15px] font-bold text-ink">الإجراءات</h3>

              {doc.status === 'draft' && can('sales.invoice.post') ? (
                <>
                  <Labeled label="طريقة الدفع">
                    <select
                      value={settlement}
                      onChange={(e) => setSettlement(e.target.value as 'credit' | 'cash' | 'bank')}
                      className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                    >
                      <option value="credit">آجلة (ذمم)</option>
                      <option value="cash">نقدية</option>
                      <option value="bank">بنك</option>
                    </select>
                  </Labeled>
                  {settlement !== 'credit' ? (
                    <Labeled label={settlement === 'bank' ? 'البنك' : 'الصندوق'} hint="يُقيَّد المبلغ على حساب هذا الموقع وتُسجَّل دفعة بنفس القيمة.">
                      <select
                        value={settleLocationId}
                        onChange={(e) => setSettleLocationId(e.target.value)}
                        className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                      >
                        <option value="">— اختر —</option>
                        {(cashLocations.data ?? []).map((row) => (
                          <option key={row.id} value={row.id}>
                            {cashLocationLabel(row)}
                          </option>
                        ))}
                      </select>
                    </Labeled>
                  ) : null}
                  <Button variant="primary" block loading={busy} onClick={() => void run(post, 'تم ترحيل الفاتورة وقيدها المحاسبي وحركتها المخزنية.')} icon={<CheckCircle2 size={16} />}>
                    ترحيل الفاتورة
                  </Button>
                </>
              ) : null}

              {doc.status === 'posted' && can('sales.invoice.pay') && dueValue > 0 ? (
                <>
                  <h4 className="m-0 text-[13px] font-bold text-ink-2 flex items-center gap-1.5">
                    <Banknote size={14} className="text-brand-600" /> تسجيل دفعة
                  </h4>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Labeled label="المبلغ">
                      <input
                        dir="ltr"
                        inputMode="decimal"
                        value={payAmountText}
                        onChange={(e) => setPayAmountText(e.target.value)}
                        placeholder={String(dueValue)}
                        className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                      />
                    </Labeled>
                    <Labeled label="الطريقة">
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value)}
                        className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                      >
                        <option value="cash">نقداً</option>
                        <option value="card">شبكة</option>
                        <option value="bank">تحويل بنكي</option>
                      </select>
                    </Labeled>
                  </div>
                  <Labeled label="الصندوق / البنك">
                    <select
                      value={payLocationId}
                      onChange={(e) => setPayLocationId(e.target.value)}
                      className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                    >
                      <option value="">— اختر —</option>
                      {(cashLocations.data ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {cashLocationLabel(row)}
                        </option>
                      ))}
                    </select>
                  </Labeled>
                  <Button
                    block
                    loading={busy}
                    icon={<Wallet size={16} />}
                    onClick={() =>
                      void run(
                        () =>
                          apiPost(`/sales/invoices/${doc.id}/payments`, {
                            method: payMethod,
                            amount: payAmountText,
                            cashLocationId: payLocationId || undefined,
                            idempotencyKey: crypto.randomUUID(),
                          }),
                        'تم تسجيل الدفعة.',
                      )
                    }
                  >
                    تسديد
                  </Button>
                </>
              ) : null}

              {doc.status === 'voided' ? <p className="m-0 alert warn">هذه الفاتورة ملغاة.</p> : null}
            </section>

            {/* timeline */}
            <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
              <h3 className="m-0 text-[15px] font-bold text-ink mb-3">الخط الزمني</h3>
              <ol className="m-0 p-0 list-none grid gap-0">
                {timeline.map((entry, i) => (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={`grid place-items-center size-6 rounded-full flex-none ${entry.done ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-muted'}`}>
                        <CheckCircle2 size={13} />
                      </span>
                      {i < timeline.length - 1 ? <span className="w-px flex-1 bg-surface-3 my-1" /> : null}
                    </div>
                    <div className="pb-4 min-w-0">
                      <p className="m-0 text-[13px] font-bold text-ink-2">{entry.label}</p>
                      <p className="m-0 text-[11.5px] text-muted">{dateTime(entry.at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </Reveal>
      </div>

      {doc.status === 'posted' && can('payments.links.manage') ? (
        <Reveal delay={0.18}>
          <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h3 className="m-0 text-[15px] font-bold text-ink">روابط الدفع</h3>
              <div className="flex items-center gap-2">
                <select className="h-10 px-3 rounded-[10px] border border-line-strong" value={payProvider} onChange={(event) => setPayProvider(event.target.value)}>
                  <option value="moyasar">ميسر</option>
                  <option value="hyperpay">HyperPay</option>
                  <option value="tap">Tap</option>
                </select>
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    void run(async () => {
                      await apiPost('/payments/links', { invoice_id: doc.id, provider: payProvider });
                      paymentLinks.reload();
                    }, 'تم إنشاء رابط الدفع.')
                  }
                >
                  💳 إنشاء رابط دفع
                </Button>
              </div>
            </div>
            {(paymentLinks.data ?? []).length === 0 ? (
              <p className="m-0 text-[13px] text-muted">لا روابط بعد. اربط المزوّد من إعدادات المدفوعات ثم أنشئ الرابط.</p>
            ) : (
              <Table
                rows={paymentLinks.data ?? []}
                rowKey={(row) => row.id}
                dense
                columns={[
                  { key: 'provider', header: 'المزوّد', cell: (row) => row.provider },
                  { key: 'amount', header: 'المبلغ', ltr: true, cell: (row) => money(row.amount, row.currency) },
                  { key: 'status', header: 'الحالة', cell: (row) => row.status },
                  { key: 'voucher', header: 'سند القبض', ltr: true, cell: (row) => row.voucherId ? row.voucherId.slice(0, 8) : '—' },
                  {
                    key: 'url',
                    header: 'الرابط',
                    cell: (row) => (
                      <a className="text-brand-700" href={row.linkUrl} target="_blank" rel="noreferrer">
                        فتح
                      </a>
                    ),
                  },
                  {
                    key: 'sim',
                    header: '',
                    cell: (row) =>
                      row.status === 'pending' ? (
                        <button
                          className="text-[12px] font-bold text-brand-700"
                          type="button"
                          onClick={() =>
                            void run(async () => {
                              await apiPost(`/payments/links/${row.id}/simulate`, {});
                              paymentLinks.reload();
                              invoice.reload();
                            }, 'تمت محاكاة الدفع وإنشاء سند القبض.')
                          }
                        >
                          محاكاة دفع
                        </button>
                      ) : null,
                  },
                ]}
              />
            )}
          </section>
        </Reveal>
      ) : null}

      {/* ------------------------------------------------ whatsapp */}
      <Reveal delay={0.2}>
        <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h3 className="m-0 text-[15px] font-bold text-ink flex items-center gap-1.5">
              <MessageCircle size={16} className="text-ok" /> واتساب
            </h3>
            <span className="text-[12px] font-semibold text-muted bg-surface-3 rounded-full px-3 py-1">
              يُرسل إلى {previewPhone ? <span dir="ltr">{previewPhone}</span> : '— لا رقم —'}
            </span>
          </div>
          {doc.status !== 'posted' ? (
            <p className="m-0 alert warn">لا يمكن إرسال الفاتورة قبل الترحيل.</p>
          ) : !previewPhone ? (
            <p className="m-0 alert warn">لا يوجد رقم جوال للعميل — أضف رقم الجوال في بطاقة العميل، أو أضفه في الفاتورة النقدية.</p>
          ) : can('sales.view') ? (
            <>
              <div className="grid gap-3 md:grid-cols-3 items-end">
                <div className="md:col-span-2">
                  <Labeled label="نص الرسالة" hint="إن تُرك فارغاً كُتبت التحية الافتراضية.">
                    <input
                      value={waMessage}
                      onChange={(e) => setWaMessage(e.target.value)}
                      placeholder={`مرحباً ${doc.cashCustomerName ?? partyName}، هذه فاتورتك رقم ${doc.number ?? ''} من …`}
                      className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                    />
                  </Labeled>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2 cursor-pointer">
                    <input type="checkbox" checked={waAttach} onChange={(e) => setWaAttach(e.target.checked)} className="size-4 accent-brand-600" />
                    إرفاق الفاتورة
                  </label>
                  <Button variant="primary" loading={waBusy} onClick={() => {
                    setWaBusy(true);
                    setNotice(undefined);
                    void sendWhatsapp({
                      invoiceId: doc.id,
                      attach: waAttach,
                      ...(waMessage.trim() ? { message: waMessage.trim() } : {}),
                    })
                      .then((result) => {
                        setNotice({
                          kind: result.message.status === 'sent' ? 'ok' : 'warn',
                          text: `${WHATSAPP_STATUS_LABELS[result.message.status] ?? result.message.status} — ${result.message.phone}${result.attachment === 'sent' ? ` · ${ATTACHMENT_STATUS_LABELS.sent}` : ''}${result.message.error ? ` · ${result.message.error}` : ''}`,
                        });
                        void sent.reload();
                      })
                      .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }))
                      .finally(() => setWaBusy(false));
                  }} icon={<MessageCircle size={15} />}>
                    إرسال واتساب
                  </Button>
                </div>
              </div>
              {sent.data && sent.data.length > 0 ? (
                <div className="mt-4">
                  <p className="m-0 mb-2 text-[12px] font-bold text-muted">سجل الإرسال</p>
                  <Table
                    rows={sent.data}
                    rowKey={(row) => row.id}
                    dense
                    columns={[
                      { key: 'at', header: 'التاريخ', ltr: true, cell: (row) => (row.createdAt ? dateTime(row.createdAt) : '—') },
                      { key: 'phone', header: 'الرقم', ltr: true, cell: (row) => row.phone },
                      { key: 'status', header: 'الحالة', cell: (row) => WHATSAPP_STATUS_LABELS[row.status] ?? row.status },
                      { key: 'attach', header: 'المرفق', cell: (row) => ATTACHMENT_STATUS_LABELS[row.attachmentStatus] ?? row.attachmentStatus },
                      { key: 'message', header: 'الرسالة', cell: (row) => <span className="block max-w-56 truncate" title={row.message}>{row.message}</span> },
                      { key: 'sim', header: 'النوع', cell: (row) => (row.simulation ? 'محاكاة' : 'فعلي') },
                    ]}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="m-0 text-[13px] text-muted">لا تملك صلاحية إرسال الفاتورة.</p>
          )}
        </section>
      </Reveal>

      {/* ------------------------------------------------ void dialog */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="إلغاء الفاتورة"
        description="حذفٌ ناعم: تبقى الفاتورة في السجل بحالة «ملغاة» ولا يمكن ترحيلها مجدداً."
        footer={
          <>
            <Button
              variant="danger"
              loading={busy}
              disabled={!voidReason.trim()}
              onClick={() => {
                void run(() => apiPost(`/sales/invoices/${doc.id}/void`, { reason: voidReason.trim() }), 'تم إلغاء الفاتورة.');
                setVoidOpen(false);
              }}
            >
              تأكيد الإلغاء
            </Button>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>
              تراجع
            </Button>
          </>
        }
      >
        <Input label="سبب الإلغاء" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="مثال: خطأ في إدخال الأصناف" />
      </Modal>

      {/* ------------------------------------------------ glasses modal */}
      <GlassesModal line={glassesLine} onClose={() => setGlassesLine(null)} />
      <CommentsPanel entityType="sales_invoice" entityId={invoiceId} />
    </div>
  );
}

/** 📢 بيانات النظارات — قسم الطباعة الخاص بالسطر (يُجلب من /optics/invoice-lines/:id/print-section). */
function GlassesModal({ line, onClose }: { line: InvoiceLine | null; onClose: () => void }) {
  const section = useQuery(
    async () => {
      if (!line) return null;
      return await apiData<{ title: string; right: Record<string, string>; left: Record<string, string>; labels: { right: Array<{ key: string; label: string }>; left: Array<{ key: string; label: string }> }; rows: unknown[] }>(
        `/optics/invoice-lines/${line.id}/print-section`,
      );
    },
    [line?.id],
  );

  return (
    <Modal
      open={line !== null}
      onClose={onClose}
      title={section.data?.title ?? '👓 بيانات النظارات'}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>إغلاق</Button>}
    >
      {section.status === 'loading' ? (
        <p className="m-0 text-muted text-[13px]">جارٍ التحميل…</p>
      ) : section.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {(
            [
              { side: 'right', values: section.data.right, labels: section.data.labels.right },
              { side: 'left', values: section.data.left, labels: section.data.labels.left },
            ] as const
          ).map((pane) => (
            <div key={pane.side} className="rounded-xl border border-line overflow-hidden">
              <p className="m-0 bg-surface-2 px-3 py-2 text-[12px] font-bold text-muted border-b border-line">
                {pane.side === 'right' ? 'العين اليمنى' : 'العين اليسرى'}
              </p>
              <dl className="m-0 p-3 grid gap-2">
                {pane.labels.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-3 text-[13px]">
                    <dt className="text-muted font-semibold m-0">{field.label}</dt>
                    <dd className="m-0 font-bold text-ink" dir="ltr">
                      {pane.values[field.key] ?? '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 text-muted text-[13px]">لا توجد بيانات نظارات لهذا السطر.</p>
      )}
    </Modal>
  );
}
