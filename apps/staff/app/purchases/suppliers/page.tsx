'use client';

import Link from 'next/link';

import { Directory } from '../../../components/directory';
import { apiDelete, apiPost, apiPut } from '../../../lib/api';
import { listParties, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

export default function SuppliersPage() {
  const { can } = useSession();
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);

  return (
    <Directory<Party>
      title="بطاقة مورد"
      subtitle="ملف المورد المستخدم في فواتير المشتريات وسندات الصرف وكشف الحساب."
      crumbs={['المشتريات', 'التعاريف']}
      query={suppliers}
      canCreate={can('parties.manage')}
      createLabel="مورد جديد"
      fields={[
        { name: 'code', label: 'الرمز', ltr: true },
        { name: 'name', label: 'الاسم', required: true },
        { name: 'phone', label: 'الجوال', ltr: true },
        { name: 'taxNo', label: 'الرقم الضريبي', ltr: true },
      ]}
      onCreate={(values) =>
        apiPost('/parties', {
          kind: 'supplier',
          code: String(values.code).trim() || undefined,
          name: String(values.name).trim(),
          phone: String(values.phone).trim() || undefined,
          taxNo: String(values.taxNo).trim() || undefined,
        })
      }
      edit={
        can('parties.manage')
          ? {
              toForm: (row) => ({ code: row.code ?? '', name: row.name, phone: row.phone ?? '', taxNo: row.taxNo ?? row.tax_no ?? '' }),
              onUpdate: (row, values) =>
                apiPut(`/parties/${row.id}`, {
                  name: String(values.name).trim(),
                  phone: String(values.phone).trim() || undefined,
                  taxNo: String(values.taxNo).trim() || undefined,
                }),
            }
          : undefined
      }
      onDelete={can('parties.manage') ? (row) => apiDelete(`/parties/${row.id}`) : undefined}
      confirmDelete={(row) => `هل تريد حذف المورد ${row.name}؟ لا يمكن الحذف إذا كان عليه رصيد مفتوح.`}
      rowLabel={(row) => `المورد ${row.name}`}
      successText={(values) => `تمت إضافة المورد ${String(values.name)}.`}
      rowKey={(row) => row.id}
      empty="لا يوجد موردون"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code ?? '—' },
        { key: 'name', header: 'الاسم', cell: (row) => row.name },
        { key: 'phone', header: 'الجوال', align: 'ltr', cell: (row) => row.phone ?? '—' },
        { key: 'tax', header: 'الرقم الضريبي', align: 'ltr', cell: (row) => row.taxNo ?? row.tax_no ?? '—' },
        {
          key: 'statement',
          header: '',
          cell: (row) => (
            <Link className="btn sm" href={`/sales/statements?partyId=${row.id}`}>
              كشف حساب
            </Link>
          ),
        },
      ]}
    />
  );
}
