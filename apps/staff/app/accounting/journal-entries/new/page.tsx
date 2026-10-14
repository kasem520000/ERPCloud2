'use client';

import { Decimal } from 'decimal.js';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../../lib/api';
import { nameOf, postableOf, type Account } from '../../../../lib/accounts';
import { money } from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

/**
 * 📒 إنشاء قيد يومية — `Form_WPF/FrmNewEntry.xaml` («إنشاء قيد يومية»).
 *
 * The card above the grid is laid out exactly as the window lays it out:
 * `رقم القيد` (read-only, allocated by `LoadResNo` on save) · `📅 التاريخ` · `⏰ الوقت`
 * · `🔑 الرقم العام` (read-only) · `✅ قيد ضريبي` · `📝 الملاحظة`. The grid is
 * `📋 تفاصيل القيد` with the window's own columns
 * `# · رمز الحساب · اسم الحساب · مدين · دائن · مركز تكلفة · الشرح · المندوب · 🗑️ حذف`,
 * `الفرق=` in its header — gold, and green only when the two sides are equal
 * (`.xaml.cs` L1236–L1246) — and `مجموع المدين:` / `مجموع الدائن:` in its footer.
 *
 * `⏰ الوقت` is the one field that changes the data model: the desktop stores a
 * *timestamp*, so two entries written on the same day keep the order they were written
 * in, and حركة الصندوق filters by date and time. The cloud stored a date alone.
 *
 * The save-time refusals are the window's own, in its own words (`Save()` L694–L741):
 * no rows, a row with no account, a row with no value on either side, and an unbalanced
 * entry. `رقم القيد` and `🔑 الرقم العام` are read-only because both are allocated by
 * the server when the entry is posted — which is also when it stops being editable.
 */
type Branch = { id: string; code?: string; nameAr?: string; name_ar?: string; nameEn?: string };
type Period = { id: string; code?: string; name?: string; status?: string };
type CostCenter = { id: string; code?: string; nameAr?: string; name_ar?: string };
type Employee = { id: string; employeeNo?: string; name?: string };

type Line = {
  key: number;
  /** What the clerk typed into `رمز الحساب`; the id is resolved from it. */
  code: string;
  accountId: string;
  debit: string;
  credit: string;
  costCenterId: string;
  salesmanId: string;
  description: string;
};

const emptyLine = (key: number): Line => ({
  key,
  code: '',
  accountId: '',
  debit: '0.00',
  credit: '0.00',
  costCenterId: '',
  salesmanId: '',
  description: '',
});

function decimal(value: string): Decimal {
  try {
    return new Decimal(value || '0');
  } catch {
    return new Decimal(0);
  }
}

/** The window fills `⏰ الوقت` with the clock at the moment the window opens. */
function nowTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

function JournalEntryForm() {
  const { can } = useSession();
  const search = useSearchParams();
  const isOpening = search?.get('kind') === 'opening';

  const accounts = useQuery<Account[]>(() => apiData<Account[]>('/accounts'), []);
  const branches = useQuery<Branch[]>(() => apiData<Branch[]>('/branches'), []);
  const periods = useQuery<Period[]>(() => apiData<Period[]>('/fiscal-periods'), []);
  const costCenters = useQuery<CostCenter[]>(() => apiData<CostCenter[]>('/cost-centers').catch(() => [] as CostCenter[]), []);
  // المندوب comes from HRM; a tenant without it simply gets no names to choose from.
  const employees = useQuery<Employee[]>(() => apiData<Employee[]>('/employees').catch(() => [] as Employee[]), []);

  const [branchId, setBranchId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState(nowTime);
  const [isVat, setIsVat] = useState(false);
  const [description, setDescription] = useState(isOpening ? 'قيد افتتاحي' : '');
  const [lines, setLines] = useState<Line[]>([emptyLine(1), emptyLine(2)]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  /** `رقم القيد` و`🔑 الرقم العام` — allocated by the server, shown once it answers. */
  const [posted, setPosted] = useState<{ number?: string; id?: string } | undefined>();

  const byCode = useMemo(() => new Map((accounts.data ?? []).map((account) => [account.code, account])), [accounts.data]);
  const postable = useMemo(() => (accounts.data ?? []).filter(postableOf), [accounts.data]);
  const openPeriods = useMemo(
    () => (periods.data ?? []).filter((period) => (period.status ?? 'open') === 'open'),
    [periods.data],
  );

  const totals = useMemo(() => {
    const debit = lines.reduce((sum, line) => sum.plus(decimal(line.debit)), new Decimal(0));
    const credit = lines.reduce((sum, line) => sum.plus(decimal(line.credit)), new Decimal(0));
    return { debit, credit, difference: debit.minus(credit).abs() };
  }, [lines]);

  const balanced = totals.debit.minus(totals.credit).isZero() && totals.debit.greaterThan(0);

  /** رمز الحساب resolves to an account: exact first, then a unique prefix. */
  function resolve(code: string): Account | undefined {
    const needle = code.trim();
    if (!needle) return undefined;
    const exact = byCode.get(needle);
    if (exact) return exact;
    const prefixed = postable.filter((account) => account.code.startsWith(needle));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  /** The window refuses named refusals; each of these is its own sentence. */
  function refusal(): string | undefined {
    const entered = lines.filter((line) => line.code.trim() || line.accountId);
    if (entered.length === 0) return 'لا يوجد بيانات';
    const nameless = entered.findIndex((line) => !(line.accountId || resolve(line.code.trim())));
    if (nameless >= 0) return 'يجب إدخال اسم ورقم الحساب';
    const valueless = entered.findIndex((line) => decimal(line.debit).isZero() && decimal(line.credit).isZero());
    if (valueless >= 0) return `يوجد بند رقم ${valueless + 1} بدون قيمة، يجب إدخال القيمة أو حذفه`;
    if (!balanced) return 'لا يمكن حفظ قيد غير متوازن';
    return undefined;
  }

  function patch(key: number, changes: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine(Math.max(0, ...current.map((line) => line.key)) + 1)]);
  }

  function removeLine(key: number) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  function reset() {
    setLines([emptyLine(1), emptyLine(2)]);
    setDescription(isOpening ? 'قيد افتتاحي' : '');
    setTime(nowTime());
    setIsVat(false);
    setPosted(undefined);
    setResult(undefined);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setResult(undefined);
    const refused = refusal();
    if (refused) {
      setResult({ kind: 'danger', text: refused });
      return;
    }
    // The window asks before it posts, and so does this one: a posted entry is not edited.
    if (!window.confirm('هل أنت متأكد من حفظ القيد؟')) return;
    setBusy(true);
    try {
      const payload = {
        branchId,
        fiscalPeriodId: periodId,
        date,
        time,
        isVat,
        description: description.trim() || undefined,
        lines: lines
          .filter((line) => resolve(line.code.trim()) || line.accountId)
          .map((line) => {
            const account = resolve(line.code.trim());
            return {
              accountId: line.accountId || account?.id,
              debit: decimal(line.debit).toFixed(2),
              credit: decimal(line.credit).toFixed(2),
              costCenterId: line.costCenterId || undefined,
              salesmanId: line.salesmanId || undefined,
              description: line.description.trim() || undefined,
            };
          }),
      };
      const created = await apiPost<{ id?: string; number?: string }>('/journal-entries', payload, {
        idempotencyKey: `je-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      setPosted({ number: created?.number, id: created?.id });
      setResult({ kind: 'ok', text: `تم حفظ القيد بنجاح — رقم ${created?.number ?? ''}` });
      setLines([emptyLine(1), emptyLine(2)]);
      setDescription(isOpening ? 'قيد افتتاحي' : '');
      setTime(nowTime());
      setIsVat(false);
    } catch (error) {
      setResult({
        kind: 'danger',
        text:
          error instanceof ApiError
            ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}`
            : 'تعذر حفظ القيد.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!can('accounting.journal.post')) return <Forbidden />;
  if (accounts.status === 'loading' || branches.status === 'loading' || periods.status === 'loading') return <Loading rows={6} />;
  if (accounts.status === 'forbidden') return <Forbidden />;
  if (accounts.status === 'error') return <ErrorBox message={accounts.error} onRetry={accounts.reload} />;

  const blocked = Boolean(refusal());

  return (
    <Screen
      title={isOpening ? 'قيد إفتتاحي' : '📒 إنشاء قيد يومية'}
      subtitle="القيد المزدوج: كل سطر إما مدين أو دائن، والمجموعان يجب أن يتساويا قبل الترحيل."
      crumbs={['المحاسبة', 'العمليات']}
      actions={
        <button className="btn" type="button" onClick={() => window.print()}>
          🖨️ طباعة
        </button>
      }
    >
      <form className="grid" onSubmit={submit}>
        <section className="card">
          <div className="form-grid">
            <label className="field">
              <span>الفرع *</span>
              <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)} required>
                <option value="">— اختر الفرع</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code ? `${branch.code} — ` : ''}
                    {branch.nameAr ?? branch.name_ar ?? branch.nameEn ?? branch.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>الفترة المحاسبية *</span>
              <select className="input" value={periodId} onChange={(event) => setPeriodId(event.target.value)} required>
                <option value="">— اختر الفترة</option>
                {openPeriods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.code ?? period.name ?? period.id}
                  </option>
                ))}
              </select>
            </label>
            {/* رقم القيد — `FrmNewEntry` allocates it on save, so it is read-only here. */}
            <label className="field">
              <span>رقم القيد</span>
              <input className="input" dir="ltr" value={posted?.number ?? ''} readOnly placeholder="يُولَّد عند الحفظ" />
            </label>
            <label className="field">
              <span>📅 التاريخ *</span>
              <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </label>
            <label className="field">
              <span>⏰ الوقت</span>
              <input className="input" type="time" dir="ltr" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
            <label className="field">
              <span>🔑 الرقم العام</span>
              <input className="input" dir="ltr" value={posted?.id ?? ''} readOnly placeholder="يُولَّد عند الحفظ" />
            </label>
            <label className="check" style={{ alignSelf: 'end', marginBottom: 10 }}>
              <input type="checkbox" checked={isVat} onChange={(event) => setIsVat(event.target.checked)} />
              ✅ قيد ضريبي
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>📝 الملاحظة</span>
              <input
                className="input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="سند قيد يومية رقم: … بتاريخ …"
              />
            </label>
          </div>
          {openPeriods.length === 0 && (
            <p className="alert warn">لا توجد فترة محاسبية مفتوحة. افتح فترة من شاشة «الفترات المحاسبية» أولاً.</p>
          )}
        </section>

        <section className="card tight">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>📋 تفاصيل القيد</h2>
            {/* الفرق= — gold, and only green when the two sides are equal. */}
            <span className="row" style={{ gap: 4 }}>
              <span className="diff-label" style={{ color: balanced ? 'var(--ok)' : '#e2543a' }}>
                الفرق=
              </span>
              <span className="diff-value" style={{ color: balanced ? 'var(--ok)' : '#e2543a' }} dir="ltr">
                {money(totals.difference.toFixed(2))}
              </span>
            </span>
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 46 }}>#</th>
                  <th style={{ minWidth: 130 }}>رمز الحساب</th>
                  <th style={{ minWidth: 200 }}>اسم الحساب</th>
                  <th style={{ minWidth: 110 }} className="num">مدين</th>
                  <th style={{ minWidth: 110 }} className="num">دائن</th>
                  <th style={{ minWidth: 150 }}>مركز تكلفة</th>
                  <th style={{ minWidth: 180 }}>الشرح</th>
                  <th style={{ minWidth: 140 }}>المندوب</th>
                  <th style={{ width: 64 }}>🗑️ حذف</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const account = line.accountId
                    ? postable.find((entry) => entry.id === line.accountId)
                    : resolve(line.code.trim());
                  return (
                    <tr key={line.key}>
                      <td dir="ltr">{index + 1}</td>
                      <td>
                        <input
                          className="input"
                          dir="ltr"
                          list="account-codes"
                          value={line.code}
                          placeholder="1101"
                          onChange={(event) =>
                            patch(line.key, { code: event.target.value, accountId: resolve(event.target.value)?.id ?? '' })
                          }
                          onBlur={(event) => {
                            const found = resolve(event.target.value.trim());
                            if (found) patch(line.key, { code: found.code, accountId: found.id });
                          }}
                        />
                      </td>
                      <td className={account ? undefined : 'muted'}>
                        {account ? nameOf(account) : line.code ? '— غير موجود —' : '—'}
                      </td>
                      <td>
                        <input
                          className="input"
                          inputMode="decimal"
                          dir="ltr"
                          value={line.debit}
                          onChange={(event) => patch(line.key, { debit: event.target.value, credit: '0.00' })}
                          onBlur={(event) => patch(line.key, { debit: decimal(event.target.value).toFixed(2) })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          inputMode="decimal"
                          dir="ltr"
                          value={line.credit}
                          onChange={(event) => patch(line.key, { credit: event.target.value, debit: '0.00' })}
                          onBlur={(event) => patch(line.key, { credit: decimal(event.target.value).toFixed(2) })}
                        />
                      </td>
                      <td>
                        <select
                          className="input"
                          value={line.costCenterId}
                          onChange={(event) => patch(line.key, { costCenterId: event.target.value })}
                        >
                          <option value="">—</option>
                          {(costCenters.data ?? []).map((center) => (
                            <option key={center.id} value={center.id}>
                              {center.code ? `${center.code} — ` : ''}
                              {center.nameAr ?? center.name_ar ?? center.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="input"
                          value={line.description}
                          onChange={(event) => patch(line.key, { description: event.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          className="input"
                          value={line.salesmanId}
                          onChange={(event) => patch(line.key, { salesmanId: event.target.value })}
                        >
                          <option value="">—</option>
                          {(employees.data ?? []).map((employee) => (
                            <option key={employee.id} value={employee.id}>
                              {employee.employeeNo ? `${employee.employeeNo} — ` : ''}
                              {employee.name ?? employee.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          className="btn sm danger"
                          type="button"
                          onClick={() => removeLine(line.key)}
                          aria-label="حذف السطر"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>
                    <span className="row" style={{ gap: 12, justifyContent: 'flex-start' }}>
                      <span>مجموع المدين:</span>
                      <span dir="ltr">{money(totals.debit.toFixed(2))}</span>
                      <span>مجموع الدائن:</span>
                      <span dir="ltr">{money(totals.credit.toFixed(2))}</span>
                    </span>
                  </th>
                  <th className="num">{money(totals.debit.toFixed(2))}</th>
                  <th className="num">{money(totals.credit.toFixed(2))}</th>
                  <th colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
          <datalist id="account-codes">
            {postable.map((account) => (
              <option key={account.id} value={account.code}>
                {account.code} — {nameOf(account)}
              </option>
            ))}
          </datalist>
          <div className="toolbar">
            <button className="btn sm" type="button" onClick={addLine}>
              + سطر
            </button>
          </div>
        </section>

        {result && <p className={`alert ${result.kind}`}>{result.text}</p>}

        <div className="toolbar">
          <button className="btn primary" type="submit" disabled={busy || blocked || !branchId || !periodId}>
            💾 حفظ
          </button>
          <button className="btn" type="button" onClick={reset} disabled={busy}>
            ➕ جديد
          </button>
        </div>
      </form>
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <JournalEntryForm />
    </Suspense>
  );
}
