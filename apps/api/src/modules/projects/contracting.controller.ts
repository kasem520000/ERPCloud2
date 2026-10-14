import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { ContractingService, type ContractInput, type ContractorPaymentInput, type OfferInput, type PayInput } from './contracting.service.js';

/**
 * Mounted on its own `/contracting` root rather than under `/projects`, because
 * `ProjectsController` already owns `GET /projects/:id` and a sibling literal segment
 * would be a coin-flip against that wildcard.
 */
@Controller('contracting')
export class ContractingController {
  constructor(private readonly contracting: ContractingService) {}

  // contracts — عقد مقاول
  @Get('contracts') @RequiresPermission('projects.view')
  listContracts(@Query('project_id') projectId?: string, @Query('status') status?: string) {
    return this.contracting.listContracts(getTenantContext().tenantId, { projectId, status }).then((data) => ({ data }));
  }

  @Post('contracts') @RequiresPermission('projects.manage')
  createContract(@Body() body: ContractInput) {
    return this.contracting.createContract(getTenantContext().tenantId, body).then((data) => ({ data }));
  }

  @Get('contracts/:id') @RequiresPermission('projects.view')
  getContract(@Param('id') id: string) {
    return this.contracting.getContract(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post('contracts/:id/activate') @RequiresPermission('projects.manage')
  activate(@Param('id') id: string) {
    return this.contracting.activateContract(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post('contracts/:id/close') @RequiresPermission('projects.manage')
  close(@Param('id') id: string) {
    return this.contracting.closeContract(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post('contracts/:id/cancel') @RequiresPermission('projects.manage')
  cancelContract(@Param('id') id: string) {
    return this.contracting.cancelContract(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  // payments — سند دفع لمقاول
  @Get('payments') @RequiresPermission('projects.view')
  listPayments(@Query('contract_id') contractId?: string, @Query('status') status?: string) {
    return this.contracting.listPayments(getTenantContext().tenantId, { contractId, status }).then((data) => ({ data }));
  }

  @Post('contracts/:id/payments') @RequiresPermission('projects.manage')
  createPayment(@Param('id') id: string, @Body() body: ContractorPaymentInput) {
    return this.contracting.createPayment(getTenantContext().tenantId, id, body).then((data) => ({ data }));
  }

  @Post('payments/:paymentId/approve') @RequiresPermission('projects.contractor.pay')
  approve(@Param('paymentId') paymentId: string) {
    return this.contracting.approvePayment(getTenantContext().tenantId, paymentId).then((data) => ({ data }));
  }

  @Post('payments/:paymentId/pay') @RequiresPermission('projects.contractor.pay')
  pay(@Param('paymentId') paymentId: string, @Body() body: PayInput) {
    return this.contracting.payPayment(getTenantContext().tenantId, paymentId, body).then((data) => ({ data }));
  }

  @Post('payments/:paymentId/cancel') @RequiresPermission('projects.manage')
  cancelPayment(@Param('paymentId') paymentId: string) {
    return this.contracting.cancelPayment(getTenantContext().tenantId, paymentId).then((data) => ({ data }));
  }

  // offers — عروض المشاريع
  @Get('offers') @RequiresPermission('projects.view')
  listOffers(@Query('status') status?: string) {
    return this.contracting.listOffers(getTenantContext().tenantId, status).then((data) => ({ data }));
  }

  @Post('offers') @RequiresPermission('projects.manage')
  createOffer(@Body() body: OfferInput) {
    return this.contracting.createOffer(getTenantContext().tenantId, body).then((data) => ({ data }));
  }

  @Post('offers/:id/send') @RequiresPermission('projects.manage')
  send(@Param('id') id: string) {
    return this.contracting.sendOffer(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post('offers/:id/accept') @RequiresPermission('projects.manage')
  accept(@Param('id') id: string) {
    return this.contracting.acceptOffer(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Post('offers/:id/reject') @RequiresPermission('projects.manage')
  reject(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.contracting.rejectOffer(getTenantContext().tenantId, id, body?.reason).then((data) => ({ data }));
  }

  @Post('offers/:id/convert') @RequiresPermission('projects.manage')
  convert(@Param('id') id: string, @Body() body: { code?: string; branchId?: string; startsOn?: string; endsOn?: string }) {
    return this.contracting.convertOffer(getTenantContext().tenantId, id, body ?? {});
  }
}
