import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  SalesService,
  type PaymentInput,
  type PostingInput,
  type SalesInvoiceInput,
  type SalesmanInput,
} from './sales.service.js';

/**
 * The screen sends «الكل» as a checkbox and the API answers both dialects — `1`,
 * `true` and `on` all mean checked, and `undefined` has to stay `undefined` so the
 * service can tell «لم يُرسل شيء» from «أُرسل لا»: both boxes default to checked.
 */
function flag(value?: string): boolean | undefined {
  return value === undefined ? undefined : value === '1' || value === 'true' || value === 'on';
}

@Controller()
export class SalesController {
  constructor(private readonly sales: SalesService) {}
  @Get('sales/invoices') @RequiresPermission('sales.view') list() { return this.sales.list(getTenantContext().tenantId); }
  @Get('sales/invoices/:id') @RequiresPermission('sales.view') get(@Param('id') id: string) { return this.sales.get(getTenantContext().tenantId, id); }
  @Get('sales/invoices/:id/print-data') @RequiresPermission('sales.view') printData(@Param('id') id: string) { return this.sales.printData(getTenantContext().tenantId, id); }
  @Post('sales/invoices') @RequiresPermission('sales.invoice.create') create(@Body() body: SalesInvoiceInput) { return this.sales.create(getTenantContext().tenantId, body); }
  @Patch('sales/invoices/:id') @RequiresPermission('sales.invoice.create') update(@Param('id') id: string, @Body() body: Partial<SalesInvoiceInput>) { return this.sales.updateDraft(getTenantContext().tenantId, id, body); }
  @Post('sales/invoices/:id/post') @RequiresPermission('sales.invoice.post') post(@Param('id') id: string, @Body() body: PostingInput) { return this.sales.post(getTenantContext().tenantId, id, body); }
  @Post('sales/invoices/:id/void') @RequiresPermission('sales.invoice.void') void(@Param('id') id: string, @Body() body: { reason: string }) { return this.sales.void(getTenantContext().tenantId, id, body.reason); }
  @Post('sales/invoices/:id/payments') @RequiresPermission('sales.invoice.pay') payment(@Param('id') id: string, @Body() body: PaymentInput) { return this.sales.addPayment(getTenantContext().tenantId, id, body); }
  @Post('sales/invoices/:id/return') @RequiresPermission('sales.return.create') returnFrom(@Param('id') id: string, @Body() body: Omit<SalesInvoiceInput, 'kind'>) { return this.sales.returnFrom(getTenantContext().tenantId, id, body); }
  @Post('sales/invoices/:id/adjustment-notes') @RequiresPermission('sales.adjustment.create') note(@Param('id') id: string, @Body() body: { branchId: string; kind: string; reason: string; amount: string }) { return this.sales.createAdjustmentNote(getTenantContext().tenantId, id, body); }
  @Get('sales/adjustment-notes') @RequiresPermission('sales.view') notes(@Query('kind') kind?: string) { return this.sales.listAdjustmentNotes(getTenantContext().tenantId, kind); }
  @Post('sales/adjustment-notes/:id/post') @RequiresPermission('sales.invoice.post') postNote(@Param('id') id: string) { return this.sales.postAdjustmentNote(getTenantContext().tenantId, id); }
  @Post('sales/offers/:id/evaluate') @RequiresPermission('sales.view') evaluateOffer(@Param('id') id: string, @Body() body: { itemId: string; quantity: string; value: string }) { return this.sales.evaluateOffer(getTenantContext().tenantId, id, body); }
  @Get('sales/quotations') @RequiresPermission('sales.view') quotations() { return this.sales.listQuotations(getTenantContext().tenantId); }
  @Post('sales/quotations') @RequiresPermission('sales.invoice.create') createQuotation(@Body() body: Parameters<SalesService['createQuotation']>[1]) { return this.sales.createQuotation(getTenantContext().tenantId, body); }
  @Post('sales/quotations/:id/convert') @RequiresPermission('sales.invoice.create') convertQuotation(@Param('id') id: string, @Body() body: { warehouseId?: string }) { return this.sales.convertQuotation(getTenantContext().tenantId, id, body ?? {}); }
  @Get('sales/offers') @RequiresPermission('sales.view') offers() { return this.sales.listOffers(getTenantContext().tenantId); }
  @Post('sales/offers') @RequiresPermission('sales.offer.manage') createOffer(@Body() body: Parameters<SalesService['createOffer']>[1]) { return this.sales.createOffer(getTenantContext().tenantId, body); }
  @Get('sales/salesmen') @RequiresPermission('sales.view') salesmen() { return this.sales.listSalesmen(getTenantContext().tenantId); }
  /** 👤 عميل نقدي — the desktop searches the invoices themselves, not a customer table. */
  @Get('sales/cash-customers')
  @RequiresPermission('sales.view')
  cashCustomers(@Query('name') name?: string, @Query('mobile') mobile?: string) {
    return this.sales.cashCustomers(getTenantContext().tenantId, { name, mobile });
  }
  /**
   * 🧑‍💼 شاشة المندوبين — `frmSalesMen.xaml`: the card now carries the three
   * commission rates (`عمولة المبيعات` · `عمولة التحصيل` · `عمولة الربح`), the three
   * contacts and the link to the employee card. Nothing already answered by the old
   * body stopped being accepted.
   */
  @Post('sales/salesmen') @RequiresPermission('sales.salesman.manage') createSalesman(@Body() body: SalesmanInput & { name: string }) { return this.sales.createSalesman(getTenantContext().tenantId, body); }
  @Patch('sales/salesmen/:id') @RequiresPermission('sales.salesman.manage') updateSalesman(@Param('id') id: string, @Body() body: SalesmanInput) { return this.sales.updateSalesman(getTenantContext().tenantId, id, body); }
  @Delete('sales/salesmen/:id') @RequiresPermission('sales.salesman.manage') deleteSalesman(@Param('id') id: string) { return this.sales.deleteSalesman(getTenantContext().tenantId, id); }

  /**
   * 📋 طباعة فواتير مندوب وعمولاتهم — `frmInvBySalesMen.xaml` («مبيعات مندوب خلال
   * فترة»): every فاتورة of the مندوب with the three commissions it earns, the
   * «إشعار مدين» that takes some of them back, and the سندات القبض he collected.
   */
  @Get('sales/salesmen/commissions')
  @RequiresPermission('sales.view')
  salesmanCommissions(
    @Query('salesman_id') salesmanId?: string,
    @Query('all_salesmen') allSalesmen?: string,
    @Query('all_period') allPeriod?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branch_id') branchId?: string,
  ) {
    return this.sales.salesmanCommissions(getTenantContext().tenantId, {
      salesmanId: salesmanId?.trim() || undefined,
      allSalesmen: flag(allSalesmen),
      allPeriod: flag(allPeriod),
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
      branchId: branchId?.trim() || undefined,
    });
  }
}
