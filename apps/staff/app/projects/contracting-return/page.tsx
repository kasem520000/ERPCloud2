'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { money, shortDate, statusLabel, today } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Project = { id: string; code: string; name: string; retentionPct: string };
type Bill = { id: string; number: string | null; billDate: string; workValue: string; retentionValue: string; netDue: string; status: string };
type ReturnableLine = { termId: string; code: string; description: string; billedValue: string; returnedValue: string; returnableValue: string };
type Returnable = { billId: string; billNumber: string | null; lines: ReturnableLine[] };
type ReturnLine = { lineNo: number; termId: string; returnValue: string };
type ContractingReturn = {
  id: string;
  number: string;
  projectId: string;
  billId: string;
  returnDate: string;
  status: string;
  reason: string;
  returnValue: string;
  retentionValue: string;
  netValue: string;
  creditNoteId: string | null;
  lines: ReturnLine[];
};

const STATUS_LABELS: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', cancelled: 'ملغي' };

/**
 * مرتجع مقاولات — take work back off a posted progress bill. The screen never offers more
 * than the bill actually certified minus what earlier returns already took.
 */
export default function ContractingReturnPage() {
  const { can } = useSession();
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const bills = useQuery<Bill[]>(() => (projectId ? apiList<Bill>(`/projects/${projectId}/progress-bills`) : Promise.resolve([])), [projectId]);
  const [billId, setBillId] = useState('');
  const returnable = useQuery<Returnable | null>(() => (billId ? apiData<Returnable>(`/contracting/returns/returnable?bill_id=${billId}`) : Promise.resolve(null)), [billId]);
  const returns = useQuery<ContractingReturn[]>(() => apiList<ContractingReturn>(projectId ? `/contracting/returns?project_id=${projectId}` : '/contracting/returns'), [projectId]);

  const [returnDate, setReturnDate] = useState(today());
  const [reason, setReason] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const project = (projects.data ?? []).find((row) => row.id === projectId) ?? null;
  const lines = returnable.data?.lines ?? [];
  const chosen = lines
    .map((line) => ({ termId: line.termId, returnValue: (amounts[line.termId] ?? '').trim(), max: Number(line.returnableValue) }))
    .filter((line) => line.returnValue !== '' && Number(line.returnValue) > 0);
  const totals = useMemo(() => {
    const gross = chosen.reduce((sum, line) => sum + Number(line.returnValue), 0);
    const retention = gross * (Number(project?.retentionPct ?? 0) / 100);
    return { gross, retention, net: gross - retention };
  }, [chosen, project?.retentionPct]);
  const overLine = chosen.find((line) => Number(line.returnValue) > line.max);

  const postedBills = (bills.data ?? []).filter((bill) => bill.status !== 'draft');

  async function create() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (!billId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر المستخلص المراد إرجاع جزء منه.');
      if (!reason.trim()) throw new ApiError(422, 'VALIDATION_FAILED', 'اكتب سبب المرتجع.');
      if (chosen.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أدخل قيمة مرتجعة لبند واحد على الأقل.');
      const created = await apiPost<ContractingReturn>('/contracting/returns', {
        billId,
        returnDate,
        reason: reason.trim(),
        lines: chosen.map((line) => ({ termId: line.termId, returnValue: line.returnValue })),
      });
      setNotice({ kind: 'ok', text: `تم إنشاء المرتجع ${created.number} بقيمة ${money(created.returnValue)} — لم يُرحَّل بعد.` });
      setAmounts({});
      setReason('');
      returns.reload();
      returnable.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function act(row: ContractingReturn, action: 'post' | 'cancel') {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<ContractingReturn>(`/contracting/returns/${row.id}/${action}`, {});
      setNotice({
        kind: 'ok',
        text: action === 'post'
          ? `تم ترحيل المرتجع ${row.number}: أُعيدت ${money(result.returnValue)} إلى بنود الكميات، وصدر إشعار دائن مسودة بقيمة ${money(result.netValue)} — رحّله من شاشة إشعارات المبيعات.`
          : `تم إلغاء المرتجع ${row.number}.`,
      });
      returns.reload();
      returnable.reload();
      bills.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="مرتجع مقاولات"
      subtitle="إرجاع أعمال سبق استخلاصها على مستخلص مرحَّل: تعود قيمتها إلى بنود جدول الكميات ليُعاد استخلاصها، ويصدر إشعار دائن للعميل بصافي القيمة بعد ردّ المحتجز."
      crumbs={['المبيعات', 'العمليات']}
    >
      {notice && <Notice notice={notice} />}

      <div className="toolbar">
        <label className="field wide">
          <span>المشروع</span>
          <select
            className="input"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setBillId('');
              setAmounts({});
            }}
          >
            <option value="">— اختر مشروعاً —</option>
            {(projects.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>{`${row.code} — ${row.name}`}</option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>المستخلص المرحَّل</span>
          <select className="input" value={billId} onChange={(event) => { setBillId(event.target.value); setAmounts({}); }} disabled={!projectId}>
            <option value="">— اختر مستخلصاً —</option>
            {postedBills.map((bill) => (
              <option key={bill.id} value={bill.id}>{`${bill.number ?? '—'} — ${shortDate(bill.billDate)} — ${money(bill.workValue)}`}</option>
            ))}
          </select>
        </label>
      </div>

      {projectId && postedBills.length === 0 && <Notice notice={{ kind: 'info', text: 'لا توجد مستخلصات مرحَّلة على هذا المشروع؛ المسودة تُعدَّل ولا تحتاج مرتجعاً.' }} />}

      {billId && can('projects.manage') && (
        <div className="card">
          <h3>بنود المرتجع</h3>
          <QueryView query={returnable} empty="لا توجد بنود قابلة للإرجاع" emptyDetail="ربما أُرجعت كل قيمة هذا المستخلص." isEmpty={(data) => !data || data.lines.length === 0}>
            {(data) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>البند</th>
                      <th>الوصف</th>
                      <th>المستخلَص</th>
                      <th>أُرجع سابقاً</th>
                      <th>القابل للإرجاع</th>
                      <th>قيمة المرتجع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.lines.map((line) => (
                      <tr key={line.termId}>
                        <td className="ltr">{line.code}</td>
                        <td>{line.description}</td>
                        <td className="num">{money(line.billedValue)}</td>
                        <td className="num">{money(line.returnedValue)}</td>
                        <td className="num">{money(line.returnableValue)}</td>
                        <td>
                          <input
                            className="input"
                            value={amounts[line.termId] ?? ''}
                            onChange={(event) => setAmounts((current) => ({ ...current, [line.termId]: event.target.value }))}
                            inputMode="decimal"
                            disabled={Number(line.returnableValue) <= 0}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>

          <div className="form-grid">
            <label className="field">
              <span>تاريخ المرتجع</span>
              <input className="input" type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} />
            </label>
            <label className="field wide">
              <span>السبب</span>
              <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="إعادة قياس، رفض قسم، أمر تغيير…" />
            </label>
          </div>
          <div className="chips">
            <span className="chip">{`قيمة المرتجع: ${money(totals.gross)}`}</span>
            <span className="chip">{`المحتجز المردود: ${money(totals.retention)}`}</span>
            <span className="chip on">{`صافي الإشعار الدائن: ${money(totals.net)}`}</span>
          </div>
          {overLine && <p className="alert danger">إحدى القيم تتجاوز المتاح للإرجاع على بندها.</p>}
          <div className="toolbar">
            <button className="btn primary" type="button" onClick={create} disabled={busy || chosen.length === 0 || !!overLine}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ المرتجع'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>المرتجعات</h3>
        <QueryView query={returns} empty="لا توجد مرتجعات" emptyDetail="أنشئ مرتجعاً من مستخلص مرحَّل.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number },
                { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.returnDate) },
                { key: 'reason', header: 'السبب', cell: (row) => row.reason },
                { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(row.returnValue) },
                { key: 'retention', header: 'المحتجز المردود', align: 'num', cell: (row) => money(row.retentionValue) },
                { key: 'net', header: 'صافي الإشعار', align: 'num', cell: (row) => money(row.netValue) },
                { key: 'note', header: 'إشعار دائن', cell: (row) => (row.creditNoteId ? 'مُنشأ (مسودة)' : '—') },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
                {
                  key: 'actions',
                  header: '',
                  cell: (row) => (
                    <div className="row">
                      {row.status === 'draft' && can('projects.bill.post') && (
                        <button className="btn sm primary" type="button" disabled={busy} onClick={() => act(row, 'post')}>
                          ترحيل
                        </button>
                      )}
                      {row.status === 'draft' && can('projects.manage') && (
                        <button className="btn sm danger" type="button" disabled={busy} onClick={() => act(row, 'cancel')}>
                          إلغاء
                        </button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </QueryView>
      </div>
    </Screen>
  );
}
