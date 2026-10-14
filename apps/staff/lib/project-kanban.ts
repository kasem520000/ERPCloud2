import { apiData, apiDelete, apiPatch, apiPost, apiPut } from './api';

export type BoardStage = { id: string; name: string; stageOrder: number };

export type ProjectTask = {
  id: string;
  projectId: string;
  stageId: string;
  title: string;
  description: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: string;
  actualHours: string;
  expenseValue: string;
  sortOrder: number;
  boqTermId: string | null;
};

export type TaskDependency = { id: string; taskId: string; dependsOnTaskId: string; kind: string };

export type ProjectBoard = {
  project: { id: string; code: string; name: string };
  stages: BoardStage[];
  tasks: ProjectTask[];
  assignees: Array<{ id: string; name: string }>;
  dependencies: TaskDependency[];
  boq: Array<{ id: string; code: string; description: string }>;
};

export type TimeLog = { id: string; taskId: string; userId: string; hours: string; logDate: string; note: string | null };

export const taskStatusLabel: Record<string, string> = {
  todo: 'قيد الانتظار',
  in_progress: 'قيد التنفيذ',
  done: 'منجز',
};

export const priorityLabel: Record<string, string> = {
  low: 'منخفضة',
  normal: 'عادية',
  high: 'عالية',
};

export const loadBoard = (projectId: string) => apiData<ProjectBoard>(`/projects/${projectId}/tasks`);

export const createTask = (projectId: string, body: Record<string, unknown>) =>
  apiPost<ProjectTask>(`/projects/${projectId}/tasks`, body);

export const updateTask = (taskId: string, body: Record<string, unknown>) => apiPatch<ProjectTask>(`/projects/tasks/${taskId}`, body);

export const moveTask = (taskId: string, stageId: string, sortOrder: number) =>
  apiPut<ProjectTask>(`/projects/tasks/${taskId}/move`, { stageId, sortOrder });

export const logTaskTime = (taskId: string, body: { hours: string; note?: string; logDate?: string }) =>
  apiPost<ProjectTask & { logs: TimeLog[] }>(`/projects/tasks/${taskId}/time-logs`, body);

export const readTask = (taskId: string) => apiData<ProjectTask & { logs: TimeLog[]; dependencies: TaskDependency[] }>(`/projects/tasks/${taskId}`);

export const addDependency = (taskId: string, dependsOnTaskId: string) =>
  apiPost<ProjectTask>(`/projects/tasks/${taskId}/dependencies`, { dependsOnTaskId });

export const removeDependency = (id: string) => apiDelete<{ id: string }>(`/projects/dependencies/${id}`);

export const loadGantt = (projectId: string) =>
  apiData<{ tasks: ProjectTask[]; dependencies: TaskDependency[]; criticalTaskIds: string[]; lengthDays: number }>(
    `/projects/${projectId}/gantt`,
  );

export const loadTime = (projectId: string) =>
  apiData<{ tasks: Array<{ id: string; title: string; estimatedHours: string; actualHours: string; varianceHours: string }>; logs: TimeLog[] }>(
    `/projects/${projectId}/time`,
  );

export const loadCost = (projectId: string) =>
  apiData<{
    lines: Array<{ termId: string; code: string; description: string; plannedValue: string; actualValue: string; varianceValue: string }>;
    laborValue: string;
    expenseValue: string;
    relatedExpenses: string;
    actualValue: string;
    plannedValue: string;
  }>(`/projects/${projectId}/cost`);
