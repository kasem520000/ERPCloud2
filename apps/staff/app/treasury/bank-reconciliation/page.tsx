'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { DocField, DocHead, FilterBar, StatTile, StatTiles } from '../../../components/ui';
import { apiData, apiDelete, apiList, apiPost } from '../../../lib/api';
import { today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type BankAccount = { id: string; bankName: string; accountNo: string | null; iban: string | null };
type BankStatement = { id: string; bankAccountId: string; periodFrom: string; periodTo: string; status: string; rowCount: number };
type BankLine = {
  id: string;
  lineNo: number;
  txnDate: string;
  description: string;
  reference: string | null;
  amount: string;
  balance: string | null;
  status: 'pending' | 'matched' | 'ignored';
  matchConfidence: string | null;
  matchReason: string | null;
  matchedInvoiceId: string | null;
  matchedInvoiceType: string | null;
  matchedVoucherId: string | null;
  suggestedAccountId: string | null;
};
type Reconciliation = {
  bankName: string;
  currency: string;
  periodFrom: string | null;
  periodTo: string | null;
  bankMovement: string;
  bankBalance: string;
  ledgerBalance: string;
  ledgerSource: string;
  difference: string;
  matchedLines: number;
  pendingLines: number;
  ignoredLines: number;
  lineCount: number;
};

function statusLabel(status: BankLine['status']): string {
  return status === 'matched' ? 'مطابق' : status === 'ignored' ? 'متجاهل' : 'معلّق';
}

export default function BankReconciliationPage() {
  const params = useSearchParams();
  const { can } = useSession();
  const [bankAccountId, setBankAccountId] = useState(params.get('bank_account_id') ?? '');
  const [statementId, setStatementId] = useState(params.get('statement_id') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();

  const accounts = useQuery<BankAccount[]>(() => apiList<BankAccount>('/treasury/bank-accounts'), []);
  const statementQuery = useMemo(() => bankAccountId ? `/treasury/bank-statements?bank_account_id=${encodeURIComponent(bankAccountId)}` : '/treasury/bank-statements', [bankAccountId]);
  const statements = useQuery<BankStatement[]>(() => apiList<BankStatement>(statementQuery), [statementQuery]);
  const selectedStatement = statements.data?.find((statement) => statement.id === statementId) ?? statements.data?.[0];
  const effectiveStatementId = selectedStatement?.id ?? '';
  const lines = useQuery<BankLine[]>(() => effectiveStatementId ? apiList<BankLine>(`/treasury/bank-statements/${effectiveStatementId}/lines`) : Promise.resolve([]), [effectiveStatementId]);
  const summaryQuery = useMemo(() => {
    if (!bankAccountId) return '';
    const query = new URLSearchParams({ bank_account_id: bankAccountId });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    return `/treasury/bank-reconciliation?${query.toString()}`;
  }, [bankAccountId, from, to]);
  const summary = useQuery<Reconciliation | undefined>(() => summaryQuery ? apiData<Reconciliation>(summaryQuery) : Promise.resolve(undefined), [summaryQuery]);
  const manage = can('treasury.bank.manage');
  const pending = (lines.data ?? []).filter((line) => line.status === 'pending');
  const matched = (lines.data ?? []).filter((line) => line.status === 'matched');

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      lines.reload();
      summary.reload();
      statements.reload();
      setNotice({ kind: 'ok', text: message });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function chooseAccount(value: string) {
    setBankAccountId(value);
    setStatementId('');
  }

  function manualMatch(line: BankLine) {
    const target = window.prompt('أدخل معرّف الفاتورة أو السند لمطابقة الحركة:');
    if (!target) return;
    const kind = window.prompt('اكتب invoice أو voucher:', 'invoice')?.toLowerCase() === 'voucher' ? 'voucher' : 'invoice';
    void run(
      () => apiPost(`/treasury/bank-statements/${effectiveStatementId}/match`, { lineId: line.id, ...(kind === 'voucher' ? { voucherId: target } : { invoiceId: target }) }),
      'تمت المطابقة اليدوية للحركة.',
    );
  }

  return (
    <Screen
      title="⚖️ التسوية البنكية"
      subtitle="كشف البنك في اليسار، وما تم ربطه من دفترنا في اليمين. المطابقة association فقط ولا ترحّل قيداً جديداً."
      crumbs={['الخزينة', 'التغذية البنكية']}
      actions={<><Link className="btn sm" href="/treasury/bank-statements">كشوف الحساب</Link><button className="btn sm" type="button" onClick={() => window.print()}>🖨️ طباعة / PDF</button></>}
    >
      <Notice notice={notice} />
      <div className="card mb-4">
        <FilterBar actions={<button className="btn primary" disabled={!manage || !effectiveStatementId || busy} type="button" onClick={() => void run(() => apiPost(`/treasury/bank-statements/${effectiveStatementId}/auto-match`, {}), 'اكتملت المطابقة التلقائية.')}>تشغيل المطابقة التلقائية</button>}>
          <label className="field"><span>الحساب البنكي</span><select value={bankAccountId} onChange={(event) => chooseAccount(event.target.value)}><option value="">اختر الحساب</option>{(accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.bankName} — {account.accountNo ?? account.iban ?? account.id.slice(0, 8)}</option>)}</select></label>
          <label className="field"><span>الكشف</span><select value={effectiveStatementId} onChange={(event) => setStatementId(event.target.value)}><option value="">اختر الكشف</option>{(statements.data ?? []).map((statement) => <option key={statement.id} value={statement.id}>{statement.periodFrom} — {statement.periodTo} ({statement.rowCount} حركة)</option>)}</select></label>
          <label className="field"><span>من تاريخ، اختياري</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="field"><span>إلى تاريخ، اختياري</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </FilterBar>
      </div>

      <StatTiles>
        <StatTile label="رصيد البنك" value={summary.data?.bankBalance ?? '—'} hint={summary.data?.currency ?? 'SAR'} />
        <StatTile label="رصيد الدفاتر" value={summary.data?.ledgerBalance ?? '—'} hint={summary.data?.ledgerSource ?? '—'} />
        <StatTile label="الفرق" value={summary.data?.difference ?? '—'} tone={summary.data?.difference === '0.0000' ? 'ok' : 'warn'} hint="البنك − الدفاتر" />
        <StatTile label="حركات معلّقة" value={summary.data?.pendingLines ?? pending.length} tone={pending.length > 0 ? 'warn' : 'ok'} />
      </StatTiles>

      <DocHead>
        <DocField label="البنك">{summary.data?.bankName ?? '—'}</DocField>
        <DocField label="الفترة"><span dir="ltr">{summary.data?.periodFrom ?? today()} — {summary.data?.periodTo ?? today()}</span></DocField>
        <DocField label="إجمالي الحركات">{summary.data?.lineCount ?? lines.data?.length ?? 0}</DocField>
        <DocField label="المطابقة">{summary.data?.matchedLines ?? matched.length}</DocField>
      </DocHead>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <section className="card">
          <div className="flex items-center justify-between gap-3 mb-3"><div><h2 className="m-0 text-[16px] font-bold">حركات كشف البنك</h2><p className="m-0 mt-1 text-[12px] text-muted">راجع السطر ثم طابقه أو تجاهله.</p></div><span className="status draft">{pending.length} معلّق</span></div>
          <QueryView query={lines} empty="لا توجد حركات في هذا الكشف">
            {(rows) => <DataTable rows={rows.filter((line) => line.status !== 'matched')} rowKey={(row) => row.id} columns={[
              { key: 'date', header: 'التاريخ', cell: (row) => <span dir="ltr">{row.txnDate}</span> },
              { key: 'description', header: 'البيان', cell: (row) => <span title={row.reference ?? undefined}>{row.description || '—'}</span> },
              { key: 'amount', header: 'المبلغ', align: 'num', cell: (row) => row.amount },
              { key: 'status', header: 'الحالة', cell: (row) => <span className={`status ${row.status === 'ignored' ? 'voided' : 'draft'}`}>{statusLabel(row.status)}</span> },
              { key: 'action', header: 'إجراء', cell: (row) => manage && row.status === 'pending' ? <div className="flex gap-1"><button className="btn sm" type="button" onClick={() => manualMatch(row)}>مطابقة</button><button className="btn sm" type="button" onClick={() => void run(() => apiPost(`/treasury/bank-statements/${effectiveStatementId}/lines/${row.id}/ignore`, {}), 'تم تجاهل الحركة.')}>تجاهل</button></div> : null },
            ]} />}
          </QueryView>
        </section>

        <section className="card">
          <div className="flex items-center justify-between gap-3 mb-3"><div><h2 className="m-0 text-[16px] font-bold">ما تمت مطابقته في الدفاتر</h2><p className="m-0 mt-1 text-[12px] text-muted">الفواتير والسندات المرتبطة بالحركات البنكية.</p></div><span className="status posted">{matched.length} مطابق</span></div>
          <DataTable rows={matched} rowKey={(row) => row.id} columns={[
            { key: 'date', header: 'التاريخ', cell: (row) => <span dir="ltr">{row.txnDate}</span> },
            { key: 'description', header: 'البيان', cell: (row) => row.description || '—' },
            { key: 'amount', header: 'المبلغ', align: 'num', cell: (row) => row.amount },
            { key: 'target', header: 'المستند', cell: (row) => <span dir="ltr">{row.matchedInvoiceId ?? row.matchedVoucherId ?? '—'}</span> },
            { key: 'confidence', header: 'الثقة', cell: (row) => row.matchConfidence ? `${Math.round(Number(row.matchConfidence) * 100)}%` : 'يدوي' },
            { key: 'action', header: 'إجراء', cell: (row) => manage ? <button className="btn sm" type="button" onClick={() => void run(() => apiDelete(`/treasury/bank-statements/${effectiveStatementId}/lines/${row.id}/match`), 'أعيدت الحركة إلى المعلّق.')}>إلغاء المطابقة</button> : null },
          ]} />
        </section>
      </div>
    </Screen>
  );
}
