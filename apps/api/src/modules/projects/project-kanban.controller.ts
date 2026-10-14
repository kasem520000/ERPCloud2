import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { ProjectKanbanService } from './project-kanban.service.js';

@Controller('projects')
export class ProjectKanbanController {
  constructor(private readonly kanban: ProjectKanbanService) {}

  @Get(':id/tasks')
  @RequiresPermission('projects.tasks.view')
  board(
    @Param('id') id: string,
    @Query('stage_id') stageId?: string,
    @Query('stageId') stageCamel?: string,
    @Query('assignee_id') assigneeId?: string,
    @Query('assigneeId') assigneeCamel?: string,
    @Query('status') status?: string,
  ) {
    return this.kanban.board(getTenantContext().tenantId, id, {
      stageId: stageId ?? stageCamel,
      assigneeId: assigneeId ?? assigneeCamel,
      status,
    });
  }

  @Post(':id/tasks')
  @RequiresPermission('projects.tasks.manage')
  create(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.kanban.create(getTenantContext().tenantId, id, body ?? {});
  }

  @Get(':id/gantt')
  @RequiresPermission('projects.tasks.view')
  gantt(@Param('id') id: string) {
    return this.kanban.gantt(getTenantContext().tenantId, id);
  }

  @Get(':id/time')
  @RequiresPermission('projects.tasks.view')
  time(@Param('id') id: string) {
    return this.kanban.time(getTenantContext().tenantId, id);
  }

  @Get(':id/cost')
  @RequiresPermission('projects.tasks.view')
  compare(@Param('id') id: string) {
    return this.kanban.compare(getTenantContext().tenantId, id);
  }

  @Get('tasks/:taskId')
  @RequiresPermission('projects.tasks.view')
  read(@Param('taskId') taskId: string) {
    return this.kanban.read(getTenantContext().tenantId, taskId);
  }

  @Patch('tasks/:taskId')
  @RequiresPermission('projects.tasks.manage')
  update(@Param('taskId') taskId: string, @Body() body: Record<string, unknown>) {
    return this.kanban.update(getTenantContext().tenantId, taskId, body ?? {});
  }

  @Put('tasks/:taskId/move')
  @RequiresPermission('projects.tasks.manage')
  move(@Param('taskId') taskId: string, @Body() body: { stageId?: string; sortOrder?: number }) {
    return this.kanban.move(getTenantContext().tenantId, taskId, body?.stageId ?? '', Number(body?.sortOrder ?? 0));
  }

  @Post('tasks/:taskId/time-logs')
  @RequiresPermission('projects.time_logs.manage')
  log(@Param('taskId') taskId: string, @Body() body: { hours?: string; note?: string; logDate?: string }) {
    const { tenantId, userId } = getTenantContext();
    return this.kanban.logTime(tenantId, userId, taskId, body ?? {});
  }

  @Post('tasks/:taskId/dependencies')
  @RequiresPermission('projects.tasks.manage')
  depend(@Param('taskId') taskId: string, @Body() body: { dependsOnTaskId?: string }) {
    return this.kanban.addDependency(getTenantContext().tenantId, taskId, body?.dependsOnTaskId ?? '');
  }

  @Delete('dependencies/:dependencyId')
  @RequiresPermission('projects.tasks.manage')
  undepend(@Param('dependencyId') dependencyId: string) {
    return this.kanban.removeDependency(getTenantContext().tenantId, dependencyId);
  }
}
