'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { STAGE_REFUSALS, boqLineValue, boqSum, missingBoqField } from '../../../lib/project-definitions';
import { useQuery } from '../../../lib/use-query';

/**
 * 📋 بطاقة بند — `Form_WPF/frmTermsPM.xaml` (‏`Home.xaml:580` ⇒ `Home.xaml.cs:3731`).
 * العنوان في النافذة «بنـــد»، وشجرة البنود في يمينها (`PM_Terms` بحقل `ParentCode`)،
 * وحقولها: «📑 نوع البند» (رئيسي/فرعي) · «🔢 الرقم» · «📝 الاسم» · الكمية والسعر والمدة ·
 * «معفي من الضريبة»، وأزرارها `➕` · `✏️` · `🗑️ حذف` · `💾 حفظ`.
 *
 * والرفض بنصّه من `frmTermsPM.xaml.cs`: L244 «من فضلك أدخل رقم البند» · L249 «من فضلك
 * أدخل اسم البند» · L270 «كود البند مدخل مسبقاً»، وترقيم البند الجديد `MAX(Code)+1` (L215)
 * صار هنا اقتراحاً في الحقل لا حكماً عليه.
 */
type BoqTerm = {
  id: string;
  code: string;
  description: string;
  qty: string;
  unitValue: string;
  estimatedCost: string;
  executionPeriod: string | null;
  previouslyBilled: string;
};
type Project = { id: string; code: string; name: string };
type ProjectDetail = { id: string; code: string; name: string; boq: BoqTerm[] };

const emptyDraft = { code: '', description: '', qty: '1', unitValue: '', estimatedCost: '', executionPeriod: '' };

export default function BoqPage() {
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const detail = useQuery<ProjectDetail | null>(
    () => (projectId ? apiData<ProjectDetail>(`/projects/${projectId}`) : Promise.resolve(null)),
    [projectId],
  );

  const [draft, setDraft] = useState({ ...emptyDraft });
  const [editingId, setEditingId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  const project = detail.data ?? null;
  const terms = useMemo(() => [...(project?.boq ?? [])].sort((left, right) => left.code.localeCompare(right.code, 'ar', { numeric: true })), [project]);
  const selected = terms.find((term) => term.id === selectedId);
  const boqValue = boqSum(terms);
  // «🔢 الرقم» التالي: `MAX(Code)+1` — اقتراحٌ يمكن تجاوزه، ورمزٌ مكرّر يُردّ 409.
  const suggestedCode = useMemo(() => {
    const numbers = terms.map((term) => Number(term.code)).filter((value) => Number.isFinite(value));
    return String(numbers.length > 0 ? Math.max(...numbers) + 1 : 1);
  }, [terms]);

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

  function resetDraft() {
    setEditingId('');
    setDraft({ ...emptyDraft, code: suggestedCode });
  }

  function startEdit(term: BoqTerm) {
    setEditingId(term.id);
    setDraft({
      code: term.code,
      description: term.description,
      qty: term.qty,
      unitValue: term.unitValue,
      estimatedCost: term.estimatedCost,
      executionPeriod: term.executionPeriod ?? '',
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save() {
    if (!projectId) return setNotice({ kind: 'warn', text: 'اختر مشروعاً أولاً.' });
    const missing = missingBoqField(draft);
    if (missing) return setNotice({ kind: 'warn', text: missing });
    if (!draft.unitValue.trim()) return setNotice({ kind: 'warn', text: 'من فضلك أدخل سعر البيع' });
    await guard(async () => {
      const body = {
        code: draft.code.trim(),
        description: draft.description.trim(),
        qty: draft.qty.trim() || undefined,
        unitValue: draft.unitValue.trim(),
        estimatedCost: draft.estimatedCost.trim() || undefined,
        executionPeriod: draft.executionPeriod.trim() || undefined,
      };
      if (editingId) {
        await apiPatch(`/projects/boq/${editingId}`, body);
        afterChange(`تم حفظ البند «${body.code}».`);
      } else {
        await apiPost(`/projects/${projectId}/boq`, body);
        afterChange(`تم حفظ البند «${body.code}».`);
      }
      resetDraft();
    });
  }

  async function remove(term: BoqTerm) {
    if (typeof window === 'undefined') return;
    if (!window.confirm(`هل تريد حذف البند «${term.code} — ${term.description}»؟`)) return;
    await guard(async () => {
      await apiDelete(`/projects/boq/${term.id}`);
      if (editingId === term.id) resetDraft();
      if (selectedId === term.id) setSelectedId('');
      afterChange(`تم حذف البند «${term.code}».`);
    });
  }

  const focus = (index: number) => {
    const target = terms[index];
    if (!target) return;
    setSelectedId(target.id);
    setNotice({ kind: 'info', text: `البند المحدَّد: ${target.code} — ${target.description}` });
  };

  return (
    <Screen
      title="بطاقة بند"
      subtitle="بنود جدول الكميات للمشروع: الرقم والاسم والكمية وسعر البيع والمدة، ومنها تُبنى قيم المستخلصات. والبند الفرعي يُنسَب إلى بنده الرئيسي."
      crumbs={['إدارة المشاريع', 'التعريفات']}
    >
      <div className="card">
        <h3>المشروع</h3>
        <div className="toolbar">
          <label className="field wide">
            <span>المشروع</span>
            <select
              className="input"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSelectedId('');
                resetDraft();
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
        </div>
      </div>

      {notice && <Notice notice={notice} />}
      {!projectId && <Notice notice={{ kind: 'info', text: 'اختر مشروعاً لعرض بنوده.' }} />}

      {project && (
        <QueryView query={detail} empty="لا توجد بيانات">
          {() => (
            <>
              <div className="card">
                <h3>{editingId ? `✏️ تعديل البند` : '➕ بند جديد'}</h3>
                <div className="form-grid">
                  <label className="field">
                    <span>🔢 الرقم</span>
                    <input
                      className="input ltr"
                      dir="ltr"
                      value={draft.code}
                      onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                    />
                  </label>
                  <label className="field wide">
                    <span>📝 الاسم</span>
                    <input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>الكمية</span>
                    <input
                      className="input ltr"
                      dir="ltr"
                      value={draft.qty}
                      onChange={(event) => setDraft({ ...draft, qty: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>سعر البيع</span>
                    <input
                      className="input ltr"
                      dir="ltr"
                      value={draft.unitValue}
                      onChange={(event) => setDraft({ ...draft, unitValue: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>التكلفة التقديرية</span>
                    <input
                      className="input ltr"
                      dir="ltr"
                      value={draft.estimatedCost}
                      onChange={(event) => setDraft({ ...draft, estimatedCost: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>مدة التنفيذ</span>
                    <input
                      className="input"
                      value={draft.executionPeriod}
                      onChange={(event) => setDraft({ ...draft, executionPeriod: event.target.value })}
                    />
                  </label>
                  <div className="field">
                    <span>قيمة البند</span>
                    <strong className="ltr" dir="ltr">
                      {money(boqLineValue(draft.qty, draft.unitValue))}
                    </strong>
                  </div>
                </div>
                <div className="toolbar">
                  <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
                    💾 حفظ
                  </button>
                  <button className="btn" type="button" onClick={resetDraft} disabled={busy}>
                    {editingId ? '✖ إلغاء التعديل' : '✖ تفريغ'}
                  </button>
                  {!editingId && (
                    <button className="btn" type="button" onClick={() => setDraft({ ...draft, code: suggestedCode })} disabled={busy}>
                      {`اقترح الرقم ${suggestedCode}`}
                    </button>
                  )}
                </div>
              </div>

              <div className="toolbar">
                <button className="btn" type="button" onClick={() => focus(0)} disabled={terms.length === 0}>
                  ⏮
                </button>
                <button className="btn" type="button" onClick={() => focus(terms.findIndex((row) => row.id === selectedId) - 1)} disabled={!selected || terms[0]?.id === selectedId}>
                  ◀
                </button>
                <button className="btn" type="button" onClick={() => focus(terms.findIndex((row) => row.id === selectedId) + 1)} disabled={!selected || terms[terms.length - 1]?.id === selectedId}>
                  ▶
                </button>
                <button className="btn" type="button" onClick={() => focus(terms.length - 1)} disabled={terms.length === 0}>
                  ⏭
                </button>
                <button className="btn" type="button" onClick={() => window.print()} disabled={terms.length === 0}>
                  🖨️ طباعة
                </button>
                <button className="btn danger" type="button" onClick={() => void remove(selected as BoqTerm)} disabled={busy || !selected}>
                  🗑️ حذف
                </button>
                {editingId && selected && (
                  <button className="btn" type="button" onClick={() => startEdit(selected)} disabled={busy}>
                    ✏️ تعديل البند المحدَّد
                  </button>
                )}
              </div>

              <div className="card">
                <div className="chips">
                  <span className="chip">{`${project.code} — ${project.name}`}</span>
                  <span className="chip">{`عدد البنود: ${terms.length}`}</span>
                  <span className="chip">{`إجمالي البنود: ${money(boqValue)}`}</span>
                  <span className="chip">{`المفوتر منها: ${money(boqSum(terms.map((term) => ({ qty: '1', unitValue: term.previouslyBilled }))))}`}</span>
                </div>
                {terms.length === 0 && <Notice notice={{ kind: 'info', text: 'لا توجد بنود لهذا المشروع بعد — أضف البند الأول من الأعلى.' }} />}

                <DataTable<BoqTerm>
                  rows={terms}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => setSelectedId(row.id)}
                  activeKey={selectedId}
                  columns={[
                    { key: 'code', header: '🔢 الرقم', align: 'ltr', cell: (row) => row.code },
                    { key: 'name', header: '📝 الاسم', cell: (row) => row.description },
                    { key: 'qty', header: 'الكمية', align: 'num', cell: (row) => row.qty },
                    { key: 'price', header: 'سعر البيع', align: 'num', cell: (row) => money(row.unitValue) },
                    { key: 'value', header: 'قيمة البند', align: 'num', cell: (row) => money(boqLineValue(row.qty, row.unitValue)) },
                    { key: 'cost', header: 'التكلفة التقديرية', align: 'num', cell: (row) => money(row.estimatedCost) },
                    { key: 'billed', header: 'المفوتر سابقاً', align: 'num', cell: (row) => money(row.previouslyBilled) },
                    { key: 'period', header: 'مدة التنفيذ', cell: (row) => row.executionPeriod ?? '—' },
                    {
                      key: '__actions',
                      header: '',
                      cell: (row) => (
                        <span className="row">
                          <button className="btn sm" type="button" onClick={() => startEdit(row)} disabled={busy}>
                            ✏️
                          </button>
                          <button className="btn sm danger" type="button" onClick={() => void remove(row)} disabled={busy}>
                            🗑️
                          </button>
                        </span>
                      ),
                    },
                  ]}
                  footer={[
                    'الإجمالي',
                    '',
                    '',
                    '',
                    money(boqValue),
                    money(boqSum(terms.map((term) => ({ qty: '1', unitValue: term.estimatedCost })))),
                    money(boqSum(terms.map((term) => ({ qty: '1', unitValue: term.previouslyBilled })))),
                    '',
                    '',
                  ]}
                />
              </div>

              <p className="muted">
                «المفوتر سابقاً» يُكتب من المستخلصات المرحَّلة، ولا يُحرَّر من هذه الشاشة — كما في النافذة: البند يُعرَّف هنا ويُستهلك في المستخلص.
                و{STAGE_REFUSALS.boqCode} و{STAGE_REFUSALS.boqName} رفضٌ من الشاشة قبل الطلب.
              </p>
            </>
          )}
        </QueryView>
      )}
    </Screen>
  );
}
