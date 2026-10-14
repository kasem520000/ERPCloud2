import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { CustomReportsService } from './custom-reports.service.js';

@Controller('custom-reports')
export class CustomReportsController {
  constructor(private readonly reports: CustomReportsService) {}

  @Get()
  @RequiresPermission('custom_reports.view')
  list() {
    return this.reports.list(getTenantContext().tenantId);
  }

  @Get('fields')
  @RequiresPermission('custom_reports.view')
  fields(@Query('base_entity') baseEntity?: string, @Query('baseEntity') baseEntityCamel?: string) {
    return this.reports.fieldCatalog(getTenantContext().tenantId, baseEntity ?? baseEntityCamel ?? 'sales_invoice');
  }

  @Post()
  @RequiresPermission('custom_reports.manage')
  create(@Body() body: unknown) {
    return this.reports.create(getTenantContext().tenantId, body, tryGetAuthContext()?.userId);
  }

  @Get(':id')
  @RequiresPermission('custom_reports.view')
  get(@Param('id') id: string) {
    return this.reports.get(getTenantContext().tenantId, id);
  }

  @Patch(':id')
  @RequiresPermission('custom_reports.manage')
  patch(@Param('id') id: string, @Body() body: unknown) {
    return this.reports.update(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }

  @Put(':id')
  @RequiresPermission('custom_reports.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.reports.update(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }

  @Delete(':id')
  @RequiresPermission('custom_reports.manage')
  remove(@Param('id') id: string) {
    return this.reports.remove(getTenantContext().tenantId, id, tryGetAuthContext()?.userId);
  }

  @Post(':id/run')
  @RequiresPermission('custom_reports.view')
  run(@Param('id') id: string) {
    return this.reports.run(getTenantContext().tenantId, id);
  }

  @Post(':id/export')
  @RequiresPermission('custom_reports.view')
  export(@Param('id') id: string, @Body() body: { format?: string }) {
    return this.reports.export(getTenantContext().tenantId, id, body?.format ?? 'csv');
  }
}
