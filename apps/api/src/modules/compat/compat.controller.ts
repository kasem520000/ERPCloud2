import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';
import { Public } from '../platform/decorators/public.decorator.js';

import { CompatService } from './compat.service.js';
import type { LegacySalesInvoiceDto, LegacyVoucherDto } from './compat-mappers.js';

@Controller('compat')
export class CompatController {
  constructor(private readonly compat: CompatService) {}

  @Post('devices') @RequiresPermission('compat.manage') createDevice(@Body() body: { name: string; branchId: string; enumMaps?: Record<string, Record<string, string>> }) { return this.compat.createDevice(getTenantContext().tenantId, body); }
  @Get('devices') @RequiresPermission('compat.manage') devices() { return this.compat.listDevices(getTenantContext().tenantId); }
  @Patch('devices/:id/revoke') @RequiresPermission('compat.manage') revoke(@Param('id') id: string) { return this.compat.revokeDevice(getTenantContext().tenantId, id); }

  @Get('sync/overview') @RequiresPermission('compat.manage') overview() { return this.compat.syncOverview(getTenantContext().tenantId); }
  @Get('sync/documents') @RequiresPermission('compat.manage') documents(@Query('entity') entity = 'invoices') { return this.compat.syncDocuments(getTenantContext().tenantId, entity); }

  @Public()
  @Post('auth/device')
  authDevice(@Body() body: { tenantId: string; apiKey: string }) { return this.compat.authDevice(body.tenantId, body.apiKey); }

  @Public()
  @Get('master/items')
  items(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Query('since') since?: string) { return this.compat.master(tenantId, token, 'items', since); }

  @Public()
  @Get('master/parties')
  parties(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Query('since') since?: string) { return this.compat.master(tenantId, token, 'parties', since); }

  @Public()
  @Get('master/accounts')
  accounts(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Query('since') since?: string) { return this.compat.master(tenantId, token, 'accounts', since); }

  @Public()
  @Get('master/tax-groups')
  taxGroups(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Query('since') since?: string) { return this.compat.master(tenantId, token, 'tax-groups', since); }

  @Public()
  @Post('docs/sales-invoice')
  sale(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: LegacySalesInvoiceDto) { return this.compat.pushSale(tenantId, token, body, idempotencyKey); }

  @Public()
  @Post('docs/voucher')
  voucher(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: LegacyVoucherDto) { return this.compat.pushVoucher(tenantId, token, body, idempotencyKey); }

  @Public()
  @Get('sync/cursor')
  getCursor(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string) { return this.compat.cursor(tenantId, token); }

  @Public()
  @Post('sync/cursor')
  setCursor(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Body() body: { entity: string; cursor: string }) { return this.compat.cursor(tenantId, token, body.entity, body.cursor); }

  @Public()
  @Get('docs/status')
  status(@Headers('x-tenant-id') tenantId: string, @Headers('x-compat-token') token: string, @Query('legacyId') legacyId: string) { return this.compat.cursor(tenantId, token).then(() => this.compat.status(tenantId, legacyId)); }
}
