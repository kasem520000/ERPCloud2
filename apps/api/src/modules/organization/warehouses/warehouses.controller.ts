import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  warehouseCreateSchema,
  warehouseListQuerySchema,
  warehouseUpdateSchema,
  type IdParam,
  type ListEnvelope,
  type WarehouseCreate,
  type WarehouseDto,
  type WarehouseListQueryDto,
  type WarehouseUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { WarehousesService } from './warehouses.service.js';

/** API_CONTRACT §3 — warehouses. */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequiresPermission('organization.warehouse.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'filter[branchId]', required: false })
  @ApiQuery({ name: 'filter[isActive]', required: false })
  @ApiOperation({ summary: 'List warehouses' })
  @ApiResponse({ status: 200, description: 'Warehouse page' })
  async list(
    @Query(new ZodValidationPipe(warehouseListQuerySchema)) query: WarehouseListQueryDto,
  ): Promise<ListEnvelope<WarehouseDto>> {
    return this.warehouses.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('organization.warehouse.view')
  @ApiOperation({ summary: 'Read one warehouse' })
  @ApiResponse({ status: 200, description: 'Warehouse' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: WarehouseDto }> {
    return { data: await this.warehouses.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.warehouse.manage')
  @zodApiBody(warehouseCreateSchema)
  @ApiOperation({ summary: 'Create a warehouse' })
  @ApiResponse({ status: 201, description: 'Warehouse created' })
  @ApiResponse({ status: 404, description: 'Branch not found in this tenant' })
  @ApiResponse({ status: 422, description: 'Duplicate code' })
  async create(
    @Body(new ZodValidationPipe(warehouseCreateSchema)) body: WarehouseCreate,
  ): Promise<{ data: WarehouseDto }> {
    return { data: await this.warehouses.create(getTenantContext().tenantId, body) };
  }

  @Patch(':id')
  @RequiresPermission('organization.warehouse.manage')
  @zodApiBody(warehouseUpdateSchema)
  @ApiOperation({ summary: 'Update a warehouse, including the default and active toggles' })
  @ApiResponse({ status: 200, description: 'Updated warehouse' })
  @ApiResponse({ status: 409, description: 'Stale version (VERSION_CONFLICT)' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(warehouseUpdateSchema)) body: WarehouseUpdate,
  ): Promise<{ data: WarehouseDto }> {
    return { data: await this.warehouses.update(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.warehouse.manage')
  @ApiOperation({ summary: 'Soft-delete a warehouse (CR-008)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 422, description: 'The default warehouse cannot be deleted' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.warehouses.remove(getTenantContext().tenantId, params.id);
  }
}
