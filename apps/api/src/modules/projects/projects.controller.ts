import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { ProjectsService, type BillInput, type BoqInput, type ProjectInput } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}
  @Get() @RequiresPermission('projects.view') list() { return this.projects.list(getTenantContext().tenantId); }
  @Post() @RequiresPermission('projects.manage') create(@Body() body: ProjectInput) { return this.projects.create(getTenantContext().tenantId, body); }
  /**
   * R11 — «🗂️ المجموعة» في `frmProjectStagesPM.xaml` قائمةُ قوالب مراحل. وهذا المسار
   * **وُضِع قبل `@Get(':id')`** لأن Nest يطابق بترتيب الإعلان: قبل اليوم كان
   * `GET /projects/stage-templates` يبلغ `:id` فيردّ `400 INVALID_ID` — مسارٌ يبدو
   * موجوداً وهو يقرأ معرّفاً.
   */
  @Get('stage-templates') @RequiresPermission('projects.view') templates() { return this.projects.listTemplates(getTenantContext().tenantId); }
  @Get(':id') @RequiresPermission('projects.view') read(@Param('id') id: string) { return this.projects.read(getTenantContext().tenantId, id); }
  @Post('stage-templates') @RequiresPermission('projects.manage') template(@Body() body: { name: string; stages: Array<{ name: string }> }) { return this.projects.createTemplate(getTenantContext().tenantId, body); }
  @Post(':id/stages') @RequiresPermission('projects.manage') stage(@Param('id') id: string, @Body() body: { name: string; stageOrder?: number }) { return this.projects.addStage(getTenantContext().tenantId, id, body); }
  /** «⬆️ لأعلى» و«⬇️ لأسفل» — `frmProjectStagesPM.xaml` L347/L353. */
  @Post('stages/:stageId/move') @RequiresPermission('projects.manage') move(@Param('stageId') stageId: string, @Body() body: { direction: 'up' | 'down' }) { return this.projects.moveStage(getTenantContext().tenantId, stageId, body.direction === 'down' ? 'down' : 'up'); }
  /** «💾 حفظ» في `frmStagePM.xaml`: الاسم والترتيب. */
  @Patch('stages/:stageId') @RequiresPermission('projects.manage') patchStage(@Param('stageId') stageId: string, @Body() body: { name?: string; stageOrder?: number }) { return this.projects.updateStage(getTenantContext().tenantId, stageId, body); }
  /** «🗑️ حذف» — يُعاد ترقيم ما بقي فلا تبقى فجوةٌ في التسلسل. */
  @Delete('stages/:stageId') @RequiresPermission('projects.manage') deleteStage(@Param('stageId') stageId: string) { return this.projects.removeStage(getTenantContext().tenantId, stageId); }
  @Post('stages/:stageId/accredit') @RequiresPermission('projects.stage.accredit') accredit(@Param('stageId') stageId: string, @Body() body: { userId: string; note?: string }) { return this.projects.accreditStage(getTenantContext().tenantId, stageId, body.userId, body.note); }
  @Post(':id/boq') @RequiresPermission('projects.manage') boq(@Param('id') id: string, @Body() body: BoqInput) { return this.projects.addBoq(getTenantContext().tenantId, id, body); }
  /** «✏️ تعديل» و«🗑️ حذف» في `frmTermsPM.xaml` — البند يُصحَّح ويُسحب قبل فوترته. */
  @Patch('boq/:termId') @RequiresPermission('projects.manage') patchBoq(@Param('termId') termId: string, @Body() body: Partial<BoqInput>) { return this.projects.updateBoq(getTenantContext().tenantId, termId, body); }
  @Delete('boq/:termId') @RequiresPermission('projects.manage') deleteBoq(@Param('termId') termId: string) { return this.projects.removeBoq(getTenantContext().tenantId, termId); }
  @Get(':id/progress-bills') @RequiresPermission('projects.view') bills(@Param('id') id: string) { return this.projects.listBills(getTenantContext().tenantId, id); }
  @Post(':id/progress-bills') @RequiresPermission('projects.manage') bill(@Param('id') id: string, @Body() body: BillInput) { return this.projects.createBill(getTenantContext().tenantId, id, body); }
  @Get('progress-bills/:billId') @RequiresPermission('projects.view') getBill(@Param('billId') billId: string) { return this.projects.getBill(getTenantContext().tenantId, billId); }
  @Post('progress-bills/:billId/post') @RequiresPermission('projects.bill.post') postBill(@Param('billId') billId: string, @Body() body: { branchId?: string; fiscalPeriodId?: string; revenueAccountId?: string; receivableAccountId?: string; retentionReceivableAccountId?: string }) { return this.projects.postBill(getTenantContext().tenantId, billId, body); }
  @Post('progress-bills/:billId/release-retention') @RequiresPermission('projects.bill.post') release(@Param('billId') billId: string, @Body() body: { branchId?: string }) { return this.projects.releaseRetention(getTenantContext().tenantId, billId, body); }
  @Post('requirements') @RequiresPermission('projects.manage') requirement(@Body() body: { projectId?: string; partyId?: string; title: string; status?: string; payload?: Record<string, unknown> }) { return this.projects.addRequirement(getTenantContext().tenantId, body); }
}
