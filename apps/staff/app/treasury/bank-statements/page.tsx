'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar } from '../../../components/ui';
import { apiList, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type BankAccount = { id: string; bankName: string; accountNo: string | null; iban: string | null };
type BankStatement = {
  id: string;
  bankAccountId: string;
  periodFrom: string;
  periodTo: string;
  status: string;
  sourceFileName: string | null;
  rowCount: number;
  openingBalance: string | null;
  closingBalance: string | null;
  createdAt: string;
};

const STATUS: Record<string, string> = {
  processing: 'قيد المعالجة',
  processed: 'جاهز للمطابقة',
  reconciled: 'تمت التسوية',
  error: 'خطأ',
};

export default function BankStatementsPage() {
  const params = useSearchParams();
  const initialAccount = params.get('bank_account_id') ?? '';
  const { can } = useSession();
  const [bankAccountId, setBankAccountId] = useState(initialAccount);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [csv, setCsv] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();

  const accounts = useQuery<BankAccount[]>(() => apiList<BankAccount>('/treasury/bank-accounts'), []);
  const query = useMemo(() => bankAccountId ? `/treasury/bank-statements?bank_account_id=${encodeURIComponent(bankAccountId)}` : '/treasury/bank-statements', [bankAccountId]);
  const statements = useQuery<BankStatement[]>(() => apiList<BankStatement>(query), [query]);
  const manage = can('treasury.bank.manage');

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setCsv(await file.text());
  }

  async function importStatement(event: React.FormEvent) {
    event.preventDefault();
    if (!bankAccountId) {
      setNotice({ kind: 'danger', text: 'اختر الحساب البنكي أولاً.' });
      return;
    }
    if (!csv.trim()) {
      setNotice({ kind: 'danger', text: 'اختر ملف CSV أو الصق محتواه.' });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<{ importedLines: number }>('/treasury/bank-statements/import', {
        bankAccountId,
        csv,
        fileName: selectedFile?.name,
        openingBalance: openingBalance.trim() || undefined,
      });
      setCsv('');
      setSelectedFile(undefined);
      setOpeningBalance('');
      statements.reload();
      setNotice({ kind: 'ok', text: `تم استيراد ${result.importedLines} حركة بنكية. راجعها قبل المطابقة.` });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runAutoMatch(statement: BankStatement) {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<{ matched: number; suggested: number }>('/treasury/bank-statements/' + statement.id + '/auto-match', {});
      statements.reload();
      setNotice({ kind: 'ok', text: `اكتملت المطابقة: ${result.matched} حركات مطابقة و${result.suggested} اقتراح قاعدة.` });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="📥 كشوف الحساب البنكي"
      subtitle="رفع CSV، مراجعة الحركات ثم تشغيل المطابقة التلقائية. لا يُنشئ الاستيراد قيداً محاسبياً من تلقاء نفسه."
      crumbs={['الخزينة', 'التغذية البنكية']}
      actions={<Link className="btn sm" href="/treasury/bank-reconciliation">فتح شاشة التسوية</Link>}
    >
      <Notice notice={notice} />
      {manage ? (
        <form className="card grid gap-3 mb-4" onSubmit={importStatement}>
          <div>
            <h2 className="m-0 text-[16px] font-bold text-ink">معالج استيراد كشف الحساب</h2>
            <p className="m-0 mt-1 text-[12px] text-muted">الخطوة 1 رفع الملف · الخطوة 2 تأكيد الحساب · الخطوة 3 مراجعة الحركات.</p>
          </div>
          <FilterBar>
            <label className="field"><span>الحساب البنكي</span><select required value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}><option value="">اختر الحساب</option>{(accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.bankName} — {account.accountNo ?? account.iban ?? account.id.slice(0, 8)}</option>)}</select></label>
            <label className="field"><span>ملف CSV</span><input type="file" accept=".csv,text/csv,text/plain" onChange={chooseFile} /></label>
            <label className="field"><span>رصيد بداية الكشف، اختياري</span><input dir="ltr" inputMode="decimal" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} placeholder="0.00" /></label>
          </FilterBar>
          <label className="field"><span>المحتوى — للمعاينة أو اللصق اليدوي</span><textarea dir="ltr" rows={5} value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="Date,Description,Amount,Balance" /></label>
          <div className="flex items-center justify-between gap-3"><span className="text-[12px] text-muted">{csv ? `${csv.split(/\r?\n/).filter(Boolean).length - 1} سطر تقريباً` : 'لم يُرفع ملف بعد'}</span><button className="btn primary" disabled={busy} type="submit">{busy ? 'جارٍ الاستيراد…' : 'رفع ومراجعة الكشف'}</button></div>
        </form>
      ) : null}

      <QueryView query={statements} empty="لا توجد كشوف مستوردة" emptyDetail="ارفع CSV من المعالج أعلاه لتظهر حركات البنك هنا.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'bank', header: 'الحساب البنكي', cell: (row) => accounts.data?.find((account) => account.id === row.bankAccountId)?.bankName ?? row.bankAccountId.slice(0, 8) },
              { key: 'period', header: 'الفترة', cell: (row) => <span dir="ltr">{row.periodFrom} — {row.periodTo}</span> },
              { key: 'file', header: 'الملف', cell: (row) => row.sourceFileName ?? 'إدخال مباشر' },
              { key: 'rows', header: 'الحركات', align: 'num', cell: (row) => row.rowCount },
              { key: 'status', header: 'الحالة', cell: (row) => <span className={`status ${row.status === 'reconciled' ? 'posted' : row.status === 'error' ? 'voided' : 'draft'}`}>{STATUS[row.status] ?? row.status}</span> },
              { key: 'actions', header: 'إجراءات', cell: (row) => <div className="flex gap-2"><Link className="btn sm" href={`/treasury/bank-reconciliation?statement_id=${row.id}&bank_account_id=${row.bankAccountId}`}>مراجعة</Link>{manage && row.status !== 'reconciled' ? <button className="btn sm" disabled={busy} type="button" onClick={() => runAutoMatch(row)}>مطابقة تلقائية</button> : null}</div> },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
