'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiList, apiPost } from '../../../lib/api';
import { accountLabel, listAccounts, type Account } from '../../../lib/accounts';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

 type BankAccount = {
  id: string;
  bankName: string;
  accountNo: string | null;
  iban: string | null;
  currency: string;
  openingBalance: string;
  accountId: string | null;
  status: string;
  version: number;
};

const EMPTY = { bankName: '', accountNo: '', iban: '', openingBalance: '0', accountId: '' };

export default function BankAccountsPage() {
  const { can } = useSession();
  const accounts = useQuery<BankAccount[]>(() => apiList<BankAccount>('/treasury/bank-accounts'), []);
  const ledgerAccounts = useQuery<Account[]>(() => listAccounts(), []);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();
  const manage = can('treasury.bank.manage');

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost('/treasury/bank-accounts', {
        bankName: form.bankName.trim(),
        accountNo: form.accountNo.trim() || undefined,
        iban: form.iban.trim() || undefined,
        openingBalance: form.openingBalance.trim() || '0',
        accountId: form.accountId || undefined,
      });
      setForm(EMPTY);
      accounts.reload();
      setNotice({ kind: 'ok', text: 'تمت إضافة الحساب البنكي.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="🏦 الحسابات البنكية"
      subtitle="تعريف الحسابات التي تستقبل كشوف البنك وتربطها بحساب دفتر الأستاذ."
      crumbs={['الخزينة', 'التغذية البنكية']}
      actions={
        <>
          <Link className="btn sm" href="/treasury/bank-statements">كشوف الحساب</Link>
          <Link className="btn sm" href="/treasury/bank-reconciliation">التسوية البنكية</Link>
        </>
      }
    >
      <Notice notice={notice} />
      {manage ? (
        <form className="card grid gap-3 mb-4" onSubmit={create}>
          <div>
            <h2 className="m-0 text-[16px] font-bold text-ink">إضافة حساب بنكي</h2>
            <p className="m-0 mt-1 text-[12px] text-muted">ابدأ بحساب واحد ثم اربطه بحساب الأستاذ لمقارنة الرصيدين.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <label className="field"><span>اسم البنك</span><input required value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} placeholder="مصرف الراجحي" /></label>
            <label className="field"><span>رقم الحساب</span><input value={form.accountNo} onChange={(event) => setForm({ ...form, accountNo: event.target.value })} /></label>
            <label className="field"><span>IBAN</span><input dir="ltr" value={form.iban} onChange={(event) => setForm({ ...form, iban: event.target.value })} placeholder="SA..." /></label>
            <label className="field"><span>الرصيد الافتتاحي</span><input dir="ltr" inputMode="decimal" value={form.openingBalance} onChange={(event) => setForm({ ...form, openingBalance: event.target.value })} /></label>
            <label className="field"><span>حساب دفتر الأستاذ</span><select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">بدون ربط الآن</option>{(ledgerAccounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}</select></label>
          </div>
          <div className="flex justify-end"><button className="btn primary" disabled={busy} type="submit">{busy ? 'جارٍ الحفظ…' : 'إضافة الحساب'}</button></div>
        </form>
      ) : null}

      <QueryView query={accounts} empty="لا توجد حسابات بنكية" emptyDetail="أضف الحساب البنكي الأول من النموذج أعلاه.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'bank', header: 'البنك', cell: (row) => <b>{row.bankName}</b> },
              { key: 'accountNo', header: 'رقم الحساب', cell: (row) => row.accountNo ?? '—', align: 'ltr' },
              { key: 'iban', header: 'IBAN', cell: (row) => row.iban ?? '—', align: 'ltr' },
              { key: 'opening', header: 'الرصيد الافتتاحي', align: 'num', cell: (row) => row.openingBalance },
              { key: 'ledger', header: 'حساب الأستاذ', cell: (row) => ledgerAccounts.data?.find((account) => account.id === row.accountId)?.code ?? 'غير مربوط' },
              { key: 'actions', header: 'إجراءات', cell: (row) => <Link className="btn sm" href={`/treasury/bank-statements?bank_account_id=${row.id}`}>الكشوف</Link> },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
