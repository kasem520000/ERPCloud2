import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DomainError } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  WmsBomService,
  optionalUuid,
  requireUuid,
  textField,
  type BinCountInput,
  type BinInput,
  type BinMoveInput,
  type BinTransferInput,
} from './wms-bom.service.js';

type Payload = Record<string, unknown>;

function pick(body: Payload, ...keys: string[]) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') return body[key];
  }
  return undefined;
}

function moveOf(body: Payload): BinMoveInput {
  return {
    itemId: requireUuid(pick(body, 'itemId', 'item_id'), 'itemId'),
    qty: textField(pick(body, 'qty', 'quantity')),
    lotId: optionalUuid(pick(body, 'lotId', 'lot_id'), 'lotId') ?? null,
    unitCost: textField(pick(body, 'unitCost', 'unit_cost')) || undefined,
  };
}

@Controller('inventory')
export class WmsController {
  constructor(private readonly wms: WmsBomService) {}

  @Get('bins')
  @RequiresPermission('inventory.view')
  listBins(@Query('warehouse_id') warehouseId?: string, @Query('warehouseId') camel?: string) {
    const id = warehouseId || camel;
    return this.wms.listBins(getTenantContext().tenantId, id ? requireUuid(id, 'warehouseId') : undefined).then((data) => ({ data }));
  }

  @Post('bins')
  @RequiresPermission('inventory.bins.manage')
  createBin(@Body() body: Payload) {
    const input: BinInput = {
      warehouseId: requireUuid(pick(body, 'warehouseId', 'warehouse_id'), 'warehouseId'),
      code: textField(pick(body, 'code')),
      zone: textField(pick(body, 'zone')) || undefined,
      aisle: textField(pick(body, 'aisle')) || undefined,
      rack: textField(pick(body, 'rack')) || undefined,
      level: textField(pick(body, 'level')) || undefined,
    };
    return this.wms.createBin(getTenantContext().tenantId, input).then((data) => ({ data }));
  }

  @Patch('bins/:id')
  @RequiresPermission('inventory.bins.manage')
  setActive(@Param('id') id: string, @Body() body: Payload) {
    const active = pick(body, 'isActive', 'is_active');
    if (active !== true && active !== false && active !== 'true' && active !== 'false') {
      throw new DomainError('BIN_ACTIVE_REQUIRED', 'isActive is required', 422);
    }
    return this.wms
      .setBinActive(getTenantContext().tenantId, requireUuid(id, 'id'), active === true || active === 'true')
      .then((data) => ({ data }));
  }

  @Get('bin-balances')
  @RequiresPermission('inventory.view')
  balances(
    @Query('warehouse_id') warehouseId?: string,
    @Query('bin_id') binId?: string,
    @Query('item_id') itemId?: string,
  ) {
    return this.wms
      .listBalances(getTenantContext().tenantId, {
        warehouseId: warehouseId ? requireUuid(warehouseId, 'warehouseId') : undefined,
        binId: binId ? requireUuid(binId, 'binId') : undefined,
        itemId: itemId ? requireUuid(itemId, 'itemId') : undefined,
      })
      .then((data) => ({ data }));
  }

  @Get('bin-transfers')
  @RequiresPermission('inventory.view')
  transfers() {
    return this.wms.listTransfers(getTenantContext().tenantId).then((data) => ({ data }));
  }

  @Post('bin-transfers')
  @RequiresPermission('inventory.bins.manage')
  transfer(@Body() body: Payload) {
    const input: BinTransferInput = {
      fromBinId: requireUuid(pick(body, 'fromBinId', 'from_bin'), 'fromBin'),
      toBinId: requireUuid(pick(body, 'toBinId', 'to_bin'), 'toBin'),
      itemId: requireUuid(pick(body, 'itemId', 'item_id'), 'itemId'),
      qty: textField(pick(body, 'qty', 'quantity')),
      lotId: optionalUuid(pick(body, 'lotId', 'lot_id'), 'lotId') ?? null,
    };
    return this.wms.transfer(getTenantContext().tenantId, input).then((data) => ({ data }));
  }

  @Post('bin-counts')
  @RequiresPermission('inventory.bins.manage')
  count(@Body() body: Payload) {
    const input: BinCountInput = {
      binId: requireUuid(pick(body, 'binId', 'bin_id'), 'binId'),
      itemId: requireUuid(pick(body, 'itemId', 'item_id'), 'itemId'),
      countedQty: textField(pick(body, 'countedQty', 'counted_qty')),
      lotId: optionalUuid(pick(body, 'lotId', 'lot_id'), 'lotId') ?? null,
      unitCost: textField(pick(body, 'unitCost', 'unit_cost')) || undefined,
    };
    return this.wms.count(getTenantContext().tenantId, input).then((data) => ({ data }));
  }

  @Post('bins/:id/receive')
  @RequiresPermission('inventory.bins.manage')
  receive(@Param('id') id: string, @Body() body: Payload) {
    return this.wms.receive(getTenantContext().tenantId, requireUuid(id, 'id'), moveOf(body)).then((data) => ({ data }));
  }

  @Post('bins/:id/issue')
  @RequiresPermission('inventory.bins.manage')
  issue(@Param('id') id: string, @Body() body: Payload) {
    return this.wms.issue(getTenantContext().tenantId, requireUuid(id, 'id'), moveOf(body)).then((data) => ({ data }));
  }
}
