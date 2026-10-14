import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { PurchasesService } from './purchases.service.js';

/**
 * Supplier credit and debit notes.
 *
 * They live outside `@Controller('purchase-invoices')` because the collection route
 * (`purchases/adjustment-notes`) would otherwise be swallowed by that controller's
 * `:id` parameter.
 */
@Controller()
export class PurchaseNotesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('purchases/adjustment-notes')
  @RequiresPermission('purchase.view')
  list(@Query('kind') kind?: string) {
    return this.purchases.listAdjustmentNotes(getTenantContext().tenantId, kind);
  }

  @Post('purchase-invoices/:id/adjustment-notes')
  @RequiresPermission('purchase.adjustment.create')
  create(@Param('id') id: string, @Body() body: { branchId: string; kind: string; reason: string; amount: string }) {
    return this.purchases.createAdjustmentNote(getTenantContext().tenantId, id, body);
  }

  @Post('purchases/adjustment-notes/:id/post')
  @RequiresPermission('purchase.invoice.post')
  post(@Param('id') id: string) {
    return this.purchases.postAdjustmentNote(getTenantContext().tenantId, id);
  }
}
