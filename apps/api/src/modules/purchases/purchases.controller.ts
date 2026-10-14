import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { PurchasesService, type PurchaseCostInput, type PurchaseInvoiceInput, type PurchasePaymentInput, type PurchasePostingInput } from './purchases.service.js';

@Controller('purchase-invoices')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get() @RequiresPermission('purchase.view') list() { return this.purchases.list(getTenantContext().tenantId); }
  @Get(':id') @RequiresPermission('purchase.view') get(@Param('id') id: string) { return this.purchases.get(getTenantContext().tenantId, id); }
  @Post() @RequiresPermission('purchase.invoice.create') create(@Body() body: PurchaseInvoiceInput) { return this.purchases.create(getTenantContext().tenantId, body); }
  @Patch(':id') @RequiresPermission('purchase.invoice.create') update(@Param('id') id: string, @Body() body: Partial<PurchaseInvoiceInput>) { return this.purchases.updateDraft(getTenantContext().tenantId, id, body); }
  @Post(':id/post') @RequiresPermission('purchase.invoice.post') postInvoice(@Param('id') id: string, @Body() body: PurchasePostingInput) { return this.purchases.post(getTenantContext().tenantId, id, body); }
  @Post(':id/void') @RequiresPermission('purchase.invoice.void') voidInvoice(@Param('id') id: string, @Body() body: { reason: string }) { return this.purchases.void(getTenantContext().tenantId, id, body.reason); }
  @Post(':id/payments') @RequiresPermission('purchase.invoice.pay') payment(@Param('id') id: string, @Body() body: PurchasePaymentInput) { return this.purchases.addPayment(getTenantContext().tenantId, id, body); }
  @Get(':id/landed-cost') @RequiresPermission('purchase.view') previewInvoiceCost(@Param('id') id: string) { return this.purchases.previewInvoiceLandedCost(getTenantContext().tenantId, id); }
  @Post('preview-landed-cost') @RequiresPermission('purchase.view') previewLandedCost(@Body() body: Parameters<PurchasesService['previewLandedCost']>[0]) { return this.purchases.previewLandedCost(body); }
  @Post(':id/costs') @RequiresPermission('purchase.cost.manage') addCost(@Param('id') id: string, @Body() body: PurchaseCostInput) { return this.purchases.addCost(getTenantContext().tenantId, id, body); }
  @Delete(':id/costs/:costId') @RequiresPermission('purchase.cost.manage') deleteCost(@Param('id') id: string, @Param('costId') costId: string) { return this.purchases.deleteCost(getTenantContext().tenantId, id, costId); }
}
