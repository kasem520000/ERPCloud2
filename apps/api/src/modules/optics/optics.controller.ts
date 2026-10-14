import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { OpticsService, type FieldLabelsInput, type PrescriptionInput, type PrescriptionPatch, type PrescriptionQuery } from './optics.service.js';

/**
 * 👓 النظارات — `Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات»), whose two tabs are
 * the card «👓  القياسات» and the definitions «⚙  أسماء الحقول»; the numbers are written
 * by `Class/InvoiceOper.cs` L1656 and printed by `Class/Print.cs` L710.
 *
 * Reading («👓 القياسات», the ten captions, قسم الطباعة) needs `optics.view`; writing a
 * وصفة or saving the captions needs `optics.manage` — the same split as the window
 * itself: opened from a فاتورة everyone may look, and «💾 حفظ الأسماء» belongs to the
 * person who keeps the catalogue.
 */
@Controller('optics')
export class OpticsController {
  constructor(private readonly optics: OpticsService) {}

  private get tenantId(): string {
    return getTenantContext().tenantId;
  }

  private get userId(): string | undefined {
    return tryGetAuthContext()?.userId;
  }

  // ─────────────────────────────── 👓 بيانات النظارات ───────────────────────────────

  /** 👓 بيانات النظارات — `?search=` picks a عميل, `?partyId=` lists one عميل's وصفات. */
  @Get('prescriptions')
  @RequiresPermission('optics.view')
  listPrescriptions(
    @Query('search') search?: string,
    @Query('partyId') partyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: PrescriptionQuery = {};
    if (search !== undefined) query.search = search;
    if (partyId) query.partyId = partyId;
    if (limit) query.limit = limit;
    if (offset) query.offset = offset;
    return this.optics.listPrescriptions(this.tenantId, query);
  }

  @Get('prescriptions/:id')
  @RequiresPermission('optics.view')
  getPrescription(@Param('id') id: string) {
    return this.optics.getPrescription(this.tenantId, id);
  }

  /** «✔ إدراج» — `btnSave_Click`: two `Glass` rows in the desktop, one وصفة here. */
  @Post('prescriptions')
  @RequiresPermission('optics.manage')
  createPrescription(@Body() body: PrescriptionInput) {
    return this.optics.createPrescription(this.tenantId, body, this.userId);
  }

  @Patch('prescriptions/:id')
  @RequiresPermission('optics.manage')
  updatePrescription(@Param('id') id: string, @Body() body: PrescriptionPatch) {
    return this.optics.updatePrescription(this.tenantId, id, body, this.userId);
  }

  @Delete('prescriptions/:id')
  @RequiresPermission('optics.manage')
  deletePrescription(@Param('id') id: string) {
    return this.optics.deletePrescription(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── ⚙️ أسماء الحقول ───────────────────────────────

  /** `loadNameLbl` — «حقل 1» … «حقل 10» with the names this tenant gave them. */
  @Get('field-labels')
  @RequiresPermission('optics.view')
  getFieldLabels() {
    return this.optics.getFieldLabels(this.tenantId);
  }

  /** «💾 حفظ الأسماء» — `insertglasses()`: the row is replaced, not patched. */
  @Put('field-labels')
  @RequiresPermission('optics.manage')
  saveFieldLabels(@Body() body: FieldLabelsInput) {
    return this.optics.saveFieldLabels(this.tenantId, body, this.userId);
  }

  // ─────────────────────────────── قسم الطباعة ───────────────────────────────

  /** `Class/Print.cs` L710 — `ReSPH … LeIPD` of one سطر فاتورة, with the captions. */
  @Get('invoice-lines/:lineId/print-section')
  @RequiresPermission('optics.view')
  print(@Param('lineId') lineId: string) {
    return this.optics.invoicePrintSection(this.tenantId, lineId);
  }
}
