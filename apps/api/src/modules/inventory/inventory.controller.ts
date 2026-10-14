import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';

import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';
import { getTenantContext } from '../platform/context/tenant-context.js';

import {
  InventoryService,
  type InventoryLine,
  type StockAdjustmentInput,
  type StockVoucherInput,
} from './inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}
  @Get('levels') @RequiresPermission('inventory.view') levels(
    @Query('warehouse_id') warehouseId?: string,
    @Query('item_id') itemId?: string,
  ) {
    return this.inventory.levels(getTenantContext().tenantId, warehouseId, itemId);
  }
  /** حركة المخزون — now with a period, which is the only way a movement list is usable. */
  @Get('movements') @RequiresPermission('inventory.view') movements(
    @Query('item_id') itemId?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventory.movements(getTenantContext().tenantId, {
      itemId,
      warehouseId,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** بطاقة الصنف — the item's ledger with a running balance, quantity and value. */
  @Get('item-card') @RequiresPermission('inventory.view') itemCard(
    @Query('item_id') itemId: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.inventory.itemCard(getTenantContext().tenantId, { itemId, warehouseId, from, to });
  }

  /** بضاعة في الطريق — transfers sent but not fully received, oldest first. */
  @Get('in-transit') @RequiresPermission('inventory.view') inTransit(
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.inventory.inTransit(getTenantContext().tenantId, warehouseId);
  }
  @Post('ledger/record') @RequiresPermission('inventory.adjust') record(
    @Body() body: { lines: InventoryLine[] },
  ) {
    return this.inventory.record(getTenantContext().tenantId, body.lines);
  }
  @Get('valuation/as-of') @RequiresPermission('inventory.view') valuationAsOf(
    @Query('as_of') asOf: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('item_id') itemId?: string,
  ) {
    return this.inventory.valuationAsOf(getTenantContext().tenantId, new Date(asOf), warehouseId, itemId);
  }
  @Post('balances/recompute') @RequiresPermission('inventory.negative.override') recompute(
    @Query('warehouse_id') warehouseId?: string,
    @Query('item_id') itemId?: string,
  ) {
    return this.inventory.recomputeBalances(getTenantContext().tenantId, warehouseId, itemId);
  }
  @Get('transfers')
  @RequiresPermission('inventory.view')
  listTransfers(
    @Query('status') status?: string,
    @Query('number') number?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.inventory.listTransfers(getTenantContext().tenantId, status, { number, from, to });
  }
  @Post('transfers') @RequiresPermission('inventory.adjust') transfer(
    @Body()
    body: {
      transferId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      lines: Array<{ itemId: string; qty: string; unitCost?: string; lotId?: string; serialId?: string }>;
    },
  ) {
    return this.inventory.transfer(getTenantContext().tenantId, body);
  }
  @Post('transfers/draft') @RequiresPermission('inventory.adjust') createTransfer(
    @Body()
    body: {
      id?: string;
      number?: string;
      branchId?: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      lines: Array<{
        itemId: string;
        qty: string;
        unitCost?: string;
        lotId?: string;
        /** 📁 رقم الدفعة وتواريخها كما على العبوة — R5 (الدفعة تُبحث أو تُنشأ على السطر). */
        batchNo?: string;
        productionDate?: string;
        expiryDate?: string;
        serialIds?: string[];
        serialNos?: string[];
      }>;
    },
  ) {
    return this.inventory.createTransfer(getTenantContext().tenantId, body);
  }
  @Get('transfers/:id') @RequiresPermission('inventory.view') getTransfer(@Param('id') transferId: string) {
    return this.inventory.getTransfer(getTenantContext().tenantId, transferId);
  }
  @Post('transfers/:id/receive') @RequiresPermission('inventory.adjust') receiveTransferById(
    @Param('id') transferId: string,
    @Body() body: { received: Array<{ lineNo: number; qty: string }>; fiscalPeriodId?: string },
  ) {
    return this.inventory.receiveTransfer(getTenantContext().tenantId, transferId, body.received, {
      fiscalPeriodId: body.fiscalPeriodId,
    });
  }
  @Post('transfers/:id/close')
  @RequiresPermission('inventory.adjust')
  closeTransfer(
    @Param('id') transferId: string,
    @Body() body: { mode?: string; reason?: string; fiscalPeriodId?: string },
  ) {
    return this.inventory.closeTransfer(getTenantContext().tenantId, transferId, {
      mode: (body?.mode === 'shortage' ? 'shortage' : 'return') as 'return' | 'shortage',
      reason: body?.reason,
      fiscalPeriodId: body?.fiscalPeriodId,
    });
  }
  @Post('transfers/:id/cancel') @RequiresPermission('inventory.adjust') cancelTransferById(
    @Param('id') transferId: string,
    @Body() body: { reason?: string },
  ) {
    return this.inventory.cancelTransfer(getTenantContext().tenantId, transferId, body.reason);
  }
  @Post('transfers/:id/send') @RequiresPermission('inventory.adjust') sendTransfer(
    @Param('id') transferId: string,
    @Body() body?: { fiscalPeriodId?: string; allowNegative?: boolean },
  ) {
    return this.inventory.sendTransfer(getTenantContext().tenantId, transferId, body ?? {});
  }
  @Post('transfers/receive') @RequiresPermission('inventory.adjust') receiveTransfer(
    @Body() body: { transferId: string; received: Array<{ lineNo: number; qty: string }> },
  ) {
    return this.inventory.receiveTransfer(getTenantContext().tenantId, body.transferId, body.received);
  }
  @Post('transfers/cancel') @RequiresPermission('inventory.adjust') cancelTransfer(
    @Body() body: { transferId: string },
  ) {
    return this.inventory.cancelTransfer(getTenantContext().tenantId, body.transferId);
  }
  @Post('adjustments/post') @RequiresPermission('inventory.adjust') adjust(
    @Body()
    body: {
      adjustmentId: string;
      itemId: string;
      warehouseId: string;
      countedQty: string;
      unitCost?: string;
      approved: boolean;
      journalEntryId?: string;
    },
  ) {
    return this.inventory.adjust(getTenantContext().tenantId, body);
  }
  @Get('adjustments') @RequiresPermission('inventory.view') listAdjustments(
    @Query('status') status?: string,
  ) {
    return this.inventory.listAdjustments(getTenantContext().tenantId, status);
  }
  @Post('adjustments') @RequiresPermission('inventory.adjust') createAdjustment(
    @Body() body: StockAdjustmentInput,
  ) {
    return this.inventory.createAdjustment(getTenantContext().tenantId, body);
  }
  @Get('adjustments/:id') @RequiresPermission('inventory.view') getAdjustment(
    @Param('id') adjustmentId: string,
  ) {
    return this.inventory.getAdjustment(getTenantContext().tenantId, adjustmentId);
  }
  @Post('adjustments/:id/post') @RequiresPermission('inventory.adjust') postAdjustment(
    @Param('id') adjustmentId: string,
    @Body()
    body: { approved?: boolean; fiscalPeriodId?: string; counterAccountId?: string; allowNegative?: boolean },
  ) {
    return this.inventory.postAdjustment(getTenantContext().tenantId, adjustmentId, body);
  }
  @Get('vouchers') @RequiresPermission('inventory.view') listVouchers(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.inventory.listVouchers(getTenantContext().tenantId, { kind, status, warehouseId });
  }
  @Post('vouchers') @RequiresPermission('inventory.adjust') createVoucher(@Body() body: StockVoucherInput) {
    return this.inventory.createVoucher(getTenantContext().tenantId, body);
  }
  @Get('vouchers/:id') @RequiresPermission('inventory.view') getVoucher(@Param('id') voucherId: string) {
    return this.inventory.getVoucher(getTenantContext().tenantId, voucherId);
  }
  @Post('vouchers/:id/post') @RequiresPermission('inventory.adjust') postVoucher(
    @Param('id') voucherId: string,
    @Body() body: { fiscalPeriodId?: string; allowNegative?: boolean },
  ) {
    return this.inventory.postVoucher(getTenantContext().tenantId, voucherId, body ?? {});
  }
  @Post('vouchers/:id/void') @RequiresPermission('inventory.adjust') voidVoucher(
    @Param('id') voucherId: string,
    @Body() body: { reason: string },
  ) {
    return this.inventory.voidVoucher(getTenantContext().tenantId, voucherId, body.reason);
  }
  @Get('barcode/:code') @RequiresPermission('inventory.view') scan(@Param('code') code: string) {
    return this.inventory.scan(getTenantContext().tenantId, decodeURIComponent(code));
  }
  @Get('expiry') @RequiresPermission('inventory.view') expiry(
    @Query('days') days?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.inventory.expiry(getTenantContext().tenantId, days ? Number(days) : 30, warehouseId);
  }
  @Get('below-minimum') @RequiresPermission('inventory.view') belowMinimum(
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.inventory.belowMinimum(getTenantContext().tenantId, warehouseId);
  }
  @Get('lots') @RequiresPermission('inventory.view') lots(
    @Query('item_id') itemId?: string,
    @Query('q') q?: string,
  ) {
    return this.inventory.listLots(getTenantContext().tenantId, { itemId, q });
  }
  @Delete('lots/:id') @RequiresPermission('inventory.adjust') deleteLot(@Param('id') lotId: string) {
    return this.inventory.deleteLot(getTenantContext().tenantId, lotId);
  }
  @Post('lots') @RequiresPermission('inventory.adjust') createLot(
    @Body()
    body: {
      itemId: string;
      lotNo: string;
      /** 📅 تاريخ الإنتاج — عمودٌ مستقلٌّ عن تاريخ الاستلام (R5). */
      productionDate?: string;
      expiryDate?: string;
      receivedAt?: string;
    },
  ) {
    return this.inventory.createLot(getTenantContext().tenantId, body);
  }
  /**
   * «🔢 التسلسلي:» — البحث بالرقم نفسه (R8): ما هو الصنف، وهل القطعة على الرفّ أم
   * بيعت، وفي أي مستنداتٍ سافرت. كان في الديسكتوب خانةً في رأس نافذة البيع
   * (`frmInvSale.xaml` L592) تُدخل الرقم فتضيف الصنف؛ وهنا يُعاد الحكم كاملاً
   * وتقرّره الشاشة.
   */
  @Get('serials/lookup') @RequiresPermission('inventory.view') lookupSerial(@Query('serialNo') serialNo: string) {
    return this.inventory.lookupSerial(getTenantContext().tenantId, serialNo ?? '');
  }
  @Get('serials') @RequiresPermission('inventory.view') serials(
    @Query('item_id') itemId?: string,
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('q') q?: string,
  ) {
    return this.inventory.listSerials(getTenantContext().tenantId, { itemId, status, warehouseId, q });
  }
  @Post('serials') @RequiresPermission('inventory.adjust') createSerial(
    @Body() body: { itemId: string; serialNo: string; lotId?: string; warehouseId?: string; status?: string },
  ) {
    return this.inventory.createSerial(getTenantContext().tenantId, body);
  }
  /** ⚙️ توليد — a batch of serials off one prefix, the way the desktop's generator does it. */
  @Post('serials/generate') @RequiresPermission('inventory.adjust') generateSerials(
    @Body() body: { itemId: string; prefix: string; startAt?: number; count: number; warehouseId?: string; lotId?: string },
  ) {
    return this.inventory.generateSerials(getTenantContext().tenantId, body);
  }
  @Delete('serials/:id') @RequiresPermission('inventory.adjust') deleteSerial(@Param('id') serialId: string) {
    return this.inventory.deleteSerial(getTenantContext().tenantId, serialId);
  }
  /** Which documents has this number travelled through? */
  @Get('serials/:id/documents') @RequiresPermission('inventory.view') serialTrace(@Param('id') serialId: string) {
    return this.inventory.serialTrace(getTenantContext().tenantId, serialId);
  }
  @Post('serials/reserve') @RequiresPermission('inventory.adjust') reserveSerials(
    @Body() body: { serialIds: string[] },
  ) {
    return this.inventory.reserveSerials(getTenantContext().tenantId, body.serialIds);
  }
  @Post('serials/release') @RequiresPermission('inventory.adjust') releaseSerials(
    @Body() body: { serialIds: string[] },
  ) {
    return this.inventory.releaseSerials(getTenantContext().tenantId, body.serialIds);
  }
  @Post('serials/consume') @RequiresPermission('inventory.adjust') consumeSerials(
    @Body() body: { serialIds: string[] },
  ) {
    return this.inventory.consumeSerials(getTenantContext().tenantId, body.serialIds);
  }
  @Post('serials/return') @RequiresPermission('inventory.adjust') returnSerials(
    @Body() body: { serialIds: string[] },
  ) {
    return this.inventory.returnSerials(getTenantContext().tenantId, body.serialIds);
  }
}
