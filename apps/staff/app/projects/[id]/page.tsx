'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { CommentsPanel } from '../../../components/comments-panel';
import { DataTable, Notice } from '../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../components/screen';
import { accountLabel, listAccounts, postableOf, type Account } from '../../../lib/accounts';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { money, percent, quantity, shortDate, statusLabel, today } from '../../../lib/lookups';
import { periodForDate } from '../../../lib/posting';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Stage = { id: string; name: string; stageOrder: number; status: string };
type BoqTerm = { id: string; code: string; description: string; qty: string; unitValue: string; totalValue: string; billedValue: string };
type Project = {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  status: string;
  contractValue: string;
  retentionPct: string;
  stages: Stage[];
  boq: BoqTerm[];
};
type Bill = { id: string; number: string | null; billDate: string; status: string; grossValue: string; retentionValue: string; netValue: string };

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id);
  const { can } = useSession();
  const project = useQuery<Project>(() => apiData<Project>(`/projects/${projectId}`), [projectId]);
  const bills = useQuery<Bill[]>(() => apiList<Bill>(`/projects/${projectId}/progress-bills`), [projectId]);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);

  const [stageName, setStageName] = useState('');
  const [term, setTerm] = useState({ code: '', description: '', qty: '', unitValue: '' });
  const [billDate, setBillDate] = useState(today());
  const [billPercents, setBillPercents] = useState<Record<string, string>>({});
  const [revenueAccountId, setRevenueAccountId] = useState('');
  const [receivableAccountId, setReceivableAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  if (project.status === 'loading') return <Loading />;
  if (project.status !== 'success' || !project.data) {
    return (
      <Screen title="مشروع" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={project.error ?? 'تعذّر تحميل المشروع'} onRetry={project.reload} />
      </Screen>
    );
  }

  const doc = project.data;
  const postable = (accounts.data ?? []).filter((account) => postableOf(account));

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      project.reload();
      bills.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createBill() {
    const lines = doc.boq
      .filter((entry) => Number(billPercents[entry.id] ?? 0) > 0)
      .map((entry) => ({ termId: entry.id, billPct: billPercents[entry.id] }));
    if (lines.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'حدّد نسبة إنجاز لبند واحد على الأقل.');
    await apiPost(`/projects/${doc.id}/progress-bills`, { billDate, lines });
    setBillPercents({});
  }

  async function postBill(billId: string) {
    const period = await periodForDate(today());
    await apiPost(`/projects/progress-bills/${billId}/post`, {
      branchId: doc.branchId ?? undefined,
      fiscalPeriodId: period?.id,
      revenueAccountId: revenueAccountId || undefined,
      receivableAccountId: receivableAccountId || undefined,
    });
  }

  return (
    <Screen
      title={`${doc.code} — ${doc.name}`}
      subtitle={`${statusLabel(doc.status)} · قيمة العقد ${money(doc.contractValue)} · محتجز ${percent(Number(doc.retentionPct) / 100)}`}
      crumbs={['إدارة المشاريع']}
      actions={
        <Link className="btn" href="/projects">
          كل المشاريع
        </Link>
      }
    >
      <Notice notice={notice} />

      <div className="grid cols-2">
        <div className="card">
          <h2>مراحل المشروع</h2>
          {doc.stages.length === 0 ? (
            <p className="muted">لا توجد مراحل.</p>
          ) : (
            <DataTable
              rows={doc.stages}
              rowKey={(row) => row.id}
              columns={[
                { key: 'order', header: '#', align: 'num', cell: (row) => row.stageOrder },
                { key: 'name', header: 'المرحلة', cell: (row) => row.name },
                { key: 'status', header: 'الحالة', cell: (row) => statusLabel(row.status) },
              ]}
            />
          )}
          {can('projects.manage') && (
            <>
              <label className="field">
                <span>مرحلة جديدة</span>
                <input className="input" value={stageName} onChange={(event) => setStageName(event.target.value)} />
              </label>
              <button
                className="btn sm"
                type="button"
                disabled={busy || !stageName.trim()}
                onClick={() =>
                  run(async () => {
                    await apiPost(`/projects/${doc.id}/stages`, { name: stageName.trim() });
                    setStageName('');
                  }, 'تمت إضافة المرحلة.')
                }
              >
                إضافة مرحلة
              </button>
            </>
          )}
        </div>

        <div className="card">
          <h2>بند جديد في جدول الكميات</h2>
          {can('projects.manage') ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>الرمز</span>
                  <input className="input" dir="ltr" value={term.code} onChange={(event) => setTerm({ ...term, code: event.target.value })} />
                </label>
                <label className="field">
                  <span>الوصف</span>
                  <input className="input" value={term.description} onChange={(event) => setTerm({ ...term, description: event.target.value })} />
                </label>
                <label className="field">
                  <span>الكمية</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={term.qty} onChange={(event) => setTerm({ ...term, qty: event.target.value })} />
                </label>
                <label className="field">
                  <span>سعر الوحدة</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={term.unitValue} onChange={(event) => setTerm({ ...term, unitValue: event.target.value })} />
                </label>
              </div>
              <button
                className="btn sm"
                type="button"
                disabled={busy || !term.code.trim() || !term.unitValue.trim()}
                onClick={() =>
                  run(async () => {
                    await apiPost(`/projects/${doc.id}/boq`, {
                      code: term.code.trim(),
                      description: term.description.trim(),
                      qty: term.qty.trim() || undefined,
                      unitValue: term.unitValue.trim(),
                    });
                    setTerm({ code: '', description: '', qty: '', unitValue: '' });
                  }, 'تمت إضافة البند.')
                }
              >
                إضافة البند
              </button>
            </>
          ) : (
            <p className="muted">لا تملك صلاحية تعديل المشروع.</p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>جدول الكميات (BOQ)</h2>
        {doc.boq.length === 0 ? (
          <p className="muted">لا توجد بنود بعد.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرمز</th>
                    <th>الوصف</th>
                    <th>الكمية</th>
                    <th>سعر الوحدة</th>
                    <th>القيمة</th>
                    <th>المستخلص سابقاً</th>
                    <th>نسبة هذا المستخلص %</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.boq.map((entry) => (
                    <tr key={entry.id}>
                      <td dir="ltr">{entry.code}</td>
                      <td>{entry.description}</td>
                      <td className="num">{quantity(entry.qty)}</td>
                      <td className="num">{money(entry.unitValue)}</td>
                      <td className="num">{money(entry.totalValue)}</td>
                      <td className="num">{money(entry.billedValue)}</td>
                      <td>
                        <input
                          className="input"
                          dir="ltr"
                          inputMode="decimal"
                          value={billPercents[entry.id] ?? ''}
                          onChange={(event) => setBillPercents((current) => ({ ...current, [entry.id]: event.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {can('projects.manage') && (
              <div className="row">
                <label className="field">
                  <span>تاريخ المستخلص</span>
                  <input className="input" type="date" dir="ltr" value={billDate} onChange={(event) => setBillDate(event.target.value)} />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => run(createBill, 'تم إنشاء المستخلص كمسودة.')}>
                  إنشاء مستخلص
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>المستخلصات</h2>
        {can('projects.bill.post') && (
          <div className="form-grid">
            <label className="field">
              <span>حساب الإيراد</span>
              <select className="input" value={revenueAccountId} onChange={(event) => setRevenueAccountId(event.target.value)}>
                <option value="">— افتراضي الربط المحاسبي —</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>حساب المدينين</span>
              <select className="input" value={receivableAccountId} onChange={(event) => setReceivableAccountId(event.target.value)}>
                <option value="">— افتراضي الربط المحاسبي —</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <DataTable
          rows={bills.data ?? []}
          rowKey={(row) => row.id}
          columns={[
            { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number ?? 'مسودة' },
            { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.billDate) },
            { key: 'gross', header: 'الإجمالي', align: 'num', cell: (row) => money(row.grossValue) },
            { key: 'retention', header: 'المحتجز', align: 'num', cell: (row) => money(row.retentionValue) },
            { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.netValue) },
            { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
            {
              key: 'actions',
              header: '',
              cell: (row) => (
                <span className="row">
                  {row.status === 'draft' && can('projects.bill.post') && (
                    <button className="btn sm primary" type="button" disabled={busy} onClick={() => run(() => postBill(row.id), 'تم ترحيل المستخلص.')}>
                      ترحيل
                    </button>
                  )}
                  {row.status === 'posted' && can('projects.bill.post') && (
                    <button
                      className="btn sm"
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => apiPost(`/projects/progress-bills/${row.id}/release-retention`, { branchId: doc.branchId ?? undefined }), 'تم الإفراج عن المحتجز.')}
                    >
                      الإفراج عن المحتجز
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className="toolbar">
        <Link className="btn" href={`/projects/${projectId}/board`}>لوحة كانبان</Link>
        <Link className="btn" href={`/projects/${projectId}/gantt`}>جانت</Link>
        <Link className="btn" href={`/projects/${projectId}/time`}>الوقت</Link>
        <Link className="btn" href={`/projects/${projectId}/cost`}>التكلفة</Link>
      </div>
      <CommentsPanel entityType="project" entityId={projectId} />
    </Screen>
  );
}
