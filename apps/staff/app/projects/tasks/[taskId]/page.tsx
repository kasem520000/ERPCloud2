'use client';

import { useParams } from 'next/navigation';

import { ProjectTaskDetail } from '../../../../components/project-task-detail';

export default function ProjectTaskPage() {
  const params = useParams<{ taskId: string }>();
  return <ProjectTaskDetail taskId={String(params.taskId)} />;
}
