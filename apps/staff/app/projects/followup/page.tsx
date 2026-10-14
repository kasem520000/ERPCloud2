'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiList } from '../../../lib/api';
import { money, percent, shortDate, statusLabel } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Stage = { id: string; name: string; stageOrder: number; status: string; accreditedAt: string | null; accreditationNote: string | null };
type BoqTerm = { id: string; code: string; description: string; qty: string; unitValue: string; previouslyBilled: string; estimatedCost: string };
type Requirement = { id: string; title: string; status: string; createdAt: string };
type ProjectDetail = {
  id: string;
  code: string;
  name: string;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  contractValue: string;
  retentionPct: string;
  stages: Stage[];
  boq: BoqTerm[];
  requirements: Requirement[];
};
type Project = { id: string; code: string; name: string; status: string; contractValue: string };
type Bill = { id: string; number: string | null; billDate: string; workValue: string; retentionValue: string; netDue: string; status: string };

const STAGE_LABELS: Record<string, string> = { pending: 'لم تبدأ', in_progress: 'جارية', accredited: 'معتمدة', done: 'منجزة' };

/** Value of a BOQ term = quantity × unit value; progress is what has been billed of it. */
const termValue = (term: BoqTerm) => Number(term.qty) * Number(term.unitValue);

export default function ProjectFollowupPage() {
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const detail = useQuery<ProjectDetail | null>(() => (projectId ? apiData<ProjectDetail>(`/projects/${projectId}`) : Promise.resolve(null)), [projectId]);
  const bills = useQuery<Bill[]>(() => (projectId ? apiList<Bill>(`/projects/${projectId}/progress-bills`) : Promise.resolve([])), [projectId]);

  const project = detail.data ?? null;
  const billRows = bills.data ?? [];
  const posted = billRows.filter((bill) => bill.status !== 'draft');
  const billedValue = posted.reduce((sum, bill) => sum + Number(bill.workValue), 0);
  const retentionHeld = posted.filter((bill) => bill.status !== 'released').reduce((sum, bill) => sum + Number(bill.retentionValue), 0);
  const contractValue = Number(project?.contractValue ?? 0);
  const completion = contractValue > 0 ? billedValue / contractValue : 0;
  const boqValue = (project?.boq ?? []).reduce((sum, term) => sum + termValue(term), 0);
  const boqBilled = (project?.boq ?? []).reduce((sum, term) => sum + Number(term.previouslyBilled), 0);

  return (
    <Screen
      title="متابعة المشروع"
      subtitle="صورة تنفيذ المشروع: نسبة الإنجاز من قيمة العقد، المستخلصات المرحَّلة، المحتجز، حالة المراحل وتقدّم بنود جدول الكميات."
      crumbs={['إدارة المشاريع', 'العمليات']}
    >
      <div className="toolbar">
        <label className="field wide">
          <span>المشروع</span>
          <select className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">— اختر مشروعاً —</option>
            {(projects.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {`${row.code} — ${row.name}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!projectId && <Notice notice={{ kind: 'info', text: 'اختر مشروعاً لعرض متابعته.' }} />}

      {project && (
        <>
          <div className="card">
            <h2>
              {project.code} — {project.name}
            </h2>
            <div className="grid cols-2">
              <div className="kpi">
                <span>قيمة العقد</span>
                <strong>{money(project.contractValue)}</strong>
              </div>
              <div className="kpi">
                <span>المستخلَص (مرحَّل)</span>
                <strong>{money(billedValue)}</strong>
              </div>
              <div className="kpi">
                <span>نسبة الإنجاز</span>
                <strong>{percent(completion)}</strong>
              </div>
              <div className="kpi">
                <span>المتبقي من العقد</span>
                <strong>{money(Math.max(contractValue - billedValue, 0))}</strong>
              </div>
              <div className="kpi">
                <span>المحتجز لدى العميل</span>
                <strong>{money(retentionHeld)}</strong>
              </div>
              <div className="kpi">
                <span>نسبة الاحتجاز</span>
                <strong>{percent(Number(project.retentionPct) / 100)}</strong>
              </div>
            </div>
            <div className="chips">
              <span className="chip">{`الحالة: ${statusLabel(project.status)}`}</span>
              <span className="chip">{`من ${project.startsOn ? shortDate(project.startsOn) : '—'} إلى ${project.endsOn ? shortDate(project.endsOn) : '—'}`}</span>
              <span className="chip">{`قيمة بنود الكميات: ${money(boqValue)}`}</span>
              <span className="chip">{`المفوتر منها: ${money(boqBilled)}`}</span>
            </div>
            {contractValue > 0 && billedValue > contractValue && (
              <p className="alert warn">قيمة المستخلصات تجاوزت قيمة العقد — راجع أوامر التغيير قبل ترحيل مستخلص جديد.</p>
            )}
          </div>

          <div className="card">
            <h3>المراحل</h3>
            {project.stages.length === 0 ? (
              <p className="muted">لا توجد مراحل معرَّفة لهذا المشروع.</p>
            ) : (
              <DataTable
                rows={[...project.stages].sort((a, b) => a.stageOrder - b.stageOrder)}
                rowKey={(row) => row.id}
                columns={[
                  { key: 'order', header: '#', align: 'num', cell: (row) => row.stageOrder },
                  { key: 'name', header: 'المرحلة', cell: (row) => row.name },
                  { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{STAGE_LABELS[row.status] ?? statusLabel(row.status)}</span> },
                  { key: 'accredited', header: 'تاريخ الاعتماد', align: 'ltr', cell: (row) => (row.accreditedAt ? shortDate(row.accreditedAt) : '—') },
                  { key: 'note', header: 'ملاحظة الاعتماد', cell: (row) => row.accreditationNote ?? '—' },
                ]}
              />
            )}
          </div>

          <div className="card">
            <h3>بنود جدول الكميات</h3>
            {project.boq.length === 0 ? (
              <p className="muted">لا توجد بنود.</p>
            ) : (
              <DataTable
                rows={project.boq}
                rowKey={(row) => row.id}
                columns={[
                  { key: 'code', header: 'البند', align: 'ltr', cell: (row) => row.code },
                  { key: 'description', header: 'الوصف', cell: (row) => row.description },
                  { key: 'value', header: 'القيمة', align: 'num', cell: (row) => money(termValue(row)) },
                  { key: 'billed', header: 'المفوتر', align: 'num', cell: (row) => money(row.previouslyBilled) },
                  { key: 'remaining', header: 'المتبقي', align: 'num', cell: (row) => money(Math.max(termValue(row) - Number(row.previouslyBilled), 0)) },
                  { key: 'progress', header: 'الإنجاز', align: 'num', cell: (row) => percent(termValue(row) > 0 ? Number(row.previouslyBilled) / termValue(row) : 0) },
                ]}
              />
            )}
          </div>

          <div className="card">
            <h3>المستخلصات</h3>
            <QueryView query={bills} empty="لا توجد مستخلصات" emptyDetail="أنشئ مستخلصاً من شاشة المشروع.">
              {(rows) => (
                <DataTable
                  rows={rows}
                  rowKey={(row) => row.id}
                  columns={[
                    { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number ?? '—' },
                    { key: 'date', header: 'التاريخ', align: 'ltr', cell: (row) => shortDate(row.billDate) },
                    { key: 'work', header: 'قيمة الأعمال', align: 'num', cell: (row) => money(row.workValue) },
                    { key: 'retention', header: 'المحتجز', align: 'num', cell: (row) => money(row.retentionValue) },
                    { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.netDue) },
                    { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
                  ]}
                />
              )}
            </QueryView>
          </div>

          <div className="card">
            <h3>المتطلبات والملاحظات</h3>
            {project.requirements.length === 0 ? (
              <p className="muted">لا توجد متطلبات مسجلة.</p>
            ) : (
              <DataTable
                rows={project.requirements}
                rowKey={(row) => row.id}
                columns={[
                  { key: 'title', header: 'المتطلب', cell: (row) => row.title },
                  { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
                  { key: 'created', header: 'أُضيف', align: 'ltr', cell: (row) => shortDate(row.createdAt) },
                ]}
              />
            )}
          </div>
        </>
      )}
    </Screen>
  );
}
