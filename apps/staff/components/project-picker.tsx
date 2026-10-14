'use client';

import Link from 'next/link';

import { apiList } from '../lib/api';
import { useQuery } from '../lib/use-query';

import { ErrorBox, Loading, Screen } from './screen';

type ProjectRow = { id: string; code: string; name: string; status: string };

export function ProjectPicker({ title, segment }: { title: string; segment: 'board' | 'gantt' | 'time' | 'cost' }) {
  const projects = useQuery<ProjectRow[]>(() => apiList<ProjectRow>('/projects'), []);
  return (
    <Screen title={title} subtitle="اختر المشروع. اللوحة نفسها على بطاقة المشروع." crumbs={['إدارة المشاريع']}>
      {projects.status === 'loading' ? <Loading /> : null}
      {projects.status === 'error' ? <ErrorBox message={projects.error ?? 'تعذّر التحميل'} onRetry={projects.reload} /> : null}
      <div className="card">
        {(projects.data ?? []).map((project) => (
          <p key={project.id}>
            <Link href={`/projects/${project.id}/${segment}`}>
              {project.code} — {project.name}
            </Link>
          </p>
        ))}
        {(projects.data ?? []).length === 0 && projects.status === 'success' ? <p className="muted">لا مشاريع.</p> : null}
      </div>
    </Screen>
  );
}
