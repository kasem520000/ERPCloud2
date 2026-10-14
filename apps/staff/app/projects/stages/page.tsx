'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { shortDate, statusLabel } from '../../../lib/lookups';
import {
  STAGE_REFUSALS,
  canMove,
  nextStageOrder,
  sortStages,
  stageNumbers,
  stageStatusLabel,
} from '../../../lib/project-definitions';
import { useQuery } from '../../../lib/use-query';

/**
 * 🏗️ مراحل مشروع — `Form_WPF/frmProjectStagesPM.xaml` و`Form_WPF/frmStagePM.xaml`.
 *
 * اللوحتان في المصدر: «🗂️ المجموعة» (قوالب المراحل؛ `Home.xaml:583` ⇒ `Home.xaml.cs:3750`)
 * و«الحالات» (مراحل المشروع نفسه)، وفي التذييل `✖` · `⏮` · `◀` · `▶` · `⏭` · `🖨️` · `🗑️` · `💾`
 * وهي تنقّلٌ بين السجلّات المحدَّدة — فصارت هنا تنقّلاً بين المراحل المحدَّدة نفسها،
 * وهي قاعدة «يجب تحديد المرحلة» التي يعتمد عليها الرفض في L212.
 * و`⬆️ لأعلى` و`⬇️ لأسفل` (L347/L353) تُبدّل المرحلة مع جارتها.
 *
 * وثلاثة عيوب خادمٍ كشفها الفحص الحيّ قبل بناء الشاشة، وكانت كلها 500/400:
 * حارس اسم المرحلة، وترتيب المسار `stage-templates` أمام `:id`، ومسارا النقل والحذف.
 */
type Stage = {
  id: string;
  name: string;
  stageOrder: number;
  status: string;
  accreditedAt: string | null;
  accreditationNote: string | null;
};
type Project = { id: string; code: string; name: string; status: string };
type TemplateStage = { name: string; order: number };
type StageTemplate = { id: string; name: string; stages: TemplateStage[] };
type ProjectDetail = { id: string; code: string; name: string; status: string; stages: Stage[] };

export default function ProjectStagesPage() {
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const templates = useQuery<StageTemplate[]>(() => apiList<StageTemplate>('/projects/stage-templates'), []);
  const [projectId, setProjectId] = useState('');
  const detail = useQuery<ProjectDetail | null>(
    () => (projectId ? apiData<ProjectDetail>(`/projects/${projectId}`) : Promise.resolve(null)),
    [projectId],
  );

  const [newName, setNewName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  const project = detail.data ?? null;
  const stages = useMemo(() => sortStages(project?.stages ?? []), [project]);
  const numbers = useMemo(() => stageNumbers(stages), [stages]);
  const numberById = new Map(numbers.map((row) => [row.id, row.number]));
  const template = (templates.data ?? []).find((row) => row.id === templateId);
  const selected = stages.find((stage) => stage.id === selectedId);

  function afterChange(message: string, kind: 'ok' | 'danger' | 'info' | 'warn' = 'ok') {
    setNotice({ kind, text: message });
    detail.reload();
  }

  async function guard(action: () => Promise<void>) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function addStage() {
    const name = newName.trim();
    if (!projectId) return setNotice({ kind: 'warn', text: 'اختر مشروعاً أولاً.' });
    if (!name) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.stageName });
    if (stages.some((stage) => stage.name === name)) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.duplicateStage });
    await guard(async () => {
      await apiPost(`/projects/${projectId}/stages`, { name });
      setNewName('');
      afterChange(`تمت إضافة المرحلة «${name}» في الذيل.`);
    });
  }

  async function applyTemplate() {
    if (!projectId) return setNotice({ kind: 'warn', text: 'اختر مشروعاً أولاً.' });
    if (!templateId) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.chooseTemplate });
    if (!template || template.stages.length === 0) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.chooseStageToAdd });
    if (typeof window !== 'undefined' && !window.confirm(STAGE_REFUSALS.saveTemplate)) return;
    await guard(async () => {
      // «➕ إضافة حالة» في المصدر: كلٌّ يُلحق في الذيل بترتيب max+1، والمكرّر يُتخطّى.
      let order = nextStageOrder(stages);
      let added = 0;
      for (const stage of [...template.stages].sort((left, right) => left.order - right.order)) {
        if (stages.some((row) => row.name === stage.name)) continue;
        await apiPost(`/projects/${projectId}/stages`, { name: stage.name, stageOrder: order });
        order += 1;
        added += 1;
      }
      afterChange(
        added === 0
          ? STAGE_REFUSALS.duplicateStage
          : `تمت إضافة ${added} مرحلة من «${template.name}» — ${STAGE_REFUSALS.saveTemplate}`,
        added === 0 ? 'warn' : 'ok',
      );
    });
  }

  async function shift(direction: 'up' | 'down') {
    if (!selected) return setNotice({ kind: 'warn', text: 'يجب تحديد المرحلة المراد نقلها' });
    if (!canMove(stages, selected.id, direction)) return setNotice({ kind: 'warn', text: 'المرحلة على الطرف — لا جارَ لها في هذا الاتجاه.' });
    await guard(async () => {
      await apiPost(`/projects/stages/${selected.id}/move`, { direction });
      afterChange(direction === 'up' ? '⬆️ تحرّكت المرحلة لأعلى.' : '⬇️ تحرّكت المرحلة لأسفل.');
    });
  }

  async function remove(stage?: Stage) {
    // «يجب تحديد المرحلة المراد إلغاها» — نصّ الرفض من `frmProjectStagesPM.xaml.cs:212`.
    if (!stage) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.chooseStageToRemove });
    if (typeof window !== 'undefined' && !window.confirm(`هل تريد حذف المرحلة «${stage.name}»؟`)) return;
    await guard(async () => {
      await apiDelete(`/projects/stages/${stage.id}`);
      setSelectedId('');
      afterChange(`تم حذف المرحلة «${stage.name}» وإعادة ترقيم البقية.`);
    });
  }

  async function rename(stage: Stage) {
    if (typeof window === 'undefined') return;
    const name = window.prompt('اسم المرحلة', stage.name);
    if (name === null) return;
    if (!name.trim()) return setNotice({ kind: 'warn', text: STAGE_REFUSALS.stageName });
    const trimmed = name.trim();
    await guard(async () => {
      await apiPatch(`/projects/stages/${stage.id}`, { name: trimmed });
      afterChange(`تم حفظ اسم المرحلة «${trimmed}».`);
    });
  }

  async function accredit(stage: Stage) {
    const note = typeof window === 'undefined' ? undefined : window.prompt('ملاحظة الاعتماد') ?? undefined;
    await guard(async () => {
      await apiPost(`/projects/stages/${stage.id}/accredit`, { note });
      afterChange(`تم اعتماد المرحلة «${stage.name}».`);
    });
  }

  const focusOn = (index: number) => {
    const target = stages[index];
    if (!target) return;
    setSelectedId(target.id);
    setNotice({ kind: 'info', text: `المرحلة المحدَّدة: ${target.name}` });
  };

  return (
    <Screen
      title="مراحل مشروع"
      subtitle="مراحل تنفيذ المشروع بترتيبها، ومنها تُبنى نسب الإنجاز في المستخلصات. والمجموعة الجاهزة تُنسخ إلى المشروع ثم تُعدَّل بحرّية."
      crumbs={['إدارة المشاريع', 'التعريفات']}
    >
      <div className="card">
        <h3>المشروع والمجموعة</h3>
        <div className="toolbar">
          <label className="field wide">
            <span>المشروع</span>
            <select
              className="input"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSelectedId('');
                setNotice(undefined);
              }}
            >
              <option value="">— اختر مشروعاً —</option>
              {(projects.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {`${row.code} — ${row.name}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            <span>🗂️ المجموعة</span>
            <select className="input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">— بلا مجموعة —</option>
              {(templates.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {`${row.name} (${row.stages.length} مرحلة)`}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={() => void applyTemplate()} disabled={busy || !projectId}>
            💾 حفظ مراحل المجموعة
          </button>
        </div>
      </div>

      {notice && <Notice notice={notice} />}
      {!projectId && <Notice notice={{ kind: 'info', text: 'اختر مشروعاً لعرض مراحله.' }} />}

      {project && (
        <QueryView query={detail} empty="لا توجد بيانات">
          {() => (
            <>
              <div className="card">
                <h3>➕ إضافة حالة</h3>
                <div className="toolbar">
                  <label className="field wide">
                    <span>اسم المرحلة</span>
                    <input
                      className="input"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void addStage();
                      }}
                    />
                  </label>
                  <button className="btn primary" type="button" onClick={() => void addStage()} disabled={busy}>
                    ➕ إضافة حالة
                  </button>
                </div>
              </div>

              <div className="toolbar">
                <button className="btn" type="button" onClick={() => focusOn(0)} disabled={stages.length === 0}>
                  ⏮
                </button>
                <button className="btn" type="button" onClick={() => focusOn(stages.findIndex((row) => row.id === selectedId) - 1)} disabled={!selected || stages[0]?.id === selectedId}>
                  ◀
                </button>
                <button className="btn" type="button" onClick={() => focusOn(stages.findIndex((row) => row.id === selectedId) + 1)} disabled={!selected || stages[stages.length - 1]?.id === selectedId}>
                  ▶
                </button>
                <button className="btn" type="button" onClick={() => focusOn(stages.length - 1)} disabled={stages.length === 0}>
                  ⏭
                </button>
                <button className="btn" type="button" onClick={() => window.print()} disabled={stages.length === 0}>
                  🖨️ طباعة
                </button>
                <button className="btn" type="button" onClick={() => void shift('up')} disabled={busy || !selected}>
                  ⬆️ لأعلى
                </button>
                <button className="btn" type="button" onClick={() => void shift('down')} disabled={busy || !selected}>
                  ⬇️ لأسفل
                </button>
                <button className="btn danger" type="button" onClick={() => void remove(selected)} disabled={busy}>
                  🗑️ حذف
                </button>
              </div>

              <div className="card">
                <div className="chips">
                  <span className="chip">{`${project.code} — ${project.name}`}</span>
                  <span className="chip">{`المراحل: ${stages.length}`}</span>
                  <span className="chip">{`المعتمدة: ${stages.filter((stage) => stage.status === 'accredited').length}`}</span>
                  <span className="chip">{`المحدَّدة: ${selected?.name ?? '—'}`}</span>
                </div>
                {stages.length === 0 && <Notice notice={{ kind: 'info', text: 'لا توجد مراحل لهذا المشروع بعد — أضف الحالة الأولى أو انسخ «🗂️ المجموعة».' }} />}

                <DataTable<Stage>
                  rows={stages}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => setSelectedId(row.id)}
                  activeKey={selectedId}
                  columns={[
                    { key: 'order', header: '🔢 الرقم', align: 'num', cell: (row) => numberById.get(row.id) ?? row.stageOrder },
                    { key: 'name', header: '📝 اسم المرحلة', cell: (row) => row.name },
                    { key: 'state', header: 'الحالة', cell: (row) => <span className="badge">{stageStatusLabel(row.status)}</span> },
                    {
                      key: 'accredited',
                      header: 'الاعتماد',
                      cell: (row) =>
                        row.accreditedAt ? <span className="badge ok">{shortDate(row.accreditedAt)}</span> : <span className="muted">—</span>,
                    },
                    { key: 'note', header: 'ملاحظة الاعتماد', cell: (row) => row.accreditationNote ?? '—' },
                    {
                      key: '__actions',
                      header: '',
                      cell: (row) => (
                        <span className="row">
                          <button className="btn sm" type="button" onClick={() => void rename(row)} disabled={busy}>
                            تعديل الاسم
                          </button>
                          <button className="btn sm" type="button" onClick={() => void accredit(row)} disabled={busy || row.status === 'accredited'}>
                            اعتماد
                          </button>
                          <button className="btn sm danger" type="button" onClick={() => void remove(row)} disabled={busy}>
                            🗑️
                          </button>
                        </span>
                      ),
                    },
                  ]}
                />
              </div>

              <p className="muted">
                حالة المشروع: {statusLabel(project.status)}. الترتيب يُحفظ بالتزحيف داخل معاملة واحدة، فيبقى الترقيم 1..n بلا فجوة عند النقل والحذف.
              </p>
            </>
          )}
        </QueryView>
      )}
    </Screen>
  );
}
