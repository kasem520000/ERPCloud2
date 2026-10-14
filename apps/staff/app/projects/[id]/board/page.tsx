'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Notice } from '../../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { ApiError, apiPost } from '../../../../lib/api';
import {
  createTask,
  loadBoard,
  moveTask,
  priorityLabel,
  taskStatusLabel,
  type ProjectBoard,
  type ProjectTask,
} from '../../../../lib/project-kanban';
import { useSession } from '../../../../lib/session';

export default function ProjectBoardPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id);
  const { can } = useSession();
  const [board, setBoard] = useState<ProjectBoard>();
  const [title, setTitle] = useState('');
  const [stageId, setStageId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  async function reload() {
    const next = await loadBoard(projectId);
    setBoard(next);
    setStageId((current) => current || next.stages[0]?.id || '');
  }

  useEffect(() => {
    void reload().catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)));
  }, [projectId]);

  async function addTask() {
    setBusy(true);
    setNotice(undefined);
    try {
      await createTask(projectId, { title, stageId: stageId || undefined, assigneeId: assigneeId || undefined });
      setTitle('');
      setNotice({ kind: 'ok', text: 'أُضيفت المهمة إلى العمود.' });
      await reload();
    } catch (reason) {
      setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function drop(task: ProjectTask, nextStageId: string) {
    if (!can('projects.tasks.manage') || task.stageId === nextStageId) return;
    setBusy(true);
    try {
      const count = board?.tasks.filter((item) => item.stageId === nextStageId).length ?? 0;
      await moveTask(task.id, nextStageId, count);
      await reload();
    } catch (reason) {
      setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function addColumns() {
    setBusy(true);
    try {
      for (const name of ['قيد الانتظار', 'قيد التنفيذ', 'منجز']) {
        await apiPost(`/projects/${projectId}/stages`, { name });
      }
      await reload();
    } catch (reason) {
      setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  if (error && !board) {
    return (
      <Screen title="لوحة كانبان" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={error} onRetry={() => void reload()} />
      </Screen>
    );
  }
  if (!board) return <Loading />;

  return (
    <Screen
      title={`لوحة ${board.project.name}`}
      subtitle="الأعمدة هي مراحل المشروع. اسحب البطاقة لتغيير المرحلة."
      crumbs={['إدارة المشاريع', board.project.code]}
      actions={
        <>
          <Link className="btn" href={`/projects/${projectId}/gantt`}>جانت</Link>
          <Link className="btn" href={`/projects/${projectId}/time`}>الوقت</Link>
          <Link className="btn" href={`/projects/${projectId}/cost`}>التكلفة</Link>
        </>
      }
    >
      <Notice notice={notice} />
      {board.stages.length === 0 ? (
        <div className="card">
          <p>لا مراحل بعد. الأعمدة الثلاثة تُنشأ من مراحل المشروع.</p>
          {can('projects.manage') ? (
            <button className="btn primary" type="button" disabled={busy} onClick={() => void addColumns()}>
              إنشاء الأعمدة الثلاثة
            </button>
          ) : null}
        </div>
      ) : null}
      {can('projects.tasks.manage') && board.stages.length > 0 ? (
        <div className="card">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="field">
              <span>المهمة</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="صب القواعد" />
            </label>
            <label className="field">
              <span>العمود</span>
              <select value={stageId} onChange={(event) => setStageId(event.target.value)}>
                {board.stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المكلّف</span>
              <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                <option value="">بدون</option>
                {board.assignees.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn primary" type="button" disabled={busy || !title.trim()} onClick={() => void addTask()}>
            إضافة مهمة
          </button>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        {board.stages.map((stage) => (
          <section
            key={stage.id}
            className="card"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const taskId = event.dataTransfer.getData('text/plain');
              const task = board.tasks.find((item) => item.id === taskId);
              if (task) void drop(task, stage.id);
            }}
          >
            <h3>{stage.name}</h3>
            {board.tasks
              .filter((task) => task.stageId === stage.id)
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((task) => (
                <article
                  key={task.id}
                  className="border-t py-2"
                  draggable={can('projects.tasks.manage') && !busy}
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', task.id)}
                >
                  <Link href={`/projects/${projectId}/tasks/${task.id}`}>{task.title}</Link>
                  <p className="muted">
                    {task.assigneeName ?? 'بلا مكلّف'} · {task.dueDate ?? 'بلا استحقاق'} · {task.actualHours} / {task.estimatedHours} س
                  </p>
                  <p className="muted">{taskStatusLabel[task.status] ?? task.status} · {priorityLabel[task.priority] ?? task.priority}</p>
                </article>
              ))}
          </section>
        ))}
      </div>
    </Screen>
  );
}
