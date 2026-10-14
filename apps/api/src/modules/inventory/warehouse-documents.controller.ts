import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  WarehouseDocumentsService,
  type GoodsRequestApproval,
  type GoodsRequestInput,
  type StockDeliveryInput,
} from './warehouse-documents.service.js';

/**
 * طلب بضاعة and توصيل مخزني.
 *
 * Approval is a separate permission from raising the request on purpose: the whole point
 * of a requisition is that the branch asking for stock is not the one deciding to release
 * it.
 */
@Controller('inventory')
export class WarehouseDocumentsController {
  constructor(private readonly documents: WarehouseDocumentsService) {}

  @Get('requests')
  @RequiresPermission('inventory.view')
  listRequests(@Query('status') status?: string) {
    return this.documents.listRequests(getTenantContext().tenantId, status);
  }

  @Get('requests/:id')
  @RequiresPermission('inventory.view')
  getRequest(@Param('id') id: string) {
    return this.documents.getRequest(getTenantContext().tenantId, id);
  }

  @Post('requests')
  @RequiresPermission('inventory.request.manage')
  createRequest(@Body() body: GoodsRequestInput) {
    return this.documents.createRequest(getTenantContext().tenantId, body);
  }

  @Post('requests/:id/submit')
  @RequiresPermission('inventory.request.manage')
  submitRequest(@Param('id') id: string) {
    return this.documents.submitRequest(getTenantContext().tenantId, id);
  }

  @Post('requests/:id/cancel')
  @RequiresPermission('inventory.request.manage')
  cancelRequest(@Param('id') id: string) {
    return this.documents.cancelRequest(getTenantContext().tenantId, id);
  }

  @Post('requests/:id/approve')
  @RequiresPermission('inventory.request.approve')
  approveRequest(@Param('id') id: string, @Body() body: GoodsRequestApproval) {
    return this.documents.approveRequest(getTenantContext().tenantId, id, body ?? {});
  }

  @Post('requests/:id/reject')
  @RequiresPermission('inventory.request.approve')
  rejectRequest(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.documents.rejectRequest(getTenantContext().tenantId, id, body?.reason ?? '');
  }

  @Post('requests/:id/fulfil')
  @RequiresPermission('inventory.request.approve')
  fulfilRequest(@Param('id') id: string, @Body() body: { fromWarehouseId?: string }) {
    return this.documents.fulfilRequest(getTenantContext().tenantId, id, body ?? {});
  }

  @Get('deliveries')
  @RequiresPermission('inventory.view')
  listDeliveries(@Query('status') status?: string, @Query('invoice_id') invoiceId?: string) {
    return this.documents.listDeliveries(getTenantContext().tenantId, { status, invoiceId });
  }

  @Get('deliveries/outstanding')
  @RequiresPermission('inventory.view')
  outstanding(@Query('invoice_id') invoiceId?: string) {
    return this.documents.outstandingInvoices(getTenantContext().tenantId, invoiceId);
  }

  @Post('deliveries')
  @RequiresPermission('inventory.delivery.manage')
  createDelivery(@Body() body: StockDeliveryInput) {
    return this.documents.createDelivery(getTenantContext().tenantId, body);
  }

  @Post('deliveries/:id/deliver')
  @RequiresPermission('inventory.delivery.manage')
  confirmDelivery(@Param('id') id: string) {
    return this.documents.confirmDelivery(getTenantContext().tenantId, id);
  }

  @Post('deliveries/:id/cancel')
  @RequiresPermission('inventory.delivery.manage')
  cancelDelivery(@Param('id') id: string) {
    return this.documents.cancelDelivery(getTenantContext().tenantId, id);
  }
}
