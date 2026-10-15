'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import {
  ACCOUNT_TYPE_LABELS,
  listAccounts,
  nameOf,
  parentOf,
  postableOf,
  typeOf,
  type Account,
} from '../../lib/accounting';

/**
 * M3 — 📂 دليل الحسابات (read-only): the directory with each node's balance, read with
 * `with_balances=1` so the balance is counted from posted entries only. Search and the
 * type filter run server-side (the API's own `q`/`type` parameters).
 */
export default function AccountsPage() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');

  const accounts = useQuery(
    () => listAccounts(search.trim() ? { q: search.trim() } : {}),
    [search, type],
  );
  // The type filter is applied client-side over the balanced directory so the balance
  // rollups (parent ⇒ branch) stay meaningful regardless of the filter.
  const rows = (accounts.data ?? []).filter((account) => !type || typeOf(account) === type);

  return (
    <Screen
      title="دليل الحسابات"
      subtitle="الأرصدة من القيود المُرحَّلة فقط، مجمَّعة على مسار الحساب (الأب يشمل فروعه)"
      crumbs={['المحاسبة', 'دليل الحسابات']}
      actions={
        <div className="row">
          <input
            className="input"
            style={{ width: 220 }}
            type="search"
            placeholder="بحث بالاسم أو الرمز…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="بحث"
          />
          <select className="input" style={{ width: 160 }} value={type} onChange={(event) => setType(event.target.value)} aria-label="نوع الحساب">
            <option value="">كل الأنواع</option>
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {accounts.status === 'loading' ? <Loading rows={6} /> : null}
      {accounts.status === 'forbidden' ? <Forbidden /> : null}
      {accounts.status === 'error' ? <ErrorBox message={accounts.error} onRetry={accounts.reload} /> : null}
      {accounts.status === 'success' && rows.length === 0 ? <Empty hint="لا توجد حسابات مطابقة." /> : null}
      {accounts.status === 'success' && rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الرمز</th>
                <th>اسم الحساب</th>
                <th>النوع</th>
                <th>الحساب الرئيسي</th>
                <th>قابل للترحيل</th>
                <th className="num">مدين</th>
                <th className="num">دائن</th>
                <th className="num">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account: Account) => (
                <tr key={account.id}>
                  <td>{account.code}</td>
                  <td>{nameOf(account)}</td>
                  <td>{ACCOUNT_TYPE_LABELS[typeOf(account)] ?? typeOf(account) ?? '—'}</td>
                  <td className="muted small">{parentLabel(account, accounts.data ?? [])}</td>
                  <td>{postableOf(account) ? 'نعم' : 'لا'}</td>
                  <td className="num">{fmt(account.balance?.debit)}</td>
                  <td className="num">{fmt(account.balance?.credit)}</td>
                  <td className="num">
                    <strong>{fmt(account.balance?.balance)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function parentLabel(account: Account, all: Account[]): string {
  const parentId = parentOf(account);
  if (!parentId) return '—';
  const parent = all.find((candidate) => candidate.id === parentId);
  return parent ? `${parent.code} — ${nameOf(parent)}` : '—';
}
