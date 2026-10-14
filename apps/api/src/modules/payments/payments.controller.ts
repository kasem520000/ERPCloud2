import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { PaymentsService, type GatewaySettingsInput, type SaleInput } from './payments.service.js';

/**
 * 💳 بوابات الدفع — `Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` L1726-L1831
 * («إعدادات جيديا» + GroupBox «NeoLeap») and the two POS save paths that call them
 * (`frmPOSBill.xaml.cs` L460-L492, `frmPOSPay.xaml.cs` L428-L441).
 *
 * The desktop's save button did all of this in one click, on the cashier's machine, with
 * no record left behind. The calls are separated here because a server must be able to
 * answer «what did the gateway say?» after the fact — and because the answer decides
 * whether an invoice is paid.
 */
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** The two cards of the window — 💳 إعدادات جيديا and NeoLeap. */
  @Get('payment-gateways') @RequiresPermission('pos.config.manage')
  view() {
    return this.payments.view(getTenantContext().tenantId);
  }

  /** 💾 حفظ — one provider at a time, exactly as the window saves them. */
  @Put('payment-gateways/:provider') @RequiresPermission('pos.config.manage')
  save(@Param('provider') provider: string, @Body() body: GatewaySettingsInput) {
    return this.payments.save(getTenantContext().tenantId, provider, body ?? {});
  }

  /** 🧪 TEST · 🧪 Test — `BtnTestGedia_Click` (L2513) and `Btntestneoleap_Click` (L4047). */
  @Post('payment-gateways/:provider/test') @RequiresPermission('pos.config.manage')
  test(@Param('provider') provider: string, @Body() body: { amount?: string }) {
    return this.payments.test(getTenantContext().tenantId, provider, body ?? {});
  }

  /** 💳 — the sale the POS used to run inside its own save. */
  @Post('payment-gateways/:provider/sale') @RequiresPermission('sales.invoice.pay')
  sale(@Param('provider') provider: string, @Body() body: SaleInput) {
    return this.payments.sale(getTenantContext().tenantId, provider, body ?? ({} as SaleInput));
  }

  /** The log — what the desktop threw away once the receipt was printed. */
  @Get('payment-gateways/transactions') @RequiresPermission('sales.view')
  transactions(@Query('provider') provider?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.payments.transactions(getTenantContext().tenantId, { provider, status, limit });
  }

  /** 🔄 — ask جيديا again how a session the cardholder has not finished ended. */
  @Post('payment-gateways/transactions/:id/refresh') @RequiresPermission('sales.invoice.pay')
  refresh(@Param('id') id: string) {
    return this.payments.refresh(getTenantContext().tenantId, id);
  }
}
