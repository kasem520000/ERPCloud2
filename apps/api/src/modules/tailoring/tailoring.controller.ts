import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  MEASUREMENT_FIELDS,
  TailoringService,
  type AttributeInput,
  type AttributePatch,
  type CategoryInput,
  type InvoiceInput,
  type InvoicePatch,
  type InvoiceQuery,
  type MeasurementField,
  type MeasurementInput,
  type MeasurementPatch,
  type MeasurementQuery,
  type OrderInput,
  type OrderPatch,
  type OrderQuery,
  type PaymentInput,
  type TypeInput,
  type TypePatch,
  type ValueInput,
} from './tailoring.service.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `1 | true | on` — the desktop reads its own checkboxes; the cloud reads query flags. */
function flag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === '1' || value === 'true' || value === 'on';
}

/**
 * 🧵 التفصيل — `Form_WPF/frmOrders.xaml` («إدارة طلبات التفصيل»),
 * `Form_WPF/frmOrderDetails.xaml` («إضافة طلب تفصيل») and
 * `Form_WPF/frmOptions.xaml` («⚙️ إدارة الخيارات الجاهزة»).
 *
 * Reading a طلب needs `tailoring.view`; saving, changing الحالة or deleting one needs
 * `tailoring.manage` — the same split as `frmOrders` (everyone may look) and
 * `frmOrderDetails` / `frmOptions` (only the person who keeps the catalogue).
 */
@Controller('tailoring')
export class TailoringController {
  constructor(private readonly tailoring: TailoringService) {}

  private get tenantId(): string {
    return getTenantContext().tenantId;
  }

  private get userId(): string | undefined {
    return tryGetAuthContext()?.userId;
  }

  // ─────────────────────────────── 📏 القياسات ───────────────────────────────

  @Get('parties/:partyId/measurements')
  @RequiresPermission('tailoring.view')
  list(@Param('partyId') partyId: string) {
    return this.tailoring.list(this.tenantId, partyId);
  }

  @Get('parties/:partyId/measurements/latest')
  @RequiresPermission('tailoring.view')
  latest(@Param('partyId') partyId: string) {
    return this.tailoring.latest(this.tenantId, partyId);
  }

  /**
   * 📋 قياسات العميل — `frmMeasurements.LoadAllMeasurements`, or
   * `LoadCustomerMeasurements` once «🔍 بحث» has picked a عميل by `?search=`.
   */
  @Get('measurements')
  @RequiresPermission('tailoring.view')
  listMeasurements(
    @Query('search') search?: string,
    @Query('partyId') partyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: MeasurementQuery = {};
    if (search !== undefined) query.search = search;
    if (partyId) query.partyId = partyId;
    if (limit) query.limit = limit;
    if (offset) query.offset = offset;
    return this.tailoring.listMeasurements(this.tenantId, query);
  }

  @Get('measurements/:id')
  @RequiresPermission('tailoring.view')
  getMeasurement(@Param('id') id: string) {
    return this.tailoring.getMeasurement(this.tenantId, id);
  }

  @Post('measurements')
  @RequiresPermission('tailoring.manage')
  create(@Body() body: MeasurementInput) {
    return this.tailoring.createMeasurement(this.tenantId, body, this.userId);
  }

  @Patch('measurements/:id')
  @RequiresPermission('tailoring.manage')
  updateMeasurement(@Param('id') id: string, @Body() body: MeasurementPatch) {
    return this.tailoring.updateMeasurement(this.tenantId, id, body, this.userId);
  }

  @Delete('measurements/:id')
  @RequiresPermission('tailoring.manage')
  deleteMeasurement(@Param('id') id: string) {
    return this.tailoring.deleteMeasurement(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── 📏 خصائص القياسات ───────────────────────────────

  /** `frmMeasurementAttributes.LoadData` — `ORDER BY DisplayOrder`, with ⚙️ الحالة نشط/معطل. */
  @Get('measurement-attributes')
  @RequiresPermission('tailoring.view')
  listAttributes(@Query('activeOnly') activeOnly?: string) {
    return this.tailoring.listAttributes(this.tenantId, { activeOnly: flag(activeOnly) ?? false });
  }

  @Post('measurement-attributes')
  @RequiresPermission('tailoring.manage')
  createAttribute(@Body() body: AttributeInput) {
    return this.tailoring.createAttribute(this.tenantId, body, this.userId);
  }

  @Patch('measurement-attributes/:id')
  @RequiresPermission('tailoring.manage')
  updateAttribute(@Param('id') id: string, @Body() body: AttributePatch) {
    return this.tailoring.updateAttribute(this.tenantId, id, body, this.userId);
  }

  /** «🔕 تعطيل» — `IsActive = 0`: «سيتم إخفاؤها من القياسات الجديدة». */
  @Post('measurement-attributes/:id/deactivate')
  @RequiresPermission('tailoring.manage')
  deactivateAttribute(@Param('id') id: string) {
    return this.tailoring.deactivateAttribute(this.tenantId, id, this.userId);
  }

  /** «▲ تحريك للأعلى» و«▼ تحريك للأسفل» — `direction=up|down`. */
  @Post('measurement-attributes/:id/move')
  @RequiresPermission('tailoring.manage')
  moveAttribute(@Param('id') id: string, @Body() body: { direction: 'up' | 'down' }) {
    return this.tailoring.moveAttribute(this.tenantId, id, body?.direction === 'down' ? 'down' : 'up', this.userId);
  }

  // ─────────────────────────────── ⚙️ الحالات ───────────────────────────────

  /** `cmbStatus` in `frmOrders` — «الكل» (0) is a UI row, so `all` returns everything. */
  @Get('order-statuses')
  @RequiresPermission('tailoring.view')
  listStatuses(@Query('activeOnly') activeOnly?: string) {
    return this.tailoring.listStatuses(this.tenantId, { activeOnly: flag(activeOnly) ?? true });
  }

  // ─────────────────────────────── 🧵 أنواع التفصيل ───────────────────────────────

  @Get('types')
  @RequiresPermission('tailoring.view')
  listTypes(@Query('activeOnly') activeOnly?: string) {
    return this.tailoring.listTypes(this.tenantId, { activeOnly: flag(activeOnly) ?? true });
  }

  @Post('types')
  @RequiresPermission('tailoring.manage')
  createType(@Body() body: TypeInput) {
    return this.tailoring.createType(this.tenantId, body, this.userId);
  }

  @Patch('types/:id')
  @RequiresPermission('tailoring.manage')
  updateType(@Param('id') id: string, @Body() body: TypePatch) {
    return this.tailoring.updateType(this.tenantId, id, body, this.userId);
  }

  @Delete('types/:id')
  @RequiresPermission('tailoring.manage')
  deleteType(@Param('id') id: string) {
    return this.tailoring.deleteType(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── 🔧 الخيارات الجاهزة ───────────────────────────────

  @Get('option-categories')
  @RequiresPermission('tailoring.view')
  listOptionCategories(@Query('activeOnly') activeOnly?: string) {
    return this.tailoring.listOptionCategories(this.tenantId, { activeOnly: flag(activeOnly) ?? true });
  }

  @Post('option-categories')
  @RequiresPermission('tailoring.manage')
  createOptionCategory(@Body() body: CategoryInput) {
    return this.tailoring.createOptionCategory(this.tenantId, body, this.userId);
  }

  @Patch('option-categories/:id')
  @RequiresPermission('tailoring.manage')
  updateOptionCategory(
    @Param('id') id: string,
    @Body() body: { nameAr?: string; displayOrder?: number; active?: boolean },
  ) {
    return this.tailoring.updateOptionCategory(this.tenantId, id, body, this.userId);
  }

  @Delete('option-categories/:id')
  @RequiresPermission('tailoring.manage')
  deleteOptionCategory(@Param('id') id: string) {
    return this.tailoring.deleteOptionCategory(this.tenantId, id, this.userId);
  }

  @Post('option-values')
  @RequiresPermission('tailoring.manage')
  createOptionValue(@Body() body: ValueInput) {
    return this.tailoring.createOptionValue(this.tenantId, body, this.userId);
  }

  @Patch('option-values/:id')
  @RequiresPermission('tailoring.manage')
  updateOptionValue(
    @Param('id') id: string,
    @Body() body: { nameAr?: string; displayOrder?: number; isDefault?: boolean; active?: boolean },
  ) {
    return this.tailoring.updateOptionValue(this.tenantId, id, body, this.userId);
  }

  @Delete('option-values/:id')
  @RequiresPermission('tailoring.manage')
  deleteOptionValue(@Param('id') id: string) {
    return this.tailoring.deleteOptionValue(this.tenantId, id, this.userId);
  }

  /** ⭐ تعيين افتراضي (`frmOptions.xaml`). */
  @Post('option-values/:id/default')
  @RequiresPermission('tailoring.manage')
  setDefaultOptionValue(@Param('id') id: string) {
    return this.tailoring.setDefaultOptionValue(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── 🧾 الطلبات ───────────────────────────────

  @Get('orders')
  @RequiresPermission('tailoring.view')
  listOrders(
    @Query('statusId') statusId?: string,
    @Query('partyId') partyId?: string,
    @Query('typeId') typeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: OrderQuery = {
      statusId: str(statusId),
      partyId: str(partyId),
      typeId: str(typeId),
      from: str(from),
      to: str(to),
      search: str(search),
      limit: num(limit),
      offset: num(offset),
    };
    return this.tailoring.listOrders(this.tenantId, query);
  }

  @Get('orders/:id')
  @RequiresPermission('tailoring.view')
  getOrder(@Param('id') id: string) {
    return this.tailoring.getOrder(this.tenantId, id);
  }

  @Post('orders')
  @RequiresPermission('tailoring.manage')
  createOrder(@Body() body: OrderInput) {
    return this.tailoring.createOrder(this.tenantId, body, this.userId);
  }

  @Patch('orders/:id')
  @RequiresPermission('tailoring.manage')
  updateOrder(@Param('id') id: string, @Body() body: OrderPatch) {
    return this.tailoring.updateOrder(this.tenantId, id, body, this.userId);
  }

  /** 🔄 تغيير الحالة — the «تغيير حالة الطلب» window in `frmOrders`. */
  @Post('orders/:id/status')
  @RequiresPermission('tailoring.manage')
  changeStatus(@Param('id') id: string, @Body() body: { statusId: string }) {
    return this.tailoring.changeStatus(this.tenantId, id, body?.statusId, this.userId);
  }

  @Delete('orders/:id')
  @RequiresPermission('tailoring.manage')
  deleteOrder(@Param('id') id: string) {
    return this.tailoring.deleteOrder(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── 🧾 فاتورة التفصيل ───────────────────────────────

  /** 👔 نوع الثوب — `typeCB` in `AddNewSizes.xaml` L423. */
  @Get('garment-types')
  @RequiresPermission('tailoring.view')
  listGarmentTypes() {
    return this.tailoring.listGarmentTypes(this.tenantId);
  }

  /**
   * 📐 المقاسات — the field catalogue of `Inv_Sub_Tailor`. The labels are the
   * `Label Content` of `AddNewSizes.xaml`, not data, so they are served rather than
   * seeded: the screen renders «الطول (س)» · «شكل اليد» · «كفة تحت» as the tailor
   * reads them.
   */
  @Get('measurement-fields')
  @RequiresPermission('tailoring.view')
  measurementFields(): { data: MeasurementField[] } {
    return { data: MEASUREMENT_FIELDS };
  }

  /** «🔍 الهاتف أو اسم العميل...» + «🔍 عرض» (`frmViewOrders`). */
  @Get('invoices')
  @RequiresPermission('tailoring.view')
  listInvoices(
    @Query('search') search?: string,
    @Query('partyId') partyId?: string,
    @Query('statusId') statusId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: InvoiceQuery = {
      search: str(search),
      partyId: str(partyId),
      statusId: str(statusId),
      from: str(from),
      to: str(to),
      limit: num(limit),
      offset: num(offset),
    };
    return this.tailoring.listInvoices(this.tenantId, query);
  }

  /** `👁️ عرض` — `AddNewSizes.showResult(code)` (`frmViewOrders` L156). */
  @Get('invoices/:id')
  @RequiresPermission('tailoring.view')
  getInvoice(@Param('id') id: string) {
    return this.tailoring.getInvoice(this.tenantId, id);
  }

  /** «💾 حفظ» (`AddNewSizes` L191). */
  @Post('invoices')
  @RequiresPermission('tailoring.manage')
  createInvoice(@Body() body: InvoiceInput) {
    return this.tailoring.createInvoice(this.tenantId, body, this.userId);
  }

  @Patch('invoices/:id')
  @RequiresPermission('tailoring.manage')
  updateInvoice(@Param('id') id: string, @Body() body: InvoicePatch) {
    return this.tailoring.updateInvoice(this.tenantId, id, body, this.userId);
  }

  /** ✅ الحالة — the `✔` beside `stateCB` (`stateSaveBtN_Click` L761). */
  @Post('invoices/:id/status')
  @RequiresPermission('tailoring.manage')
  changeInvoiceStatus(@Param('id') id: string, @Body() body: { statusId: string }) {
    return this.tailoring.changeInvoiceStatus(this.tenantId, id, body?.statusId, this.userId);
  }

  /** 💵 إستلام دفعة — `frmSandQ` with `ISTailor = true` (`AddNewSizes` L664). */
  @Post('invoices/:id/payments')
  @RequiresPermission('tailoring.manage')
  addPayment(@Param('id') id: string, @Body() body: PaymentInput) {
    return this.tailoring.addPayment(this.tenantId, id, body ?? { amount: 0 }, this.userId);
  }

  @Delete('invoices/:id')
  @RequiresPermission('tailoring.manage')
  deleteInvoice(@Param('id') id: string) {
    return this.tailoring.deleteInvoice(this.tenantId, id, this.userId);
  }
}
