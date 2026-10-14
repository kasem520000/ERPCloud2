'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Forbidden, Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import { approvalInbox, decideApproval, type ApprovalRequest } from '../../../lib/approvals';
import { useSession } from '../../../lib/session';

const labels: Record<ApprovalRequest['entityType'], string> = {
  sales_invoice: 'فاتورة مبيعات',
  purchase_invoice: 'فاتورة مشتريات',
  voucher: 'سند خزينة',
  expense: 'مصروف',
  leave: 'إجازة',
};

export default function ApprovalInboxPage() {
  const { can } = useSession();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();
  const [busy, setBusy] = useState<string>();

  const reload = async (): Promise<void> => setRequests(await approvalInbox());
  useEffect(() => {
    void reload().catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }));
  }, []);

  if (!can('approval.approve')) {
    return <Screen title="وارد الموافقات" subtitle="المستندات التي تنتظر قرارك." crumbs={['الموافقات', 'الوارد']}><Forbidden /></Screen>;
  }

  const decide = async (request: ApprovalRequest, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(`${request.id}:${decision}`);
    setNotice(undefined);
    try {
      await decideApproval(request.id, decision, comments[request.id] ?? '');
      await reload();
      setNotice({ kind: 'ok', text: decision === 'approve' ? 'تمت الموافقة وانتقلت المعاملة للخطوة التالية.' : 'تم الرفض وبقي المستند مسودة.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Screen title="وارد الموافقات" subtitle="يعرض هذا الوارد الطلبات المسندة إلى دورك أو إلى مستخدمك فقط." crumbs={['الموافقات', 'الوارد']} actions={<span className="chip">{requests.length} بانتظارك</span>}>
      <Notice notice={notice} />
      {requests.length === 0 ? <div className="card"><p className="muted m-0">لا توجد طلبات بانتظار قرارك.</p></div> : (
        <div className="grid gap-3">
          {requests.map((request) => (
            <article className="card grid gap-3" key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="m-0">{labels[request.entityType]} <span className="muted">#{request.entityId.slice(0, 8)}</span></h2>
                  <p className="muted m-0 mt-1">مسار: {request.workflowName ?? '—'} · الخطوة {request.currentStepOrder ?? '—'}</p>
                </div>
                <span className="chip">{request.currentStep?.approverRole ?? request.currentStep?.approverUserId ?? 'مستخدم محدد'}</span>
              </div>
              <div className="rounded-lg bg-surface-2 p-3 text-[13px]">
                <strong>أنشأه:</strong> {request.createdBy ?? 'النظام'} · <strong>التاريخ:</strong> {new Date(request.createdAt).toLocaleString('ar')}
              </div>
              <label className="field"><span>تعليق القرار (اختياري)</span><textarea value={comments[request.id] ?? ''} onChange={(event) => setComments((current) => ({ ...current, [request.id]: event.target.value }))} rows={2} placeholder="اكتب ملاحظة للمُنشئ أو للمراجع التالي" /></label>
              <div className="toolbar">
                <button className="btn primary" type="button" disabled={busy !== undefined} onClick={() => void decide(request, 'approve')}>{busy === `${request.id}:approve` ? 'جارٍ…' : 'موافقة'}</button>
                <button className="btn" type="button" disabled={busy !== undefined} onClick={() => void decide(request, 'reject')}>{busy === `${request.id}:reject` ? 'جارٍ…' : 'رفض وإبقاء مسودة'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Screen>
  );
}
