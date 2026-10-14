import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  PosService,
  type DiningTableInput,
  type OrderItemInput,
  type PosCheckoutInput,
  type PosHoldInput,
  type PosOfflineSyncInput,
  type TableCategoryInput,
} from './pos.service.js';

@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}
  @Get('categories') @RequiresPermission('pos.view') categories(@Query('branchId') branchId?: string) {
    return this.pos.categories(getTenantContext().tenantId, branchId);
  }
  @Post('categories') @RequiresPermission('pos.config.manage') createCategory(
    @Body() body: TableCategoryInput,
  ) {
    return this.pos.createCategory(getTenantContext().tenantId, body);
  }
  @Get('tables') @RequiresPermission('pos.view') tables(@Query('branchId') branchId?: string) {
    return this.pos.tables(getTenantContext().tenantId, branchId);
  }
  @Post('tables') @RequiresPermission('pos.tables.manage') createTable(@Body() body: DiningTableInput) {
    return this.pos.createTable(getTenantContext().tenantId, body);
  }
  @Post('tables/:id/open') @RequiresPermission('pos.operate') open(
    @Param('id') id: string,
    @Body() body: { businessDay?: string },
  ) {
    return this.pos.openTable(getTenantContext().tenantId, id, body.businessDay);
  }
  @Post('tables/:id/items') @RequiresPermission('pos.operate') addItem(
    @Param('id') id: string,
    @Body() body: OrderItemInput & { businessDay?: string },
  ) {
    return this.pos.addItem(getTenantContext().tenantId, id, body, body.businessDay);
  }
  @Post('events/:id/void') @RequiresPermission('pos.operate') voidItem(
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.pos.voidItem(getTenantContext().tenantId, id, body.reason);
  }
  @Post('tables/:id/send-to-invoice') @RequiresPermission('pos.operate') send(
    @Param('id') id: string,
    @Body() body: { cashCustomerName?: string; orderType?: string; businessDay?: string },
  ) {
    return this.pos.sendToInvoice(
      getTenantContext().tenantId,
      id,
      body.cashCustomerName,
      body.orderType,
      body.businessDay,
    );
  }
  @Post('tables/:id/close') @RequiresPermission('pos.operate') close(
    @Param('id') id: string,
    @Body()
    body: {
      settlement?: 'credit' | 'cash' | 'card' | 'bank';
      cashLocationId?: string;
      settlementAccountId?: string;
    },
  ) {
    return this.pos.close(getTenantContext().tenantId, id, body);
  }
  /** Snapshot used to seed IndexedDB before a till leaves the network. */
  @Get('offline-data') @RequiresPermission('pos.view') offlineData() {
    return this.pos.offlineData(getTenantContext().tenantId);
  }

  /** Replays cash-only IndexedDB tickets; each ticket gets an independent outcome. */
  @Post('offline-sync') @RequiresPermission('pos.operate', 'sales.invoice.post') offlineSync(
    @Body() body: PosOfflineSyncInput,
  ) {
    const ctx = getTenantContext();
    return this.pos.offlineSync(ctx.tenantId, ctx.userId, body);
  }

  /**
   * The till checkout. One call creates, posts, relieves stock and settles the
   * sale — and links it to the cashier's open shift so the day-close report can
   * count the drawer. Requires `sales.invoice.post` as well as `pos.operate`
   * because it writes a posted invoice and a journal entry.
   */
  @Post('checkout') @RequiresPermission('pos.operate', 'sales.invoice.post') checkout(
    @Body() body: PosCheckoutInput,
  ) {
    const ctx = getTenantContext();
    return this.pos.checkout(ctx.tenantId, ctx.userId, body);
  }
  /**
   * ⚙️ إعدادات الكاشير (`frmCasherSetting.xaml`): يقرأها مَن يشغّل الصندوق بصلاحية
   * `pos.view`، وتُكتب من شاشة الإعدادات بـ`PUT /settings/pos.*` وصلاحية إعدادات المستأجر.
   */
  @Get('settings') @RequiresPermission('pos.view') settings() {
    return this.pos.posSettings(getTenantContext().tenantId);
  }
  /** 🅿️ الفواتير المعلّقة: ٩ خانات لكل كاشير في الفرع. */
  @Get('holds') @RequiresPermission('pos.operate') holds(@Query('branchId') branchId: string) {
    const ctx = getTenantContext();
    return this.pos.holds(ctx.tenantId, ctx.userId, branchId);
  }
  @Post('holds') @RequiresPermission('pos.operate') hold(@Body() body: PosHoldInput) {
    const ctx = getTenantContext();
    return this.pos.hold(ctx.tenantId, ctx.userId, body);
  }
  @Post('holds/:id/recall') @RequiresPermission('pos.operate') recallHold(@Param('id') id: string) {
    const ctx = getTenantContext();
    return this.pos.recallHold(ctx.tenantId, ctx.userId, id);
  }
  @Post('holds/:id/release') @RequiresPermission('pos.operate') dropHold(@Param('id') id: string) {
    const ctx = getTenantContext();
    return this.pos.dropHold(ctx.tenantId, ctx.userId, id);
  }
  @Post('tables/:sourceId/merge/:targetId') @RequiresPermission('pos.operate') merge(
    @Param('sourceId') sourceId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.pos.merge(getTenantContext().tenantId, sourceId, targetId);
  }
  @Post('tables/:id/split') @RequiresPermission('pos.operate') split(@Param('id') id: string) {
    return this.pos.split(getTenantContext().tenantId, id);
  }
}
