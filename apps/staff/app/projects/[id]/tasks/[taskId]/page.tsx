'use client';

import { useParams } from 'next/navigation';

import { ProjectTaskDetail } from '../../../../../components/project-task-detail';

export default function NestedProjectTaskPage() {
  const params = useParams<{ id: string; taskId: string }>();
  return <ProjectTaskDetail projectId={String(params.id)} taskId={String(params.taskId)} />;
}
