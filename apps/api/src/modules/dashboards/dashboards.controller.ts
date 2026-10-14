import { Body, Controller, Delete, Get, Param, Post, Put, StreamableFile } from '@nestjs/common';

import { RequiresPermission, getTenantContext } from '../platform/index.js';

import { DashboardsService } from './dashboards.service.js';

@Controller()
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get('dashboards/widgets/catalog')
  @RequiresPermission('dashboards.view')
  catalog() {
    return { data: this.dashboards.catalog() };
  }

  @Get('dashboards')
  @RequiresPermission('dashboards.view')
  async list() {
    const tenant = getTenantContext();
    return { data: await this.dashboards.list(tenant.tenantId, tenant.userId) };
  }

  @Post('dashboards')
  @RequiresPermission('dashboards.manage')
  async create(@Body() body: { name?: string }) {
    const tenant = getTenantContext();
    return { data: await this.dashboards.create(tenant.tenantId, tenant.userId, body.name ?? '') };
  }

  @Get('dashboards/:id')
  @RequiresPermission('dashboards.view')
  async get(@Param('id') id: string) {
    const tenant = getTenantContext();
    return { data: await this.dashboards.get(tenant.tenantId, tenant.userId, id) };
  }

  @Get('dashboards/:id/data')
  @RequiresPermission('dashboards.view')
  async data(@Param('id') id: string) {
    const tenant = getTenantContext();
    return { data: await this.dashboards.data(tenant.tenantId, tenant.userId, id) };
  }

  @Get('dashboards/:id/pdf')
  @RequiresPermission('dashboards.view')
  async pdf(@Param('id') id: string) {
    const tenant = getTenantContext();
    const bytes = await this.dashboards.pdf(tenant.tenantId, tenant.userId, id);
    return new StreamableFile(bytes, { type: 'application/pdf', disposition: 'attachment; filename="dashboard.pdf"' });
  }

  @Post('dashboards/:id/widgets')
  @RequiresPermission('dashboards.manage')
  async addWidget(@Param('id') id: string, @Body() body: { key?: string; config?: Record<string, unknown> }) {
    const tenant = getTenantContext();
    return {
      data: await this.dashboards.addWidget(tenant.tenantId, tenant.userId, id, body.key ?? '', body.config ?? {}),
    };
  }

  @Put('dashboards/:id/layout')
  @RequiresPermission('dashboards.manage')
  async layout(@Param('id') id: string, @Body() body: { widgets?: Array<{ widgetId: string; positionX: number; positionY: number; width: number; height: number }> }) {
    const tenant = getTenantContext();
    return { data: await this.dashboards.saveLayout(tenant.tenantId, tenant.userId, id, body.widgets ?? []) };
  }

  @Post('dashboards/:id/default')
  @RequiresPermission('dashboards.manage')
  async setDefault(@Param('id') id: string) {
    const tenant = getTenantContext();
    await this.dashboards.setDefault(tenant.tenantId, tenant.userId, id);
    return { data: { id, isDefault: true } };
  }

  @Delete('dashboards/:id/widgets/:widgetId')
  @RequiresPermission('dashboards.manage')
  async removeWidget(@Param('id') id: string, @Param('widgetId') widgetId: string) {
    const tenant = getTenantContext();
    await this.dashboards.removeWidget(tenant.tenantId, tenant.userId, id, widgetId);
    return { data: { id: widgetId } };
  }

  @Delete('dashboards/:id')
  @RequiresPermission('dashboards.manage')
  async remove(@Param('id') id: string) {
    const tenant = getTenantContext();
    await this.dashboards.remove(tenant.tenantId, tenant.userId, id);
    return { data: { id } };
  }
}
