import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { BackupService } from './backup.service.js';
import { CompanyFilesService, type CopySet } from './company-files.service.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * `/api/v1/settings/*` — the file-level operations from قائمة الإعدادات.
 *
 * These are the five buttons that make people nervous in a desktop product, so each one is
 * split into a step that only reports and a step that acts, and the acting step always
 * needs something typed or ticked. Every run is recorded with its actor, so "who rotated
 * the data" has an answer.
 */
@ApiTags('operations')
@Controller('settings')
export class OperationsController {
  constructor(
    private readonly backups: BackupService,
    private readonly maintenance: MaintenanceService,
    private readonly companyFiles: CompanyFilesService,
  ) {}

  // ------------------------------------------------------------- النسخ الإحتياطي
  @Get('backups')
  @RequiresPermission('settings.backup.manage')
  @ApiOperation({ summary: 'Backups taken for this file' })
  async listBackups() { return { data: await this.backups.listBackups(getTenantContext().tenantId) }; }

  @Post('backups')
  @RequiresPermission('settings.backup.manage')
  @ApiOperation({ summary: 'Take a logical backup of this file' })
  async createBackup(@Body() body: { note?: string }) { return { data: await this.backups.createBackup(getTenantContext().tenantId, body ?? {}) }; }

  @Get('backups/:id/download')
  @RequiresPermission('settings.backup.manage')
  @ApiOperation({ summary: 'Download a backup payload' })
  async downloadBackup(@Param('id') id: string) { return { data: await this.backups.download(getTenantContext().tenantId, id) }; }

  // ------------------------------------------------------------ إستعادة البيانات
  @Get('restores')
  @RequiresPermission('settings.restore.manage')
  async listRestores() { return { data: await this.backups.listRestores(getTenantContext().tenantId) }; }

  @Post('restores')
  @RequiresPermission('settings.restore.manage')
  @ApiOperation({ summary: 'Dry-run or apply a restore (additive: nothing is ever deleted)' })
  async restore(@Body() body: { backupId?: string; payload?: Record<string, Array<Record<string, unknown>>>; checksum?: string; mode?: 'dry_run' | 'apply'; confirmTenantCode?: string }) {
    return { data: await this.backups.restore(getTenantContext().tenantId, body ?? {}) };
  }

  // -------------------------------------------------------------- تدوير البيانات
  @Get('maintenance-runs')
  @RequiresPermission('settings.maintenance.manage')
  async listRuns(@Query('kind') kind?: string) { return { data: await this.maintenance.listRuns(getTenantContext().tenantId, kind) }; }

  @Post('data-rotation')
  @RequiresPermission('settings.rotation.manage')
  @ApiOperation({ summary: 'Preview or apply operational-log rotation (documents are never deleted)' })
  async rotation(@Body() body: { cutoffDate: string; mode?: 'preview' | 'apply'; confirm?: boolean; backupId?: string }) {
    return { data: await this.maintenance.rotation(getTenantContext().tenantId, body) };
  }

  // ------------------------------------------------------------- صيانة الفواتير
  @Post('invoice-maintenance')
  @RequiresPermission('settings.maintenance.manage')
  @ApiOperation({ summary: 'Scan invoices for inconsistencies; apply repairs drafts only' })
  async invoiceMaintenance(@Body() body: { mode?: 'preview' | 'apply'; staleDraftDays?: number }) {
    return { data: await this.maintenance.invoiceMaintenance(getTenantContext().tenantId, body ?? {}) };
  }

  // ----------------------------------------------------------------- إنشاء ملف
  @Get('company-files')
  @RequiresPermission('settings.companyfile.create')
  async listCompanyFiles() { return { data: await this.companyFiles.list(getTenantContext().tenantId) }; }

  @Post('company-files')
  @RequiresPermission('settings.companyfile.create')
  @ApiOperation({ summary: 'Create a sibling company file (a new, unlicensed tenant) for the same owner' })
  async createCompanyFile(@Body() body: { code: string; name: string; baseCurrency?: string; timezone?: string; countryCode?: string; copy?: CopySet[] }) {
    return { data: await this.companyFiles.create(getTenantContext().tenantId, body) };
  }
}
