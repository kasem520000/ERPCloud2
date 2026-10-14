'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Notice } from '../../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { ApiError } from '../../../../lib/api';
import { loadGantt, updateTask, type ProjectTask, type TaskDependency } from '../../../../lib/project-kanban';
import { useSession } from '../../../../lib/session';

const DAY = 28;

export default function ProjectGanttPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id);
  const { can } = useSession();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [edges, setEdges] = useState<TaskDependency[]>([]);
  const [critical, setCritical] = useState<string[]>([]);
  const [lengthDays, setLengthDays] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  async function reload() {
    const next = await loadGantt(projectId);
    setTasks(next.tasks);
    setEdges(next.dependencies);
    setCritical(next.criticalTaskIds);
    setLengthDays(next.lengthDays);
    setReady(true);
  }

  useEffect(() => {
    void reload().catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)));
  }, [projectId]);

  if (error && !ready) {
    return (
      <Screen title="جانت" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={error} onRetry={() => void reload()} />
      </Screen>
    );
  }
  if (!ready) return <Loading />;

  const origin = earliest(tasks);
  const span = Math.max(14, ...tasks.map((task) => dayIndex(origin, task.dueDate ?? task.startDate ?? origin) + 2));

  function drag(task: ProjectTask, event: ReactPointerEvent<HTMLButtonElement>) {
    if (!can('projects.tasks.manage')) return;
    const startX = event.clientX;
    const startDate = task.startDate ?? origin;
    const dueDate = task.dueDate ?? startDate;
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointerup', onUp);
      const days = Math.round((up.clientX - startX) / DAY);
      if (days === 0) return;
      void updateTask(task.id, { startDate: shiftDate(startDate, days), dueDate: shiftDate(dueDate, days) })
        .then(() => reload())
        .then(() => setNotice({ kind: 'ok', text: 'تغيّر تاريخ المهمة.' }))
        .catch((reason: unknown) => setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) }));
    };
    window.addEventListener('pointerup', onUp);
  }

  return (
    <Screen
      title="مخطط جانت"
      subtitle={`المسار الحرج ${lengthDays} يوم. اسحب الشريط لتغيير التاريخ.`}
      crumbs={['إدارة المشاريع']}
      actions={<Link className="btn" href={`/projects/${projectId}/board`}>اللوحة</Link>}
    >
      <Notice notice={notice} />
      <div className="card" dir="ltr" style={{ overflowX: 'auto' }}>
        <svg width={span * DAY} height={Math.max(48, tasks.length * 36)} role="img" aria-label="مخطط جانت">
          {edges.map((edge) => {
            const from = tasks.findIndex((task) => task.id === edge.dependsOnTaskId);
            const to = tasks.findIndex((task) => task.id === edge.taskId);
            if (from < 0 || to < 0) return null;
            const fromTask = tasks[from];
            const toTask = tasks[to];
            if (!fromTask || !toTask) return null;
            const x1 = (dayIndex(origin, fromTask.dueDate ?? fromTask.startDate ?? origin) + 1) * DAY;
            const x2 = dayIndex(origin, toTask.startDate ?? origin) * DAY;
            return <line key={edge.id} x1={x1} y1={from * 36 + 18} x2={x2} y2={to * 36 + 18} stroke="var(--muted)" />;
          })}
        </svg>
        <div style={{ marginTop: -Math.max(48, tasks.length * 36) }}>
          {tasks.map((task) => {
            const left = dayIndex(origin, task.startDate ?? origin) * DAY;
            const width = Math.max(DAY, (duration(task) ) * DAY);
            const marked = critical.includes(task.id);
            return (
              <div key={task.id} style={{ height: 36, position: 'relative' }}>
                <button
                  type="button"
                  title={marked ? 'مسار حرج' : task.title}
                  onPointerDown={(event) => drag(task, event)}
                  style={{
                    position: 'absolute',
                    left,
                    width,
                    height: 24,
                    top: 6,
                    background: marked ? 'var(--warn)' : 'var(--ok)',
                    color: 'var(--on-accent)',
                    border: 0,
                    borderRadius: 4,
                    cursor: 'ew-resize',
                  }}
                >
                  {task.title}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h3>الاعتمادات</h3>
        {edges.length === 0 ? <p className="muted">لا اعتمادات. تُضاف من بطاقة المهمة.</p> : null}
        {edges.map((edge) => (
          <p key={edge.id}>
            {tasks.find((task) => task.id === edge.taskId)?.title ?? edge.taskId} بعد{' '}
            {tasks.find((task) => task.id === edge.dependsOnTaskId)?.title ?? edge.dependsOnTaskId}
            {critical.includes(edge.taskId) ? ' · مسار حرج' : ''}
          </p>
        ))}
      </div>
    </Screen>
  );
}

function earliest(tasks: ProjectTask[]): string {
  const dates = tasks.flatMap((task) => [task.startDate, task.dueDate].filter((value): value is string => Boolean(value)));
  return dates.sort()[0] ?? new Date().toISOString().slice(0, 10);
}

function dayIndex(origin: string, value: string): number {
  const from = Date.parse(`${origin}T00:00:00Z`);
  const to = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

function duration(task: ProjectTask): number {
  if (!task.startDate || !task.dueDate) return 1;
  return Math.max(1, dayIndex(task.startDate, task.dueDate) + 1);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
