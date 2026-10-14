import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  approvalDecisionInputSchema,
  approvalStepInputSchema,
  approvalWorkflowInputSchema,
} from '@erp/contracts';

import { getAuthContext, getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { ApprovalService } from './approvals.service.js';

@Controller()
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get(['approval-workflows', 'approvals/workflows'])
  @RequiresPermission('approval.manage')
  listWorkflows() {
    return this.approvals.listWorkflows(getTenantContext().tenantId);
  }

  @Post(['approval-workflows', 'approvals/workflows'])
  @RequiresPermission('approval.manage')
  createWorkflow(@Body() body: unknown) {
    const auth = getAuthContext();
    return this.approvals.createWorkflow(
      getTenantContext().tenantId,
      auth.userId,
      approvalWorkflowInputSchema.parse(body),
    );
  }

  @Get(['approval-workflows/:id', 'approvals/workflows/:id'])
  @RequiresPermission('approval.manage')
  getWorkflow(@Param('id') id: string) {
    return this.approvals.getWorkflow(getTenantContext().tenantId, id);
  }

  @Patch(['approval-workflows/:id', 'approvals/workflows/:id'])
  @RequiresPermission('approval.manage')
  updateWorkflow(@Param('id') id: string, @Body() body: unknown) {
    const auth = getAuthContext();
    return this.approvals.updateWorkflow(
      getTenantContext().tenantId,
      auth.userId,
      id,
      approvalWorkflowInputSchema.parse(body),
    );
  }

  @Delete(['approval-workflows/:id', 'approvals/workflows/:id'])
  @RequiresPermission('approval.manage')
  deactivateWorkflow(@Param('id') id: string) {
    return this.approvals.deactivateWorkflow(
      getTenantContext().tenantId,
      getAuthContext().userId,
      id,
    );
  }

  @Get(['approval-workflows/:id/steps', 'approvals/workflows/:id/steps'])
  @RequiresPermission('approval.manage')
  listSteps(@Param('id') id: string) {
    return this.approvals.listSteps(getTenantContext().tenantId, id);
  }

  @Post(['approval-workflows/:id/steps', 'approvals/workflows/:id/steps'])
  @RequiresPermission('approval.manage')
  addStep(@Param('id') id: string, @Body() body: unknown) {
    return this.approvals.addStep(
      getTenantContext().tenantId,
      id,
      approvalStepInputSchema.parse(body),
    );
  }

  @Get('approvals/inbox')
  @RequiresPermission('approval.approve')
  inbox(@Query('status') status?: string) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return this.approvals.listInbox(tenant.tenantId, auth.userId, tenant.membershipId, status ?? 'pending');
  }

  @Get('approvals/history')
  @RequiresPermission('approval.approve')
  history(@Query('status') status?: string) {
    return this.approvals.listHistory(getTenantContext().tenantId, status);
  }

  @Get('sales/invoices/:id/approval')
  @RequiresPermission('sales.view')
  salesApproval(@Param('id') id: string) {
    return this.approvals.latestForEntity(getTenantContext().tenantId, 'sales_invoice', id);
  }

  @Get('purchases/invoices/:id/approval')
  @RequiresPermission('purchase.view')
  purchaseApproval(@Param('id') id: string) {
    return this.approvals.latestForEntity(getTenantContext().tenantId, 'purchase_invoice', id);
  }

  @Get('approvals/requests/:id')
  @RequiresPermission('approval.approve')
  request(@Param('id') id: string) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return this.approvals.getRequest(tenant.tenantId, id, auth.userId, tenant.membershipId);
  }

  @Post('approvals/requests/:id/approve')
  @RequiresPermission('approval.approve')
  approve(@Param('id') id: string, @Body() body: unknown) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return this.approvals.decide(
      tenant.tenantId,
      id,
      auth.userId,
      tenant.membershipId,
      'approved',
      approvalDecisionInputSchema.parse(body ?? {}),
    );
  }

  @Post('approvals/requests/:id/reject')
  @RequiresPermission('approval.approve')
  reject(@Param('id') id: string, @Body() body: unknown) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return this.approvals.decide(
      tenant.tenantId,
      id,
      auth.userId,
      tenant.membershipId,
      'rejected',
      approvalDecisionInputSchema.parse(body ?? {}),
    );
  }
}
