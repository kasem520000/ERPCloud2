import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, Public, RequiresPermission } from '../platform/index.js';

import { CrmService } from './crm.service.js';

@Controller()
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('crm/pipelines')
  @RequiresPermission('crm.deals.view')
  async pipelines() {
    return { data: await this.crm.pipelines(getTenantContext().tenantId) };
  }

  @Post('crm/pipelines')
  @RequiresPermission('crm.deals.manage')
  async createPipeline(@Body() body: { name?: string; stages?: unknown }) {
    return { data: await this.crm.createPipeline(getTenantContext().tenantId, body ?? {}) };
  }

  @Get('crm/deals')
  @RequiresPermission('crm.deals.view')
  async deals(
    @Query('pipelineId') pipelineId?: string,
    @Query('pipeline_id') pipelineSnake?: string,
    @Query('stageId') stageId?: string,
    @Query('stage_id') stageSnake?: string,
    @Query('ownerId') ownerId?: string,
    @Query('owner_id') ownerSnake?: string,
  ) {
    return {
      data: await this.crm.deals(getTenantContext().tenantId, {
        pipelineId: pipelineId ?? pipelineSnake,
        stageId: stageId ?? stageSnake,
        ownerId: ownerId ?? ownerSnake,
      }),
    };
  }

  @Post('crm/deals')
  @RequiresPermission('crm.deals.manage')
  async createDeal(@Body() body: Record<string, unknown>) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.crm.createDeal(tenantId, userId, body ?? {}) };
  }

  @Get('crm/deals/:id')
  @RequiresPermission('crm.deals.view')
  async deal(@Param('id') id: string) {
    return { data: await this.crm.deal(getTenantContext().tenantId, id) };
  }

  @Put('crm/deals/:id/move')
  @RequiresPermission('crm.deals.manage')
  async move(@Param('id') id: string, @Body() body: { stageId?: string; stage_id?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.crm.move(tenantId, userId, id, body?.stageId ?? body?.stage_id ?? '') };
  }

  @Put('crm/deals/:id/status')
  @RequiresPermission('crm.deals.manage')
  async close(@Param('id') id: string, @Body() body: { status?: string; lostReason?: string; lost_reason?: string }) {
    return { data: await this.crm.close(getTenantContext().tenantId, id, body ?? {}) };
  }

  @Post('crm/deals/:id/activities')
  @RequiresPermission('crm.activities.manage')
  async activity(@Param('id') id: string, @Body() body: { type?: string; description?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.crm.addActivity(tenantId, userId, id, body ?? {}) };
  }

  @Post('crm/deals/:id/whatsapp')
  @RequiresPermission('crm.activities.manage')
  async whatsapp(
    @Param('id') id: string,
    @Body() body: { templateId?: string; template_id?: string; message?: string; to?: string },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.crm.sendWhatsapp(tenantId, userId, id, body ?? {}) };
  }

  @Get('crm/activities')
  @RequiresPermission('crm.deals.view')
  async activities(@Query('dealId') dealId?: string) {
    return { data: await this.crm.activities(getTenantContext().tenantId, dealId) };
  }

  @Get('crm/forecast')
  @RequiresPermission('crm.deals.view')
  async forecast(@Query('pipelineId') pipelineId?: string, @Query('pipeline_id') pipelineSnake?: string) {
    return { data: await this.crm.forecast(getTenantContext().tenantId, pipelineId ?? pipelineSnake) };
  }

  @Get('crm/whatsapp/templates')
  @RequiresPermission('crm.deals.view')
  async templates() {
    return { data: await this.crm.templates(getTenantContext().tenantId) };
  }

  @Post('crm/whatsapp/templates')
  @RequiresPermission('crm.deals.manage')
  async createTemplate(@Body() body: { name?: string; body?: string }) {
    return { data: await this.crm.createTemplate(getTenantContext().tenantId, body ?? {}) };
  }

  @Get('crm/settings')
  @RequiresPermission('crm.deals.manage')
  async settings() {
    return { data: await this.crm.settings(getTenantContext().tenantId) };
  }

  @Public()
  @Post('crm/webhooks/whatsapp')
  async inbound(@Query('token') token: string | undefined, @Body() body: unknown) {
    return { data: await this.crm.inbound(token ?? '', body) };
  }
}
