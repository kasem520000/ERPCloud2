import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';

import { Public } from '../platform/decorators/public.decorator.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';
import { getTenantContext } from '../platform/context/tenant-context.js';

import {
  PaymentLinksService,
  type CreateLinkInput,
  type ProviderConfigInput,
} from './payment-links.service.js';

@Controller()
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  @Get('payments/providers')
  @RequiresPermission('payments.links.manage')
  providers() {
    return this.links.listConfigs(getTenantContext().tenantId);
  }

  @Post('payments/providers')
  @RequiresPermission('payments.links.manage')
  save(@Body() body: ProviderConfigInput) {
    return this.links.saveConfig(getTenantContext().tenantId, body ?? { provider: '' });
  }

  @Get('payments/links')
  @RequiresPermission('payments.links.manage')
  list(@Query('invoice_id') invoiceId?: string) {
    return this.links.listLinks(getTenantContext().tenantId, invoiceId);
  }

  @Post('payments/links')
  @RequiresPermission('payments.links.manage')
  create(@Body() body: CreateLinkInput) {
    return this.links.createLink(getTenantContext().tenantId, body ?? {});
  }

  @Post('payments/links/:id/send')
  @RequiresPermission('payments.links.manage')
  send(@Param('id') id: string, @Body() body: { channel?: string; to?: string }) {
    return this.links.sendLink(getTenantContext().tenantId, id, body ?? {});
  }

  @Post('payments/links/:id/simulate')
  @RequiresPermission('payments.links.manage')
  simulate(@Param('id') id: string) {
    return this.links.simulatePayment(getTenantContext().tenantId, id);
  }

  /**
   * Provider callbacks are public. The tenant comes from metadata we set on the invoice
   * (or from the webhook URL query), and the shared secret is checked before any voucher
   * is written. A forged tenant id without that secret is rejected.
   */
  @Post('payments/webhooks/:provider')
  @Public()
  webhook(
    @Param('provider') provider: string,
    @Query('tenant_id') tenantId: string | undefined,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: Record<string, unknown>,
  ) {
    return this.links.receiveWebhook(provider, body ?? {}, headers ?? {}, tenantId);
  }
}
