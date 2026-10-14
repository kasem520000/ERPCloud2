import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { FitmentService } from './fitment.service.js';
@Controller('fitment')
export class FitmentController { constructor(private readonly fitment: FitmentService) {} @Post('makes') @RequiresPermission('fitment.manage') make(@Body() b: { name: string }) { return this.fitment.make(getTenantContext().tenantId, b.name); } @Post('makes/:makeId/models') @RequiresPermission('fitment.manage') model(@Param('makeId') makeId: string, @Body() b: { name: string }) { return this.fitment.model(getTenantContext().tenantId, makeId, b.name); } @Post('items') @RequiresPermission('fitment.manage') attach(@Body() b: { itemId: string; makeId: string; modelId?: string; yearFrom?: number; yearTo?: number; notes?: string }) { return this.fitment.attach(getTenantContext().tenantId, b); } @Get('items-for-vehicle') @RequiresPermission('fitment.view') items(@Query('makeId') makeId: string, @Query('modelId') modelId?: string, @Query('year') year?: string) { return this.fitment.itemsForVehicle(getTenantContext().tenantId, { makeId, modelId, year: year ? Number(year) : undefined }); } @Get('items/:itemId/vehicles') @RequiresPermission('fitment.view') vehicles(@Param('itemId') itemId: string) { return this.fitment.vehiclesForItem(getTenantContext().tenantId, itemId); } }
