import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  cashLocationCreateSchema,
  cashLocationListQuerySchema,
  cashLocationUpdateSchema,
  idParamSchema,
  type CashLocationBalanceDto,
  type CashLocationCreate,
  type CashLocationDto,
  type CashLocationListQueryDto,
  type CashLocationUpdate,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { CashLocationsService } from './cash-locations.service.js';

/**
 * API_CONTRACT §3 — cash locations (safes and bank accounts).
 *
 * The list response masks the IBAN; the single-row read returns it in full
 * (SECURITY_ARCHITECTURE §5). Balances are read-only in PHASE_05: the writers arrive
 * with treasury in PHASE_12.
 */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('cash-locations')
export class CashLocationsController {
  constructor(private readonly cashLocations: CashLocationsService) {}

  @Get()
  @RequiresPermission('organization.cashlocation.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'filter[kind]', required: false })
  @ApiQuery({ name: 'filter[branchId]', required: false })
  @ApiOperation({ summary: 'List cash locations (IBAN masked)' })
  @ApiResponse({ status: 200, description: 'Cash-location page' })
  async list(
    @Query(new ZodValidationPipe(cashLocationListQuerySchema)) query: CashLocationListQueryDto,
  ): Promise<ListEnvelope<CashLocationDto>> {
    return this.cashLocations.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('organization.cashlocation.view')
  @ApiOperation({ summary: 'Read one cash location (full bank details)' })
  @ApiResponse({ status: 200, description: 'Cash location' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: CashLocationDto }> {
    return { data: await this.cashLocations.read(getTenantContext().tenantId, params.id) };
  }

  @Get(':id/balances')
  @RequiresPermission('organization.cashlocation.view')
  @ApiOperation({ summary: 'Read the per-currency balances of a cash location (read-only)' })
  @ApiResponse({ status: 200, description: 'Balances' })
  async balances(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: CashLocationBalanceDto[] }> {
    return { data: await this.cashLocations.listBalances(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.cashlocation.manage')
  @zodApiBody(cashLocationCreateSchema)
  @ApiOperation({ summary: 'Create a safe or bank account' })
  @ApiResponse({ status: 201, description: 'Cash location created' })
  @ApiResponse({ status: 422, description: 'Invalid IBAN, or a safe carrying bank details' })
  async create(
    @Body(new ZodValidationPipe(cashLocationCreateSchema)) body: CashLocationCreate,
  ): Promise<{ data: CashLocationDto }> {
    return { data: await this.cashLocations.create(getTenantContext().tenantId, body) };
  }

  @Patch(':id')
  @RequiresPermission('organization.cashlocation.manage')
  @zodApiBody(cashLocationUpdateSchema)
  @ApiOperation({ summary: 'Update a cash location (kind is immutable)' })
  @ApiResponse({ status: 200, description: 'Updated cash location' })
  @ApiResponse({ status: 409, description: 'Stale version (VERSION_CONFLICT)' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(cashLocationUpdateSchema)) body: CashLocationUpdate,
  ): Promise<{ data: CashLocationDto }> {
    return { data: await this.cashLocations.update(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.cashlocation.manage')
  @ApiOperation({ summary: 'Soft-delete a cash location (CR-008)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 422, description: 'The default cash location cannot be deleted' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.cashLocations.remove(getTenantContext().tenantId, params.id);
  }
}
