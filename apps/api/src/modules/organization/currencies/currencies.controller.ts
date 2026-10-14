import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  currencyCreateSchema,
  currencyListQuerySchema,
  currencyCodeSchema,
  currencyUpdateSchema,
  fxRateCreateSchema,
  fxRateListQuerySchema,
  fxRateUpdateSchema,
  fxResolveQuerySchema,
  idParamSchema,
  type CurrencyCreate,
  type CurrencyDto,
  type CurrencyListQueryDto,
  type CurrencyUpdate,
  type FxRateCreate,
  type FxRateDto,
  type FxRateListQueryDto,
  type FxRateUpdate,
  type FxResolutionDto,
  type FxResolveQuery,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { CurrenciesService } from './currencies.service.js';
import { FxService } from './fx.service.js';

const currencyParamSchema = z.object({ code: currencyCodeSchema });
type CurrencyParam = z.infer<typeof currencyParamSchema>;

/** API_CONTRACT §3 — currencies. Keyed by ISO code, not by uuid. */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currencies: CurrenciesService) {}

  @Get()
  @RequiresPermission('organization.currency.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[isBase]', required: false })
  @ApiOperation({ summary: 'List the currencies enabled for the tenant' })
  @ApiResponse({ status: 200, description: 'Currency page' })
  async list(
    @Query(new ZodValidationPipe(currencyListQuerySchema)) query: CurrencyListQueryDto,
  ): Promise<ListEnvelope<CurrencyDto>> {
    return this.currencies.list(getTenantContext().tenantId, query);
  }

  @Get(':code')
  @RequiresPermission('organization.currency.view')
  @ApiOperation({ summary: 'Read one currency by ISO code' })
  @ApiResponse({ status: 200, description: 'Currency' })
  @ApiResponse({ status: 404, description: 'Not enabled for this tenant' })
  async read(
    @Param(new ZodValidationPipe(currencyParamSchema)) params: CurrencyParam,
  ): Promise<{ data: CurrencyDto }> {
    return { data: await this.currencies.read(getTenantContext().tenantId, params.code) };
  }

  @Post()
  @RequiresPermission('organization.currency.manage')
  @zodApiBody(currencyCreateSchema)
  @ApiOperation({ summary: 'Enable a currency (the first one becomes the base currency)' })
  @ApiResponse({ status: 201, description: 'Currency enabled' })
  @ApiResponse({ status: 422, description: 'Already enabled' })
  async create(
    @Body(new ZodValidationPipe(currencyCreateSchema)) body: CurrencyCreate,
  ): Promise<{ data: CurrencyDto }> {
    return { data: await this.currencies.create(getTenantContext().tenantId, body) };
  }

  @Patch(':code')
  @RequiresPermission('organization.currency.manage')
  @zodApiBody(currencyUpdateSchema)
  @ApiOperation({ summary: 'Update a currency, including promoting it to base' })
  @ApiResponse({ status: 200, description: 'Updated currency' })
  @ApiResponse({ status: 422, description: 'Base-currency invariant violated' })
  async update(
    @Param(new ZodValidationPipe(currencyParamSchema)) params: CurrencyParam,
    @Body(new ZodValidationPipe(currencyUpdateSchema)) body: CurrencyUpdate,
  ): Promise<{ data: CurrencyDto }> {
    return { data: await this.currencies.update(getTenantContext().tenantId, params.code, body) };
  }
}

/** API_CONTRACT §3 — FX rates. */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('fx-rates')
export class FxRatesController {
  constructor(private readonly fx: FxService) {}

  @Get()
  @RequiresPermission('organization.currency.view')
  @ApiQuery({ name: 'filter[fromCode]', required: false })
  @ApiQuery({ name: 'filter[toCode]', required: false })
  @ApiOperation({ summary: 'List stored FX rates (newest effective date first)' })
  @ApiResponse({ status: 200, description: 'FX-rate page' })
  async list(
    @Query(new ZodValidationPipe(fxRateListQuerySchema)) query: FxRateListQueryDto,
  ): Promise<ListEnvelope<FxRateDto>> {
    return this.fx.list(getTenantContext().tenantId, query);
  }

  /** Declared before `:id` so the literal segment is not captured as a uuid. */
  @Get('resolve')
  @RequiresPermission('organization.currency.view')
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'date', required: false })
  @ApiOperation({ summary: 'Resolve a rate (direct, inverse or triangulated through base)' })
  @ApiResponse({ status: 200, description: 'Resolved rate with its provenance' })
  @ApiResponse({ status: 422, description: 'No rate available for the pair on that date' })
  async resolve(
    @Query(new ZodValidationPipe(fxResolveQuerySchema)) query: FxResolveQuery,
  ): Promise<{ data: FxResolutionDto }> {
    const tenant = getTenantContext();
    return { data: await this.fx.resolveFx(tenant.tenantId, query.from, query.to, query.date) };
  }

  @Get(':id')
  @RequiresPermission('organization.currency.view')
  @ApiOperation({ summary: 'Read one stored FX rate' })
  @ApiResponse({ status: 200, description: 'FX rate' })
  async read(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: FxRateDto }> {
    return { data: await this.fx.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.currency.manage')
  @zodApiBody(fxRateCreateSchema)
  @ApiOperation({ summary: 'Record a rate for a pair on a date' })
  @ApiResponse({ status: 201, description: 'FX rate recorded' })
  @ApiResponse({ status: 422, description: 'Duplicate (pair, date) or currency not enabled' })
  async create(
    @Body(new ZodValidationPipe(fxRateCreateSchema)) body: FxRateCreate,
  ): Promise<{ data: FxRateDto }> {
    return { data: await this.fx.create(getTenantContext().tenantId, body) };
  }

  @Patch(':id')
  @RequiresPermission('organization.currency.manage')
  @zodApiBody(fxRateUpdateSchema)
  @ApiOperation({ summary: 'Correct a stored rate (the pair and date are immutable)' })
  @ApiResponse({ status: 200, description: 'Updated FX rate' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(fxRateUpdateSchema)) body: FxRateUpdate,
  ): Promise<{ data: FxRateDto }> {
    return { data: await this.fx.update(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.currency.manage')
  @ApiOperation({ summary: 'Delete a stored FX rate' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.fx.remove(getTenantContext().tenantId, params.id);
  }
}
