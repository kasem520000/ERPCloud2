import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { InstallmentsService, type CollectInput, type ContractInput } from './installments.service.js';

@Controller('installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}
  @Get('contracts') @RequiresPermission('installments.view') list() { return this.installments.list(getTenantContext().tenantId); }
  @Post('contracts') @RequiresPermission('installments.manage') create(@Body() body: ContractInput) { return this.installments.create(getTenantContext().tenantId, body); }
  @Get('contracts/:id') @RequiresPermission('installments.view') read(@Param('id') id: string) { return this.installments.read(getTenantContext().tenantId, id); }
  @Get('overdue') @RequiresPermission('installments.view') overdue(@Query('asOf') asOf?: string) { return this.installments.overdue(getTenantContext().tenantId, asOf); }
  @Post('contracts/:id/collect') @RequiresPermission('installments.collect') collect(@Param('id') id: string, @Body() body: CollectInput) { return this.installments.collect(getTenantContext().tenantId, id, body); }
}
