'use client';

import Link from 'next/link';

import { Directory } from '../../../components/directory';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { listEmployees, type Employee } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🧑‍💼 شاشة المندوبين — `Form_WPF/frmSalesMen.xaml` («شاشة المندوبين»).
 *
 * Two tabs in the desktop, and this screen keeps both: the card («🧑‍💼 بيانات
 * المندوبين») is the form below, and the search («🔍 البحث») is the grid.
 * `btnSave_Click` L155 writes
 * `salesmen(name, comm, tel, mobile, email, notes, IS_Deleted, Profit_Comm, Colle_Comm)`,
 * and the grid's columns are `الرقم · 🧑‍💼 اسم المندوب · عمولة المبيعات ·
 * 📧 البريد الإلكتروني · 📞 الهاتف · 📱 الجوال` — with the three rates added, because a
 * مندوب you cannot see the commission of is a مندوب you cannot pay.
 *
 * «📋 طباعة فواتير مندوب وعمولاتهم» (L272 `Button1_Click`) opens `frmInvBySalesMen`;
 * here it is a link to the same report, which now exists (`/sales/salesman-commissions`).
 *
 * `الموظف` is the one field the desktop has no box for: the cloud splits its single
 * `salesmen` table in two — a فاتورة names this card and a سند قبض names the employee
 * card — and the link is what lets one مندوب own both (migration 0052).
 */
type Salesman = {
  id: string;
  name: string;
  employeeRef?: string | null;
  active: boolean;
  commissionRate?: string;
  collectionCommissionRate?: string;
  profitCommissionRate?: string;
  employeeId?: string | null;
  tel?: string | null;
  mobile?: string | null;
  email?: string | null;
  notes?: string | null;
};

/** نسبة مئوية — 10 means «10%»; the API refuses anything outside 0–100. */
const pct = (value?: string | null) => (value ? `${Number(value).toFixed(2).replace(/\.00$/, '')}%` : '—');

const trim = (value: string | boolean | undefined) => String(value ?? '').trim();
const optional = (value: string | boolean | undefined) => trim(value ?? '') || undefined;
const nullable = (value: string | boolean | undefined) => trim(value ?? '') || null;

export default function SalesmenPage() {
  const { can } = useSession();
  const salesmen = useQuery<Salesman[]>(() => apiList<Salesman>('/sales/salesmen'), []);
  const employees = useQuery<Employee[]>(() => listEmployees(), []);

  const employeeOptions = (employees.data ?? []).map((row) => ({
    id: row.id,
    label: `${row.employeeNo ?? ''} — ${row.name}`.trim(),
  }));

  return (
    <Directory<Salesman>
      title="شاشة المندوبين"
      subtitle="بطاقة المندوب: العمولات الثلاث التي تُحسب على فواتيره، وبيانات التواصل، وربطه ببطاقة الموظف حتى تُنسَب سندات القبض إليه."
      crumbs={['المبيعات', 'التعاريف']}
      query={salesmen}
      canCreate={can('sales.salesman.manage')}
      createLabel="➕ جديد"
      formTitle="🧑‍💼 بيانات المندوبين"
      fields={[
        { name: 'name', label: '🧑‍💼 اسم المندوب:', required: true, wide: true },
        { name: 'commissionRate', label: 'عمولة المبيعات:', type: 'number', ltr: true, placeholder: '0', hint: 'نسبة مئوية من صافي الفاتورة' },
        { name: 'collectionCommissionRate', label: 'عمولة التحصيل:', type: 'number', ltr: true, placeholder: '0', hint: 'تُحسب على الفواتير المُحصَّلة فقط' },
        { name: 'profitCommissionRate', label: 'عمولة الربح:', type: 'number', ltr: true, placeholder: '0', hint: 'من هامش الربح، إن كان موجباً' },
        { name: 'employeeId', label: 'الموظف', type: 'select', options: [{ id: '', label: '— بلا موظف —' }, ...employeeOptions] },
        { name: 'tel', label: 'الهاتف', ltr: true },
        { name: 'mobile', label: 'الجوال', ltr: true },
        { name: 'email', label: 'البريد الإلكتروني', ltr: true },
        { name: 'employeeRef', label: 'الرقم الوظيفي', ltr: true },
        { name: 'notes', label: 'ملاحظات', type: 'textarea', wide: true },
        { name: 'active', label: 'نشط', type: 'checkbox' },
      ]}
      initial={{ active: true }}
      onCreate={(values) =>
        apiPost('/sales/salesmen', {
          name: trim(values.name),
          commissionRate: optional(values.commissionRate) ?? '0',
          collectionCommissionRate: optional(values.collectionCommissionRate) ?? '0',
          profitCommissionRate: optional(values.profitCommissionRate) ?? '0',
          employeeId: optional(values.employeeId) ?? null,
          tel: nullable(values.tel),
          mobile: nullable(values.mobile),
          email: nullable(values.email),
          employeeRef: optional(values.employeeRef),
          notes: nullable(values.notes),
          active: Boolean(values.active),
        })
      }
      edit={
        can('sales.salesman.manage')
          ? {
              toForm: (row) => ({
                name: row.name,
                commissionRate: Number(row.commissionRate ?? 0).toString(),
                collectionCommissionRate: Number(row.collectionCommissionRate ?? 0).toString(),
                profitCommissionRate: Number(row.profitCommissionRate ?? 0).toString(),
                employeeId: row.employeeId ?? '',
                tel: row.tel ?? '',
                mobile: row.mobile ?? '',
                email: row.email ?? '',
                employeeRef: row.employeeRef ?? '',
                notes: row.notes ?? '',
                active: row.active,
              }),
              onUpdate: (row, values) =>
                apiPatch(`/sales/salesmen/${row.id}`, {
                  name: trim(values.name),
                  commissionRate: optional(values.commissionRate) ?? '0',
                  collectionCommissionRate: optional(values.collectionCommissionRate) ?? '0',
                  profitCommissionRate: optional(values.profitCommissionRate) ?? '0',
                  employeeId: optional(values.employeeId) ?? null,
                  tel: nullable(values.tel),
                  mobile: nullable(values.mobile),
                  email: nullable(values.email),
                  employeeRef: optional(values.employeeRef),
                  notes: nullable(values.notes),
                  active: Boolean(values.active),
                }),
            }
          : undefined
      }
      onDelete={can('sales.salesman.manage') ? (row) => apiDelete(`/sales/salesmen/${row.id}`) : undefined}
      confirmDelete={(row) => `هل تريد حذف المندوب ${row.name}؟ إذا كان مرتبطاً بفواتير فسيتم إيقافه فقط.`}
      rowLabel={(row) => `المندوب ${row.name}`}
      successText={(values) => `تم حفظ المندوب ${trim(values.name)}.`}
      rowKey={(row) => row.id}
      empty="لا يوجد مندوبون"
      toolbar={
        <Link className="btn sm" href="/sales/salesman-commissions">
          📋 طباعة فواتير مندوب وعمولاتهم
        </Link>
      }
      columns={[
        { key: 'name', header: '🧑‍💼 اسم المندوب', cell: (row) => row.name },
        { key: 'comm', header: 'عمولة المبيعات', align: 'ltr', cell: (row) => pct(row.commissionRate) },
        { key: 'colle', header: 'عمولة التحصيل', align: 'ltr', cell: (row) => pct(row.collectionCommissionRate) },
        { key: 'profit', header: 'عمولة الربح', align: 'ltr', cell: (row) => pct(row.profitCommissionRate) },
        { key: 'email', header: '📧 البريد الإلكتروني', align: 'ltr', cell: (row) => row.email ?? '—' },
        { key: 'tel', header: '📞 الهاتف', align: 'ltr', cell: (row) => row.tel ?? '—' },
        { key: 'mobile', header: '📱 الجوال', align: 'ltr', cell: (row) => row.mobile ?? '—' },
        { key: 'active', header: 'الحالة', cell: (row) => (row.active ? 'نشط' : 'موقوف') },
      ]}
    />
  );
}
