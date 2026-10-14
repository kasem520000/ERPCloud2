'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { cashLocationLabel, listCashLocations, money, shortDate, statusLabel, today, type CashLocation } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Payment = {
  id: string;
  number: string;
  contractId: string;
  kind: string;
  status: string;
  paymentDate: string;
  grossAmount: string;
  retentionAmount: string;
  advanceRecovery: string;
  netAmount: string;
  voucherId: string | null;
  notes: string | null;
};
type Contract = {
  id: string;
  number: string;
  title: string;
  status: string;
  projectName: string | null;
  contractValue: string;
  retentionPct: string;
  certified: string;
  remainingValue: string;
  retentionHeld: string;
  advanceOutstanding: string;
  advanceIssued: string;
  advanceAmount: string;
};

const KIND_LABELS: Record<string, string> = { advance: 'دفعة مقدمة', progress: 'مستخلص جاري', final: 'مستخلص ختامي', retention_release: 'إفراج محتجز' };
const STATUS_LABELS: Record<string, string> = { draft: 'مسودة', approved: 'معتمد', paid: 'مدفوع', cancelled: 'ملغي' };

/**
 * سند دفع لمقاول. The deductions are shown before saving but are recalculated by the
 * server from the contract — the preview here is a courtesy, not the source of truth.
 */
export default function ContractorPaymentPage() {
  const { can } = useSession();
  const contracts = useQuery<Contract[]>(() => apiList<Contract>('/contracting/contracts?status=active'), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);

  const [contractId, setContractId] = useState('');
  const contract = useQuery<Contract | null>(() => (contractId ? apiData<Contract>(`/contracting/contracts/${contractId}`) : Promise.resolve(null)), [contractId]);
  const payments = useQuery<Payment[]>(() => (contractId ? apiList<Payment>(`/contracting/payments?contract_id=${contractId}`) : apiList<Payment>('/contracting/payments')), [contractId]);

  const [kind, setKind] = useState('progress');
  const [paymentDate, setPaymentDate] = useState(today());
  const [grossAmount, setGrossAmount] = useState('');
  const [advanceRecovery, setAdvanceRecovery] = useState('0');
  const [notes, setNotes] = useState('');
  const [cashLocationId, setCashLocationId] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const header = contract.data ?? null;
  const preview = useMemo(() => {
    const gross = Number(grossAmount || 0);
    const deducted = kind === 'progress' || kind === 'final' ? gross * (Number(header?.retentionPct ?? 0) / 100) : 0;
    const recovery = kind === 'progress' || kind === 'final' ? Number(advanceRecovery || 0) : 0;
    return { gross, retention: deducted, recovery, net: gross - deducted - recovery };
  }, [grossAmount, advanceRecovery, kind, header?.retentionPct]);

  async function create() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (!contractId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر العقد أولاً.');
      if (!grossAmount.trim()) throw new ApiError(422, 'VALIDATION_FAILED', 'أدخل قيمة السند.');
      const created = await apiPost<Payment>(`/contracting/contracts/${contractId}/payments`, {
        kind,
        paymentDate,
        grossAmount,
        advanceRecovery: advanceRecovery || '0',
        notes: notes.trim() || undefined,
      });
      setNotice({ kind: 'ok', text: `تم إنشاء السند ${created.number}: إجمالي ${money(created.grossAmount)} − محتجز ${money(created.retentionAmount)} − استرداد مقدمة ${money(created.advanceRecovery)} = صافي ${money(created.netAmount)}.` });
      setGrossAmount('');
      setAdvanceRecovery('0');
      setNotes('');
      payments.reload();
      contract.reload();
      contracts.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function approve(payment: Payment) {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost<Payment>(`/contracting/payments/${payment.id}/approve`, {});
      setNotice({ kind: 'ok', text: `تم اعتماد السند ${payment.number}.` });
      payments.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function pay(payment: Payment) {
    setBusy(true);
    setNotice(undefined);
    try {
      if (!cashLocationId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر الصندوق أو البنك الذي سيُصرف منه.');
      const paid = await apiPost<Payment>(`/contracting/payments/${payment.id}/pay`, { cashLocationId, method });
      setNotice({
        kind: 'ok',
        text: `تم صرف ${money(paid.netAmount)} على السند ${payment.number}، وأُنشئ سند صرف بحالة مسودة — رحّله من شاشة السندات لقيده في الدفاتر.`,
      });
      payments.reload();
      contract.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(payment: Payment) {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost<Payment>(`/contracting/payments/${payment.id}/cancel`, {});
      setNotice({ kind: 'ok', text: `تم إلغاء السند ${payment.number}؛ عادت قيمته إلى رصيد العقد.` });
      payments.reload();
      contract.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="سند دفع لمقاول"
      subtitle="مستخلصات المقاول: الاحتجاز واسترداد الدفعة المقدمة يُحسبان من العقد، والصرف يُنشئ سند صرف مسودة في الخزينة."
      crumbs={['إدارة المشاريع', 'العمليات']}
    >
      {notice && <Notice notice={notice} />}

      <div className="toolbar">
        <label className="field wide">
          <span>العقد (الساري فقط)</span>
          <select className="input" value={contractId} onChange={(event) => setContractId(event.target.value)}>
            <option value="">— كل السندات —</option>
            {(contracts.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>{`${row.number} — ${row.title}`}</option>
            ))}
          </select>
        </label>
      </div>

      {header && (
        <div className="card">
          <h3>
            {header.number} — {header.title}
          </h3>
          <div className="grid cols-2">
            <div className="kpi">
              <span>قيمة العقد</span>
              <strong>{money(header.contractValue)}</strong>
            </div>
            <div className="kpi">
              <span>المتبقي للاستخلاص</span>
              <strong>{money(header.remainingValue)}</strong>
            </div>
            <div className="kpi">
              <span>المحتجز الحالي</span>
              <strong>{money(header.retentionHeld)}</strong>
            </div>
            <div className="kpi">
              <span>المتبقي من المقدمة</span>
              <strong>{money(header.advanceOutstanding)}</strong>
            </div>
          </div>
        </div>
      )}

      {can('projects.manage') && (
        <div className="card">
          <h3>سند جديد</h3>
          <div className="form-grid">
            <label className="field">
              <span>نوع السند</span>
              <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="advance">دفعة مقدمة</option>
                <option value="progress">مستخلص جاري</option>
                <option value="final">مستخلص ختامي</option>
                <option value="retention_release">إفراج محتجز</option>
              </select>
            </label>
            <label className="field">
              <span>التاريخ</span>
              <input className="input" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
            </label>
            <label className="field">
              <span>قيمة الأعمال</span>
              <input className="input" value={grossAmount} onChange={(event) => setGrossAmount(event.target.value)} inputMode="decimal" />
            </label>
            <label className="field">
              <span>استرداد من المقدمة</span>
              <input
                className="input"
                value={advanceRecovery}
                onChange={(event) => setAdvanceRecovery(event.target.value)}
                inputMode="decimal"
                disabled={kind === 'advance' || kind === 'retention_release'}
              />
            </label>
            <label className="field wide">
              <span>ملاحظات</span>
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>
          <div className="chips">
            <span className="chip">{`إجمالي: ${money(preview.gross)}`}</span>
            <span className="chip">{`محتجز: ${money(preview.retention)}`}</span>
            <span className="chip">{`استرداد مقدمة: ${money(preview.recovery)}`}</span>
            <span className="chip on">{`الصافي المستحق: ${money(preview.net)}`}</span>
          </div>
          {preview.net < 0 && <p className="alert danger">الاستقطاعات تتجاوز قيمة السند — راجع الاسترداد قبل الحفظ.</p>}
          <div className="toolbar">
            <button className="btn primary" type="button" onClick={create} disabled={busy || !contractId}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ السند'}
            </button>
          </div>
        </div>
      )}

      {can('projects.contractor.pay') && (
        <div className="card">
          <h3>بيانات الصرف</h3>
          <div className="form-grid">
            <label className="field">
              <span>الصندوق / البنك</span>
              <select className="input" value={cashLocationId} onChange={(event) => setCashLocationId(event.target.value)}>
                <option value="">— اختر —</option>
                {(cashLocations.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{cashLocationLabel(row)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>طريقة الصرف</span>
              <select className="input" value={method} onChange={(event) => setMethod(event.target.value)}>
                <option value="bank_transfer">حوالة بنكية</option>
                <option value="cash">نقداً</option>
                <option value="cheque">شيك</option>
                <option value="card">بطاقة</option>
              </select>
            </label>
          </div>
          <p className="muted">يُستخدم هذا الاختيار عند الضغط على «صرف» في جدول السندات أدناه.</p>
        </div>
      )}

      <div className="card">
        <h3>السندات</h3>
        <QueryView query={payments} empty="لا توجد سندات دفع" emptyDetail="أنشئ سنداً من النموذج أعلاه.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number },
                { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.paymentDate) },
                { key: 'kind', header: 'النوع', cell: (row) => KIND_LABELS[row.kind] ?? row.kind },
                { key: 'gross', header: 'الإجمالي', align: 'num', cell: (row) => money(row.grossAmount) },
                { key: 'retention', header: 'المحتجز', align: 'num', cell: (row) => money(row.retentionAmount) },
                { key: 'recovery', header: 'استرداد مقدمة', align: 'num', cell: (row) => money(row.advanceRecovery) },
                { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.netAmount) },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
                { key: 'voucher', header: 'سند الصرف', cell: (row) => (row.voucherId ? 'مُنشأ (مسودة)' : '—') },
                {
                  key: 'actions',
                  header: '',
                  cell: (row) => (
                    <div className="row">
                      {row.status === 'draft' && can('projects.contractor.pay') && (
                        <button className="btn sm" type="button" disabled={busy} onClick={() => approve(row)}>
                          اعتماد
                        </button>
                      )}
                      {row.status === 'approved' && can('projects.contractor.pay') && (
                        <button className="btn sm primary" type="button" disabled={busy} onClick={() => pay(row)}>
                          صرف
                        </button>
                      )}
                      {(row.status === 'draft' || row.status === 'approved') && can('projects.manage') && (
                        <button className="btn sm danger" type="button" disabled={busy} onClick={() => cancel(row)}>
                          إلغاء
                        </button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </QueryView>
      </div>
    </Screen>
  );
}
