'use client';

import { useEffect, useState } from 'react';

import { Screen } from '../../../components/screen';
import { ApiError, apiData } from '../../../lib/api';

type Leave = { id: string; employee_name: string; starts_on: string | null; ends_on: string | null; reason: string };

export default function HrmLeavesPage() {
  const [rows, setRows] = useState<Leave[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void apiData<Leave[]>('/hrm/employee-leaves')
      .then((next) => setRows(Array.isArray(next) ? next : []))
      .catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : 'تعذر تحميل الإجازات'));
  }, []);

  return (
    <Screen title="إجازات الموظفين" subtitle="الطلبات التي وافق عليها المدير من تطبيق الموظف." crumbs={['الموظفين', 'الإجازات']}>
      {message ? <p className="alert danger">{message}</p> : null}
      <section className="card">
        {rows.length === 0 ? <p>لا إجازات معتمدة.</p> : null}
        {rows.map((row) => (
          <p key={row.id}>{row.employee_name}: {row.starts_on} إلى {row.ends_on} — {row.reason}</p>
        ))}
      </section>
    </Screen>
  );
}
