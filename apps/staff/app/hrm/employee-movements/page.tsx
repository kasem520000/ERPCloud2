'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { downloadCsv } from '../../../lib/accounts';
import { apiFetch } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 📈 حركات الموظف — `Form_WPF/frmEmpInvs.xaml` («مبيعات ومشتريات موظف خلال الفترة»).
 *
 * The window's filters are `👤 الموظف` («اختر الموظف...», with `الكل` beside it) ·
 * `🔄 نوع الحركة` (`مبيعات` · `مرتجع`, with `الكل` checked) · `📅 من تاريخ` ·
 * `📅 إلى تاريخ` · `🔍 عرض`, its grid is «📋 بيانات الحركات» — `نوع الحركة · 📅 التاريخ ·
 * رقم الفاتورة · 📦 الصنف · الكمية · 💵 السعر · إضافات · 💰 الإجمالي` — and its footer is
 * `💰 الإجمالي` (`txtSum`). `ShowResult` (L226) reads `Inv ⋈ Inv_Sub` on
 * `Inv.sales_emp` — the employee who made the sale — one row per line.
 *
 * The cloud carries that same link as `sales_invoices.salesman_id`, and its نقطة بيع
 * sales are `sales_invoices` with an `orderType`/shift, which is how the desktop's
 * `inv_type` 2 and 3 differ — hence «فاتورة نقطة بيع» and «فاتورة مرتجع نقطة بيع» in
 * `نوع الحركة`. The مشتريات half has no cloud counterpart: a purchase invoice carries no
 * employee at all, so nothing is invented here (§10 of `PHASE_08_HRM.md`).
 *
 * Two columns the window does not print are shown because the cloud is branch-first and
 * the footer has to be checkable: `الفرع` and the sale/return split behind `💰 الإجمالي`.
 */
type Row = {
  seq: number;
  movementType: string;
  date: string;
  invoiceId: string;
  number: string | null;
  itemName: string;
  quantity: string;
  unitPrice: string;
  additions: string;
  lineTotal: string;
  branchName: string | null;
  isReturn: boolean;
};

type Summary = { total: string; salesTotal: string; returnsTotal: string; invoices: number; lines: number };

type Employee = { id: string; employeeNo: string; name: string };
type Branch = { id: string; nameAr?: string; name?: string };

type Envelope = {
  employeeId: string | null;
  allEmployees: boolean;
  branchId: string | null;
  from: string;
  to: string;
  movementType: string;
  summary: Summary;
  rows: Row[];
};

type Filters = {
  employeeId: string;
  allEmployees: boolean;
  from: string;
  to: string;
  movementType: 'all' | 'sales' | 'returns';
  branchId: string;
};

const EMPTY: Summary = { total: '0', salesTotal: '0', returnsTotal: '0', invoices: 0, lines: 0 };

const today = () => new Date().toISOString().slice(0, 10);

function EmployeeMovements() {
  const search = useSearchParams();
  const employees = useQuery<Employee[]>(() => apiFetch<{ data: Employee[] }>('/hrm/employees').then((body) => body.data), []);
  const branches = useQuery<Branch[]>(() => apiFetch<{ data: Branch[] }>('/branches').then((body) => body.data), []);

  const [employeeId, setEmployeeId] = useState(search.get('employee') ?? '');
  const [allEmployees, setAllEmployees] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [movementType, setMovementType] = useState<'all' | 'sales' | 'returns'>('all');
  const [applied, setApplied] = useState<Filters>({
    employeeId: search.get('employee') ?? '',
    allEmployees: false,
    branchId: '',
    from: today(),
    to: today(),
    movementType: 'all',
  });

  const movements = useQuery<Envelope>(() => {
    if (!applied.employeeId && !applied.allEmployees) {
      return Promise.resolve({ employeeId: null, allEmployees: false, branchId: null, from: applied.from, to: applied.to, movementType: applied.movementType, summary: EMPTY, rows: [] });
    }
    const params = new URLSearchParams({ from: applied.from, to: applied.to, movement_type: applied.movementType });
    if (applied.employeeId) params.set('employee_id', applied.employeeId);
    if (applied.allEmployees) params.set('all_employees', '1');
    if (applied.branchId) params.set('branch_id', applied.branchId);
    return apiFetch<{ data: Envelope }>(`/hrm/employee-movements?${params.toString()}`).then((body) => body.data);
  }, [applied]);

  const rows = movements.data?.rows ?? [];
  const totals = movements.data?.summary ?? EMPTY;

  return (
    <Screen
      title="حركات الموظف"
      subtitle="📈 مبيعات ومشتريات موظف خلال الفترة — ما باعه الموظف، سطراً بسطر، من الفواتير المرحَّلة وحدها."
      crumbs={['الموظفين والرواتب', 'التقارير']}
      actions={
        <>
          <button className="btn" type="button" onClick={() => window.print()} disabled={rows.length === 0}>
            🖨️ طباعة
          </button>
          <button
            className="btn"
            type="button"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(
                `employee-movements-${applied.employeeId || 'all'}.csv`,
                ['م', 'نوع الحركة', 'التاريخ', 'رقم الفاتورة', 'الفرع', 'الصنف', 'الكمية', 'السعر', 'إضافات', 'الإجمالي'],
                rows.map((row) => [
                  row.seq,
                  row.movementType,
                  row.date,
                  row.number ?? '',
                  row.branchName ?? '',
                  row.itemName,
                  row.quantity,
                  row.unitPrice,
                  row.additions,
                  row.lineTotal,
                ]),
              )
            }
          >
            📊 تصدير CSV
          </button>
        </>
      }
    >
      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 240, flex: 1 }}>
            <span>👤 الموظف</span>
            <select
              className="input"
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              disabled={allEmployees}
            >
              <option value="">اختر الموظف...</option>
              {(employees.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.employeeNo} — {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={allEmployees} onChange={(event) => setAllEmployees(event.target.checked)} />
            الكل
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>🏢 الفرع</span>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr ?? branch.name ?? branch.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>📅 من تاريخ</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field" style={{ margin: 0, width: 160 }}>
            <span>📅 إلى تاريخ</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button
            className="btn primary"
            type="button"
            disabled={!employeeId && !allEmployees}
            onClick={() => setApplied({ employeeId, allEmployees, branchId, from, to, movementType })}
          >
            🔍 عرض
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <span className="group-label">🔄 نوع الحركة</span>
          <button type="button" className={`btn sm${movementType === 'all' ? ' primary' : ''}`} onClick={() => setMovementType('all')}>
            الكل
          </button>
          <button type="button" className={`btn sm${movementType === 'sales' ? ' primary' : ''}`} onClick={() => setMovementType('sales')}>
            مبيعات
          </button>
          <button type="button" className={`btn sm${movementType === 'returns' ? ' primary' : ''}`} onClick={() => setMovementType('returns')}>
            مرتجع
          </button>
        </div>
      </div>

      {!applied.employeeId && !applied.allEmployees && (
        <Empty title="اختر موظف" detail="«الكل» يعرض حركات كل موظف له مبيعات في الفترة." />
      )}
      {(applied.employeeId || applied.allEmployees) && movements.status === 'loading' && <Loading />}
      {(applied.employeeId || applied.allEmployees) && movements.status === 'forbidden' && <Forbidden />}
      {(applied.employeeId || applied.allEmployees) && movements.status === 'error' && (
        <ErrorBox message={movements.error} onRetry={movements.reload} />
      )}
      {(applied.employeeId || applied.allEmployees) && movements.status === 'success' && (
        <>
          <StatTiles>
            <StatTile label="💰 الإجمالي" value={money(totals.total)} tone="ok" hint="المبيعات − المرتجع" />
            <StatTile label="مبيعات" value={money(totals.salesTotal)} tone="brand" />
            <StatTile label="مرتجع" value={money(totals.returnsTotal)} />
            <StatTile label="عدد الفواتير" value={String(totals.invoices)} />
            <StatTile label="عدد الأسطر" value={String(totals.lines)} />
          </StatTiles>

          {rows.length === 0 ? (
            <Empty title="لا توجد حركات في هذه الفترة" detail="تأكد من التاريخين، أو أن فواتير الموظف مرحَّلة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>م</th>
                    <th>نوع الحركة</th>
                    <th>التاريخ</th>
                    <th>رقم الفاتورة</th>
                    <th>الفرع</th>
                    <th>الصنف</th>
                    <th className="num">الكمية</th>
                    <th className="num">السعر</th>
                    <th className="num">إضافات</th>
                    <th className="num">الإجمالي</th>
                    <th>👁️ عرض</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.invoiceId}-${row.seq}`}>
                      <td dir="ltr">{row.seq}</td>
                      <td>{row.movementType}</td>
                      <td dir="ltr">{row.date}</td>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td>{row.branchName ?? '—'}</td>
                      <td>{row.itemName}</td>
                      <td className="num">{money(row.quantity)}</td>
                      <td className="num">{money(row.unitPrice)}</td>
                      <td className="num">{money(row.additions)}</td>
                      <td className="num">{money(row.lineTotal)}</td>
                      <td>
                        <Link className="btn sm" href={`/sales/invoices/${row.invoiceId}`}>
                          👁️ عرض
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={9}>💰 الإجمالي</th>
                    <th className="num">{money(totals.total)}</th>
                    <th></th>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <EmployeeMovements />
    </Suspense>
  );
}
