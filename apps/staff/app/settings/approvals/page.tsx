'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Forbidden, Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import {
  deactivateApprovalWorkflow,
  listApprovalWorkflows,
  saveApprovalWorkflow,
  type ApprovalCondition,
  type ApprovalEntity,
  type ApprovalStep,
  type ApprovalWorkflow,
  type ApprovalWorkflowInput,
} from '../../../lib/approvals';
import { useSession } from '../../../lib/session';

const entityLabels: Record<ApprovalEntity, string> = {
  sales_invoice: 'فاتورة مبيعات',
  purchase_invoice: 'فاتورة مشتريات',
  voucher: 'سند خزينة',
  expense: 'مصروف',
  leave: 'إجازة',
};

type NoticeState = { kind: 'ok' | 'danger' | 'info' | 'warn'; text: string };
type DraftStep = {
  approver_role: string;
  approver_user_id: string;
  min_amount: string;
  max_amount: string;
  branch_id: string;
  cost_center_id: string;
  action: 'approve' | 'notify';
};

const emptyStep = (): DraftStep => ({
  approver_role: '',
  approver_user_id: '',
  min_amount: '',
  max_amount: '',
  branch_id: '',
  cost_center_id: '',
  action: 'approve',
});

function stepToDraft(step: ApprovalStep): DraftStep {
  return {
    approver_role: step.approverRole ?? '',
    approver_user_id: step.approverUserId ?? '',
    min_amount: step.condition.min_amount === undefined ? '' : String(step.condition.min_amount),
    max_amount: step.condition.max_amount === undefined ? '' : String(step.condition.max_amount),
    branch_id: step.condition.branch_id ?? '',
    cost_center_id: step.condition.cost_center_id ?? '',
    action: step.action,
  };
}

export default function ApprovalSettingsPage() {
  const { can } = useSession();
  const [workflows, setWorkflows] = useState<ApprovalWorkflow[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [entity, setEntity] = useState<ApprovalEntity>('purchase_invoice');
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const [notice, setNotice] = useState<NoticeState>();
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => setWorkflows(await listApprovalWorkflows());

  useEffect(() => {
    void reload().catch((error: unknown) =>
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }),
    );
  }, []);

  if (!can('approval.manage')) {
    return (
      <Screen title="مسارات الموافقات" subtitle="إدارة التسلسل والشروط لكل مستند." crumbs={['الإعدادات', 'الموافقات']}>
        <Forbidden />
      </Screen>
    );
  }

  const reset = (): void => {
    setEditingId(undefined);
    setEntity('purchase_invoice');
    setName('');
    setActive(true);
    setSteps([emptyStep()]);
  };

  const edit = (workflow: ApprovalWorkflow): void => {
    setEditingId(workflow.id);
    setEntity(workflow.entity);
    setName(workflow.name);
    setActive(workflow.isActive);
    setSteps(workflow.steps.map(stepToDraft));
    setNotice(undefined);
  };

  const updateStep = (index: number, patch: Partial<DraftStep>): void =>
    setSteps((current) => current.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)));

  const buildInput = (): ApprovalWorkflowInput => ({
    entity,
    name: name.trim(),
    is_active: active,
    steps: steps.map((step, index) => {
      const condition: ApprovalCondition = {};
      if (step.min_amount.trim()) condition.min_amount = step.min_amount.trim();
      if (step.max_amount.trim()) condition.max_amount = step.max_amount.trim();
      if (step.branch_id.trim()) condition.branch_id = step.branch_id.trim();
      if (step.cost_center_id.trim()) condition.cost_center_id = step.cost_center_id.trim();
      return {
        step_order: index + 1,
        ...(step.approver_role.trim() ? { approver_role: step.approver_role.trim() } : {}),
        ...(step.approver_user_id.trim() ? { approver_user_id: step.approver_user_id.trim() } : {}),
        condition,
        action: step.action,
        is_required: true,
      };
    }),
  });

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      await saveApprovalWorkflow(buildInput(), editingId);
      await reload();
      reset();
      setNotice({ kind: 'ok', text: 'تم حفظ مسار الموافقات.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (workflow: ApprovalWorkflow): Promise<void> => {
    setBusy(true);
    try {
      await deactivateApprovalWorkflow(workflow.id);
      await reload();
      setNotice({ kind: 'ok', text: 'تم إيقاف المسار مع إبقاء سجله.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="مسارات الموافقات"
      subtitle="قائمة خطوات مرتبة: عندما ينطبق الشرط، يتوقف الترحيل حتى يقرر المراجع الحالي."
      crumbs={['الإعدادات', 'الموافقات']}
      actions={<span className="chip">{workflows.length} مسار</span>}
    >
      <Notice notice={notice} />

      <section className="card grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="m-0">{editingId ? 'تعديل مسار' : 'مسار جديد'}</h2>
            <p className="muted m-0">لا توجد موافقات متوازية؛ التنفيذ متسلسل من الأعلى إلى الأسفل.</p>
          </div>
          {editingId ? <button className="btn" type="button" onClick={reset}>إلغاء التعديل</button> : null}
        </div>
        <div className="form-grid">
          <label className="field">
            <span>نوع المستند</span>
            <select value={entity} onChange={(event) => setEntity(event.target.value as ApprovalEntity)}>
              {(Object.keys(entityLabels) as ApprovalEntity[]).map((key) => <option key={key} value={key}>{entityLabels[key]}</option>)}
            </select>
          </label>
          <label className="field wide">
            <span>اسم المسار</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="مثال: مشتريات أعلى من 5,000" />
          </label>
          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
            <span>مسار نشط</span>
          </label>
        </div>

        <div className="grid gap-3">
          <h3 className="m-0">الخطوات</h3>
          {steps.map((step, index) => (
            <div className="rounded-xl border border-line bg-surface-2 p-3 grid gap-3" key={index}>
              <div className="flex items-center justify-between gap-2">
                <strong>الخطوة {index + 1}</strong>
                {steps.length > 1 ? <button className="btn" type="button" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}>حذف</button> : null}
              </div>
              <div className="form-grid">
                <label className="field"><span>دور المراجع</span><input value={step.approver_role} onChange={(event) => updateStep(index, { approver_role: event.target.value })} placeholder="Accountant أو مدير" /></label>
                <label className="field"><span>معرّف المستخدم (اختياري)</span><input dir="ltr" value={step.approver_user_id} onChange={(event) => updateStep(index, { approver_user_id: event.target.value })} placeholder="UUID" /></label>
                <label className="field"><span>الحد الأدنى</span><input dir="ltr" value={step.min_amount} onChange={(event) => updateStep(index, { min_amount: event.target.value })} placeholder="10000" /></label>
                <label className="field"><span>الحد الأعلى</span><input dir="ltr" value={step.max_amount} onChange={(event) => updateStep(index, { max_amount: event.target.value })} placeholder="اتركه بلا حد" /></label>
                <label className="field"><span>معرّف الفرع (اختياري)</span><input dir="ltr" value={step.branch_id} onChange={(event) => updateStep(index, { branch_id: event.target.value })} placeholder="UUID" /></label>
                <label className="field"><span>مركز التكلفة (اختياري)</span><input dir="ltr" value={step.cost_center_id} onChange={(event) => updateStep(index, { cost_center_id: event.target.value })} placeholder="UUID" /></label>
                <label className="field"><span>الإجراء</span><select value={step.action} onChange={(event) => updateStep(index, { action: event.target.value as 'approve' | 'notify' })}><option value="approve">موافقة مطلوبة</option><option value="notify">إشعار فقط</option></select></label>
              </div>
            </div>
          ))}
          <div className="toolbar">
            <button className="btn" type="button" onClick={() => setSteps((current) => [...current, emptyStep()])}>+ إضافة خطوة</button>
            <button className="btn primary" type="button" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'جارٍ الحفظ…' : 'حفظ المسار'}</button>
          </div>
        </div>
      </section>

      <section className="card grid gap-3">
        <h2 className="m-0">المسارات الحالية</h2>
        {workflows.length === 0 ? <p className="muted m-0">لا توجد مسارات بعد.</p> : workflows.map((workflow) => (
          <article className="rounded-xl border border-line p-4 grid gap-2" key={workflow.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><strong>{workflow.name}</strong><span className="muted"> · {entityLabels[workflow.entity]}</span></div>
              <span className={`chip ${workflow.isActive ? 'success' : ''}`}>{workflow.isActive ? 'نشط' : 'متوقف'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {workflow.steps.map((step) => <span className="chip" key={step.id}>{step.stepOrder}. {step.approverRole ?? step.approverUserId ?? '—'} · {step.action === 'approve' ? 'موافقة' : 'إشعار'}</span>)}
            </div>
            <div className="toolbar"><button className="btn" type="button" onClick={() => edit(workflow)}>تعديل</button>{workflow.isActive ? <button className="btn" type="button" onClick={() => void deactivate(workflow)}>إيقاف</button> : null}</div>
          </article>
        ))}
      </section>
    </Screen>
  );
}
