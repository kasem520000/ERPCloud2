'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { listJournalEntries, type JournalEntry } from '../../lib/accounting';

/**
 * M3 — 📚 القيود اليومية (read-only): the journal register with per-entry totals.
 * The status filter maps straight onto the register's own `status` query parameter.
 */
export default function JournalsPage() {
  const [status, setStatus] = useState('');
  const entries = useQuery(() => listJournalEntries(status ? { status } : {}), [status]);

  return (
    <Screen
      title="القيود اليومية"
      subtitle="سجل القيود مع مجاميع كل قيد — من القيود المُرحَّلة"
      crumbs={['المحاسبة', 'القيود اليومية']}
      actions={
        <select className="input" style={{ width: 170 }} value={status} onChange={(event) => setStatus(event.target.value)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          <option value="posted">مُرحَّل</option>
          <option value="draft">مسودة</option>
          <option value="voided">ملغى</option>
        </select>
      }
    >
      {entries.status === 'loading' ? <Loading rows={6} /> : null}
      {entries.status === 'forbidden' ? <Forbidden /> : null}
      {entries.status === 'error' ? <ErrorBox message={entries.error} onRetry={entries.reload} /> : null}
      {entries.status === 'success' && (entries.data ?? []).length === 0 ? <Empty hint="لا توجد قيود في هذا النطاق." /> : null}
      {entries.status === 'success' && (entries.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>رقم القيد</th>
                <th>التاريخ</th>
                <th>الحالة</th>
                <th>الفرع</th>
                <th>الوصف</th>
                <th className="num">مدين</th>
                <th className="num">دائن</th>
              </tr>
            </thead>
            <tbody>
              {(entries.data ?? []).map((entry: JournalEntry) => (
                <tr key={entry.id}>
                  <td>{entry.number ?? entry.entryNo ?? '—'}</td>
                  <td>{dateOf(entry)}</td>
                  <td>
                    <span className={`badge ${statusOf(entry)}`}>{statusLabel(statusOf(entry))}</span>
                  </td>
                  <td className="muted small">{entry.branchName ?? entry.branch_name ?? '—'}</td>
                  <td className="small">{entry.description ?? entry.notes ?? ''}</td>
                  <td className="num">{fmt(entry.totalDebit ?? entry.total_debit)}</td>
                  <td className="num">{fmt(entry.totalCredit ?? entry.total_credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Screen>
  );
}

function dateOf(entry: JournalEntry): string {
  const raw = entry.entryDate ?? entry.entry_date ?? entry.postedAt ?? entry.posted_at ?? '';
  return raw ? String(raw).slice(0, 10) : '—';
}
function statusOf(entry: JournalEntry): string {
  return entry.status ?? 'draft';
}
function statusLabel(status: string): string {
  return { posted: 'مُرحَّل', draft: 'مسودة', voided: 'ملغى' }[status] ?? status;
}
function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
