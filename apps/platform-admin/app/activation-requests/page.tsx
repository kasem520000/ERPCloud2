'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

type Request = {
  id: string;
  tenant_code: string;
  tenant_name: string;
  plan_name: string | null;
  amount: string | null;
  currency: string | null;
  notes: string | null;
  created_at: string;
  requested_by_email: string | null;
  status: string;
};

export default function ActivationRequestsPage() {
  const [status, setStatus] = useState('pending');
  const requests = useQuery<Request[]>(() => apiData<Request[]>(`/platform/activation-requests?status=${status}`), [status]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  async function review(id: string, approve: boolean) {
    setBusy(id);
    setMessage(undefined);
    try {
      await apiPost(`/platform/activation-requests/${id}/review`, { approve });
      setMessage({ kind: 'ok', text: approve ? 'تم اعتماد الطلب وإصدار ترخيص لمدة 12 شهراً.' : 'تم رفض الطلب.' });
      requests.reload();
    } catch (error) {
      setMessage({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  const rows = requests.data ?? [];

  return (
    <Screen
      title="طلبات التفعيل"
      subtitle="طلبات الاشتراك اليدوية القادمة من بوابة العملاء."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <select className="input" style={{ maxWidth: 180 }} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="pending">معلقة</option>
          <option value="approved">معتمدة</option>
          <option value="rejected">مرفوضة</option>
        </select>
      }
    >
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
      {requests.status === 'loading' && <Loading />}
      {requests.status === 'error' && <ErrorBox message={requests.error} onRetry={requests.reload} />}
      {requests.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا توجد طلبات" detail="ستظهر هنا طلبات العملاء من صفحة الاشتراك في بوابة العملاء." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المنشأة</th>
                  <th>مقدم الطلب</th>
                  <th>الباقة</th>
                  <th className="num">القيمة</th>
                  <th>التاريخ</th>
                  <th>ملاحظات</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.tenant_name}</strong>
                      <div className="muted small" dir="ltr">
                        {row.tenant_code}
                      </div>
                    </td>
                    <td dir="ltr" className="small">{row.requested_by_email ?? '—'}</td>
                    <td>{row.plan_name ?? '—'}</td>
                    <td className="num">
                      {row.amount ? `${Number(row.amount).toLocaleString('ar-SA', { minimumFractionDigits: 2 })} ${row.currency ?? ''}` : '—'}
                    </td>
                    <td dir="ltr">{new Date(row.created_at).toLocaleDateString('ar-SA')}</td>
                    <td className="small">{row.notes ?? '—'}</td>
                    <td>
                      {row.status === 'pending' && (
                        <div className="row">
                          <button className="btn sm primary" type="button" disabled={busy === row.id} onClick={() => void review(row.id, true)}>
                            اعتماد
                          </button>
                          <button className="btn sm danger" type="button" disabled={busy === row.id} onClick={() => void review(row.id, false)}>
                            رفض
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Screen>
  );
}
