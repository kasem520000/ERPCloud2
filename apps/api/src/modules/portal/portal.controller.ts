import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getAuthContext, getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { PortalService, type PortalGrantInput } from './portal.service.js';

/**
 * Two surfaces, one module.
 *
 * `/parties/:id/portal-access` is back-office work and is gated by `parties.manage`.
 * `/portal/*` is the customer's own view and carries **no** `@RequiresPermission`: a portal
 * login holds a role with an empty permission set, so those decorators would lock it out of
 * its own invoices. Authorisation for those routes is the `portal_accounts` row itself, which
 * every service method resolves from the token before it touches a table.
 */
@Controller()
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  // ---------------------------------------------------------------- back office
  @Get('portal-access') @RequiresPermission('parties.view') async listAllAccess(@Query('partyId') partyId?: string) {
    return { data: await this.portal.listAccess(getTenantContext().tenantId, partyId) };
  }

  @Get('parties/:id/portal-access') @RequiresPermission('parties.view') async listAccess(@Param('id') id: string) {
    return { data: await this.portal.listAccess(getTenantContext().tenantId, id) };
  }

  @Post('parties/:id/portal-access') @RequiresPermission('parties.manage') async grantAccess(@Param('id') id: string, @Body() body: PortalGrantInput) {
    return { data: await this.portal.grantAccess(getTenantContext().tenantId, getAuthContext().userId, id, body) };
  }

  @Patch('portal-access/:id') @RequiresPermission('parties.manage') async setStatus(@Param('id') id: string, @Body() body: { status: 'active' | 'suspended' }) {
    return { data: await this.portal.setAccessStatus(getTenantContext().tenantId, id, body.status) };
  }

  @Delete('portal-access/:id') @RequiresPermission('parties.manage') async revoke(@Param('id') id: string) {
    return { data: await this.portal.revokeAccess(getTenantContext().tenantId, id) };
  }

  // ---------------------------------------------------------------- the customer
  @Get('portal/me') async me() {
    return { data: await this.portal.me(getTenantContext().tenantId, getAuthContext().userId) };
  }

  @Get('portal/invoices') async invoices(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.portal.invoices(getTenantContext().tenantId, getAuthContext().userId, { from, to }) };
  }

  @Get('portal/invoices/:id') async invoice(@Param('id') id: string) {
    return { data: await this.portal.invoice(getTenantContext().tenantId, getAuthContext().userId, id) };
  }

  @Get('portal/invoices/:id/print') async invoicePrint(@Param('id') id: string) {
    return { html: await this.portal.invoicePrint(getTenantContext().tenantId, getAuthContext().userId, id) };
  }

  @Get('portal/invoices/:id/payment-link') async paymentLink(@Param('id') id: string) {
    return { data: await this.portal.paymentLink(getTenantContext().tenantId, getAuthContext().userId, id) };
  }

  @Get('portal/statement') async statement(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.portal.statement(getTenantContext().tenantId, getAuthContext().userId, { from, to }) };
  }

  @Get('portal/payments') async payments() {
    return { data: await this.portal.payments(getTenantContext().tenantId, getAuthContext().userId) };
  }
}
