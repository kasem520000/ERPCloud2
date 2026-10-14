'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, listUnits, type Unit } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

export default function UnitsPage() {
  const { can } = useSession();
  const units = useQuery<Unit[]>(() => listUnits(), []);
  const unitRows = units.data ?? [];

  return (
    <Directory<Unit>
      title="بطاقة وحدة"
      subtitle="وحدات القياس الأساسية للمواد (حبة، كرتون، كيلوجرام…)."
      crumbs={['المستودعات', 'التعاريف']}
      query={units}
      canCreate={can('catalog.unit.manage')}
      createLabel="وحدة جديدة"
      tiles={[
        { label: 'وحدات القياس', value: unitRows.length, hint: 'وحدة معرّفة', tone: 'brand' },
        {
          label: 'بلا اسم إنجليزي',
          value: unitRows.filter((row) => !row.nameEn).length,
          hint: 'تظهر بالعربية فقط',
          tone: unitRows.some((row) => !row.nameEn) ? 'warn' : 'ok',
        },
        { label: 'الرموز', value: new Set(unitRows.map((row) => row.code)).size, hint: 'رمز مختلف' },
      ]}
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true, placeholder: 'PCS' },
        { name: 'nameAr', label: 'الاسم العربي', required: true },
        { name: 'nameEn', label: 'الاسم الإنجليزي', ltr: true },
      ]}
      onCreate={(values) =>
        apiPost('/organization/catalog/units', {
          code: String(values.code).trim().toUpperCase(),
          nameAr: String(values.nameAr).trim(),
          nameEn: String(values.nameEn).trim() || undefined,
        })
      }
      edit={
        can('catalog.unit.manage')
          ? {
              toForm: (row) => ({ code: row.code, nameAr: row.nameAr ?? '', nameEn: row.nameEn ?? '' }),
              onUpdate: (row, values) =>
                apiPatch(`/organization/catalog/units/${row.id}`, {
                  code: String(values.code).trim().toUpperCase(),
                  nameAr: String(values.nameAr).trim(),
                  nameEn: String(values.nameEn).trim() || null,
                }),
            }
          : undefined
      }
      onDelete={can('catalog.unit.manage') ? (row) => apiDelete(`/organization/catalog/units/${row.id}`) : undefined}
      rowLabel={(row) => `الوحدة ${row.code}`}
      successText={(values) => `تمت إضافة الوحدة ${String(values.code)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد وحدات قياس"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
        { key: 'name', header: 'الاسم', cell: (row) => arabicName(row) },
      ]}
    />
  );
}
