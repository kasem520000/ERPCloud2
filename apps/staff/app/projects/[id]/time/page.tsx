'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Notice } from '../../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { ApiError } from '../../../../lib/api';
import { loadTime, logTaskTime, type TimeLog } from '../../../../lib/project-kanban';
import { useSession } from '../../../../lib/session';

type TimeTask = { id: string; title: string; estimatedHours: string; actualHours: string; varianceHours: string };

export default function ProjectTimePage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id);
  const { can } = useSession();
  const [tasks, setTasks] = useState<TimeTask[]>([]);
  const [logs, setLogs] = useState<TimeLog[]>([]);
  const [taskId, setTaskId] = useState('');
  const [hours, setHours] = useState('2');
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();
  const [busy, setBusy] = useState(false);

  async function reload() {
    const next = await loadTime(projectId);
    setTasks(next.tasks);
    setLogs(next.logs);
    setTaskId((current) => current || next.tasks[0]?.id || '');
    setReady(true);
  }

  useEffect(() => {
    void reload().catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)));
  }, [projectId]);

  async function save() {
    setBusy(true);
    setNotice(undefined);
    try {
      await logTaskTime(taskId, { hours, note });
      setNotice({ kind: 'ok', text: 'سُجّل الوقت وتحدّثت الساعات الفعلية.' });
      await reload();
    } catch (reason) {
      setNotice({ kind: 'danger', text: reason instanceof ApiError ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  if (error && !ready) {
    return (
      <Screen title="تتبع الوقت" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={error} onRetry={() => void reload()} />
      </Screen>
    );
  }
  if (!ready) return <Loading />;

  return (
    <Screen title="تتبع الوقت" subtitle="الساعات الفعلية مجموع التسجيلات. التكلفة تُحسب من معدل الموظف." crumbs={['إدارة المشاريع']} actions={<Link className="btn" href={`/projects/${projectId}/cost`}>التكلفة</Link>}>
      <Notice notice={notice} />
      {can('projects.time_logs.manage') ? (
        <div className="card">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="field">
              <span>المهمة</span>
              <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.title}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>الساعات</span>
              <input value={hours} onChange={(event) => setHours(event.target.value)} />
            </label>
            <label className="field">
              <span>ملاحظة</span>
              <input value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
          </div>
          <button className="btn primary" type="button" disabled={busy || !taskId} onClick={() => void save()}>
            تسجيل
          </button>
        </div>
      ) : null}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>المهمة</th>
              <th>مخطط</th>
              <th>فعلي</th>
              <th>الفرق</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td><Link href={`/projects/${projectId}/tasks/${task.id}`}>{task.title}</Link></td>
                <td>{task.estimatedHours}</td>
                <td>{task.actualHours}</td>
                <td>{task.varianceHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.map((entry) => (
          <p key={entry.id} className="muted">{entry.logDate} · {entry.hours} س · {entry.note ?? ''}</p>
        ))}
      </div>
    </Screen>
  );
}
