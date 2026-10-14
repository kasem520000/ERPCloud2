'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Job = { id: string; code: string; name: string };

export default function JobsPage() {
  const { can } = useSession();
  const jobs = useQuery<Job[]>(() => apiList<Job>('/hrm/jobs'), []);

  return (
    <Directory<Job>
      title="تعريف الأقسام والوظائف"
      subtitle="المسميات الوظيفية المستخدمة في بطاقة الموظف."
      crumbs={['الموظفين والرواتب', 'التعاريف']}
      query={jobs}
      canCreate={can('hrm.manage')}
      createLabel="وظيفة جديدة"
      fields={[
        { name: 'code', label: 'الرمز', required: true, ltr: true },
        { name: 'name', label: 'المسمى', required: true },
      ]}
      onCreate={(values) => apiPost('/hrm/jobs', { code: String(values.code).trim(), name: String(values.name).trim() })}
      edit={
        can('hrm.manage')
          ? {
              toForm: (row) => ({ code: row.code, name: row.name }),
              onUpdate: (row, values) => apiPatch(`/hrm/jobs/${row.id}`, { code: String(values.code).trim(), name: String(values.name).trim() }),
            }
          : undefined
      }
      onDelete={can('hrm.manage') ? (row) => apiDelete(`/hrm/jobs/${row.id}`) : undefined}
      rowLabel={(row) => `الوظيفة ${row.name}`}
      successText={(values) => `تمت إضافة الوظيفة ${String(values.name)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد وظائف"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
        { key: 'name', header: 'المسمى', cell: (row) => row.name },
      ]}
    />
  );
}
