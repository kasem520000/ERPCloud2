import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { TenantDto, TenantPatch } from '@erp/contracts';
import { tenantPatchSchema } from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../context/tenant-context.js';
import { RequiresPermission } from '../decorators/requires-permission.decorator.js';
import { getAuthContext } from '../../../request-context/request-context.js';

import { TenantService } from './tenant.service.js';

/** API_CONTRACT §2 — `GET/PATCH /tenant`. */
@ApiTags('tenancy')
@ApiBearerAuth()
@Controller('tenant')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @RequiresPermission('tenant.view')
  @ApiOperation({ summary: 'Read the own tenant record and its effective settings' })
  @ApiResponse({ status: 200, description: 'Tenant' })
  async read(): Promise<{ data: TenantDto }> {
    return { data: await this.tenants.read(getTenantContext().tenantId) };
  }

  @Patch()
  @RequiresPermission('tenant.manage')
  @zodApiBody(tenantPatchSchema)
  @ApiOperation({ summary: 'Update the own tenant record and typed settings in bulk' })
  @ApiResponse({ status: 200, description: 'Updated tenant' })
  @ApiResponse({ status: 400, description: 'Unknown setting key or invalid value' })
  async patch(
    @Body(new ZodValidationPipe(tenantPatchSchema)) body: TenantPatch,
  ): Promise<{ data: TenantDto }> {
    const tenant = getTenantContext();
    return { data: await this.tenants.patch(tenant.tenantId, getAuthContext().userId, body) };
  }
}
