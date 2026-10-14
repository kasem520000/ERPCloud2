import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, RequiresPermission } from '../platform/index.js';

import { CommentsService } from './comments.service.js';

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('comments/suggest')
  @RequiresPermission('comment.manage')
  async suggest(@Query('q') q?: string) {
    return { data: await this.comments.suggest(getTenantContext().tenantId, q ?? '') };
  }

  @Get('comments/mentions')
  @RequiresPermission('comment.view')
  async mentions(@Query('is_read') isRead?: string, @Query('isRead') camel?: string) {
    const flag = isRead ?? camel;
    const unreadOnly = flag === 'false' || flag === '0';
    const { tenantId, userId } = getTenantContext();
    return { data: await this.comments.mentions(tenantId, userId, unreadOnly) };
  }

  @Post('comments/mentions/:id/read')
  @RequiresPermission('comment.view')
  async markRead(@Param('id') id: string) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.comments.markRead(tenantId, userId, id) };
  }

  @Get('comments')
  @RequiresPermission('comment.view')
  async list(
    @Query('entity_type') entityType?: string,
    @Query('entityType') entityCamel?: string,
    @Query('entity_id') entityId?: string,
    @Query('entityId') entityIdCamel?: string,
    @Query('open') open?: string,
  ) {
    return {
      data: await this.comments.list(
        getTenantContext().tenantId,
        entityType ?? entityCamel ?? '',
        entityId ?? entityIdCamel ?? '',
        open === 'true' || open === '1',
      ),
    };
  }

  @Post('comments')
  @RequiresPermission('comment.manage')
  async create(@Body() body: Record<string, unknown>) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.comments.create(tenantId, userId, body ?? {}) };
  }

  @Put('comments/:id/resolve')
  @RequiresPermission('comment.manage')
  async resolve(@Param('id') id: string) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.comments.resolve(tenantId, userId, id) };
  }

  @Put('comments/:id')
  @RequiresPermission('comment.manage')
  async update(@Param('id') id: string, @Body() body: { body?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.comments.update(tenantId, userId, id, body?.body ?? '') };
  }

  @Delete('comments/:id')
  @RequiresPermission('comment.manage')
  async remove(@Param('id') id: string) {
    const { tenantId, userId } = getTenantContext();
    await this.comments.remove(tenantId, userId, id);
    return { data: { id, deleted: true } };
  }
}
