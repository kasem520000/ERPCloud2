import { date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { employees } from './hrm.js';
import { tenants, users } from './platform.js';
import { boqTerms, projectStages, projects } from './projects.js';

const value = { precision: 20, scale: 4, mode: 'string' as const };

/** مهمة على لوحة المشروع. العمود هو مرحلة المشروع لا حالة عامة. */
export const projectTasks = pgTable(
  'project_tasks',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => projectStages.id, { onDelete: 'restrict' }),
    boqTermId: uuid('boq_term_id').references(() => boqTerms.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    assigneeId: uuid('assignee_id').references(() => employees.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('todo'),
    priority: text('priority').notNull().default('normal'),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    estimatedHours: numeric('estimated_hours', value).notNull().default('0'),
    actualHours: numeric('actual_hours', value).notNull().default('0'),
    expenseValue: numeric('expense_amount', value).notNull().default('0'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardIdx: index('project_tasks_board_idx').on(table.tenantId, table.projectId, table.stageId, table.sortOrder),
    termIdx: index('project_tasks_term_idx').on(table.tenantId, table.boqTermId),
  }),
);

export const projectTimeLogs = pgTable(
  'project_time_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    hours: numeric('hours', value).notNull(),
    logDate: date('log_date').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index('project_time_logs_task_idx').on(table.tenantId, table.taskId, table.logDate),
  }),
);

export const projectDependencies = pgTable(
  'project_dependencies',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => projectTasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('finish_to_start'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    once: uniqueIndex('project_dependencies_once_key').on(table.taskId, table.dependsOnTaskId),
    taskIdx: index('project_dependencies_task_idx').on(table.tenantId, table.taskId),
  }),
);
