'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSession } from '@erp/web-core/session';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { listAccounts, listFiscalYears, type Account, type FiscalYear } from '../../lib/accounting';
import {
  approveBudget,
  createBudget,
  deleteDraftBudget,
  listBudgets,
  previewDistribution,
  statusLabelOf,
  type Budget,
} from '../../lib/budgets';

/**
 * 📊 M6.4 — الموازنات: القائمة وإنشاء المسودة واعتمادها.
 *
 * الكتابة الثانية في تطبيق المحاسبة (بعد الأصول): الإنشاء والاعتماد والحذف خلف
 * `accounting.budget.manage`، والقراءة للجميع — والـAPI يفرض الفصل نفسه رغم ذلك.
 * المبلغ السنوي يُوزَّع على فترات السنة في الخادم؛ المعاينة هنا تقدير للعرض فقط.
 */
export default function BudgetsPage() {
  const { can } = useSession();
  const canManage = can('accounting.budget.manage');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const budgets = useQuery(() => listBudgets(), []);
  const years = useQuery(() => listFiscalYears(), []);
  const accounts = useQuery(() => listAccounts(), []);

  return (
    <Screen
      title="الموازنات"
      subtitle="خطة السنة المالية حسابًا حسابًا، ومقارنتها بالفعلي من القيود المُرحَّلة — الاعتماد يجمّد السطور"
      crumbs={['المحاسبة', 'الموازنات']}
    >
      {budgets.status === 'loading' ? <Loading rows={4} /> : null}
      {budgets.status === 'forbidden' ? <Forbidden /> : null}
      {budgets.status === 'error' ? <ErrorBox message={budgets.error} onRetry={budgets.reload} /> : null}
      {budgets.status === 'success' && (budgets.data ?? []).length === 0 ? (
        <Empty hint="لا توجد موازنات بعد — أنشئ خطة السنة المالية." />
      ) : null}
      {budgets.status === 'success' && (budgets.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الاسم</th>
                <th>السنة المالية</th>
                <th>الحالة</th>
                <th className="num">إجمالي الموازنة</th>
                <th>الاعتماد</th>
                <th>المقارنة</th>
                {canManage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {(budgets.data ?? []).map((budget: Budget) => (
                <tr key={budget.id}>
                  <td>{budget.name}</td>
                  <td className="muted small">{budget.fiscalYearName ?? '—'}</td>
                  <td>
                    <span className={`badge ${budget.status === 'approved' ? 'posted' : 'draft'}`}>{statusLabelOf(budget)}</span>
                  </td>
                  <td className="num">{fmt(budget.totalAmount)}</td>
                  <td className="muted small">{budget.approvedAt ? String(budget.approvedAt).slice(0, 10) : '—'}</td>
                  <td>
                    <Link className="btn ghost sm" href={`/budgets/${budget.id}`}>
                      مقابل الفعلي
                    </Link>
                  </td>
                  {canManage ? (
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {budget.status === 'draft' ? (
                          <>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={budgets.status !== 'success'}
                              onClick={() => void act(approveBudget(budget.id), `اعتُمدت الموازنة ${budget.name} — سطورها مجمدة الآن.`)}
                            >
                              اعتماد
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              onClick={() => void act(deleteDraftBudget(budget.id), `حُذفت مسودة «${budget.name}».`)}
                            >
                              حذف
                            </button>
                          </>
                        ) : (
                          <span className="muted small">مجمدة</span>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {canManage ? <CreateForm years={years.data ?? []} accounts={accounts.data ?? []} onDone={() => budgets.reload()} /> : null}

      {notice ? (
        <div className="card" role={notice.kind === 'ok' ? 'status' : 'alert'}>
          <p className="small m-0">{notice.text}</p>
        </div>
      ) : null}
    </Screen>
  );

  async function act(action: Promise<unknown>, message: string) {
    try {
      await action;
      setNotice({ kind: 'ok', text: message });
      budgets.reload();
    } catch (cause) {
      setNotice({ kind: 'danger', text: cause instanceof Error ? cause.message : String(cause) });
    }
  }
}

function CreateForm({
  years,
  accounts,
  onDone,
}: {
  years: FiscalYear[];
  accounts: Account[];
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [lines, setLines] = useState<Array<{ accountId: string; annualAmount: string }>>([{ accountId: '', annualAmount: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const postable = accounts.filter((account) => account.isPostable ?? account.is_postable ?? true);
  const preview = useMemo(
    () => (lines.length === 1 ? previewDistribution(lines[0]?.annualAmount ?? '', 12) : null),
    [lines],
  );

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    setOk('');
    try {
      const created = await createBudget({
        name: name.trim(),
        fiscalYearId,
        lines: lines.filter((line) => line.accountId && Number(line.annualAmount) > 0),
      });
      setOk(`أُنشئت موازنة «${created.name ?? name}» مسودةً — راجع توزيعها الشهري ثم اعتمدها.`);
      setName('');
      setLines([{ accountId: '', annualAmount: '' }]);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const complete = name.trim() && fiscalYearId && lines.some((line) => line.accountId && Number(line.annualAmount) > 0);

  return (
    <section className="card">
      <h2 className="m-0">موازنة جديدة</h2>
      <p className="muted small">
        المبلغ السنوي لكل حساب يُوزَّع على فترات السنة (قسط متساوٍ والفترة الأخيرة تحمل الباقي)؛ عدّل السطور شهريًا
        للموسمية قبل الاعتماد.
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <label className="small">
          الاسم
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="الخطة الأساسية" />
        </label>
        <label className="small">
          السنة المالية
          <select className="input" value={fiscalYearId} onChange={(event) => setFiscalYearId(event.target.value)}>
            <option value="">— اختر سنة —</option>
            {years.map((year) => (
              <option key={year.id} value={year.id}>
                {year.name ?? year.yearName ?? year.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>الحساب</th>
            <th className="num">المبلغ السنوي</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>
                <select
                  className="input"
                  value={line.accountId}
                  onChange={(event) => setLines((current) => current.map((row, i) => (i === index ? { ...row, accountId: event.target.value } : row)))}
                >
                  <option value="">— اختر حسابًا —</option>
                  {postable.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.nameAr ?? account.name_ar ?? ''}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="input"
                  inputMode="decimal"
                  value={line.annualAmount}
                  onChange={(event) => setLines((current) => current.map((row, i) => (i === index ? { ...row, annualAmount: event.target.value } : row)))}
                  placeholder="120000"
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setLines((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current))}
                  aria-label="احذف السطر"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn ghost sm" onClick={() => setLines((current) => [...current, { accountId: '', annualAmount: '' }])}>
          + حساب
        </button>
        <button type="button" className="btn" disabled={busy || !complete} onClick={() => void submit()}>
          {busy ? 'جارٍ الإنشاء…' : 'أنشئ المسودة'}
        </button>
        {ok ? <span className="small" role="status">{ok}</span> : null}
      </div>
      {preview ? (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          توزيع تقديري للسطر الأول: {preview[0]} شهريًا والأخير {preview[preview.length - 1]} — الرسمي ما يوزّعه الخادم.
        </p>
      ) : null}
      {error ? (
        <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', margin: '8px 0 0' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── مساعدات

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
