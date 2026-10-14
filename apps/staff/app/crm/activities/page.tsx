'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import { listActivities, type CrmActivity } from '../../../lib/crm';

export default function CrmActivitiesPage() {
  const [rows, setRows] = useState<CrmActivity[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  useEffect(() => {
    void listActivities()
      .then(setRows)
      .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }));
  }, []);

  return (
    <Screen title="أنشطة المبيعات" subtitle="كل نشاط مرتبط بصفقة، بما فيه رسائل واتساب الصادرة والواردة." crumbs={['المبيعات', 'الأنشطة']}>
      <Notice notice={notice} />
      <div className="card">
        <DataTable
          columns={[
            { key: 'type', header: 'النوع', cell: (row: CrmActivity) => row.type },
            { key: 'title', header: 'الصفقة', cell: (row: CrmActivity) => <Link href={`/crm/deals/${row.dealId}`}>{row.title || row.dealId}</Link> },
            { key: 'description', header: 'الوصف', cell: (row: CrmActivity) => row.description },
            { key: 'direction', header: 'الاتجاه', cell: (row: CrmActivity) => (row.direction === 'out' ? 'صادر' : row.direction === 'in' ? 'وارد' : '—') },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
        />
      </div>
    </Screen>
  );
}
