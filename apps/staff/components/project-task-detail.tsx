'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiError } from '../lib/api';
import {
  addDependency,
  loadBoard,
  logTaskTime,
  priorityLabel,
  readTask,
  taskStatusLabel,
  updateTask,
  type ProjectBoard,
  type ProjectTask,
  type TaskDependency,
  type TimeLog,
} from '../lib/project-kanban';
import { useSession } from '../lib/session';

import { CommentsPanel } from './comments-panel';
import { Notice } from './data-view';
import { ErrorBox, Loading, Screen } from './screen';

export function ProjectTaskDetail({ taskId, projectId }: { taskId: string; projectId?: string }) {
  const { can } = useSession();
  const [task, setTask] = useState<(ProjectTask & { logs: TimeLog[]; dependencies: TaskDependency[] }) | null>(null);
  const [board, setBoard] = useState<ProjectBoard>();
  const [hours, setHours] = useState('2');
  const [note, setNote] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function reload(id = task?.projectId ?? projectId) {
    const next = await readTask(taskId);
    setTask(next);
    if (id || next.projectId) setBoard(await loadBoard(id || next.projectId));
  }

  useEffect(() => {
    void reload(projectId).catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)));
  }, [taskId, projectId]);

  async function save(patch: Record<string, unknown>, ok: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await updateTask(taskId, patch);
      setNotice({ kind: 'ok', text: ok });
      await reload();
    } catch (reason) {
      setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  if (error && !task) {
    return (
      <Screen title="مهمة" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={error} onRetry={() => void reload()} />
      </Screen>
    );
  }
  if (!task) return <Loading />;
  if (projectId && task.projectId !== projectId) {
    return (
      <Screen title="مهمة" crumbs={['إدارة المشاريع']}>
        <ErrorBox message="المهمة ليست في هذا المشروع" />
      </Screen>
    );
  }

  const siblings = (board?.tasks ?? []).filter((item) => item.id !== task.id);

  return (
    <Screen
      title={task.title}
      subtitle={`${taskStatusLabel[task.status] ?? task.status} · ${task.assigneeName ?? 'بلا مكلّف'}`}
      crumbs={['إدارة المشاريع']}
      actions={<Link className="btn" href={`/projects/${task.projectId}/board`}>اللوحة</Link>}
    >
      <Notice notice={notice} />
      {can('projects.tasks.manage') ? (
        <div className="card grid gap-3 md:grid-cols-2">
          <label className="field">
            <span>الحالة</span>
            <select value={task.status} onChange={(event) => void save({ status: event.target.value }, 'تغيّرت الحالة.')}>
              {Object.entries(taskStatusLabel).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الأولوية</span>
            <select value={task.priority} onChange={(event) => void save({ priority: event.target.value }, 'تغيّرت الأولوية.')}>
              {Object.entries(priorityLabel).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>البداية</span>
            <input type="date" value={task.startDate ?? ''} onChange={(event) => void save({ startDate: event.target.value }, 'تغيّر التاريخ.')} />
          </label>
          <label className="field">
            <span>الاستحقاق</span>
            <input type="date" value={task.dueDate ?? ''} onChange={(event) => void save({ dueDate: event.target.value }, 'تغيّر التاريخ.')} />
          </label>
          <label className="field">
            <span>ساعات مخططة</span>
            <input defaultValue={task.estimatedHours} onBlur={(event) => void save({ estimatedHours: event.target.value }, 'تغيّر المخطط.')} />
          </label>
          <label className="field">
            <span>مصاريف المهمة</span>
            <input defaultValue={task.expenseValue} onBlur={(event) => void save({ expenseValue: event.target.value }, 'تغيّرت المصاريف.')} />
          </label>
          <label className="field">
            <span>بند جدول الكميات</span>
            <select value={task.boqTermId ?? ''} onChange={(event) => void save({ boqTermId: event.target.value }, 'رُبط البند.')}>
              <option value="">بدون</option>
              {(board?.boq ?? []).map((term) => (
                <option key={term.id} value={term.id}>{term.code} — {term.description}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>تعتمد على</span>
            <select value={dependsOn} onChange={(event) => setDependsOn(event.target.value)}>
              <option value="">اختر مهمة</option>
              {siblings.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            type="button"
            disabled={busy || !dependsOn}
            onClick={() =>
              void addDependency(task.id, dependsOn)
                .then(() => reload())
                .then(() => setNotice({ kind: 'ok', text: 'أُضيف الاعتماد.' }))
                .catch((reason: unknown) => setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) }))
            }
          >
            إضافة اعتماد
          </button>
        </div>
      ) : null}
      <div className="card">
        <p>فعلي {task.actualHours} ساعة من {task.estimatedHours} مخططة.</p>
        {can('projects.time_logs.manage') ? (
          <div className="grid gap-3 md:grid-cols-3">
            <input value={hours} onChange={(event) => setHours(event.target.value)} />
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="ملاحظة" />
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void logTaskTime(task.id, { hours, note })
                  .then(() => reload())
                  .catch((reason: unknown) => setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) }))
              }
            >
              تسجيل وقت
            </button>
          </div>
        ) : null}
        {task.logs.map((entry) => (
          <p key={entry.id} className="muted">{entry.logDate} · {entry.hours} س · {entry.note ?? ''}</p>
        ))}
      </div>
      <CommentsPanel entityType="project_task" entityId={task.id} />
    </Screen>
  );
}
