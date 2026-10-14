'use client';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

type AuditRow = {
  id: string;
  occurredAt?: string;
  occurred_at?: string;
  action?: string;
  entityType?: string;
  entity_type?: string;
  entityId?: string;
  entity_id?: string;
  actorUserId?: string | null;
  actor_user_id?: string | null;
  requestId?: string | null;
  request_id?: string | null;
};

export default function TenantAuditPage() {
  const audit = useQuery<AuditRow[] | { items?: AuditRow[]; data?: AuditRow[] }>(() => apiData('/audit-log?limit=100'), []);

  const rows: AuditRow[] = Array.isArray(audit.data)
    ? audit.data
    : ((audit.data as { items?: AuditRow[] })?.items ?? []);

  return (
    <Screen
      title="سجلات المستخدمين"
      subtitle="سجل غير قابل للتعديل لكل عملية مؤثرة. النطاق محدد بالمنشأة الحالية."
      crumbs={['الإعدادات', 'التدقيق']}
      actions={
        <button className="btn" type="button" onClick={audit.reload}>
          تحديث
        </button>
      }
    >
      {audit.status === 'loading' && <Loading />}
      {audit.status === 'forbidden' && <Forbidden />}
      {audit.status === 'error' && <ErrorBox message={audit.error} onRetry={audit.reload} />}
      {audit.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا توجد سجلات بعد" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الوقت</th>
                  <th>الإجراء</th>
                  <th>الكيان</th>
                  <th>المعرف</th>
                  <th>المستخدم</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td dir="ltr">{new Date(row.occurredAt ?? row.occurred_at ?? Date.now()).toLocaleString('ar-SA')}</td>
                    <td dir="ltr">{row.action}</td>
                    <td dir="ltr">{row.entityType ?? row.entity_type}</td>
                    <td dir="ltr" className="small">{(row.entityId ?? row.entity_id ?? '').slice(0, 8)}</td>
                    <td dir="ltr" className="small">{(row.actorUserId ?? row.actor_user_id ?? '—').slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Screen>
  );
}
