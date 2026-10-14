'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

type Alert = {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  kind: 'iqama' | 'insurance';
  expiresOn: string;
  daysRemaining: number;
  severity: 'overdue' | 'due';
};

type Alerts = { today: string; withinDays: number; count: number; data: Alert[] };

const kindLabel = { iqama: 'إقامة', insurance: 'تأمين' };

export default function HrmCompliancePage() {
  const [withinDays, setWithinDays] = useState('30');
  const alerts = useQuery<Alerts>(() => apiData<Alerts>(`/hrm/compliance/alerts?within_days=${withinDays || 30}`), [withinDays]);

  return (
    <Screen
      title="تنبيهات الإقامة والتأمين"
      subtitle="موظفون تنتهي إقامتهم أو تأمينهم خلال النافذة المحددة، مع المتأخرين عن التجديد."
      crumbs={['الموظفين والرواتب', 'العمليات']}
      actions={<Link className="btn" href="/hrm/employees">بطاقات الموظفين</Link>}
    >
      <div className="card">
        <label className="field">
          <span>خلال (يوم)</span>
          <input className="input" dir="ltr" value={withinDays} onChange={(event) => setWithinDays(event.target.value)} />
        </label>
      </div>
      <QueryView query={alerts} empty="لا تنبيهات" emptyDetail="لا إقامة أو تأمين ينتهي داخل هذه النافذة." isEmpty={(payload) => payload.count === 0}>
        {(payload) => (
          <>
            <Notice notice={{ kind: payload.count ? 'warn' : 'ok', text: `${payload.count} تنبيه حتى ${payload.today}` }} />
            <DataTable
              rows={payload.data}
              rowKey={(row) => `${row.employeeId}-${row.kind}`}
              columns={[
                { key: 'name', header: 'الموظف', cell: (row) => row.employeeName },
                { key: 'no', header: 'الرقم', align: 'ltr', cell: (row) => row.employeeNo || '—' },
                { key: 'kind', header: 'النوع', cell: (row) => kindLabel[row.kind] },
                { key: 'date', header: 'الانتهاء', align: 'ltr', cell: (row) => row.expiresOn },
                {
                  key: 'days',
                  header: 'المتبقي',
                  cell: (row) => (
                    <span className={`badge ${row.severity === 'overdue' ? 'danger' : ''}`}>
                      {row.severity === 'overdue' ? `متأخر ${Math.abs(row.daysRemaining)} يوم` : `${row.daysRemaining} يوم`}
                    </span>
                  ),
                },
              ]}
            />
          </>
        )}
      </QueryView>
    </Screen>
  );
}
