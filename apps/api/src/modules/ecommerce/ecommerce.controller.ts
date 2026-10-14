import { Body, Controller, Delete, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { DomainError, errorCodes } from '@erp/contracts';
import type { Request } from 'express';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { Public, RequiresPermission } from '../platform/index.js';

import { ECOMMERCE_PROVIDERS, type EcommerceProvider, type EcommerceStoreInput } from './ecommerce.types.js';
import { EcommerceService } from './ecommerce.service.js';

@Controller('ecommerce')
export class EcommerceController {
  constructor(private readonly ecommerce: EcommerceService) {}

  private get tenantId(): string {
    return getTenantContext().tenantId;
  }

  @Get('providers')
  @RequiresPermission('ecommerce.manage')
  providers() {
    return this.ecommerce.listProviders();
  }

  @Post('stores')
  @RequiresPermission('ecommerce.manage')
  createStore(@Body() body: EcommerceStoreInput) {
    return this.ecommerce.createStore(this.tenantId, body);
  }

  @Get('stores')
  @RequiresPermission('ecommerce.manage')
  stores() {
    return this.ecommerce.listStores(this.tenantId);
  }

  @Get('stores/:id/logs')
  @RequiresPermission('ecommerce.manage')
  logs(@Param('id') id: string) {
    return this.ecommerce.getLogs(this.tenantId, id);
  }

  @Delete('stores/:id')
  @RequiresPermission('ecommerce.manage')
  deleteStore(@Param('id') id: string) {
    return this.ecommerce.deleteStore(this.tenantId, id);
  }

  @Post('stores/:id/sync')
  @RequiresPermission('ecommerce.manage')
  sync(@Param('id') id: string) {
    return this.ecommerce.syncStore(this.tenantId, id);
  }

  /**
   * Provider webhooks are public at the HTTP layer; the tenant id/store id plus the
   * provider HMAC are the capability. The raw body is essential: re-stringifying parsed
   * JSON would make a valid signature fail whenever whitespace or key order differs.
   */
  @Post('webhooks/:provider')
  @Public()
  webhook(
    @Param('provider') providerValue: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: Record<string, unknown>,
    @Req() request: Request & { rawBody?: Buffer },
  ) {
    if (!ECOMMERCE_PROVIDERS.includes(providerValue as EcommerceProvider)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `Unsupported e-commerce provider '${providerValue}'`,
        422,
        { field: 'provider' },
      );
    }
    const provider = providerValue as EcommerceProvider;
    const signature = headerFor(provider, headers);
    const tenantId = stringFromHeader(headers['x-tenant-id']) ?? stringValue(body.tenantId);
    const storeId = stringFromHeader(headers['x-store-id']) ?? stringValue(body.storeId);
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(body));
    return this.ecommerce.receiveWebhook(provider, tenantId ?? '', rawBody, body, signature, storeId);
  }

  @Get('orders')
  @RequiresPermission('ecommerce.manage')
  orders(@Query('store_id') storeId?: string, @Query('status') status?: string) {
    return this.ecommerce.listOrders(this.tenantId, { storeId, status });
  }
}

function headerFor(
  provider: EcommerceProvider,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const names =
    provider === 'salla'
      ? ['x-salla-signature', 'x-signature']
      : provider === 'zid'
        ? ['x-zid-signature', 'x-signature']
        : ['x-shopify-hmac-sha256', 'x-signature'];
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return undefined;
}

function stringFromHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
