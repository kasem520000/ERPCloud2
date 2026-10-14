import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  ProjectKanbanError,
  addLoggedHours,
  addMoney,
  assertAcyclic,
  assertDateOrder,
  assertEstimate,
  assertHours,
  assertPriority,
  assertStatus,
  assertTaskTitle,
  boqTerms,
  compareBoq,
  contractorPayments,
  employees,
  ganttView,
  hourlyValue,
  moneyOf,
  moveTask,
  placeTask,
  plannedValue,
  subtractMoney,
  projectDependencies,
  projectStages,
  projectTasks,
  projectTimeLogs,
  projects,
  taskActualValue,
  tenantSettings,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TaskInput = {
  title?: string;
  description?: string;
  stageId?: string;
  assigneeId?: string | null;
  status?: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  estimatedHours?: string;
  expenseValue?: string;
  boqTermId?: string | null;
};

@Injectable()
export class ProjectKanbanService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async board(tenantId: string, projectId: string, filter: { stageId?: string; assigneeId?: string; status?: string } = {}) {
    this.uuid(projectId, 'المشروع غير موجود');
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const project = await this.projectOr404(tx, tenantId, projectId);
      const stages = await this.stages(tx, tenantId, projectId);
      const tasks = (await this.tasks(tx, tenantId, projectId)).filter((task) => {
        if (filter.stageId && task.stageId !== filter.stageId) return false;
        if (filter.assigneeId && task.assigneeId !== filter.assigneeId) return false;
        if (filter.status && task.status !== filter.status) return false;
        return true;
      });
      const people = await this.assignees(tx, tenantId);
      const edges = await this.edges(tx, tenantId, tasks.map((task) => task.id));
      const terms = await this.terms(tx, tenantId, projectId);
      return {
        data: {
          project: { id: project.id, code: project.code, name: project.name },
          stages,
          tasks: tasks.map((task) => this.toTask(task, people)),
          assignees: people.map((person) => ({ id: person.id, name: person.name })),
          dependencies: edges,
          boq: terms.map((term) => ({ id: term.id, code: term.code, description: term.description })),
        },
      };
    });
  }

  async create(tenantId: string, projectId: string, raw: Record<string, unknown>) {
    const input = readInput(raw);
    this.uuid(projectId, 'المشروع غير موجود');
    await this.ensureEnabled(tenantId);
    const title = this.rules(() => assertTaskTitle(String(input.title ?? '')));
    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.projectOr404(tx, tenantId, projectId);
      const stages = await this.stages(tx, tenantId, projectId);
      const stageId = input.stageId || stages[0]?.id;
      if (!stageId || !stages.some((stage) => stage.id === stageId)) {
        throw new DomainError('PROJECT_STAGE_REQUIRED', 'أضف مرحلة للمشروع قبل إنشاء مهمة', 422);
      }
      const fields = await this.fields(tx, tenantId, projectId, input);
      const existing = await this.tasks(tx, tenantId, projectId);
      const sortOrder = existing.filter((task) => task.stageId === stageId).reduce((max, task) => Math.max(max, task.sortOrder), 0) + 1;
      await tx.insert(projectTasks).values({
        id,
        tenantId,
        projectId,
        stageId,
        title,
        sortOrder,
        ...fields,
      });
    });
    return this.read(tenantId, id);
  }

  async read(tenantId: string, taskId: string) {
    this.uuid(taskId, 'المهمة غير موجودة');
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const task = await this.taskOr404(tx, tenantId, taskId);
      const people = await this.assignees(tx, tenantId);
      const logs = await tx
        .select()
        .from(projectTimeLogs)
        .where(and(eq(projectTimeLogs.tenantId, tenantId), eq(projectTimeLogs.taskId, taskId)))
        .orderBy(asc(projectTimeLogs.logDate));
      const edges = await this.edges(tx, tenantId, [taskId]);
      return { data: { ...this.toTask(task, people), logs: logs.map(toLog), dependencies: edges } };
    });
  }

  async update(tenantId: string, taskId: string, raw: Record<string, unknown>) {
    const input = readInput(raw);
    this.uuid(taskId, 'المهمة غير موجودة');
    await this.ensureEnabled(tenantId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.taskOr404(tx, tenantId, taskId);
      const fields = await this.fields(tx, tenantId, current.projectId, input, current);
      const title = input.title === undefined ? current.title : this.rules(() => assertTaskTitle(input.title ?? ''));
      await tx
        .update(projectTasks)
        .set({ ...fields, title, updatedAt: new Date() })
        .where(and(eq(projectTasks.id, taskId), eq(projectTasks.tenantId, tenantId)));
    });
    return this.read(tenantId, taskId);
  }

  async move(tenantId: string, taskId: string, stageId: string, sortOrder: number) {
    this.uuid(taskId, 'المهمة غير موجودة');
    this.uuid(stageId, 'المرحلة ليست في هذا المشروع');
    await this.ensureEnabled(tenantId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.taskOr404(tx, tenantId, taskId);
      const stages = await this.stages(tx, tenantId, current.projectId);
      this.rules(() => moveTask(current, stages, stageId, sortOrder));
      const existing = await this.tasks(tx, tenantId, current.projectId);
      const placed = placeTask(existing, taskId, stageId, sortOrder);
      for (const row of placed) {
        await tx
          .update(projectTasks)
          .set({ stageId: row.stageId, sortOrder: row.sortOrder, updatedAt: new Date() })
          .where(and(eq(projectTasks.id, row.id), eq(projectTasks.tenantId, tenantId)));
      }
    });
    return this.read(tenantId, taskId);
  }

  async logTime(tenantId: string, userId: string, taskId: string, input: { hours?: string; note?: string; logDate?: string }) {
    this.uuid(taskId, 'المهمة غير موجودة');
    const hours = this.rules(() => assertHours(String(input.hours ?? '')));
    const logDate = input.logDate?.trim() || new Date().toISOString().slice(0, 10);
    this.rules(() => assertDateOrder(logDate, logDate));
    const note = input.note?.trim() || null;
    if (note && note.length > 500) throw new DomainError('PROJECT_TASK_INVALID', 'الملاحظة أطول من 500 حرف', 422);
    await this.ensureEnabled(tenantId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.taskOr404(tx, tenantId, taskId);
      await tx.insert(projectTimeLogs).values({ id: newId(), tenantId, taskId, userId, hours, logDate, note });
      const logs = await tx
        .select({ hours: projectTimeLogs.hours })
        .from(projectTimeLogs)
        .where(and(eq(projectTimeLogs.tenantId, tenantId), eq(projectTimeLogs.taskId, taskId)));
      const actualHours = logs.reduce((sum, row) => addLoggedHours(sum, String(row.hours)), '0');
      await tx
        .update(projectTasks)
        .set({ actualHours, updatedAt: new Date() })
        .where(and(eq(projectTasks.id, taskId), eq(projectTasks.tenantId, tenantId)));
    });
    return this.read(tenantId, taskId);
  }

  async addDependency(tenantId: string, taskId: string, dependsOnTaskId: string) {
    this.uuid(taskId, 'المهمة غير موجودة');
    this.uuid(dependsOnTaskId, 'المهمة السابقة غير موجودة');
    await this.ensureEnabled(tenantId);
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        const task = await this.taskOr404(tx, tenantId, taskId);
        const previous = await this.taskOr404(tx, tenantId, dependsOnTaskId);
        if (task.projectId !== previous.projectId) {
          throw new DomainError('PROJECT_TASK_INVALID', 'الاعتماد يجب أن يكون داخل المشروع نفسه', 422);
        }
        const existing = await this.edges(tx, tenantId, (await this.tasks(tx, tenantId, task.projectId)).map((row) => row.id));
        this.rules(() => assertAcyclic([...existing, { taskId, dependsOnTaskId }]));
        await tx.insert(projectDependencies).values({
          id: newId(),
          tenantId,
          taskId,
          dependsOnTaskId,
          kind: 'finish_to_start',
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('PROJECT_TASK_INVALID', 'هذا الاعتماد موجود', 422);
      throw error;
    }
    return this.read(tenantId, taskId);
  }

  async removeDependency(tenantId: string, dependencyId: string) {
    this.uuid(dependencyId, 'الاعتماد غير موجود');
    await this.ensureEnabled(tenantId);
    const removed = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .delete(projectDependencies)
        .where(and(eq(projectDependencies.id, dependencyId), eq(projectDependencies.tenantId, tenantId)))
        .returning({ id: projectDependencies.id }),
    );
    if (!removed[0]) throw new DomainError('NOT_FOUND', 'الاعتماد غير موجود', 404);
    return { data: { id: dependencyId, deleted: true } };
  }

  async gantt(tenantId: string, projectId: string) {
    const board = await this.board(tenantId, projectId);
    const view = ganttView(board.data.tasks, board.data.dependencies);
    return { data: view };
  }

  async time(tenantId: string, projectId: string) {
    this.uuid(projectId, 'المشروع غير موجود');
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.projectOr404(tx, tenantId, projectId);
      const tasks = await this.tasks(tx, tenantId, projectId);
      const ids = tasks.map((task) => task.id);
      const logs = ids.length
        ? await tx
            .select()
            .from(projectTimeLogs)
            .where(and(eq(projectTimeLogs.tenantId, tenantId), inArray(projectTimeLogs.taskId, ids)))
            .orderBy(asc(projectTimeLogs.logDate))
        : [];
      return {
        data: {
          tasks: tasks.map((task) => ({
            id: task.id,
            title: task.title,
            estimatedHours: task.estimatedHours,
            actualHours: task.actualHours,
            varianceHours: subtractMoney(task.actualHours, task.estimatedHours),
          })),
          logs: logs.map(toLog),
        },
      };
    });
  }

  async compare(tenantId: string, projectId: string) {
    this.uuid(projectId, 'المشروع غير موجود');
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.projectOr404(tx, tenantId, projectId);
      const tasks = await this.tasks(tx, tenantId, projectId);
      const people = await this.assignees(tx, tenantId);
      const byPerson = new Map(people.map((person) => [person.id, person.salaryComponents]));
      const actualByTerm = new Map<string, string>();
      let labor = '0.0000';
      let expenses = '0.0000';
      for (const task of tasks) {
        const hourly = hourlyValue(byPerson.get(task.assigneeId ?? '') ?? {});
        const laborPart = taskActualValue(task.actualHours, hourly, '0');
        labor = addMoney(labor, laborPart);
        expenses = addMoney(expenses, task.expenseValue);
        if (!task.boqTermId) continue;
        const actual = taskActualValue(task.actualHours, hourly, task.expenseValue);
        actualByTerm.set(task.boqTermId, addMoney(actualByTerm.get(task.boqTermId) ?? '0', actual));
      }
      const terms = await this.terms(tx, tenantId, projectId);
      const lines = compareBoq(
        terms.map((term) => ({
          id: term.id,
          code: term.code,
          description: term.description,
          plannedValue: plannedValue(term),
        })),
        actualByTerm,
      );
      const payments = await tx
        .select({ netAmount: contractorPayments.netAmount, status: contractorPayments.status })
        .from(contractorPayments)
        .where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.projectId, projectId)));
      const relatedExpenses = payments
        .filter((row) => row.status === 'approved' || row.status === 'paid')
        .reduce((sum, row) => addMoney(sum, String(row.netAmount)), '0.0000');
      return {
        data: {
          lines,
          laborValue: labor,
          expenseValue: expenses,
          relatedExpenses,
          actualValue: addMoney(addMoney(labor, expenses), relatedExpenses),
          plannedValue: lines.reduce((sum, line) => addMoney(sum, line.plannedValue), '0.0000'),
        },
      };
    });
  }

  private async fields(tx: DrizzleTx, tenantId: string, projectId: string, input: TaskInput, current?: { startDate: string | null; dueDate: string | null; status: string; priority: string; estimatedHours: string; expenseValue: string; assigneeId: string | null; boqTermId: string | null; description: string | null }) {
    const startDate = input.startDate === undefined ? current?.startDate ?? null : blank(input.startDate);
    const dueDate = input.dueDate === undefined ? current?.dueDate ?? null : blank(input.dueDate);
    this.rules(() => assertDateOrder(startDate, dueDate));
    const status = input.status === undefined ? current?.status ?? 'todo' : this.rules(() => assertStatus(input.status ?? ''));
    const priority = input.priority === undefined ? current?.priority ?? 'normal' : this.rules(() => assertPriority(input.priority ?? ''));
    const estimatedHours = input.estimatedHours === undefined ? current?.estimatedHours ?? '0.0000' : this.rules(() => assertEstimate(input.estimatedHours ?? '0'));
    const expenseValue = input.expenseValue === undefined ? current?.expenseValue ?? '0.0000' : this.rules(() => moneyOf(input.expenseValue ?? '0'));
    const assigneeId = input.assigneeId === undefined ? current?.assigneeId ?? null : blank(input.assigneeId);
    if (assigneeId) {
      this.uuid(assigneeId, 'الموظف غير موجود');
      const people = await this.assignees(tx, tenantId);
      if (!people.some((person) => person.id === assigneeId)) throw new DomainError('NOT_FOUND', 'الموظف غير موجود', 404);
    }
    const boqTermId = input.boqTermId === undefined ? current?.boqTermId ?? null : blank(input.boqTermId);
    if (boqTermId) {
      this.uuid(boqTermId, 'بند جدول الكميات غير موجود');
      const terms = await this.terms(tx, tenantId, projectId);
      if (!terms.some((term) => term.id === boqTermId)) throw new DomainError('NOT_FOUND', 'بند جدول الكميات غير موجود', 404);
    }
    const description = input.description === undefined ? current?.description ?? null : input.description.trim() || null;
    if (description && description.length > 4000) throw new DomainError('PROJECT_TASK_INVALID', 'الوصف أطول من 4000 حرف', 422);
    return { description, assigneeId, status, priority, startDate, dueDate, estimatedHours, expenseValue, boqTermId };
  }

  private async ensureEnabled(tenantId: string) {
    const [flag] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(tenantSettings)
        .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.projects')))
        .limit(1),
    );
    if (flag && flag.value !== true && flag.value !== 'true') {
      throw new DomainError('NOT_FOUND', 'Projects pack is disabled for this tenant', 404);
    }
  }

  private async projectOr404(tx: DrizzleTx, tenantId: string, projectId: string) {
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new DomainError('NOT_FOUND', 'المشروع غير موجود', 404);
    return project;
  }

  private async taskOr404(tx: DrizzleTx, tenantId: string, taskId: string) {
    const [task] = await tx
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.tenantId, tenantId), eq(projectTasks.id, taskId)))
      .limit(1);
    if (!task) throw new DomainError('NOT_FOUND', 'المهمة غير موجودة', 404);
    return task;
  }

  private stages(tx: DrizzleTx, tenantId: string, projectId: string) {
    return tx
      .select({ id: projectStages.id, name: projectStages.name, stageOrder: projectStages.stageOrder })
      .from(projectStages)
      .where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, projectId)))
      .orderBy(asc(projectStages.stageOrder));
  }

  private tasks(tx: DrizzleTx, tenantId: string, projectId: string) {
    return tx
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.tenantId, tenantId), eq(projectTasks.projectId, projectId)))
      .orderBy(asc(projectTasks.sortOrder));
  }

  private terms(tx: DrizzleTx, tenantId: string, projectId: string) {
    return tx
      .select()
      .from(boqTerms)
      .where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.projectId, projectId), isNull(boqTerms.deletedAt)));
  }

  private assignees(tx: DrizzleTx, tenantId: string) {
    return tx
      .select({ id: employees.id, name: employees.name, salaryComponents: employees.salaryComponents })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.status, 'active'), isNull(employees.deletedAt)))
      .orderBy(asc(employees.name));
  }

  private async edges(tx: DrizzleTx, tenantId: string, taskIds: string[]) {
    if (taskIds.length === 0) return [];
    const rows = await tx
      .select()
      .from(projectDependencies)
      .where(and(eq(projectDependencies.tenantId, tenantId), inArray(projectDependencies.taskId, taskIds)));
    return rows.map((row) => ({ id: row.id, taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId, kind: row.kind }));
  }

  private toTask(
    task: typeof projectTasks.$inferSelect,
    people: Array<{ id: string; name: string }>,
  ) {
    return {
      id: task.id,
      projectId: task.projectId,
      stageId: task.stageId,
      title: task.title,
      description: task.description,
      assigneeId: task.assigneeId,
      assigneeName: people.find((person) => person.id === task.assigneeId)?.name ?? null,
      status: task.status,
      priority: task.priority,
      startDate: task.startDate,
      dueDate: task.dueDate,
      estimatedHours: task.estimatedHours,
      actualHours: task.actualHours,
      expenseValue: task.expenseValue,
      sortOrder: task.sortOrder,
      boqTermId: task.boqTermId,
    };
  }

  private uuid(value: string, message: string) {
    if (!UUID.test(value)) throw new DomainError('NOT_FOUND', message, 404);
    return value;
  }

  private rules<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof ProjectKanbanError) throw new DomainError('PROJECT_TASK_INVALID', ruleMessage(error.rule), 422);
      throw error;
    }
  }
}

function toLog(row: typeof projectTimeLogs.$inferSelect) {
  return { id: row.id, taskId: row.taskId, userId: row.userId, hours: row.hours, logDate: row.logDate, note: row.note };
}

function readInput(raw: Record<string, unknown> | null | undefined): TaskInput {
  const body = raw ?? {};
  const pick = (camel: string, snake: string): string | null | undefined => {
    if (Object.prototype.hasOwnProperty.call(body, camel)) return body[camel] === null ? null : String(body[camel]);
    if (Object.prototype.hasOwnProperty.call(body, snake)) return body[snake] === null ? null : String(body[snake]);
    return undefined;
  };
  return {
    title: pick('title', 'title') ?? undefined,
    description: pick('description', 'description') ?? undefined,
    stageId: pick('stageId', 'stage_id') ?? undefined,
    assigneeId: pick('assigneeId', 'assignee_id'),
    status: pick('status', 'status') ?? undefined,
    priority: pick('priority', 'priority') ?? undefined,
    startDate: pick('startDate', 'start_date'),
    dueDate: pick('dueDate', 'due_date'),
    estimatedHours: pick('estimatedHours', 'estimated_hours') ?? undefined,
    expenseValue: pick('expenseValue', 'expense_amount') ?? undefined,
    boqTermId: pick('boqTermId', 'boq_term_id'),
  };
}

function blank(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text.length > 0 ? text : null;
}

function ruleMessage(rule: string): string {
  if (rule === 'TITLE') return 'عنوان المهمة بين حرف و160 حرف';
  if (rule === 'STATUS') return 'حالة المهمة غير مدعومة';
  if (rule === 'PRIORITY') return 'الأولوية غير مدعومة';
  if (rule === 'STAGE') return 'المرحلة ليست في هذا المشروع';
  if (rule === 'HOURS') return 'ساعات التسجيل بين 0.01 و24';
  if (rule === 'DATE') return 'تاريخ الاستحقاق قبل البداية';
  if (rule === 'CYCLE') return 'الاعتماد يكوّن حلقة';
  if (rule === 'SELF') return 'المهمة لا تعتمد على نفسها';
  return 'المبلغ غير صالح';
}
