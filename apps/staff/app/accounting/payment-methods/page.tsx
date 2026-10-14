'use client';

import { Directory } from '../../../components/directory';
import { apiList, apiPost, apiPut } from '../../../lib/api';
import { cashLocationLabel, listCashLocations, type CashLocation } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type PaymentMethod = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  kind: string;
  dueDays: number;
  cashLocationId: string | null;
  isActive: boolean;
  isDefault: boolean;
};

const KIND_LABELS: Record<string, string> = {
  cash: 'نقداً',
  card: 'شبكة / بطاقة',
  transfer: 'تحويل بنكي',
  cheque: 'شيك',
  credit: 'آجل',
};

/**
 * Customer payment methods.
 *
 * The method carries the credit period (`dueDays`) and the cash location the money lands
 * in, so a customer filed under "آجل 30" produces a due date instead of an argument.
 */
export default function PaymentMethodsPage() {
  const methods = useQuery<PaymentMethod[]>(() => apiList<PaymentMethod>('/payment-methods'), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);

  return (
    <Directory<PaymentMethod>
      title="طريقة دفع عميل"
      subtitle="طرق السداد المعتمدة: نقداً، شبكة، تحويل، شيك أو آجل بمدة محددة."
      crumbs={['المحاسبة', 'تعاريف']}
      query={methods}
      createLabel="طريقة دفع جديدة"
      formTitle="بطاقة طريقة دفع"
      empty="لا توجد طرق دفع"
      emptyDetail="عرّف طرق السداد لتظهر في بطاقة العميل وسندات القبض."
      initial={{ kind: 'cash', dueDays: '0', isActive: true }}
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true, placeholder: 'CASH' },
        { name: 'nameAr', label: 'الاسم بالعربية', required: true },
        { name: 'nameEn', label: 'الاسم بالإنجليزية', ltr: true },
        { name: 'kind', label: 'النوع', type: 'select', required: true, options: Object.entries(KIND_LABELS).map(([id, label]) => ({ id, label })) },
        { name: 'dueDays', label: 'مهلة السداد (أيام)', type: 'number', hint: 'صفر يعني السداد فوراً.' },
        {
          name: 'cashLocationId',
          label: 'الصندوق / الحساب البنكي',
          type: 'select',
          wide: true,
          options: (cashLocations.data ?? []).map((row) => ({ id: row.id, label: cashLocationLabel(row) })),
        },
        { name: 'isActive', label: 'مفعّلة', type: 'checkbox' },
        { name: 'isDefault', label: 'الافتراضية', type: 'checkbox' },
      ]}
      onCreate={(values) =>
        apiPost('/payment-methods', {
          code: String(values.code).toUpperCase(),
          nameAr: String(values.nameAr),
          nameEn: values.nameEn ? String(values.nameEn) : undefined,
          kind: String(values.kind || 'cash'),
          dueDays: Number(values.dueDays || 0),
          cashLocationId: values.cashLocationId ? String(values.cashLocationId) : undefined,
          isActive: Boolean(values.isActive),
          isDefault: Boolean(values.isDefault),
        })
      }
      edit={{
        toForm: (row) => ({
          code: row.code,
          nameAr: row.nameAr,
          nameEn: row.nameEn ?? '',
          kind: row.kind,
          dueDays: String(row.dueDays ?? 0),
          cashLocationId: row.cashLocationId ?? '',
          isActive: row.isActive,
          isDefault: row.isDefault,
        }),
        onUpdate: (row, values) =>
          apiPut(`/payment-methods/${row.id}`, {
            nameAr: String(values.nameAr),
            nameEn: values.nameEn ? String(values.nameEn) : undefined,
            kind: String(values.kind || 'cash'),
            dueDays: Number(values.dueDays || 0),
            cashLocationId: values.cashLocationId ? String(values.cashLocationId) : undefined,
            isActive: Boolean(values.isActive),
            isDefault: Boolean(values.isDefault),
          }),
      }}
      rowLabel={(row) => `طريقة الدفع ${row.nameAr}`}
      successText={(values) => `تم حفظ «${String(values.nameAr)}».`}
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
        { key: 'name', header: 'الاسم', cell: (row) => row.nameAr },
        { key: 'kind', header: 'النوع', cell: (row) => KIND_LABELS[row.kind] ?? row.kind },
        { key: 'dueDays', header: 'المهلة', align: 'num', cell: (row) => (row.dueDays > 0 ? `${row.dueDays} يوم` : 'فوري') },
        {
          key: 'cashLocation',
          header: 'الصندوق',
          cell: (row) => {
            const location = (cashLocations.data ?? []).find((candidate) => candidate.id === row.cashLocationId);
            return location ? cashLocationLabel(location) : '—';
          },
        },
        { key: 'status', header: 'الحالة', cell: (row) => `${row.isActive ? 'مفعّلة' : 'موقوفة'}${row.isDefault ? ' • افتراضية' : ''}` },
      ]}
      rowKey={(row) => row.id}
    />
  );
}
