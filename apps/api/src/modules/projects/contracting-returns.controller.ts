import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { ContractingReturnsService, type ContractingReturnInput } from './contracting-returns.service.js';

/**
 * مرتجع مقاولات. Posting a return is gated by `projects.bill.post` — the same authority
 * that posted the bill being reversed, because reversing certified work is the same
 * decision taken backwards.
 */
@Controller('contracting/returns')
export class ContractingReturnsController {
  constructor(private readonly returns: ContractingReturnsService) {}

  @Get() @RequiresPermission('projects.view')
  list(@Query('project_id') projectId?: string, @Query('bill_id') billId?: string, @Query('status') status?: string) {
    return this.returns.list(getTenantContext().tenantId, { projectId, billId, status }).then((data) => ({ data }));
  }

  @Get('returnable') @RequiresPermission('projects.view')
  returnable(@Query('bill_id') billId: string) {
    return this.returns.returnable(getTenantContext().tenantId, billId).then((data) => ({ data }));
  }

  @Post() @RequiresPermission('projects.manage')
  create(@Body() body: ContractingReturnInput) {
    return this.returns.create(getTenantContext().tenantId, body).then((data) => ({ data }));
  }

  @Get(':id') @RequiresPermission('projects.view')
  read(@Param('id') id: string) {
    return this.returns.get(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post(':id/post') @RequiresPermission('projects.bill.post')
  post(@Param('id') id: string) {
    return this.returns.post(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post(':id/cancel') @RequiresPermission('projects.manage')
  cancel(@Param('id') id: string) {
    return this.returns.cancel(getTenantContext().tenantId, id).then((data) => ({ data }));
  }
}
