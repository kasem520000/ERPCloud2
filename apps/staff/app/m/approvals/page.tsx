'use client';

import { useEffect, useState } from 'react';

import { ApiError, apiData, apiPost } from '../../../lib/api';

type RequestRow = { id: string; employee_name: string; type: string; reason: string; starts_on: string | null; ends_on: string | null };

const LABELS: Record<string, string> = { leave: 'إجازة', permission: 'استئذان', custody: 'عهدة', advance: 'سلفة' };

export default function ApprovalsPage() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [message, setMessage] = useState('');

  async function reload() {
    const next = await apiData<RequestRow[]>('/employee/requests?status=pending');
    setRows(Array.isArray(next) ? next : []);
  }

  useEffect(() => {
    void reload().catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : 'تعذر فتح الوارد'));
  }, []);

  async function decide(id: string, action: 'approve' | 'reject') {
    setMessage('');
    try {
      await apiPost(`/employee/requests/${id}/${action}`, {});
      setMessage(action === 'approve' ? 'وُوفق على الطلب وسيصل إشعار للموظف.' : 'رُفض الطلب.');
      await reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'تعذر حسم الطلب');
    }
  }

  return (
    <section className="employee-card">
      <h1>موافقاتي</h1>
      {message ? <p className="alert info">{message}</p> : null}
      {rows.length === 0 ? <p>لا طلبات معلّقة.</p> : null}
      {rows.map((row) => (
        <article key={row.id} className="card">
          <strong>{row.employee_name}</strong>
          <p>{LABELS[row.type] ?? row.type} — {row.reason}</p>
          <p className="muted">{row.starts_on ?? ''} {row.ends_on ? `إلى ${row.ends_on}` : ''}</p>
          <div className="row">
            <button className="btn primary" type="button" onClick={() => void decide(row.id, 'approve')}>موافقة</button>
            <button className="btn" type="button" onClick={() => void decide(row.id, 'reject')}>رفض</button>
          </div>
        </article>
      ))}
    </section>
  );
}
