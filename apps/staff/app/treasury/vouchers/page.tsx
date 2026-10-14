'use client';

import Link from 'next/link';
import Decimal from 'decimal.js';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';

import { BankChooser } from '../../../components/bank-chooser';
import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import {
  ActionBar,
  DocField,
  DocHead,
  StatTile,
  StatTiles,
  StatusTrack,
  Tabs,
} from '../../../components/ui';
import { accountLabel, listAccounts, postableOf, type Account } from '../../../lib/accounts';
import { ApiError, apiDelete, apiFetch, apiList, apiPost, apiData } from '../../../lib/api';
import {
  branchOptions,
  cashLocationLabel,
  defaultOf,
  listBranches,
  listCashLocations,
  listCostCenters,
  listEmployees,
  listParties,
  money,
  partyLabel,
  shortDate,
  statusLabel,
  today,
  type Branch,
  type CashLocation,
  type CostCenter,
  type Employee,
  type Party,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * سند قبض عميل / سند صرف لمورد — and the four siblings the desktop keeps beside them.
 *
 * `Form_WPF/frmSandQ.xaml` (سند قبض عميل) and `frmSandD.xaml` (سند صرف لمورد) are laid
 * out the same way a clerk works: who, how much, how, then the details — with the cheque
 * block opening only when the money is a cheque, and a 🔍 grid underneath for "the receipt
 * I took last Thursday". `frmSandVAT` (سند صرف الضريبة) and `frmPaymentVoucher` are the
 * same document with a different جهة, which is why this screen is one document with a
 * جهة picker rather than four screens.
 *
 * `Class/ReceiptOper.cs:21` (`BindReceiptToEntry`) is the part that matters most: the
 * desktop turned the receipt into a journal entry as it saved it. This screen no longer
 * builds those lines by hand — the API does, from the cash location's account and the
 * party's account, so a voucher can never be posted with no entry at all.
 */

type Voucher = {
  id: string;
  number: string | null;
  kind: 'receipt' | 'payment';
  subtype: string;
  status: string;
  date: string;
  voucherTime?: string | null;
  partyId: string | null;
  cashLocationId: string;
  method: string;
  amount: string;
  currency: string;
  foreignAmount?: string | null;
  fxRate?: string | null;
  recipient: string | null;
  description?: string | null;
  salesmanId?: string | null;
  costCenterId?: string | null;
  referenceNo?: string | null;
  referenceDate?: string | null;
  chequeNo?: string | null;
  chequeDate?: string | null;
  chequeState?: string | null;
  bankName?: string | null;
  /** محرر السند — `frmSandQ` / `frmSandD` تُظهر «محرر السند:» بجانب البيان. */
  createdByName?: string | null;
  createdBy?: string | null;
};

/** 📄 سند قبض عميل · 📄 سند صرف لمورد — `frmSandQ` / `frmSandD` titles, verbatim. */
const SUBTYPES: Array<{ id: string; label: string; kind: 'receipt' | 'payment' | 'both' }> = [
  { id: 'customer', label: 'عميل', kind: 'both' },
  { id: 'supplier', label: 'مورد', kind: 'both' },
  { id: 'expense', label: 'مصروف', kind: 'payment' },
  { id: 'salary', label: 'راتب', kind: 'payment' },
  { id: 'vat', label: 'ضريبة القيمة المضافة', kind: 'payment' },
  { id: 'account', label: 'حساب عام', kind: 'both' },
  { id: 'other', label: 'أخرى', kind: 'both' },
];

/** 💳 نوع الدفع — `frmSandQ` puts these two on radios: 💵 نقدي and 🏦 بنكي. */
const METHODS: Array<{ id: string; label: string; group: 'cash' | 'bank' }> = [
  { id: 'cash', label: '💵 نقدي', group: 'cash' },
  { id: 'cheque', label: '🏦 شيك', group: 'bank' },
  { id: 'bank_transfer', label: '🏦 تحويل بنكي', group: 'bank' },
  { id: 'card', label: '💳 شبكة', group: 'cash' },
];

/** 📋 حالة الشيك — the three states `frmPaymentVoucher` toggles. */
const CHEQUE_STATES: Record<string, string> = {
  pending: 'تحت التحصيل',
  collected: 'محصّل',
  cleared: 'محصّل',
  bounced: 'مرتجع',
};

const BLANK = {
  subtype: 'customer',
  date: today(),
  voucherTime: '',
  branchId: '',
  partyId: '',
  cashLocationId: '',
  counterAccountId: '',
  method: 'cash',
  amountText: '',
  foreignAmountText: '',
  currency: 'SAR',
  chequeNo: '',
  chequeDate: '',
  bankName: '',
  costCenterId: '',
  referenceNo: '',
  referenceDate: '',
  recipient: '',
  description: '',
  salesmanId: '',
};

function VouchersScreen() {
  const searchParams = useSearchParams();
  const initialKind = searchParams.get('kind') === 'payment' ? 'payment' : 'receipt';
  const highlightedId = searchParams.get('id');
  const { can } = useSession();

  const [kind, setKind] = useState<'receipt' | 'payment'>(initialKind);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState(highlightedId ? '' : '');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [docVoucherId, setDocVoucherId] = useState<string | null>(highlightedId ?? null);
  const [docBusy, setDocBusy] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (q.trim()) params.set('q', q.trim());
    else if (highlightedId) params.set('q', highlightedId);
    const suffix = params.toString();
    return `/vouchers${suffix ? `?${suffix}` : ''}`;
  }, [from, to, q, highlightedId]);

  const vouchers = useQuery<Voucher[]>(() => apiList<Voucher>(query), [query]);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  // 📎 إرفاق المستندات — `ReceiptOper.insertDocument` يحفظ صورة السند؛ `files` مع entity=voucher
  const voucherFiles = useQuery<{ data: Array<{ id: string; name: string; mime: string; sizeBytes: number; createdAt: string }> }>(
    () => (docVoucherId ? apiFetch(`/files?filter[entity]=voucher&filter[entityId]=${docVoucherId}&limit=50`) : Promise.resolve({ data: [] } as any)),
    [docVoucherId],
  );
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  /**
   * 🏦 `frmPayBank` — opened from the voucher the way the desktop opens it from a sale:
   * a transfer names the bank it went to, and the window refuses to close without one.
   */
  const [pickingBank, setPickingBank] = useState(false);
  const parties = useQuery<Party[]>(() => listParties(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);
  const employees = useQuery<Employee[]>(() => listEmployees(), []);

  const branchRows = branches.data ?? [];
  const cashRows = cashLocations.data ?? [];
  const effectiveBranch = form.branchId || defaultOf(branchRows)?.id || '';
  const postable = (accounts.data ?? []).filter((account) => postableOf(account));
  const filteredSubtypes = SUBTYPES.filter((entry) => entry.kind === 'both' || entry.kind === kind);
  const rows = (vouchers.data ?? []).filter((row) => row.kind === kind);
  const partyOf = (id: string | null) => (parties.data ?? []).find((row) => row.id === id);
  const isBank = METHODS.find((entry) => entry.id === form.method)?.group === 'bank';
  const isTransfer = form.method === 'bank_transfer';
  const bankRows = cashRows.filter(
    (row) =>
      (row.kind ?? 'safe') === 'bank' && (!effectiveBranch || !row.branchId || row.branchId === effectiveBranch),
  );

  const totals = useMemo(() => {
    const posted = rows.filter((row) => row.status === 'posted');
    // Money is summed as text and only rendered — a float here would round someone's cash.
    const addUp = (list: Voucher[]) =>
      list.reduce((running, row) => running.plus(row.amount ?? '0'), new Decimal('0'));
    return {
      count: rows.length,
      drafts: rows.filter((row) => row.status === 'draft').length,
      posted: posted.length,
      postedTotal: addUp(posted),
      pending: rows.filter((row) => row.method === 'cheque' && row.chequeState === 'pending').length,
    };
  }, [rows]);

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      vouchers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await apiPost('/vouchers', {
        branchId: effectiveBranch,
        kind,
        subtype: form.subtype,
        date: form.date,
        voucherTime: form.voucherTime.trim() || undefined,
        partyId: form.partyId || undefined,
        counterAccountId: form.counterAccountId || undefined,
        cashLocationId: form.cashLocationId,
        method: form.method,
        amount: form.amountText.trim(),
        currency: form.currency,
        foreignAmount: form.foreignAmountText.trim() || undefined,
        chequeNo: form.method === 'cheque' ? form.chequeNo.trim() : undefined,
        chequeDate: form.method === 'cheque' ? form.chequeDate || undefined : undefined,
        bankName: isBank ? form.bankName.trim() || undefined : undefined,
        costCenterId: form.costCenterId || undefined,
        referenceNo: form.referenceNo.trim() || undefined,
        referenceDate: form.referenceDate || undefined,
        recipient: form.recipient.trim() || undefined,
        description: form.description.trim() || undefined,
        salesmanId: form.salesmanId || undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      setForm({ ...BLANK, date: form.date, branchId: form.branchId, cashLocationId: form.cashLocationId });
    }, 'حُفظ السند كمسودة. رحّله ليُقيَّد في الدفتر ويحرّك رصيد الصندوق.');
  }

  const uploadVoucherDoc = async (file: File) => {
    if (!docVoucherId) return;
    setDocBusy(true);
    try {
      const presigned = await apiPost<{ fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> }>('/files/presign', {
        name: file.name,
        mime: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        entity: 'voucher',
        entityId: docVoucherId,
      });
      const put = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { ...presigned.requiredHeaders, 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!put.ok) throw new Error(`فشل رفع المرفق: ${put.status}`);
      await apiPost(`/files/${presigned.fileId}/finalize`, { entity: 'voucher', entityId: docVoucherId });
      voucherFiles.reload();
      setNotice({ kind: 'ok', text: '✅ تم إرفاق المستند' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setDocBusy(false);
    }
  };

  return (
    <Screen
      title={kind === 'receipt' ? '📄 سند قبض' : '📄 سند صرف'}
      subtitle={
        kind === 'receipt'
          ? 'سند قبض عميل — كما في frmSandQ: من، كم، وكيف، ثم التفاصيل.'
          : 'سند صرف لمورد — كما في frmSandD: من، كم، وكيف، ثم التفاصيل.'
      }
      crumbs={['الخزينة', 'العمليات']}
      actions={
        can('treasury.voucher.create') ? (
          <button className="btn primary" type="button" onClick={() => setOpen(!open)}>
            {open ? '✖ إغلاق' : '➕ جديد'}
          </button>
        ) : null
      }
    >
      <StatTiles>
        <StatTile label="📋 السندات" value={totals.count} hint="في الفترة المحددة" />
        <StatTile label="📝 مسودات" value={totals.drafts} hint="لم تُرحَّل بعد" tone="warn" />
        <StatTile label="✅ مُرحَّل" value={totals.posted} tone="ok" />
        <StatTile label="💰 قيمة المُرحَّل" value={money(totals.postedTotal.toFixed(4))} />
        <StatTile label="🏦 شيكات تحت التحصيل" value={totals.pending} hint="لا تلمس الرصيد قبل التحصيل" />
      </StatTiles>

      <div className="card toolbar">
        <Tabs
          items={[
            { id: 'receipt' as const, label: '📥 سند قبض' },
            { id: 'payment' as const, label: '📤 سند صرف' },
          ]}
          value={kind}
          onChange={(next) => {
            setKind(next);
            setForm((current) => ({
              ...current,
              subtype: next === 'payment' && current.subtype === 'customer' ? 'supplier' : current.subtype,
            }));
          }}
        />
      </div>

      {/* 🔍 البحث — `frmSandQ`'s panel: من تاريخ / إلى تاريخ, 📋 كل الفترة, and a free search. */}
      <div className="card toolbar">
        <label className="field">
          <span>📅 من تاريخ</span>
          <input className="input" type="date" dir="ltr" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field">
          <span>📅 إلى تاريخ</span>
          <input className="input" type="date" dir="ltr" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label className="field">
          <span>🔍 البحث</span>
          <input
            className="input"
            value={q}
            placeholder="🔢 الرقم · رقم المرجع · رقم الشيك · البيان"
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <button
          className="btn sm"
          type="button"
          onClick={() => {
            setFrom('');
            setTo('');
            setQ('');
          }}
        >
          📋 كل الفترة
        </button>
      </div>

      {open && (
        <form className="card" onSubmit={create}>
          <DocHead>
            <DocField label="🔢 الرقم">
              <span className="muted">يُرقَّم تلقائياً عند الترحيل</span>
            </DocField>
            <DocField label="📅 التاريخ">
              <input className="input" type="date" dir="ltr" value={form.date} onChange={(event) => set('date', event.target.value)} required />
            </DocField>
            <DocField label="⏰ الوقت">
              <input
                className="input"
                dir="ltr"
                inputMode="numeric"
                placeholder="09:05"
                value={form.voucherTime}
                onChange={(event) => set('voucherTime', event.target.value)}
              />
            </DocField>
            <DocField label="🏢 الفرع">
              <select className="input" value={effectiveBranch} onChange={(event) => set('branchId', event.target.value)} required>
                {branchOptions(branchRows).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </DocField>
            <DocField label={kind === 'receipt' ? '👤 حساب العميل' : '🏭 المورد'}>
              <select className="input" value={form.partyId} onChange={(event) => set('partyId', event.target.value)}>
                <option value="">— بدون —</option>
                {(parties.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {partyLabel(row)}
                  </option>
                ))}
              </select>
            </DocField>
            <DocField label="👤 الجهة">
              <select className="input" value={form.subtype} onChange={(event) => set('subtype', event.target.value)}>
                {filteredSubtypes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </DocField>
          </DocHead>

          <div className="form-grid">
            <label className="field">
              <span>💵 قيمة السند *</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.amountText}
                onChange={(event) => set('amountText', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>💲 العملة</span>
              <select className="input" value={form.currency} onChange={(event) => set('currency', event.target.value)}>
                <option value="SAR">ريال سعودي</option>
                <option value="USD">💲 دولار</option>
                <option value="YER">ريال يمني</option>
                <option value="EUR">يورو</option>
              </select>
            </label>
            {form.currency !== 'SAR' && (
              <label className="field">
                <span>💲 القيمة بالعملة</span>
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.foreignAmountText}
                  onChange={(event) => set('foreignAmountText', event.target.value)}
                />
                <span className="muted small">كما كُتبت في السند؛ المبلغ الأساسي يبقى بالريال.</span>
              </label>
            )}
            {isTransfer ? (
              /**
               * 🏦 اختر طريقة الدفع (تحويل بنكي) — the desktop's tile window. A transfer
               * that lands in "the default bank" is a transfer nobody chose, so the
               * voucher names the bank before it is saved.
               */
              <div className="card tight">
                <div className="card-head">🏦 البنوك المتاحة</div>
                <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>
                    {form.cashLocationId
                      ? cashLocationLabel(cashRows.find((row) => row.id === form.cashLocationId) ?? ({} as CashLocation))
                      : 'لم يُختر بنك'}
                  </span>
                  <button type="button" className="btn primary" onClick={() => setPickingBank(true)}>
                    🏦 اختر البنك
                  </button>
                </div>
              </div>
            ) : (
              <label className="field">
                <span>{kind === 'receipt' ? '🏧 يودع في حساب *' : '🏧 يصرف من حساب *'}</span>
                <select className="input" value={form.cashLocationId} onChange={(event) => set('cashLocationId', event.target.value)} required>
                  <option value="">— اختر —</option>
                  {cashRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {cashLocationLabel(row)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>🏦 دفعة لحساب</span>
              <select className="input" value={form.counterAccountId} onChange={(event) => set('counterAccountId', event.target.value)}>
                <option value="">— حساب الطرف —</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
              <span className="muted small">
                إن تركته فارغاً استُخدم حساب الطرف، ثم حساب التعيين في إعدادات الترحيل.
              </span>
            </label>
          </div>

          {/* 💼 تفاصيل الدفع — `frmSandQ`'s group box, with the cheque block behind it. */}
          <div className="card">
            <h4>💼 تفاصيل الدفع</h4>
            <div className="form-grid">
              <label className="field">
                <span>💳 نوع الدفع</span>
                <select className="input" value={form.method} onChange={(event) => set('method', event.target.value)}>
                  {METHODS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              {isBank && (
                <>
                  <label className="field">
                    <span>🏦 مسحوب على بنك</span>
                    <input className="input" value={form.bankName} onChange={(event) => set('bankName', event.target.value)} />
                  </label>
                  {form.method === 'cheque' && (
                    <>
                      <label className="field">
                        <span>🔢 رقم الشيك *</span>
                        <input
                          className="input"
                          dir="ltr"
                          value={form.chequeNo}
                          onChange={(event) => set('chequeNo', event.target.value)}
                          required
                        />
                      </label>
                      <label className="field">
                        <span>📅 تاريخ استحقاق (شيك)</span>
                        <input
                          className="input"
                          type="date"
                          dir="ltr"
                          value={form.chequeDate}
                          onChange={(event) => set('chequeDate', event.target.value)}
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              <label className="field">
                <span>📅 تاريخ المرجع</span>
                <input
                  className="input"
                  type="date"
                  dir="ltr"
                  value={form.referenceDate}
                  onChange={(event) => set('referenceDate', event.target.value)}
                />
              </label>
              <label className="field">
                <span>🔢 رقم المرجع</span>
                <input className="input" dir="ltr" value={form.referenceNo} onChange={(event) => set('referenceNo', event.target.value)} />
              </label>
              <label className="field">
                <span>مركز التكلفة</span>
                <select className="input" value={form.costCenterId} onChange={(event) => set('costCenterId', event.target.value)}>
                  <option value="">— بدون —</option>
                  {(costCenters.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.nameAr ?? row.name_ar ?? row.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>👔 المندوب</span>
                <select className="input" value={form.salesmanId} onChange={(event) => set('salesmanId', event.target.value)}>
                  <option value="">— بدون —</option>
                  {(employees.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{kind === 'receipt' ? 'المستلم منه' : 'المستلم'}</span>
                <input className="input" value={form.recipient} onChange={(event) => set('recipient', event.target.value)} />
              </label>
              <label className="field">
                <span>📝 البيان</span>
                <input className="input" value={form.description} onChange={(event) => set('description', event.target.value)} />
                <span className="muted small">ينتقل إلى سطر القيد كما فيReceipts.Notes.</span>
              </label>
            </div>
          </div>

          <Notice notice={notice} />
          <ActionBar>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : '💾 حفظ'}
            </button>
          </ActionBar>
        </form>
      )}

      {!open && <Notice notice={notice} />}
      {highlightedId && (
        <div className="card tight" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn-line)' }}>
          <span>
            🔍 تم فتح السند <code dir="ltr">{highlightedId}</code> من تقرير آخر — الصف المميز أدناه هو المطلوب.
          </span>
          <Link className="btn sm" href={`/print/voucher/${highlightedId}`} style={{ marginInlineStart: 12 }}>
            🖨️ طباعة السند
          </Link>
        </div>
      )}

      <QueryView query={vouchers} isEmpty={() => rows.length === 0} empty="لا توجد سندات" emptyDetail="أنشئ سند قبض أو صرف جديداً.">
        {() => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            activeKey={highlightedId ?? undefined}
            footer={[
              <>المجموع</>,
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              money(
                rows
                  .reduce((running, row) => running.plus(row.amount ?? '0'), new Decimal('0'))
                  .toFixed(4),
              ),
              '',
              '',
              '',
            ]}
            columns={[
              { key: 'number', header: '🔢 الرقم', align: 'ltr', cell: (row) => row.number ?? 'مسودة' },
              { key: 'date', header: '📅 التاريخ', align: 'ltr', cell: (row) => shortDate(row.date) },
              { key: 'time', header: '⏰ الوقت', align: 'ltr', cell: (row) => row.voucherTime?.slice(0, 5) ?? '—' },
              {
                key: 'party',
                header: kind === 'receipt' ? '👤 العميل' : '🏭 المورد',
                cell: (row) => {
                  const party = partyOf(row.partyId);
                  return party ? partyLabel(party) : (row.recipient ?? '—');
                },
              },
              {
                key: 'description',
                header: '📝 البيان',
                cell: (row) => row.description ?? '—',
              },
              {
                key: 'editor',
                header: 'محرر السند:',
                cell: (row) => row.createdByName ?? '—',
              },
              {
                key: 'cash',
                header: '🏦 الصندوق',
                cell: (row) => {
                  const location = cashRows.find((entry) => entry.id === row.cashLocationId);
                  return location ? cashLocationLabel(location) : '—';
                },
              },
              {
                key: 'method',
                header: '💳 نوع الدفع',
                cell: (row) =>
                  row.method === 'cheque'
                    ? `🏦 شيك ${row.chequeNo ?? ''}`.trim()
                    : (METHODS.find((entry) => entry.id === row.method)?.label ?? row.method),
              },
              { key: 'amount', header: '💰 المبلغ', align: 'num', cell: (row) => money(row.amount, row.currency) },
              {
                key: 'foreign',
                header: '💲 أجنبي',
                align: 'num',
                cell: (row) => (row.foreignAmount ? `${money(row.foreignAmount, row.currency)}${row.fxRate ? ` @${Number(row.fxRate).toFixed(4)}` : ''}` : '—'),
              },
              {
                key: 'status',
                header: '📋 الحالة',
                cell: (row) => (
                  <span className="badge">
                    {row.method === 'cheque' && row.chequeState
                      ? (CHEQUE_STATES[row.chequeState] ?? statusLabel(row.status))
                      : statusLabel(row.status)}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="row">
                    <Link className="btn sm" href={`/print/voucher/${row.id}`}>
                      🖨️ طباعة
                    </Link>
                    <button className="btn sm" type="button" onClick={() => setDocVoucherId(row.id)}>
                      📎 مرفقات
                    </button>
                    {row.status === 'draft' && can('treasury.voucher.post') && (
                      <button
                        className="btn sm primary"
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => apiPost(`/vouchers/${row.id}/post`, {}), 'تم ترحيل السند.')}
                      >
                        ✅ ترحيل
                      </button>
                    )}
                    {row.status === 'posted' && row.method === 'cheque' && row.chequeState === 'pending' && (
                      <>
                        <button
                          className="btn sm"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(() => apiPost(`/vouchers/${row.id}/cheque`, { action: 'clear' }), 'تم تحصيل الشيك.')
                          }
                        >
                          💰 تحصيل
                        </button>
                        <button
                          className="btn sm danger"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(() => apiPost(`/vouchers/${row.id}/cheque`, { action: 'bounce' }), 'أُعيد الدين على الطرف.')
                          }
                        >
                          ↩️ إرجاع
                        </button>
                      </>
                    )}
                    {row.status === 'posted' && can('treasury.voucher.void') && (
                      <button
                        className="btn sm danger"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(() => apiPost(`/vouchers/${row.id}/void`, { reason: 'إلغاء من شاشة السندات' }), 'تم إلغاء السند.')
                        }
                      >
                        🗑️ إلغاء
                      </button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </QueryView>

      {docVoucherId && (
        <div className="card">
          <h3>📎 مرفقات السند — `ReceiptOper.insertDocument` — {docVoucherId.slice(0, 8)}…</h3>
          <div className="toolbar">
            <input
              className="input"
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadVoucherDoc(file);
              }}
              disabled={docBusy}
            />
            <button className="btn sm" type="button" onClick={() => voucherFiles.reload()} disabled={voucherFiles.status === 'loading'}>
              🔄 تحديث
            </button>
            <button className="btn sm" type="button" onClick={() => setDocVoucherId(null)}>
              ✖ إغلاق
            </button>
          </div>
          {voucherFiles.status === 'loading' && <p className="hint">جارٍ التحميل…</p>}
          {voucherFiles.status === 'success' && (voucherFiles.data?.data?.length ?? 0) === 0 && <p className="hint">لا توجد مرفقات — `frmshowdocument.xaml` «لا يوجد وثائق.»</p>}
          {voucherFiles.status === 'success' && (voucherFiles.data?.data?.length ?? 0) > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>📄 اسم الملف</th>
                    <th>النوع</th>
                    <th>الحجم</th>
                    <th>التاريخ</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(voucherFiles.data?.data ?? []).map((file) => (
                    <tr key={file.id}>
                      <td>{file.name}</td>
                      <td dir="ltr">{file.mime}</td>
                      <td dir="ltr">{file.sizeBytes}</td>
                      <td dir="ltr">{shortDate(file.createdAt)}</td>
                      <td>
                        <span className="row">
                          <button
                            className="btn sm"
                            type="button"
                            onClick={async () => {
                              try {
                                const link = await apiData<{ url: string }>(`/files/${file.id}/download`);
                                window.open(link.url, '_blank');
                              } catch (e) {
                                setNotice({ kind: 'danger', text: e instanceof ApiError ? e.message : String(e) });
                              }
                            }}
                          >
                            ⬇️ تنزيل
                          </button>
                          <button
                            className="btn sm danger"
                            type="button"
                            onClick={async () => {
                              if (!window.confirm(`هل أنت متأكد من حذف ${file.name}؟`)) return;
                              try {
                                await apiDelete(`/files/${file.id}`);
                                voucherFiles.reload();
                              } catch (e) {
                                setNotice({ kind: 'danger', text: e instanceof ApiError ? e.message : String(e) });
                              }
                            }}
                          >
                            🗑️ حذف
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <StatusTrack
        steps={['مسودة', 'مُرحَّل', 'مُقيَّد']}
        current={rows.some((row) => row.status === 'posted') ? 1 : 0}
        cancelled={rows.some((row) => row.status === 'voided')}
      />

      {/**
       * 🏦 `frmPayBank` — the bank is chosen here, not inherited: `SelectedBankId == 0`
       * is the desktop's "يرجى اختر بنك أولًا", and a transfer without a bank is a
       * transfer that will reconcile to the wrong account.
       */}
      {pickingBank ? (
        <BankChooser
          banks={bankRows}
          selectedId={form.cashLocationId}
          loading={cashLocations.status === 'loading'}
          onPick={(bank) => {
            set('cashLocationId', bank.id);
            setPickingBank(false);
          }}
          onCancel={() => setPickingBank(false)}
        />
      ) : null}
    </Screen>
  );
}

export default function VouchersPage() {
  return (
    <Suspense fallback={null}>
      <VouchersScreen />
    </Suspense>
  );
}
