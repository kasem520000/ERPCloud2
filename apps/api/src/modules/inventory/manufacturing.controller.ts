import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DomainError } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  WmsBomService,
  optionalUuid,
  requireUuid,
  textField,
  type BomInput,
  type ManufacturingOrderInput,
  type ProduceInput,
} from './wms-bom.service.js';

type Payload = Record<string, unknown>;

function pick(body: Payload, ...keys: string[]) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') return body[key];
  }
  return undefined;
}

function linesOf(value: unknown): BomInput['lines'] {
  if (!Array.isArray(value)) throw new DomainError('BOM_COMPONENTS_REQUIRED', 'A bill of materials needs components', 422);
  return value.map((line) => {
    const row = (line ?? {}) as Payload;
    return {
      componentItemId: requireUuid(pick(row, 'componentItemId', 'component_item_id'), 'componentItemId'),
      qty: textField(pick(row, 'qty')),
      scrapPercent: textField(pick(row, 'scrapPercent', 'scrap_percent')) || undefined,
      unitId: optionalUuid(pick(row, 'unitId', 'unit_id'), 'unitId'),
    };
  });
}

@Controller('manufacturing')
export class ManufacturingController {
  constructor(private readonly wms: WmsBomService) {}

  @Get('boms')
  @RequiresPermission('manufacturing.view')
  listBoms() {
    return this.wms.listBoms(getTenantContext().tenantId).then((data) => ({ data }));
  }

  @Post('boms')
  @RequiresPermission('manufacturing.manage')
  createBom(@Body() body: Payload) {
    const version = pick(body, 'version');
    const input: BomInput = {
      productItemId: requireUuid(pick(body, 'productItemId', 'product_item_id', 'item_id'), 'productItemId'),
      name: textField(pick(body, 'name')),
      version: version === undefined ? undefined : Number(version),
      lines: linesOf(pick(body, 'lines')),
    };
    return this.wms.createBom(getTenantContext().tenantId, input).then((data) => ({ data }));
  }

  @Get('orders')
  @RequiresPermission('manufacturing.view')
  listOrders() {
    return this.wms.listOrders(getTenantContext().tenantId).then((data) => ({ data }));
  }

  @Get('orders/:id')
  @RequiresPermission('manufacturing.view')
  readOrder(@Param('id') id: string) {
    return this.wms.getOrder(getTenantContext().tenantId, requireUuid(id, 'id')).then((data) => ({ data }));
  }

  @Post('orders')
  @RequiresPermission('manufacturing.manage')
  createOrder(@Body() body: Payload) {
    const input: ManufacturingOrderInput = {
      bomId: requireUuid(pick(body, 'bomId', 'bom_id'), 'bomId'),
      warehouseId: requireUuid(pick(body, 'warehouseId', 'warehouse_id'), 'warehouseId'),
      qty: textField(pick(body, 'qty', 'qty_planned')),
    };
    return this.wms.createOrder(getTenantContext().tenantId, input).then((data) => ({ data }));
  }

  @Post('orders/:id/produce')
  @RequiresPermission('manufacturing.produce')
  produce(@Param('id') id: string, @Body() body: Payload) {
    // 🏷️ دفعة الناتج (اللوت): صنفٌ يُتتبَّع بالدفعات لا يُستلم بلا رقم دفعة.
    const outputLotNo = textField(pick(body, 'outputLotNo', 'output_lot_no', 'batchNo'));
    const outputProductionDate = textField(
      pick(body, 'outputProductionDate', 'output_production_date', 'productionDate'),
    );
    const input: ProduceInput = {
      qty: textField(pick(body, 'qty')),
      componentBinId: optionalUuid(pick(body, 'componentBinId', 'component_bin_id'), 'componentBinId'),
      outputBinId: optionalUuid(pick(body, 'outputBinId', 'output_bin_id'), 'outputBinId'),
      outputLot:
        outputLotNo || outputProductionDate
          ? { lotNo: outputLotNo || null, productionDate: outputProductionDate || null }
          : undefined,
    };
    return this.wms.produce(getTenantContext().tenantId, requireUuid(id, 'id'), input).then((data) => ({ data }));
  }
}
