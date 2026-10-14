import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { PrintSettingsService, type PrintSettingsInput } from './print-settings.service.js';
import { PrintTemplatesService } from './print-templates.service.js';
import { PrinterLinksService, type PrinterLinkInput } from './printer-links.service.js';
import { ReportLayoutsService, type ReportLayoutInput } from './report-layouts.service.js';
import { ReportingService, type ExportFormat } from './reporting.service.js';

@Controller('reports')
export class ReportingController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly layouts: ReportLayoutsService,
    private readonly print: PrintTemplatesService,
    private readonly printSettings: PrintSettingsService,
    private readonly printerLinks: PrinterLinksService,
  ) {}
  @Get() @RequiresPermission('reporting.view') catalog() { return this.reporting.catalog(); }

  // Declared before `:key` on purpose — otherwise the layout routes would be swallowed by
  // the report runner and `/reports/layouts` would look like a report called "layouts".
  @Get('layouts') @RequiresPermission('reporting.view') async listLayouts(@Query('report_key') reportKey?: string) { return { data: await this.layouts.list(getTenantContext().tenantId, reportKey) }; }
  @Post('layouts') @RequiresPermission('reporting.layout.manage') async createLayout(@Body() body: ReportLayoutInput) { return { data: await this.layouts.create(getTenantContext().tenantId, body) }; }
  @Patch('layouts/:id') @RequiresPermission('reporting.layout.manage') async updateLayout(@Param('id') id: string, @Body() body: Partial<ReportLayoutInput>) { return { data: await this.layouts.update(getTenantContext().tenantId, id, body) }; }
  @Delete('layouts/:id') @RequiresPermission('reporting.layout.manage') async deleteLayout(@Param('id') id: string) { return { data: await this.layouts.remove(getTenantContext().tenantId, id) }; }

  // 🖨️ إعدادات الطباعة — `SettingPrint` of `Desktop_ERP` (`frmSettings.xaml` «خيارات
  // الطباعة»). Reading them is part of viewing a report; changing them is part of owning
  // the report designer's surface, so writes carry `reporting.layout.manage`.
  @Get('print-settings') @RequiresPermission('reporting.view') listPrintSettings() { return this.printSettings.list(getTenantContext().tenantId); }
  @Put('print-settings/:scope') @RequiresPermission('reporting.layout.manage') async writePrintSettings(@Param('scope') scope: string, @Body() body: PrintSettingsInput) { return { data: await this.printSettings.write(getTenantContext().tenantId, scope, body) }; }
  @Delete('print-settings/:scope') @RequiresPermission('reporting.layout.manage') async resetPrintSettings(@Param('scope') scope: string) { return { data: await this.printSettings.reset(getTenantContext().tenantId, scope) }; }
  @Get('print-settings/:scope') @RequiresPermission('reporting.view') readPrintSettings(@Param('scope') scope: string) { return this.printSettings.read(getTenantContext().tenantId, scope); }

  // 📑 ربط الطابعات بالتقارير — `PrinterSettings` L2163-L2180 (`Inv_Id, PrintName, Printer, RptUrl, RptName`)
  @Get('printer-links') @RequiresPermission('reporting.view') listPrinterLinks() { return this.printerLinks.list(getTenantContext().tenantId); }
  @Post('printer-links') @RequiresPermission('reporting.layout.manage') async createPrinterLink(@Body() body: PrinterLinkInput) { return { data: await this.printerLinks.create(getTenantContext().tenantId, body) }; }
  @Put('printer-links/:id') @RequiresPermission('reporting.layout.manage') async updatePrinterLink(@Param('id') id: string, @Body() body: Partial<PrinterLinkInput>) { return { data: await this.printerLinks.update(getTenantContext().tenantId, id, body) }; }
  @Delete('printer-links/:id') @RequiresPermission('reporting.layout.manage') async deletePrinterLink(@Param('id') id: string) { await this.printerLinks.remove(getTenantContext().tenantId, id); return { ok: true }; }

  // Printable documents. Each returns `{ html }` — a complete, self-contained A4 page the
  // browser can show in an iframe and send straight to the printer.
  @Get('print/invoices/:id') @RequiresPermission('reporting.view') async invoicePrint(@Param('id') id: string) { return { html: await this.print.salesInvoice(getTenantContext().tenantId, id) }; }
  @Get('print/purchase-invoices/:id') @RequiresPermission('reporting.view') async purchaseInvoicePrint(@Param('id') id: string) { return { html: await this.print.purchaseInvoice(getTenantContext().tenantId, id) }; }
  @Get('print/vouchers/:id') @RequiresPermission('reporting.view') async voucherPrint(@Param('id') id: string) { return { html: await this.print.voucher(getTenantContext().tenantId, id) }; }
  @Get('print/journal-entries/:id') @RequiresPermission('reporting.view') async journalPrint(@Param('id') id: string) { return { html: await this.print.journalEntry(getTenantContext().tenantId, id) }; }
  @Get('print/shifts/:id') @RequiresPermission('reporting.view') async shiftPrint(@Param('id') id: string) { return { html: await this.print.shiftClose(getTenantContext().tenantId, id) }; }
  // 🖨️ طباعة / 👁️ معاينة — the print-ready page of a report (`frmRpt*` has both buttons).
  // Declared before `:key` for the same reason `layouts` is.
  @Get('print/:key') @RequiresPermission('reporting.view') async printReport(@Param('key') key: string, @Query() query: Record<string, string | undefined>) {
    return this.reporting.printable(getTenantContext().tenantId, key, query, tryGetAuthContext()?.userId);
  }

  @Get(':key') @RequiresPermission('reporting.view') run(@Param('key') key: string, @Query() query: Record<string, string | undefined>) { return this.reporting.run(getTenantContext().tenantId, key, query); }
  @Post(':key/export') @RequiresPermission('reporting.export.execute') export(@Param('key') key: string, @Query() query: Record<string, string | undefined>, @Body() body: { format?: ExportFormat }) { return this.reporting.export(getTenantContext().tenantId, key, query, body.format ?? 'csv'); }
}
