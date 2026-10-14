import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { MigrationService } from './migration.service.js';

@Controller('migration')
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}
  @Post('runs') @RequiresPermission('migration.run.execute') start(@Body() body: { mode: string; source?: { label?: string; kind?: string } }) { return this.migration.startRun(getTenantContext().tenantId, body); }
  @Get('runs') @RequiresPermission('migration.view') list() { return this.migration.listRuns(getTenantContext().tenantId); }
  @Get('runs/:id') @RequiresPermission('migration.view') read(@Param('id') id: string) { return this.migration.readRun(getTenantContext().tenantId, id); }
  @Get('runs/:id/issues') @RequiresPermission('migration.view') issues(@Param('id') id: string) { return this.migration.issues(getTenantContext().tenantId, id); }
  @Get('runs/:id/reconciliation') @RequiresPermission('migration.view') reconciliation(@Param('id') id: string) { return this.migration.reconciliation(getTenantContext().tenantId, id); }
}
