import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { getTenantContext } from '../../platform/context/tenant-context.js';
import { Public } from '../../platform/decorators/public.decorator.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { SallaService } from './salla.service.js';
import { SallaStoreService } from './salla-store.service.js';

/**
 * 🛒 متجر سلة — `Form_WPF/FrmSallah.xaml` («تكامل Salla API») و`Home.xaml` L394
 * («متجر سلة»: المنتجات · إدارة الطلبات · ربط المستودعات) وL638 («إعدادات ربط سلة»).
 *
 * Reading the store (connections · mappings · products · orders · the export log) needs
 * `salla.integration.view`; every operation — connect, pull, push, import, update a
 * status, disconnect — needs `salla.integration.manage`. The webhook is the one route with
 * no permission: it is signed with the store's secret instead.
 */
@Controller('integrations/salla')
export class SallaController {
  constructor(
    private readonly salla: SallaService,
    private readonly store: SallaStoreService,
  ) {}

  private get tenantId(): string {
    return getTenantContext().tenantId;
  }

  // ─────────────────────────────── إعدادات ربط سلة ───────────────────────────────

  /** `SallaAuth` — where the merchant's code becomes a token. */
  @Get('oauth/authorize')
  @RequiresPermission('salla.integration.manage')
  auth(@Query('clientId') clientId: string, @Query('redirectUri') redirectUri: string, @Query('state') state: string) {
    return this.salla.authUrl(this.tenantId, { clientId, redirectUri, state });
  }

  @Post('connections')
  @RequiresPermission('salla.integration.manage')
  connect(@Body() b: { storeId: string; accessToken: string; refreshToken?: string; webhookSecret: string; scopes?: string[]; expiresAt?: string }) {
    return this.salla.connect(this.tenantId, b);
  }

  /** قطع المتجر — connection, mappings and everything pulled under it. */
  @Delete('connections/:id')
  @RequiresPermission('salla.integration.manage')
  disconnect(@Param('id') id: string) {
    return this.store.disconnect(this.tenantId, id);
  }

  @Get('connections')
  @RequiresPermission('salla.integration.view')
  connections() {
    return this.salla.listConnections(this.tenantId);
  }

  /** «ربط المستودعات» — `FrmSallaBranchMapping` عند الديسكتوب (نافذتُه معلَّقة). */
  @Post('branch-mappings')
  @RequiresPermission('salla.integration.manage')
  map(@Body() b: { connectionId: string; branchId?: string; warehouseId?: string; cashLocationId?: string; remoteBranchId?: string }) {
    return this.salla.mapBranch(this.tenantId, b);
  }

  @Get('branch-mappings')
  @RequiresPermission('salla.integration.view')
  mappings() {
    return this.salla.listBranchMappings(this.tenantId);
  }

  // ─────────────────────────────── 📦 المنتجات ───────────────────────────────

  /** الأصناف محلياً وحالة مزامنتها — the screen's first table. */
  @Get('products')
  @RequiresPermission('salla.integration.view')
  products() {
    return this.salla.listProducts(this.tenantId);
  }

  /** «📦 جلب المنتجات» — `ProductsManager.GetProducts()`, mirrored into `salla_products`. */
  @Post('products/pull')
  @RequiresPermission('salla.integration.manage')
  pullProducts(@Body() b: { connectionId: string }) {
    return this.store.pullProducts(this.tenantId, b.connectionId);
  }

  /** ➕ إضافة منتج — `ProductsManager.CreateProduct()`, from a real صنف. */
  @Post('products/push')
  @RequiresPermission('salla.integration.manage')
  pushProduct(@Body() b: { connectionId: string; itemId: string }) {
    return this.store.pushProduct(this.tenantId, b);
  }

  /** ما في المتجر الآن — the mirror «📦 جلب المنتجات» filled. */
  @Get('catalog')
  @RequiresPermission('salla.integration.view')
  catalog(@Query('connectionId') connectionId?: string) {
    return this.store.listStoreProducts(this.tenantId, connectionId);
  }

  @Put('products/:remoteId')
  @RequiresPermission('salla.integration.manage')
  updateProduct(@Param('remoteId') remoteId: string, @Body() b: { connectionId: string; itemId: string }) {
    return this.store.updateProduct(this.tenantId, b);
  }

  @Delete('products/:remoteId')
  @RequiresPermission('salla.integration.manage')
  deleteProduct(@Param('remoteId') remoteId: string, @Query('connectionId') connectionId: string, @Query('itemId') itemId: string) {
    void remoteId;
    return this.store.deleteProduct(this.tenantId, { connectionId, itemId });
  }

  // ─────────────────────────────── 👥 العملاء ───────────────────────────────

  /** «👥 العملاء» — `CustomersManager.GetCustomers()`; read-only, and stored nowhere. */
  @Get('customers')
  @RequiresPermission('salla.integration.view')
  customers(@Query('connectionId') connectionId: string) {
    return this.store.pullCustomers(this.tenantId, connectionId);
  }

  // ─────────────────────────────── 📋 إدارة الطلبات ───────────────────────────────

  /** «📋 جلب الطلبات» — `OrdersManager.GetOrders()`, then a فاتورة لكل طلبٍ جديد. */
  @Post('orders/pull')
  @RequiresPermission('salla.integration.manage')
  pullOrders(@Body() b: { connectionId: string }) {
    return this.store.pullOrders(this.tenantId, b.connectionId);
  }

  /** «إدارة الطلبات» — every invoice tagged `salla`, with its remote number and status. */
  @Get('orders')
  @RequiresPermission('salla.integration.view')
  orders() {
    return this.store.listOrders(this.tenantId);
  }

  /** `OrdersManager.UpdateOrderStatus()` — `PUT orders/{id}/status` بـ`{ status }`. */
  @Put('orders/:id/status')
  @RequiresPermission('salla.integration.manage')
  orderStatus(@Param('id') id: string, @Body() b: { status: string }) {
    return this.store.updateOrderStatus(this.tenantId, id, b?.status ?? '');
  }

  /** 🗑️ — the import's way back: المسوّدة تُمحى، والطلب المُرحَّل يُرتجَع. */
  @Delete('orders/:id')
  @RequiresPermission('salla.integration.manage')
  deleteOrder(@Param('id') id: string) {
    return this.store.deleteOrder(this.tenantId, id);
  }

  // ─────────────────────────────── طابور التصدير ───────────────────────────────

  @Post('export-queue')
  @RequiresPermission('salla.integration.manage')
  queue(@Body() b: { connectionId: string; itemId: string; action?: 'create' | 'update' | 'price' | 'qty' }) {
    return this.salla.queueExport(this.tenantId, b);
  }

  @Post('export-next')
  @RequiresPermission('salla.integration.manage')
  exportNext() {
    return this.salla.exportNext(this.tenantId);
  }

  @Get('export-log')
  @RequiresPermission('salla.integration.view')
  logs() {
    return this.salla.logs(this.tenantId);
  }

  // ─────────────────────────────── الويب هوك ───────────────────────────────

  /**
   * AUD-04 — بلا صلاحية: التوقيع هو بيانات الاعتماد، والمسار **عامّ** لأنه يأتي من متجر
   * سلة لا من مستخدمٍ داخل المنشأة. المستأجر يُشتقّ في الخدمة من صفّ الاتصال الموقَّع،
   * لا من سياق الطلب — و`rawBody` هو ما وقّعه المزود بالبايت، لا `JSON.stringify(body)`
   * (إعادة التسلسل قد تغيّر المسافات أو ترتيب المفاتيح فيفشل التحقّق على جسمٍ صحيح).
   */
  @Public()
  @Post('webhooks/:storeId/orders')
  webhook(
    @Param('storeId') storeId: string,
    @Headers('x-salla-signature') signature: string | undefined,
    @Req() req: Request,
    @Body() body: { event?: string; data?: { customer?: { name?: string; mobile?: string }; items?: Array<{ name?: string; quantity?: string; amount?: string }>; branchId?: string } },
  ) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    return this.salla.webhook(storeId, rawBody, signature, body);
  }
}
