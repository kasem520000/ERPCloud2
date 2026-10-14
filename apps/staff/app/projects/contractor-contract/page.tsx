'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import { listParties, money, partyLabel, percent, shortDate, statusLabel, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Project = { id: string; code: string; name: string };
type ContractLine = { lineNo: number; description: string; qty: string; unitValue: string; lineValue: string };
type Payment = { id: string; number: string; kind: string; status: string; grossAmount: string; netAmount: string };
type Contract = {
  id: string;
  number: string;
  title: string;
  scope: string | null;
  status: string;
  projectId: string;
  projectName: string | null;
  contractorPartyId: string;
  contractValue: string;
  retentionPct: string;
  advanceAmount: string;
  advanceRecovered: string;
  startsOn: string | null;
  endsOn: string | null;
  lines: ContractLine[];
  payments: Payment[];
  certified: string;
  remainingValue: string;
  advanceIssued: string;
  advanceOutstanding: string;
  retentionHeld: string;
  paidNet: string;
};

type LineDraft = { description: string; qty: string; unitValue: string };

const STATUS_LABELS: Record<string, string> = { draft: 'مسودة', active: 'ساري', suspended: 'موقوف', closed: 'مغلق', cancelled: 'ملغي' };
const emptyLine = (): LineDraft => ({ description: '', qty: '1', unitValue: '' });
const lineValue = (line: LineDraft) => Number(line.qty || 0) * Number(line.unitValue || 0);

/** عقد مقاول — the subcontract behind a project: scope lines, retention and the advance. */
export default function ContractorContractPage() {
  const { can } = useSession();
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const contracts = useQuery<Contract[]>(() => apiList<Contract>('/contracting/contracts'), []);

  const [selectedId, setSelectedId] = useState('');
  const detail = useQuery<Contract | null>(() => (selectedId ? apiData<Contract>(`/contracting/contracts/${selectedId}`) : Promise.resolve(null)), [selectedId]);

  const [projectId, setProjectId] = useState('');
  const [contractorPartyId, setContractorPartyId] = useState('');
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [retentionPct, setRetentionPct] = useState('5');
  const [advanceAmount, setAdvanceAmount] = useState('0');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const filled = lines.filter((line) => line.description.trim() !== '' && line.unitValue.trim() !== '');
  const draftValue = filled.reduce((sum, line) => sum + lineValue(line), 0);
  const supplierName = (id: string) => {
    const party = (suppliers.data ?? []).find((row) => row.id === id);
    return party ? partyLabel(party) : id;
  };

  function setLine(index: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  async function create() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (!projectId || !contractorPartyId) throw new ApiError(422, 'VALIDATION_FAILED', 'اختر المشروع والمقاول.');
      if (filled.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف بنداً واحداً على الأقل بوصف وقيمة.');
      const created = await apiPost<Contract>('/contracting/contracts', {
        projectId,
        contractorPartyId,
        title: title.trim(),
        scope: scope.trim() || undefined,
        retentionPct,
        advanceAmount,
        startsOn: startsOn || undefined,
        endsOn: endsOn || undefined,
        lines: filled.map((line) => ({ description: line.description.trim(), qty: line.qty || '1', unitValue: line.unitValue })),
      });
      setNotice({ kind: 'ok', text: `تم إنشاء العقد ${created.number} بقيمة ${money(created.contractValue)} — يبدأ كمسودة حتى يُعتمد.` });
      setTitle('');
      setScope('');
      setLines([emptyLine(), emptyLine(), emptyLine()]);
      setSelectedId(created.id);
      contracts.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: 'activate' | 'close' | 'cancel', label: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost<Contract>(`/contracting/contracts/${id}/${action}`, {});
      setNotice({ kind: 'ok', text: label });
      contracts.reload();
      detail.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const current = detail.data ?? null;

  return (
    <Screen
      title="عقد مقاول"
      subtitle="عقد الباطن المرتبط بالمشروع: بنود الأعمال، نسبة الاحتجاز والدفعة المقدمة. لا تُصرف أي مستخلصات إلا بعد اعتماد العقد."
      crumbs={['إدارة المشاريع', 'العمليات']}
    >
      {notice && <Notice notice={notice} />}

      {can('projects.manage') && (
        <div className="card">
          <h3>عقد جديد</h3>
          <div className="form-grid">
            <label className="field">
              <span>المشروع</span>
              <select className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">— اختر —</option>
                {(projects.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{`${row.code} — ${row.name}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المقاول</span>
              <select className="input" value={contractorPartyId} onChange={(event) => setContractorPartyId(event.target.value)}>
                <option value="">— اختر —</option>
                {(suppliers.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{partyLabel(row)}</option>
                ))}
              </select>
            </label>
            <label className="field wide">
              <span>موضوع العقد</span>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="أعمال الهيكل الخرساني" />
            </label>
            <label className="field">
              <span>نسبة الاحتجاز %</span>
              <input className="input" value={retentionPct} onChange={(event) => setRetentionPct(event.target.value)} inputMode="decimal" />
            </label>
            <label className="field">
              <span>الدفعة المقدمة</span>
              <input className="input" value={advanceAmount} onChange={(event) => setAdvanceAmount(event.target.value)} inputMode="decimal" />
            </label>
            <label className="field">
              <span>من تاريخ</span>
              <input className="input" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
            </label>
            <label className="field">
              <span>إلى تاريخ</span>
              <input className="input" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
            </label>
            <label className="field wide">
              <span>نطاق الأعمال</span>
              <input className="input" value={scope} onChange={(event) => setScope(event.target.value)} placeholder="وصف مختصر للنطاق" />
            </label>
          </div>

          <h4>بنود العقد</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الوصف</th>
                  <th>الكمية</th>
                  <th>سعر الوحدة</th>
                  <th>القيمة</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <input className="input" value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} />
                    </td>
                    <td>
                      <input className="input" value={line.qty} onChange={(event) => setLine(index, { qty: event.target.value })} inputMode="decimal" />
                    </td>
                    <td>
                      <input className="input" value={line.unitValue} onChange={(event) => setLine(index, { unitValue: event.target.value })} inputMode="decimal" />
                    </td>
                    <td className="num">{money(lineValue(line))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button className="btn sm" type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
              إضافة سطر
            </button>
            <span className="chip">{`قيمة العقد من البنود: ${money(draftValue)}`}</span>
            <button className="btn primary" type="button" onClick={create} disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'حفظ العقد'}
            </button>
          </div>
          <p className="muted">قيمة العقد تُحسب من مجموع البنود، فلا يمكن أن يختلف رأس العقد عن تفاصيله.</p>
        </div>
      )}

      <div className="card">
        <h3>العقود</h3>
        <QueryView query={contracts} empty="لا توجد عقود مقاولين" emptyDetail="أنشئ عقداً من النموذج أعلاه.">
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => (
                  <button className="btn sm" type="button" onClick={() => setSelectedId(row.id)}>{row.number}</button>
                ) },
                { key: 'project', header: 'المشروع', cell: (row) => row.projectName ?? '—' },
                { key: 'contractor', header: 'المقاول', cell: (row) => supplierName(row.contractorPartyId) },
                { key: 'title', header: 'الموضوع', cell: (row) => row.title },
                { key: 'value', header: 'قيمة العقد', align: 'num', cell: (row) => money(row.contractValue) },
                { key: 'certified', header: 'المستخلَص', align: 'num', cell: (row) => money(row.certified) },
                { key: 'remaining', header: 'المتبقي', align: 'num', cell: (row) => money(row.remainingValue) },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STATUS_LABELS[row.status] ?? statusLabel(row.status)}</span> },
              ]}
            />
          )}
        </QueryView>
      </div>

      {current && (
        <div className="card">
          <h3>
            {current.number} — {current.title}
          </h3>
          <div className="grid cols-2">
            <div className="kpi">
              <span>قيمة العقد</span>
              <strong>{money(current.contractValue)}</strong>
            </div>
            <div className="kpi">
              <span>المستخلَص</span>
              <strong>{money(current.certified)}</strong>
            </div>
            <div className="kpi">
              <span>المتبقي</span>
              <strong>{money(current.remainingValue)}</strong>
            </div>
            <div className="kpi">
              <span>المحتجز لدى المنشأة</span>
              <strong>{money(current.retentionHeld)}</strong>
            </div>
            <div className="kpi">
              <span>الدفعة المقدمة المصروفة</span>
              <strong>{money(current.advanceIssued)}</strong>
            </div>
            <div className="kpi">
              <span>المتبقي استرداده من المقدمة</span>
              <strong>{money(current.advanceOutstanding)}</strong>
            </div>
          </div>
          <div className="chips">
            <span className="chip">{`الحالة: ${STATUS_LABELS[current.status] ?? statusLabel(current.status)}`}</span>
            <span className="chip">{`الاحتجاز: ${percent(Number(current.retentionPct) / 100)}`}</span>
            <span className="chip">{`المدة: ${current.startsOn ? shortDate(current.startsOn) : '—'} → ${current.endsOn ? shortDate(current.endsOn) : '—'}`}</span>
            <span className="chip">{`صافي المدفوع: ${money(current.paidNet)}`}</span>
          </div>
          {can('projects.manage') && (
            <div className="toolbar">
              {current.status === 'draft' && (
                <button className="btn primary" type="button" disabled={busy} onClick={() => act(current.id, 'activate', 'تم اعتماد العقد؛ يمكن الآن إصدار المستخلصات.')}>
                  اعتماد العقد
                </button>
              )}
              {current.status === 'active' && (
                <button className="btn" type="button" disabled={busy} onClick={() => act(current.id, 'close', 'تم إغلاق العقد.')}>
                  إغلاق العقد
                </button>
              )}
              {(current.status === 'draft' || current.status === 'active') && (
                <button className="btn danger" type="button" disabled={busy} onClick={() => act(current.id, 'cancel', 'تم إلغاء العقد.')}>
                  إلغاء العقد
                </button>
              )}
            </div>
          )}

          <h4>البنود</h4>
          {current.lines.length === 0 ? (
            <p className="muted">لا توجد بنود مسجلة.</p>
          ) : (
            <DataTable
              rows={current.lines}
              rowKey={(row) => String(row.lineNo)}
              columns={[
                { key: 'no', header: '#', align: 'num', cell: (row) => row.lineNo },
                { key: 'description', header: 'الوصف', cell: (row) => row.description },
                { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => row.qty },
                { key: 'unit', header: 'سعر الوحدة', align: 'num', cell: (row) => money(row.unitValue) },
                { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(row.lineValue) },
              ]}
            />
          )}

          <h4>المستخلصات وسندات الدفع</h4>
          {current.payments.length === 0 ? (
            <p className="muted">لم يصدر أي سند دفع على هذا العقد بعد.</p>
          ) : (
            <DataTable
              rows={current.payments}
              rowKey={(row) => row.id}
              columns={[
                { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number },
                { key: 'kind', header: 'النوع', cell: (row) => row.kind },
                { key: 'gross', header: 'الإجمالي', align: 'num', cell: (row) => money(row.grossAmount) },
                { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.netAmount) },
                { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
              ]}
            />
          )}
        </div>
      )}
    </Screen>
  );
}
