'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Branch = {
  id: string;
  code?: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  isDefault?: boolean;
  is_default?: boolean;
  isActive?: boolean;
  is_active?: boolean;
};

const nameOf = (row: Branch) => row.nameAr ?? row.name_ar ?? row.nameEn ?? row.code ?? '—';
const isDefaultOf = (row: Branch) => row.isDefault ?? row.is_default ?? false;
const isActiveOf = (row: Branch) => (row.isActive ?? row.is_active) !== false;

export default function BranchesPage() {
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => apiList<Branch>('/branches'), []);
  const manage = can('organization.branch.manage');

  return (
    <Directory<Branch>
      title="بطاقة فرع"
      subtitle="فروع المنشأة. كل مستند يصدر تحت فرع، والترقيم مستقل لكل فرع."
      crumbs={['الإعدادات', 'تعاريف المنشأة']}
      query={branches}
      canCreate={manage}
      createLabel="فرع جديد"
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true, hint: 'ثابت بعد الإنشاء — تحمله المستندات المطبوعة.' },
        { name: 'nameAr', label: 'الاسم العربي', required: true },
        { name: 'nameEn', label: 'الاسم الإنجليزي', ltr: true },
        { name: 'phone', label: 'الهاتف', ltr: true },
        { name: 'mobile', label: 'الجوال', ltr: true },
        { name: 'email', label: 'البريد الإلكتروني', ltr: true },
        { name: 'isDefault', label: 'الفرع الافتراضي', type: 'checkbox', hint: 'يُختار تلقائياً في الشاشات الجديدة' },
        { name: 'isActive', label: 'نشط', type: 'checkbox' },
      ]}
      initial={{ isActive: true }}
      onCreate={(values) =>
        apiPost('/branches', {
          code: String(values.code).trim(),
          nameAr: String(values.nameAr).trim(),
          nameEn: String(values.nameEn).trim() || undefined,
          phone: String(values.phone).trim() || undefined,
          mobile: String(values.mobile).trim() || undefined,
          email: String(values.email).trim() || undefined,
          isDefault: Boolean(values.isDefault),
          isActive: Boolean(values.isActive),
        })
      }
      edit={
        manage
          ? {
              toForm: (row) => ({
                code: row.code ?? '',
                nameAr: nameOf(row),
                nameEn: row.nameEn ?? '',
                phone: row.phone ?? '',
                mobile: row.mobile ?? '',
                email: row.email ?? '',
                isDefault: isDefaultOf(row),
                isActive: isActiveOf(row),
              }),
              // `code` is not sent: the API rejects renaming it, because printed documents
              // and the migration mapping tables already carry the old value.
              onUpdate: (row, values) =>
                apiPatch(`/branches/${row.id}`, {
                  nameAr: String(values.nameAr).trim(),
                  nameEn: String(values.nameEn).trim() || null,
                  phone: String(values.phone).trim() || null,
                  mobile: String(values.mobile).trim() || null,
                  email: String(values.email).trim() || null,
                  isDefault: Boolean(values.isDefault),
                  isActive: Boolean(values.isActive),
                }),
            }
          : undefined
      }
      onDelete={manage ? (row) => apiDelete(`/branches/${row.id}`) : undefined}
      rowLabel={(row) => `الفرع ${row.code ?? nameOf(row)}`}
      successText={(values) => `تمت إضافة الفرع ${String(values.code)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد فروع"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code ?? '—' },
        { key: 'name', header: 'الاسم', cell: (row) => nameOf(row) },
        { key: 'phone', header: 'الهاتف', align: 'ltr', cell: (row) => row.phone ?? row.mobile ?? '—' },
        { key: 'default', header: 'افتراضي', cell: (row) => (isDefaultOf(row) ? <span className="badge active">نعم</span> : '—') },
        {
          key: 'status',
          header: 'الحالة',
          cell: (row) => <span className={`badge ${isActiveOf(row) ? 'active' : 'planned'}`}>{isActiveOf(row) ? 'نشط' : 'موقوف'}</span>,
        },
      ]}
    />
  );
}
