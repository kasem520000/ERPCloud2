'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, listBranches, listWarehouses, type Branch, type Warehouse } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

export default function WarehousesPage() {
  const { can } = useSession();
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const defaults = warehouseRows.filter((row) => row.isDefault).length;

  return (
    <Directory<Warehouse>
      title="بطاقة مستودع"
      subtitle="المستودعات التي تُرحَّل إليها حركة المخزون؛ لكل فرع مستودع افتراضي واحد."
      crumbs={['المستودعات', 'التعاريف']}
      query={warehouses}
      canCreate={can('organization.warehouse.manage')}
      createLabel="مستودع جديد"
      blocked={branchRows.length === 0 ? 'أنشئ فرعاً أولاً من «الإعدادات ← بطاقة فرع».' : undefined}
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true },
        { name: 'name', label: 'الاسم', required: true },
        {
          name: 'branchId',
          label: 'الفرع',
          type: 'select',
          required: true,
          options: branchRows.map((row) => ({ id: row.id, label: `${row.code ?? ''} ${arabicName(row)}`.trim() })),
        },
        { name: 'isDefault', label: 'افتراضي', type: 'checkbox', hint: 'يُستخدم تلقائياً في الفواتير' },
      ]}
      onCreate={(values) =>
        apiPost('/warehouses', {
          code: String(values.code).trim(),
          name: String(values.name).trim(),
          branchId: String(values.branchId),
          isDefault: Boolean(values.isDefault),
        })
      }
      edit={
        can('organization.warehouse.manage')
          ? {
              toForm: (row) => ({
                code: row.code ?? '',
                name: arabicName(row),
                branchId: row.branchId ?? '',
                isDefault: Boolean(row.isDefault),
              }),
              onUpdate: (row, values) =>
                apiPatch(`/warehouses/${row.id}`, {
                  code: String(values.code).trim(),
                  name: String(values.name).trim(),
                  branchId: String(values.branchId) || undefined,
                  isDefault: Boolean(values.isDefault),
                }),
            }
          : undefined
      }
      onDelete={can('organization.warehouse.manage') ? (row) => apiDelete(`/warehouses/${row.id}`) : undefined}
      rowLabel={(row) => `المستودع ${row.code ?? ''}`}
      successText={(values) => `تمت إضافة المستودع ${String(values.code)}.`}
      rowKey={(row) => row.id}
      tiles={[
        { label: 'المستودعات', value: warehouseRows.length, hint: 'مستودع معرّف', tone: 'brand' },
        { label: 'الفروع', value: branchRows.length, hint: 'فرع مسجّل' },
        { label: 'مستودع افتراضي', value: defaults, hint: 'يُستخدم تلقائياً في الفواتير' },
        {
          label: 'مستودعات بلا فرع',
          value: warehouseRows.filter((row) => !row.branchId).length,
          hint: 'لن تجد ملف ترحيل',
          tone: warehouseRows.some((row) => !row.branchId) ? 'danger' : 'ok',
        },
      ]}
      empty="لا توجد مستودعات"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code ?? '—' },
        { key: 'name', header: 'الاسم', cell: (row) => arabicName(row) },
        {
          key: 'branch',
          header: 'الفرع',
          cell: (row) => {
            const branch = branchRows.find((item) => item.id === row.branchId);
            return branch ? arabicName(branch) : '—';
          },
        },
        { key: 'default', header: 'افتراضي', cell: (row) => (row.isDefault ? 'نعم' : '—') },
      ]}
    />
  );
}
