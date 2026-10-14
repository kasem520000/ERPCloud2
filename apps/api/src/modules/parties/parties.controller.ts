/* eslint-disable no-restricted-syntax, import/order */
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';
import { PartiesService, type AllocationInput, type ContactInput, type PartyInput, type PaymentMethodInput } from './parties.service.js';
@Controller()
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}
  @Get('parties') @RequiresPermission('parties.view') list(@Query('kind') kind?: string) { return this.parties.list(getTenantContext().tenantId, kind); }
  @Get('parties/:id') @RequiresPermission('parties.view') get(@Param('id') id: string) { return this.parties.get(getTenantContext().tenantId, id); }
  @Post('parties') @RequiresPermission('parties.manage') create(@Body() body: PartyInput) { return this.parties.create(getTenantContext().tenantId, body); }
  @Put('parties/:id') @RequiresPermission('parties.manage') update(@Param('id') id: string, @Body() body: Partial<PartyInput>) { return this.parties.update(getTenantContext().tenantId, id, body); }
  @Delete('parties/:id') @RequiresPermission('parties.manage') async remove(@Param('id') id: string) { await this.parties.softDelete(getTenantContext().tenantId, id); return { data: { id, deleted: true } }; }
  @Get('parties/:id/contacts') @RequiresPermission('parties.view') contacts(@Param('id') id: string) { return this.parties.contacts(getTenantContext().tenantId, id); }
  @Post('parties/:id/contacts') @RequiresPermission('parties.manage') addContact(@Param('id') id: string, @Body() body: ContactInput) { return this.parties.addContact(getTenantContext().tenantId, id, body); }
  @Delete('parties/:partyId/contacts/:contactId') @RequiresPermission('parties.manage') removeContact(@Param('partyId') partyId: string, @Param('contactId') contactId: string) { return this.parties.removeContact(getTenantContext().tenantId, partyId, contactId); }
  @Get('parties/:id/balance') @RequiresPermission('parties.view') balance(@Param('id') id: string, @Query('asOf') asOf?: string) { return this.parties.partyBalance(getTenantContext().tenantId, id, asOf); }
  @Get('parties/:id/statement') @RequiresPermission('parties.view') statement(@Param('id') id: string, @Query('asOf') asOf?: string) { return this.parties.partyBalance(getTenantContext().tenantId, id, asOf); }
  @Get('payment-methods') @RequiresPermission('parties.view') paymentMethods() { return this.parties.listPaymentMethods(getTenantContext().tenantId); }
  @Post('payment-methods') @RequiresPermission('parties.manage') createPaymentMethod(@Body() body: PaymentMethodInput) { return this.parties.createPaymentMethod(getTenantContext().tenantId, body); }
  @Put('payment-methods/:id') @RequiresPermission('parties.manage') updatePaymentMethod(@Param('id') id: string, @Body() body: Partial<PaymentMethodInput>) { return this.parties.updatePaymentMethod(getTenantContext().tenantId, id, body); }
  @Post('allocations') @RequiresPermission('parties.allocate') allocate(@Body() body: AllocationInput) { return this.parties.allocate(getTenantContext().tenantId, body); }
}
