'use client';

import { useMemo, useState } from 'react';

import { Directory } from '../../../components/directory';
import { apiDelete, apiList, apiPost } from '../../../lib/api';
import { money, shortDate, today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Employee = { id: string; employeeNo: string; name: string; branchId?: string | null };
type Branch = { id: string; nameAr?: string; name?: string };
type CashLocation = { id: string; name: string; kind: 'safe' | 'bank' | string };
type Run = { id: string; yearMonth: string; status: string };
type SalaryPayment = {
  id: string;
  number: string;
  employeeId: string;
  employeeName: string | null;
  employeeNo: string | null;
  branchId: string | null;
  branchName: string | null;
  runId: string | null;
  yearMonth: string;
  month: string;
  year: string;
  paymentDate: string;
  method: string;
  cashLocationId: string | null;
  cashLocationName: string | null;
  responsibleEmployeeId: string | null;
  responsibleName: string | null;
  basic: string;
  housing: string;
  transport: string;
  otherAllowances: string;
  additions: string;
  deductions: string;
  net: string;
  notes: string | null;
  voucherId: string | null;
  voucherNumber: string | null;
  voucherStatus: string | null;
  journalEntryId: string | null;
};

const currentMonth = () => new Date().toISOString().slice(0, 7);
const ARABIC_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthLabel = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-');
  const name = ARABIC_MONTHS[Number(month) - 1] ?? month;
  return `${name} ${year}`;
};

export default function SalaryPaymentsPage() {
  const { can } = useSession();
  const payments = useQuery<SalaryPayment[]>(() => apiList<SalaryPayment>('/hrm/salary-payments'), []);
  const employees = useQuery<Employee[]>(() => apiList<Employee>('/hrm/employees'), []);
  const branches = useQuery<Branch[]>(() => apiList<Branch>('/branches'), []);
  const locations = useQuery<CashLocation[]>(() => apiList<CashLocation>('/cash-locations'), []);
  const runs = useQuery<Run[]>(() => apiList<Run>('/hrm/payroll/runs'), []);
  // «🔍 البحث» — by «رقم الإذن», by «الموظف», and by `من تاريخ`/`إلى تاريخ` unless
  // «كل الفترة» is on.
  const [filterNumber, setFilterNumber] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const rows = useMemo(() => {
    const list = payments.data ?? [];
    return list.filter((row) => {
      if (filterNumber && row.number !== filterNumber.trim()) return false;
      if (filterEmployee && row.employeeId !== filterEmployee) return false;
      if (filterMonth && row.yearMonth !== filterMonth) return false;
      if (filterMethod && row.method !== filterMethod) return false;
      if (filterFrom && row.paymentDate < filterFrom) return false;
      if (filterTo && row.paymentDate > filterTo) return false;
      return true;
    });
  }, [payments.data, filterNumber, filterEmployee, filterMonth, filterMethod, filterFrom, filterTo]);

  // `Directory` renders `query.data`; this screen shows a filtered slice of the same
  // request, so it hands the filtered rows over while keeping the original status.
  const view = { ...payments, data: rows };
  const manage = can('hrm.payroll.post');
  const employeeRows = employees.data ?? [];
  const branchRows = branches.data ?? [];
  const locationRows = locations.data ?? [];
  const runRows = runs.data ?? [];

  // «إجمالي المصروف» of what the search found — `money()` formats the string the API
  // returns, so nothing here rounds twice.
  const paidSum = (list: SalaryPayment[]) => list.reduce((sum, row) => sum + Number(row.net || 0), 0).toFixed(2);

  return (
    <Directory<SalaryPayment>
      title="دفع الرواتب"
      subtitle="إذن صرف راتب لكل موظف عن كل شهر — «لقد تم دفع راتب الموظف سابقاً» يحرس التكرار، والمبلغ هو صافي مسيّر الشهر."
      crumbs={['الموظفين والرواتب', 'العمليات']}
      query={view}
      canCreate={manage && employeeRows.length > 0 && locationRows.length > 0 && branchRows.length > 0}
      createLabel="إذن صرف جديد"
      formTitle="💰 دفع الرواتب"
      blocked={
        employeeRows.length === 0
          ? 'أضف موظفاً واحداً على الأقل أولاً.'
          : branchRows.length === 0
            ? 'أنشئ فرعاً واحداً على الأقل أولاً.'
            : locationRows.length === 0
              ? 'أنشئ صندوقاً أو بنكاً أولاً — «يجب اختيار الصندوق».'
              : undefined
      }
      fields={[
        {
          name: 'employeeId',
          label: 'الموظف',
          type: 'select',
          required: true,
          options: employeeRows.map((row) => ({ id: row.id, label: `${row.employeeNo} — ${row.name}` })),
        },
        {
          name: 'branchId',
          label: 'الفرع',
          type: 'select',
          required: true,
          hint: 'يُملأ تلقائياً من فرع الموظف.',
          options: branchRows.map((row) => ({ id: row.id, label: row.nameAr ?? row.name ?? row.id })),
        },
        {
          name: 'yearMonth',
          label: 'الشهر',
          type: 'text',
          required: true,
          ltr: true,
          placeholder: currentMonth(),
          hint: 'الشهر والسنة بصيغة YYYY-MM — هما صندوقا «الشهر» و«السنة» في الديسكتوب.',
        },
        { name: 'paymentDate', label: 'تاريخ الإدخال', type: 'date', required: true },
        {
          name: 'method',
          label: 'طريقة الدفع',
          type: 'select',
          options: [
            { id: 'cash', label: 'نقدي' },
            { id: 'bank', label: 'تحويل بنكي' },
          ],
        },
        {
          name: 'cashLocationId',
          label: 'الصندوق/البنك',
          type: 'select',
          required: true,
          options: locationRows.map((row) => ({
            id: row.id,
            label: row.kind === 'bank' ? `${row.name} (بنك)` : row.name,
          })),
        },
        {
          name: 'runId',
          label: 'يصرف من مسيّر',
          type: 'select',
          hint: '📊 عرض الراتب — يُصرف ما في سطر الموظف من مسيّر الشهر؛ وإن تُرك فارغاً حُسب من بطاقة الموظف والحوافز المعتمدة.',
          options: runRows.map((row) => ({ id: row.id, label: `${monthLabel(row.yearMonth)} — ${row.status}` })),
        },
        {
          name: 'responsibleEmployeeId',
          label: 'اسم الموظف المسؤول',
          type: 'select',
          options: employeeRows.map((row) => ({ id: row.id, label: row.name })),
        },
        { name: 'notes', label: 'ملاحظات', wide: true },
      ]}
      initial={{ yearMonth: currentMonth(), paymentDate: today(), method: 'cash', branchId: '', employeeId: '' }}
      onCreate={(values) =>
        apiPost('/hrm/salary-payments', {
          employeeId: String(values.employeeId),
          // الفرع defaults to the employee's own branch — «يجب اختيار الفرع» is about an
          // إذن with no branch at all, not about making the clerk pick it twice.
          branchId: String(values.branchId) || employeeRows.find((row) => row.id === String(values.employeeId))?.branchId || undefined,
          yearMonth: String(values.yearMonth).trim(),
          paymentDate: String(values.paymentDate),
          method: String(values.method || 'cash'),
          cashLocationId: String(values.cashLocationId),
          runId: String(values.runId) || undefined,
          responsibleEmployeeId: String(values.responsibleEmployeeId) || undefined,
          notes: String(values.notes).trim() || undefined,
        })
      }
      successText={() => 'تم حفظ الإذن وصُرفت قيمته سندَ صرفٍ مرحَّل.'}
      rowKey={(row) => row.id}
      empty="لا توجد إذونات صرف"
      emptyDetail="سجّل أول إذن صرف راتب من زر «إذن صرف جديد»."
      onDelete={manage ? (row) => apiDelete(`/hrm/salary-payments/${row.id}`) : undefined}
      deleteLabel="حذف"
      confirmDelete={(row) => `⚠️ هل أنت متأكد من الحذف؟\nإذن صرف رقم ${row.number} للموظف ${row.employeeName ?? ''}`}
      rowLabel={(row) => `الإذن ${row.number}`}
      tiles={[
        { label: 'عدد الإذونات', value: String(rows.length), hint: 'بعد البحث' },
        { label: 'إجمالي المصروف', value: money(paidSum(rows)), tone: 'ok' as const },
      ]}
      toolbar={
        <div className="row wrap">
          <label className="field inline">
            <span>رقم الإذن</span>
            <input className="input sm" dir="ltr" value={filterNumber} onChange={(event) => setFilterNumber(event.target.value)} />
          </label>
          <label className="field inline">
            <span>الموظف</span>
            <select value={filterEmployee} onChange={(event) => setFilterEmployee(event.target.value)}>
              <option value="">كل الموظفين</option>
              {employeeRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.employeeNo} — {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>الشهر</span>
            <input className="input sm" dir="ltr" placeholder={currentMonth()} value={filterMonth} onChange={(event) => setFilterMonth(event.target.value)} />
          </label>
          <label className="field inline">
            <span>طريقة الدفع</span>
            <select value={filterMethod} onChange={(event) => setFilterMethod(event.target.value)}>
              <option value="">الكل</option>
              <option value="cash">نقدي</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </label>
          <label className="field inline">
            <span>من تاريخ</span>
            <input type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} dir="ltr" />
          </label>
          <label className="field inline">
            <span>إلى تاريخ</span>
            <input type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} dir="ltr" />
          </label>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFilterNumber('');
              setFilterEmployee('');
              setFilterMonth('');
              setFilterMethod('');
              setFilterFrom('');
              setFilterTo('');
            }}
          >
            كل الفترة
          </button>
        </div>
      }
      columns={[
        { key: 'number', header: 'رقم الإذن', align: 'ltr', cell: (row) => row.number },
        { key: 'employee', header: '👤 الموظف', cell: (row) => row.employeeName ?? row.employeeId },
        { key: 'month', header: 'الشهر', cell: (row) => monthLabel(row.yearMonth) },
        {
          key: 'amounts',
          header: 'الراتب الأساسي · بدل سكن · بدل مواصلات',
          align: 'num',
          cell: (row) => `${money(row.basic)} · ${money(row.housing)} · ${money(row.transport)}`,
        },
        { key: 'additions', header: '💰 الحوافز', align: 'num', cell: (row) => money(row.additions) },
        { key: 'deductions', header: '🔴 الخصومات', align: 'num', cell: (row) => money(row.deductions) },
        { key: 'net', header: '💵 الصافي', align: 'num', cell: (row) => money(row.net) },
        { key: 'date', header: '📅 التاريخ', align: 'ltr', cell: (row) => shortDate(row.paymentDate) },
        {
          key: 'method',
          header: 'طريقة الدفع',
          cell: (row) => (row.method === 'bank_transfer' ? 'تحويل بنكي' : 'نقدي'),
        },
        { key: 'cash', header: 'الصندوق/البنك', cell: (row) => row.cashLocationName ?? '—' },
        { key: 'responsible', header: 'المستخدم', cell: (row) => row.responsibleName ?? '—' },
        { key: 'notes', header: 'ملاحظات', cell: (row) => row.notes ?? '—' },
        {
          key: 'voucher',
          header: 'سند الصرف',
          cell: (row) => (row.voucherNumber ? <span className="badge">{row.voucherNumber}</span> : '—'),
        },
      ]}
      footer={(list) => [
        <strong key="count">{list.length} إذن</strong>,
        <span key="label">إجمالي المصروف</span>,
        <strong key="sum">{money(paidSum(list))}</strong>,
      ]}
    />
  );
}
