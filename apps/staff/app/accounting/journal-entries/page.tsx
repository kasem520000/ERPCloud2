'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData } from '../../../lib/api';
import { downloadCsv } from '../../../lib/accounts';
import { useQuery } from '../../../lib/use-query';

type Entry = {
  id: string;
  number: string | null;
  date: string;
  kind: string;
  status: string;
  description: string | null;
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  sourceType: string | null;
};

function money(value: string) {
  return Number(value || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function JournalRegisterPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const search = useSearchParams();
  /**
   * 📄 كشف الحساب يفتح قيداً بعينه من عموده «تفاصيل» (`?entry=<id>`). وفي R10 صار للقيد
   * شاشةٌ بمعرّفه (`/accounting/journal-entries/[id]`) تحمل متنقّل النافذة المكتبية
   * (⏮ ◀ ▶ ⏭) وطباعتها — فالرابط القديم يُحوَّل إليها.
   */
  const linked = search.get('entry') ?? '';
  const router = useRouter();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ from: monthStart, to: today, status: '' });

  /**
   * `?entry=<id>` وصل من كشف الحساب («تفاصيل») قبل R10. والآن للقيد **شاشةٌ** تُفتح
   * بمعرّفه، فيُحوَّل الرابط القديم إليها بدل أن يبقى عرضاً ثانياً داخل السجل — فالمُدخِل
   * يصل إلى المتنقّل والطباعة، والرابط لا ينكسر.
   */
  useEffect(() => {
    if (!linked) return;
    router.replace(`/accounting/journal-entries/${linked}`);
  }, [linked, router]);

  const entries = useQuery<Entry[]>(() => {
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (applied.status) params.set('status', applied.status);
    return apiData<Entry[]>(`/journal-entries?${params.toString()}`);
  }, [applied]);

  const rows = entries.data ?? [];
  /** نطاق السجل ينتقل إلى شاشة القيد كما هو (فترة · حالة). */
  const scopeSuffix = applied.from || applied.to || applied.status
    ? `?${new URLSearchParams(
        Object.entries({ from: applied.from, to: applied.to, status: applied.status }).filter(([, value]) => Boolean(value)) as Array<[string, string]>,
      ).toString()}`
    : '';
  const totalDebit = rows.reduce((sum, row) => sum + Number(row.totalDebit || 0), 0);
  const totalCredit = rows.reduce((sum, row) => sum + Number(row.totalCredit || 0), 0);

  return (
    <Screen
      title="القيود اليومية"
      subtitle="سجل كل القيود المرحّلة خلال الفترة المحددة."
      crumbs={['المحاسبة', 'تقارير محاسبية']}
      actions={
        <>
          <button className="btn" type="button" onClick={() => window.print()}>
            طباعة
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              downloadCsv(
                'journal-entries.csv',
                ['الرقم', 'التاريخ', 'البيان', 'مدين', 'دائن', 'الحالة'],
                rows.map((row) => [row.number ?? '', row.date, row.description ?? '', row.totalDebit, row.totalCredit, row.status]),
              )
            }
          >
            تصدير CSV
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row">
          <label className="field" style={{ margin: 0 }}>
            <span>من تاريخ</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>إلى تاريخ</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>الحالة</span>
            <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">الكل</option>
              <option value="posted">مرحّل</option>
              <option value="draft">مسودة</option>
              <option value="void">ملغي</option>
            </select>
          </label>
          <button className="btn primary" type="button" style={{ alignSelf: 'end' }} onClick={() => setApplied({ from, to, status })}>
            عرض
          </button>
        </div>
      </div>

      {entries.status === 'loading' && <Loading />}
      {entries.status === 'forbidden' && <Forbidden />}
      {entries.status === 'error' && <ErrorBox message={entries.error} onRetry={entries.reload} />}
      {entries.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا توجد قيود في هذه الفترة" detail="جرّب توسيع المدى الزمني أو أنشئ سند قيد جديد." />
        ) : (
          <>
            <div className="grid cols">
              <article className="card">
                <p className="muted">عدد القيود</p>
                <div className="kpi">{rows.length}</div>
              </article>
              <article className="card">
                <p className="muted">إجمالي المدين</p>
                <div className="kpi" style={{ fontSize: 22 }}>{money(String(totalDebit))}</div>
              </article>
              <article className="card">
                <p className="muted">إجمالي الدائن</p>
                <div className="kpi" style={{ fontSize: 22 }}>{money(String(totalCredit))}</div>
              </article>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>التاريخ</th>
                    <th>النوع</th>
                    <th>البيان</th>
                    <th className="num">مدين</th>
                    <th className="num">دائن</th>
                    <th>الحالة</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td dir="ltr">{row.date}</td>
                      <td>{row.kind === 'reversal' ? 'عكسي' : row.sourceType ?? 'يدوي'}</td>
                      <td>{row.description ?? '—'}</td>
                      <td className="num">{money(row.totalDebit)}</td>
                      <td className="num">{money(row.totalCredit)}</td>
                      <td>
                        <span className={`badge ${row.status}`}>
                          {row.status === 'posted' ? 'مرحّل' : row.status === 'void' ? 'ملغي' : 'مسودة'}
                        </span>
                      </td>
                      <td>
                        <span className="row">
                          {/*
                            «تفاصيل» صارت باباً إلى شاشة القيد (R10) — في الرابط
                            نطاقُ السجل نفسه، فيبقى المتنقّل ⏮ ◀ ▶ ⏭ داخل الفترة المعروضة.
                          */}
                          <Link className="btn sm" href={`/accounting/journal-entries/${row.id}${scopeSuffix}`}>
                            تفاصيل
                          </Link>
                          <Link className="btn sm" href={`/print/journal-entry/${row.id}`}>
                            طباعة
                          </Link>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

          </>
        ))}
    </Screen>
  );
}
