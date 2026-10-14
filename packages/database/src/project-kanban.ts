/**
 * Kanban, Gantt and time rules that do not touch the database.
 * Columns are the project's stages. A dependency is finish-to-start.
 * The critical path is the longest chain. Money stays in four decimal strings.
 */

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Payroll uses a 30-day month. Eight hours a day makes the hourly rate basic / 240. */
export const MONTHLY_HOURS = 240;

export class ProjectKanbanError extends Error {
  constructor(
    readonly rule: 'TITLE' | 'STATUS' | 'STAGE' | 'HOURS' | 'DATE' | 'CYCLE' | 'SELF' | 'PRIORITY' | 'MONEY',
  ) {
    super(rule);
    this.name = 'ProjectKanbanError';
  }
}

export type BoardStage = { id: string; name: string; stageOrder: number };

export type BoardTask = {
  id: string;
  stageId: string;
  title: string;
  sortOrder: number;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: string;
  actualHours: string;
  expenseValue: string;
  assigneeId: string | null;
  boqTermId: string | null;
};

export type TaskDependency = { taskId: string; dependsOnTaskId: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertTaskTitle(title: string): string {
  const text = title.trim();
  if (text.length < 1 || text.length > 160) throw new ProjectKanbanError('TITLE');
  return text;
}

export function assertStatus(value: string): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) throw new ProjectKanbanError('STATUS');
  return value as TaskStatus;
}

export function assertPriority(value: string): TaskPriority {
  if (!(TASK_PRIORITIES as readonly string[]).includes(value)) throw new ProjectKanbanError('PRIORITY');
  return value as TaskPriority;
}

export function moneyOf(raw: string): string {
  const text = raw.trim();
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(text)) throw new ProjectKanbanError('MONEY');
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(4, '0').slice(0, 4)}`;
}

export function assertHours(raw: string): string {
  const value = moneyOf(raw);
  const minor = toMinor(value);
  if (minor <= 0n || minor > 24n * 10000n) throw new ProjectKanbanError('HOURS');
  return value;
}

export function assertEstimate(raw: string): string {
  const value = moneyOf(raw || '0');
  if (toMinor(value) > 100000n * 10000n) throw new ProjectKanbanError('HOURS');
  return value;
}

export function assertDateOrder(startDate: string | null, dueDate: string | null): void {
  if (startDate && !DATE.test(startDate)) throw new ProjectKanbanError('DATE');
  if (dueDate && !DATE.test(dueDate)) throw new ProjectKanbanError('DATE');
  if (startDate && dueDate && dueDate < startDate) throw new ProjectKanbanError('DATE');
}

export function addMoney(left: string, right: string): string {
  return fromMinor(toMinor(moneyOf(left || '0')) + toMinor(moneyOf(right || '0')));
}

export function subtractMoney(left: string, right: string): string {
  return fromMinor(toMinor(moneyOf(left || '0')) - toMinor(moneyOf(right || '0')));
}

export function multiplyMoney(left: string, right: string): string {
  return fromMinor((toMinor(moneyOf(left || '0')) * toMinor(moneyOf(right || '0'))) / 10000n);
}

/** A logged slice is added to the stored actual hours. Two hours on an empty task become 2. */
export function addLoggedHours(currentHours: string, loggedHours: string): string {
  return addMoney(currentHours || '0', assertHours(loggedHours));
}

/**
 * Explicit `hourly` wins. Otherwise the monthly basic is divided by 240.
 * A missing salary is zero, not a guessed market rate.
 */
export function hourlyValue(components: Record<string, string | undefined>): string {
  const explicit = components.hourly?.trim();
  if (explicit && /^\d/.test(explicit)) {
    const parsed = moneyOf(explicit);
    if (toMinor(parsed) > 0n) return parsed;
  }
  const basic = moneyOf(components.basic?.trim() || '0');
  return fromMinor(toMinor(basic) / BigInt(MONTHLY_HOURS));
}

export function laborValue(hours: string, hourly: string): string {
  return multiplyMoney(hours || '0', hourly || '0');
}

export function taskActualValue(hours: string, hourly: string, expenseValue: string): string {
  return addMoney(laborValue(hours, hourly), expenseValue || '0');
}

export function plannedValue(term: { estimatedCost: string; qty: string; unitValue: string }): string {
  const estimated = moneyOf(term.estimatedCost || '0');
  if (toMinor(estimated) > 0n) return estimated;
  return multiplyMoney(term.qty || '0', term.unitValue || '0');
}

export function groupBoard<T extends { stageId: string; sortOrder: number }>(
  stages: readonly BoardStage[],
  tasks: readonly T[],
): Array<{ stage: BoardStage; tasks: T[] }> {
  return [...stages]
    .sort((left, right) => left.stageOrder - right.stageOrder)
    .map((stage) => ({
      stage,
      tasks: tasks.filter((task) => task.stageId === stage.id).sort((left, right) => left.sortOrder - right.sortOrder),
    }));
}

export function moveTask<T extends { stageId: string; sortOrder: number }>(
  task: T,
  stages: readonly BoardStage[],
  stageId: string,
  sortOrder: number,
): T {
  if (!stages.some((stage) => stage.id === stageId)) throw new ProjectKanbanError('STAGE');
  if (!Number.isInteger(sortOrder) || sortOrder < 0) throw new ProjectKanbanError('STAGE');
  return { ...task, stageId, sortOrder };
}

/** Inserts the card and renumbers both the source column and the target column from 1. */
export function placeTask<T extends { id: string; stageId: string; sortOrder: number }>(
  tasks: readonly T[],
  taskId: string,
  stageId: string,
  sortOrder: number,
): T[] {
  const current = tasks.find((task) => task.id === taskId);
  if (!current) throw new ProjectKanbanError('STAGE');
  const next = tasks.map((task) => ({ ...task }));
  const moving = next.find((task) => task.id === taskId);
  if (!moving) throw new ProjectKanbanError('STAGE');
  const sourceId = moving.stageId;
  moving.stageId = stageId;
  const target = next.filter((task) => task.stageId === stageId && task.id !== taskId).sort(byOrder);
  const index = Math.max(0, Math.min(sortOrder, target.length));
  target.splice(index, 0, moving);
  target.forEach((task, position) => {
    task.sortOrder = position + 1;
  });
  if (sourceId !== stageId) {
    next
      .filter((task) => task.stageId === sourceId)
      .sort(byOrder)
      .forEach((task, position) => {
        task.sortOrder = position + 1;
      });
  }
  return next;
}

export function durationDays(startDate: string | null, dueDate: string | null): number {
  if (!startDate || !dueDate || !DATE.test(startDate) || !DATE.test(dueDate) || dueDate < startDate) return 1;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.max(1, Math.round((due - start) / 86_400_000) + 1);
}

export function assertAcyclic(edges: readonly TaskDependency[]): void {
  const nextOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.taskId === edge.dependsOnTaskId) throw new ProjectKanbanError('SELF');
    const list = nextOf.get(edge.dependsOnTaskId) ?? [];
    list.push(edge.taskId);
    nextOf.set(edge.dependsOnTaskId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string) => {
    if (visiting.has(node)) throw new ProjectKanbanError('CYCLE');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of nextOf.get(node) ?? []) walk(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of nextOf.keys()) walk(node);
}

export function criticalPath(
  tasks: ReadonlyArray<{ id: string; startDate: string | null; dueDate: string | null }>,
  edges: readonly TaskDependency[],
): { taskIds: string[]; lengthDays: number } {
  assertAcyclic(edges);
  const own = new Map(tasks.map((task) => [task.id, durationDays(task.startDate, task.dueDate)]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.taskId) ?? [];
    list.push(edge.dependsOnTaskId);
    incoming.set(edge.taskId, list);
  }
  const best = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    const known = best.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new ProjectKanbanError('CYCLE');
    visiting.add(id);
    let length = own.get(id) ?? 1;
    let from: string | null = null;
    for (const predecessor of incoming.get(id) ?? []) {
      const candidate = walk(predecessor) + (own.get(id) ?? 1);
      if (candidate > length) {
        length = candidate;
        from = predecessor;
      }
    }
    visiting.delete(id);
    best.set(id, length);
    previous.set(id, from);
    return length;
  };
  let end = tasks[0]?.id ?? '';
  let lengthDays = 0;
  for (const task of tasks) {
    const length = walk(task.id);
    if (length > lengthDays) {
      lengthDays = length;
      end = task.id;
    }
  }
  const taskIds: string[] = [];
  let cursor: string | null = end || null;
  while (cursor) {
    taskIds.push(cursor);
    cursor = previous.get(cursor) ?? null;
  }
  taskIds.reverse();
  return { taskIds, lengthDays };
}

export function ganttView<T extends { id: string; startDate: string | null; dueDate: string | null }>(
  tasks: readonly T[],
  edges: readonly TaskDependency[],
): { tasks: T[]; dependencies: TaskDependency[]; criticalTaskIds: string[]; lengthDays: number } {
  const path = criticalPath(tasks, edges);
  return { tasks: [...tasks], dependencies: [...edges], criticalTaskIds: path.taskIds, lengthDays: path.lengthDays };
}

export function compareBoq(
  terms: ReadonlyArray<{ id: string; code: string; description: string; plannedValue: string }>,
  actualByTerm: ReadonlyMap<string, string>,
): Array<{ termId: string; code: string; description: string; plannedValue: string; actualValue: string; varianceValue: string }> {
  return terms.map((term) => {
    const planned = moneyOf(term.plannedValue || '0');
    const actual = moneyOf(actualByTerm.get(term.id) ?? '0');
    return {
      termId: term.id,
      code: term.code,
      description: term.description,
      plannedValue: planned,
      actualValue: actual,
      varianceValue: subtractMoney(actual, planned),
    };
  });
}

export const DEFAULT_BOARD_STAGE_NAMES = ['قيد الانتظار', 'قيد التنفيذ', 'منجز'] as const;

function toMinor(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole || '0'}${fraction.padEnd(4, '0').slice(0, 4)}`);
}

function fromMinor(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const text = (value < 0n ? -value : value).toString().padStart(5, '0');
  return `${sign}${text.slice(0, -4)}.${text.slice(-4)}`;
}

function byOrder<T extends { sortOrder: number }>(left: T, right: T): number {
  return left.sortOrder - right.sortOrder;
}
