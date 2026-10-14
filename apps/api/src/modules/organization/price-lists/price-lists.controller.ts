import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  idParamSchema,
  priceListCreateSchema,
  priceListItemListQuerySchema,
  priceListItemUpsertSchema,
  priceListListQuerySchema,
  priceListUpdateSchema,
  uuidSchema,
  type IdParam,
  type ListEnvelope,
  type PriceListCreate,
  type PriceListDto,
  type PriceListItemDto,
  type PriceListItemListQueryDto,
  type PriceListItemUpsert,
  type PriceListListQueryDto,
  type PriceListUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { PriceListsService } from './price-lists.service.js';

const priceListItemParamSchema = z.object({ id: uuidSchema, itemRowId: uuidSchema });
type PriceListItemParam = z.infer<typeof priceListItemParamSchema>;

/** API_CONTRACT §3 — price lists (+ items). */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('price-lists')
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Get()
  @RequiresPermission('organization.priceList.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'List price lists' })
  @ApiResponse({ status: 200, description: 'Price-list page' })
  async list(
    @Query(new ZodValidationPipe(priceListListQuerySchema)) query: PriceListListQueryDto,
  ): Promise<ListEnvelope<PriceListDto>> {
    return this.priceLists.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('organization.priceList.view')
  @ApiOperation({ summary: 'Read one price list' })
  @ApiResponse({ status: 200, description: 'Price list' })
  async read(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: PriceListDto }> {
    return { data: await this.priceLists.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.priceList.manage')
  @zodApiBody(priceListCreateSchema)
  @ApiOperation({ summary: 'Create a price list' })
  @ApiResponse({ status: 201, description: 'Price list created' })
  @ApiResponse({ status: 422, description: 'Duplicate name, or currency not enabled' })
  async create(
    @Body(new ZodValidationPipe(priceListCreateSchema)) body: PriceListCreate,
  ): Promise<{ data: PriceListDto }> {
    return { data: await this.priceLists.create(getTenantContext().tenantId, body) };
  }

  @Patch(':id')
  @RequiresPermission('organization.priceList.manage')
  @zodApiBody(priceListUpdateSchema)
  @ApiOperation({ summary: 'Update a price list' })
  @ApiResponse({ status: 200, description: 'Updated price list' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(priceListUpdateSchema)) body: PriceListUpdate,
  ): Promise<{ data: PriceListDto }> {
    return { data: await this.priceLists.update(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.priceList.manage')
  @ApiOperation({ summary: 'Soft-delete a price list (CR-008)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.priceLists.remove(getTenantContext().tenantId, params.id);
  }

  @Get(':id/items')
  @RequiresPermission('organization.priceList.view')
  @ApiOperation({ summary: 'List the priced rows of a list' })
  @ApiResponse({ status: 200, description: 'Price-list item page' })
  async listItems(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Query(new ZodValidationPipe(priceListItemListQuerySchema)) query: PriceListItemListQueryDto,
  ): Promise<ListEnvelope<PriceListItemDto>> {
    return this.priceLists.listItems(getTenantContext().tenantId, params.id, query);
  }

  @Post(':id/items')
  @RequiresPermission('organization.priceList.manage')
  @zodApiBody(priceListItemUpsertSchema)
  @ApiOperation({
    summary: 'Upsert a priced row (item validation lands in PHASE_06 with the items table)',
  })
  @ApiResponse({ status: 201, description: 'Priced row stored' })
  async upsertItem(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(priceListItemUpsertSchema)) body: PriceListItemUpsert,
  ): Promise<{ data: PriceListItemDto }> {
    return { data: await this.priceLists.upsertItem(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id/items/:itemRowId')
  @HttpCode(204)
  @RequiresPermission('organization.priceList.manage')
  @ApiOperation({ summary: 'Remove a priced row' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async removeItem(
    @Param(new ZodValidationPipe(priceListItemParamSchema)) params: PriceListItemParam,
  ): Promise<void> {
    await this.priceLists.removeItem(getTenantContext().tenantId, params.id, params.itemRowId);
  }
}
