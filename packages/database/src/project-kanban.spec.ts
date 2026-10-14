import { describe, expect, it } from 'vitest';

import {
  ProjectKanbanError,
  addLoggedHours,
  assertAcyclic,
  compareBoq,
  criticalPath,
  ganttView,
  groupBoard,
  hourlyValue,
  moveTask,
  placeTask,
  plannedValue,
  taskActualValue,
} from './project-kanban.js';

const stages = [
  { id: 's1', name: 'قيد الانتظار', stageOrder: 1 },
  { id: 's2', name: 'قيد التنفيذ', stageOrder: 2 },
  { id: 's3', name: 'منجز', stageOrder: 3 },
];

describe('project kanban, gantt and time', () => {
  it('shows five tasks in three stage columns', () => {
    const tasks = [
      { id: 't1', stageId: 's1', sortOrder: 2 },
      { id: 't2', stageId: 's1', sortOrder: 1 },
      { id: 't3', stageId: 's2', sortOrder: 1 },
      { id: 't4', stageId: 's3', sortOrder: 1 },
      { id: 't5', stageId: 's2', sortOrder: 2 },
    ];
    const board = groupBoard(stages, tasks);
    expect(board).toHaveLength(3);
    expect(board.map((column) => column.tasks.map((task) => task.id))).toEqual([['t2', 't1'], ['t3', 't5'], ['t4']]);
  });

  it('changes the stage when a card is dropped and rejects an unknown column', () => {
    const moved = moveTask({ id: 't1', stageId: 's1', sortOrder: 1 }, stages, 's3', 0);
    expect(moved.stageId).toBe('s3');
    expect(() => moveTask(moved, stages, 'missing', 0)).toThrow(ProjectKanbanError);
  });

  it('renumbers both columns after the drop', () => {
    const placed = placeTask(
      [
        { id: 't1', stageId: 's1', sortOrder: 1 },
        { id: 't2', stageId: 's1', sortOrder: 2 },
        { id: 't3', stageId: 's2', sortOrder: 1 },
      ],
      't2',
      's2',
      0,
    );
    expect(placed.find((task) => task.id === 't2')).toMatchObject({ stageId: 's2', sortOrder: 1 });
    expect(placed.find((task) => task.id === 't3')?.sortOrder).toBe(2);
    expect(placed.find((task) => task.id === 't1')?.sortOrder).toBe(1);
  });

  it('returns dependencies and the critical path on the gantt', () => {
    const tasks = [
      { id: 'a', startDate: '2026-10-01', dueDate: '2026-10-05' },
      { id: 'b', startDate: '2026-10-06', dueDate: '2026-10-07' },
      { id: 'c', startDate: '2026-10-06', dueDate: '2026-10-06' },
      { id: 'd', startDate: '2026-10-08', dueDate: '2026-10-10' },
    ];
    const edges = [
      { taskId: 'b', dependsOnTaskId: 'a' },
      { taskId: 'c', dependsOnTaskId: 'a' },
      { taskId: 'd', dependsOnTaskId: 'b' },
    ];
    const view = ganttView(tasks, edges);
    expect(view.dependencies).toEqual(edges);
    expect(view.criticalTaskIds).toEqual(['a', 'b', 'd']);
    expect(view.lengthDays).toBe(10);
    expect(criticalPath(tasks, edges).lengthDays).toBe(10);
  });

  it('refuses a self link and a dependency cycle', () => {
    expect(() => assertAcyclic([{ taskId: 'a', dependsOnTaskId: 'a' }])).toThrow(ProjectKanbanError);
    expect(() =>
      assertAcyclic([
        { taskId: 'a', dependsOnTaskId: 'b' },
        { taskId: 'b', dependsOnTaskId: 'a' },
      ]),
    ).toThrow(ProjectKanbanError);
  });

  it('makes actual hours 2 after a two-hour log', () => {
    expect(addLoggedHours('0', '2')).toBe('2.0000');
  });

  it('adds a second log to the stored hours', () => {
    expect(addLoggedHours('2.0000', '1.5')).toBe('3.5000');
    expect(() => addLoggedHours('0', '0')).toThrow(ProjectKanbanError);
  });

  it('prices the task as hours times the hourly value plus expenses', () => {
    expect(taskActualValue('2', '25.0000', '10')).toBe('60.0000');
  });

  it('derives the hourly value from basic salary or an explicit hourly component', () => {
    expect(hourlyValue({ basic: '4800' })).toBe('20.0000');
    expect(hourlyValue({ basic: '4800', hourly: '35' })).toBe('35.0000');
    expect(hourlyValue({})).toBe('0.0000');
  });

  it('compares BOQ planned value with the actual task value', () => {
    const planned = plannedValue({ estimatedCost: '100', qty: '2', unitValue: '40' });
    expect(planned).toBe('100.0000');
    const rows = compareBoq(
      [{ id: 'term', code: 'B1', description: 'أعمال', plannedValue: planned }],
      new Map([['term', taskActualValue('2', '20', '10')]]),
    );
    expect(rows[0]).toMatchObject({ plannedValue: '100.0000', actualValue: '50.0000', varianceValue: '-50.0000' });
  });
});
