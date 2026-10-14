'use client';

import { useMemo, useState } from 'react';

import { Directory } from '../../../components/directory';
import { ApiError, apiDelete, apiList, apiPost } from '../../../lib/api';
import { money, shortDate, statusLabel, today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Employee = { id: string; employeeNo: string; name: string };
type AdjustmentType = { id: string; code: string; name: string; kind: 'addition' | 'deduction' | string; sortOrder: number };
type CashLocation = { id: string; name: string; kind: 'safe' | 'bank' | string };
type Adjustment = {
  id: string;
  number: string | null;
  employeeId: string;
  employeeName: string | null;
  employeeNo: string | null;
  typeId: string | null;
  typeName: string | null;
  typeCode: string | null;
  typeKind: string | null;
  kind: 'addition' | 'deduction';
  componentCode: string;
  valueText: string;
  startsOn: string;
  endsOn: string | null;
  recurring: boolean;
  subFromSalary: boolean;
  paymentMethod: string | null;
  cashLocationId: string | null;
  cashLocationName: string | null;
  journalEntryId: string | null;
  status: string;
  reason: string | null;
};

export default function AdjustmentsPage() {
  const { can } = useSession();
  const adjustments = useQuery<Adjustment[]>(() => apiList<Adjustment>('/hrm/adjustments'), []);
  const employees = useQuery<Employee[]>(() => apiList<Employee>('/hrm/employees'), []);
  const types = useQuery<AdjustmentType[]>(() => apiList<AdjustmentType>('/hrm/adjustment-types'), []);
  const locations = useQuery<CashLocation[]>(() => apiList<CashLocation>('/cash-locations'), []);
  const [error, setError] = useState('');

  // «من» و«إلى» و«الموظف» — `BtnSearch_Click` narrows `LoadGrid` to one employee and one
  // date window; `chkAllEmp` («كل الموظفين») is the empty choice.
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const rows = useMemo(() => {
    const list = adjustments.data ?? [];
    return list.filter((row) => {
      if (filterEmployee && row.employeeId !== filterEmployee) return false;
      if (filterType && row.typeCode !== filterType) return false;
      if (filterFrom && row.startsOn < filterFrom) return false;
      if (filterTo && row.startsOn > filterTo) return false;
      return true;
    });
  }, [adjustments.data, filterEmployee, filterType, filterFrom, filterTo]);

  // `Directory` renders `query.data`; this screen shows a filtered slice of the same
  // request, so it hands the filtered rows over while keeping the original status.
  const view = { ...adjustments, data: rows };
  const typeRows = types.data ?? [];
  const manage = can('hrm.manage');

  const totals = rows.reduce(
    (sum, row) => ({
      additions: sum.additions + (row.kind === 'addition' ? Number(row.valueText || 0) : 0),
      deductions: sum.deductions + (row.kind === 'deduction' ? Number(row.valueText || 0) : 0),
    }),
    { additions: 0, deductions: 0 },
  );

  async function approve(id: string) {
    setError('');
    try {
      await apiPost(`/hrm/adjustments/${id}/approve`, {});
      adjustments.reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : String(problem));
    }
  }

  return (
    <Directory<Adjustment>
      title="الحوافز والجزاءات"
      subtitle="إدخال الحوافز والخصومات للموظفين — ما يُصرف الآن يُقيَّد على الصندوق، وما يخصم من الراتب ينتظر مسير الرواتب."
      crumbs={['الموظفين والرواتب', 'العمليات']}
      query={view}
      canCreate={manage && (employees.data ?? []).length > 0 && typeRows.length > 0}
      createLabel="حركة جديدة"
      formTitle="إدخال الحوافز والخصومات للموظفين"
      blocked={
        (employees.data ?? []).length === 0
          ? 'أضف موظفاً واحداً على الأقل أولاً.'
          : typeRows.length === 0
            ? 'لا توجد أنواع حركات — أضف «مكافأة» و«خصم» و«سلفة» من تعاريف الرواتب.'
            : undefined
      }
      fields={[
        {
          name: 'employeeId',
          label: 'الموظف',
          type: 'select',
          required: true,
          options: (employees.data ?? []).map((row) => ({ id: row.id, label: `${row.employeeNo} — ${row.name}` })),
        },
        {
          name: 'typeId',
          label: 'نوع الإجراء',
          type: 'select',
          required: true,
          options: typeRows.map((row) => ({ id: row.id, label: row.name })),
        },
        { name: 'valueText', label: 'المبلغ', type: 'number', required: true },
        { name: 'startsOn', label: 'التاريخ', type: 'date', required: true },
        {
          name: 'subFromSalary',
          label: 'تخصم من الراتب',
          type: 'checkbox',
          hint: 'المكافأة إن لم تُخصم من الراتب تُصرف نقداً أو بشيك؛ والخصم والسلفة يُصرفان للموظف ويُردّان من راتبه.',
        },
        {
          name: 'paymentMethod',
          label: 'طريقة الدفع',
          type: 'select',
          options: [
            { id: 'cash', label: 'نقدي' },
            { id: 'bank', label: 'بنكي' },
          ],
        },
        {
          name: 'cashLocationId',
          label: 'الصندوق أو البنك',
          type: 'select',
          hint: 'يُطلب عند الصرف الآن — «يجب اختيار الصندوق أو البنك».',
          options: (locations.data ?? []).map((row) => ({
            id: row.id,
            label: row.kind === 'bank' ? `${row.name} (بنك)` : row.name,
          })),
        },
        { name: 'endsOn', label: 'ينتهي في', type: 'date' },
        { name: 'recurring', label: 'متكرر شهرياً', type: 'checkbox' },
        { name: 'reason', label: 'ملاحظات', wide: true, placeholder: 'تُكتب تلقائياً إن تُرکت فارغة: «مكافأة للموظف …»' },
      ]}
      initial={{ startsOn: today(), typeId: '', subFromSalary: true, paymentMethod: 'cash' }}
      onCreate={(values) => {
        const type = typeRows.find((row) => row.id === String(values.typeId));
        const subFromSalary = Boolean(values.subFromSalary);
        return apiPost('/hrm/adjustments', {
          employeeId: String(values.employeeId),
          typeId: String(values.typeId),
          valueText: String(values.valueText).trim(),
          startsOn: String(values.startsOn),
          endsOn: String(values.endsOn) || undefined,
          recurring: Boolean(values.recurring),
          subFromSalary,
          paymentMethod: subFromSalary ? undefined : String(values.paymentMethod || 'cash'),
          cashLocationId: subFromSalary ? undefined : String(values.cashLocationId) || undefined,
          reason: String(values.reason).trim() || undefined,
          // `kind` follows the type («مكافأة» إضافة، «خصم» و«سلفة» خصمان) unless the
          // clerk overrides it explicitly.
          kind: type ? (type.kind === 'deduction' ? 'deduction' : 'addition') : undefined,
        });
      }}
      successText={() => 'تم تسجيل الحركة؛ إن كانت من الراتب فهي مسودة حتى تُعتمد.'}
      rowKey={(row) => row.id}
      empty="لا توجد حركات"
      emptyDetail="سجّل أول مكافأة أو خصم أو سلفة من زر «حركة جديدة»."
      onDelete={
        manage
          ? (row) => apiDelete(`/hrm/adjustments/${row.id}`)
          : undefined
      }
      deleteLabel="حذف"
      confirmDelete={(row) => `⚠️ هل أنت متأكد من الحذف؟\nسند رقم ${row.number ?? '—'} للموظف ${row.employeeName ?? ''}`}
      rowLabel={(row) => `السند ${row.number ?? ''}`}
      tiles={[
        { label: 'عدد الحركات', value: String(rows.length), hint: 'بعد البحث' },
        { label: 'إجمالي الإضافات', value: money(String(totals.additions)), tone: 'ok' as const },
        { label: 'إجمالي الخصومات', value: money(String(totals.deductions)), tone: 'danger' as const },
      ]}
      toolbar={
        <div className="row wrap">
          {error ? <span className="alert danger">{error}</span> : null}
          <label className="field inline">
            <span>الموظف</span>
            <select value={filterEmployee} onChange={(event) => setFilterEmployee(event.target.value)}>
              <option value="">كل الموظفين</option>
              {(employees.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.employeeNo} — {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>النوع</span>
            <select value={filterType} onChange={(event) => setFilterType(event.target.value)}>
              <option value="">كل الأنواع</option>
              {typeRows.map((row) => (
                <option key={row.id} value={row.code}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>من</span>
            <input type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} dir="ltr" />
          </label>
          <label className="field inline">
            <span>إلى</span>
            <input type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} dir="ltr" />
          </label>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFilterEmployee('');
              setFilterType('');
              setFilterFrom('');
              setFilterTo('');
            }}
          >
            عرض الكل
          </button>
        </div>
      }
      columns={[
        { key: 'number', header: 'رقم السند', align: 'ltr', cell: (row) => row.number ?? '—' },
        {
          key: 'employee',
          header: 'الموظف',
          cell: (row) => row.employeeName ?? (employees.data ?? []).find((entry) => entry.id === row.employeeId)?.name ?? row.employeeId,
        },
        { key: 'employeeNo', header: 'رقم الموظف', align: 'ltr', cell: (row) => row.employeeNo ?? '—' },
        { key: 'type', header: 'النوع', cell: (row) => row.typeName ?? row.componentCode },
        { key: 'value', header: 'المبلغ', align: 'num', cell: (row) => money(row.valueText) },
        { key: 'startsOn', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.startsOn) },
        {
          key: 'subFromSalary',
          header: 'تضاف على الراتب',
          cell: (row) =>
            row.kind === 'addition'
              ? row.subFromSalary
                ? '✅ تضاف على الراتب'
                : 'نقداً'
              : row.subFromSalary
                ? '✂️ تخصم من الراتب'
                : 'نقداً',
        },
        {
          key: 'paymentMethod',
          header: 'طريقة الدفع',
          cell: (row) => (row.subFromSalary ? '—' : row.paymentMethod === 'bank' ? 'بنكي' : row.paymentMethod === 'cash' ? 'نقدي' : '—'),
        },
        { key: 'cash', header: 'الصندوق / البنك', cell: (row) => row.cashLocationName ?? '—' },
        { key: 'reason', header: 'ملاحظات', cell: (row) => row.reason ?? '—' },
        { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
        {
          key: 'actions',
          header: '',
          cell: (row) => (
            <span className="row">
              {row.status === 'draft' && can('hrm.adjust.approve') ? (
                <button className="btn sm primary" type="button" onClick={() => approve(row.id)}>
                  اعتماد
                </button>
              ) : null}
              {row.journalEntryId ? <span className="muted small">له قيد</span> : null}
            </span>
          ),
        },
      ]}
    />
  );
}
