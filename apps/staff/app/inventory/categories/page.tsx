'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, listCategories, type Category } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

export default function CategoriesPage() {
  const { can } = useSession();
  const categories = useQuery<Category[]>(() => listCategories(), []);
  const categoryRows = categories.data ?? [];
  const roots = categoryRows.filter((row) => !row.parentId);

  return (
    <Directory<Category>
      title="بطاقة مجموعة"
      subtitle="مجموعات الأصناف — تُستخدم في التقارير وفي عرض المواد داخل نقطة البيع."
      crumbs={['المستودعات', 'التعاريف']}
      query={categories}
      canCreate={can('catalog.category.manage')}
      createLabel="مجموعة جديدة"
      tiles={[
        { label: 'المجموعات', value: categoryRows.length, hint: 'مجموعة أصناف', tone: 'brand' },
        { label: 'مجموعات رئيسية', value: roots.length, hint: 'بلا أب' },
        {
          label: 'مجموعات فرعية',
          value: categoryRows.length - roots.length,
          hint: 'تندرج تحت مجموعة أخرى',
        },
      ]}
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true },
        { name: 'nameAr', label: 'الاسم العربي', required: true },
        { name: 'nameEn', label: 'الاسم الإنجليزي', ltr: true },
        {
          name: 'parentId',
          label: 'المجموعة الأب',
          type: 'select',
          options: (categories.data ?? []).map((row) => ({ id: row.id, label: `${row.code} — ${arabicName(row)}` })),
        },
      ]}
      onCreate={(values) =>
        apiPost('/organization/catalog/categories', {
          code: String(values.code).trim(),
          nameAr: String(values.nameAr).trim(),
          nameEn: String(values.nameEn).trim() || undefined,
          parentId: String(values.parentId) || undefined,
        })
      }
      edit={
        can('catalog.category.manage')
          ? {
              toForm: (row) => ({ code: row.code, nameAr: row.nameAr ?? '', nameEn: row.nameEn ?? '', parentId: row.parentId ?? '' }),
              onUpdate: (row, values) =>
                apiPatch(`/organization/catalog/categories/${row.id}`, {
                  code: String(values.code).trim(),
                  nameAr: String(values.nameAr).trim(),
                  nameEn: String(values.nameEn).trim() || null,
                  parentId: String(values.parentId) || null,
                }),
            }
          : undefined
      }
      onDelete={can('catalog.category.manage') ? (row) => apiDelete(`/organization/catalog/categories/${row.id}`) : undefined}
      rowLabel={(row) => `المجموعة ${row.code}`}
      successText={(values) => `تمت إضافة المجموعة ${String(values.code)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد مجموعات"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
        { key: 'name', header: 'الاسم', cell: (row) => arabicName(row) },
      ]}
    />
  );
}
