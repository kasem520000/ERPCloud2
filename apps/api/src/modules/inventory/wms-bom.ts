/**
 * Pure rules for bin quantities and a light bill of materials.
 * No database. Warehouse stock is posted separately by the moving-average engine.
 */

import { Decimal } from 'decimal.js';

export class WmsRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WmsRuleError';
  }
}

export type BinRef = { id: string; warehouseId: string; active: boolean };
export type BinQty = { binId: string; itemId: string; lotId: string | null; quantity: string };
export type BomLine = { componentItemId: string; qty: string; scrapPercent?: string };
export type ComponentDemand = { componentItemId: string; qty: string };
export type OrderStatus = 'draft' | 'in_progress' | 'done';

const lotKey = (lotId: string | null | undefined) => lotId ?? '';

function parseQty(value: string, code: string, label: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error('not finite');
    return parsed;
  } catch {
    throw new WmsRuleError(code, `${label} is not a valid quantity`);
  }
}

function assertActive(bin: BinRef) {
  if (!bin.active) throw new WmsRuleError('BIN_INACTIVE', 'The bin is inactive');
}

function currentQty(rows: BinQty[], binId: string, itemId: string, lotId: string | null): Decimal {
  const found = rows.find(
    (row) => row.binId === binId && row.itemId === itemId && lotKey(row.lotId) === lotKey(lotId),
  );
  return found ? new Decimal(found.quantity) : new Decimal(0);
}

function writeQty(rows: BinQty[], binId: string, itemId: string, lotId: string | null, next: Decimal): BinQty[] {
  const quantity = next.toFixed(4);
  const index = rows.findIndex(
    (row) => row.binId === binId && row.itemId === itemId && lotKey(row.lotId) === lotKey(lotId),
  );
  if (index === -1) return [...rows, { binId, itemId, lotId, quantity }];
  return rows.map((row, at) => (at === index ? { ...row, quantity } : row));
}

export function applyBinReceipt(
  rows: BinQty[],
  bin: BinRef,
  input: { itemId: string; lotId?: string | null; qty: string },
): BinQty[] {
  assertActive(bin);
  const qty = parseQty(input.qty, 'BIN_QTY_INVALID', 'Receipt quantity');
  if (qty.lte(0)) throw new WmsRuleError('BIN_QTY_INVALID', 'Receipt quantity must be greater than zero');
  const lotId = input.lotId ?? null;
  return writeQty(rows, bin.id, input.itemId, lotId, currentQty(rows, bin.id, input.itemId, lotId).plus(qty));
}

export function applyBinIssue(
  rows: BinQty[],
  bin: BinRef,
  input: { itemId: string; lotId?: string | null; qty: string },
): BinQty[] {
  assertActive(bin);
  const qty = parseQty(input.qty, 'BIN_QTY_INVALID', 'Issue quantity');
  if (qty.lte(0)) throw new WmsRuleError('BIN_QTY_INVALID', 'Issue quantity must be greater than zero');
  const lotId = input.lotId ?? null;
  const onHand = currentQty(rows, bin.id, input.itemId, lotId);
  if (onHand.lt(qty)) throw new WmsRuleError('BIN_INSUFFICIENT', 'The bin does not have enough of this item');
  return writeQty(rows, bin.id, input.itemId, lotId, onHand.minus(qty));
}

export function applyBinTransfer(
  rows: BinQty[],
  from: BinRef,
  to: BinRef,
  input: { itemId: string; lotId?: string | null; qty: string },
): BinQty[] {
  if (from.id === to.id) throw new WmsRuleError('BIN_TRANSFER_SAME', 'Choose two different bins');
  if (from.warehouseId !== to.warehouseId) {
    throw new WmsRuleError('BIN_WAREHOUSE_MISMATCH', 'A bin transfer stays inside one warehouse');
  }
  const issued = applyBinIssue(rows, from, input);
  return applyBinReceipt(issued, to, input);
}

/** Stocktake. `delta` is counted minus on-hand: positive receives, negative issues. */
export function applyBinCount(
  rows: BinQty[],
  bin: BinRef,
  input: { itemId: string; lotId?: string | null; countedQty: string },
): { rows: BinQty[]; delta: string } {
  assertActive(bin);
  const counted = parseQty(input.countedQty, 'BIN_COUNT_INVALID', 'Counted quantity');
  if (counted.lt(0)) throw new WmsRuleError('BIN_COUNT_INVALID', 'Counted quantity cannot be negative');
  const lotId = input.lotId ?? null;
  const onHand = currentQty(rows, bin.id, input.itemId, lotId);
  return {
    rows: writeQty(rows, bin.id, input.itemId, lotId, counted),
    delta: counted.minus(onHand).toFixed(4),
  };
}

export function assertBom(productItemId: string, lines: BomLine[]): void {
  if (lines.length === 0) {
    throw new WmsRuleError('BOM_COMPONENTS_REQUIRED', 'A bill of materials needs at least one component');
  }
  if (lines.some((line) => line.componentItemId === productItemId)) {
    throw new WmsRuleError('BOM_COMPONENT_IS_PRODUCT', 'The finished item cannot be one of its components');
  }
  componentDemand(lines, '1');
}

/** Quantity of each component for one production run, including scrap. */
export function componentDemand(lines: BomLine[], produceQty: string): ComponentDemand[] {
  const produce = parseQty(produceQty, 'PRODUCE_QTY_INVALID', 'Produced quantity');
  if (produce.lte(0)) throw new WmsRuleError('PRODUCE_QTY_INVALID', 'Produced quantity must be greater than zero');
  const seen = new Set<string>();
  return lines.map((line) => {
    if (seen.has(line.componentItemId)) {
      throw new WmsRuleError('BOM_COMPONENT_DUPLICATE', 'Each component may appear only once');
    }
    seen.add(line.componentItemId);
    const perUnit = parseQty(line.qty, 'BOM_QTY_INVALID', 'Component quantity');
    if (perUnit.lte(0)) throw new WmsRuleError('BOM_QTY_INVALID', 'Component quantity must be greater than zero');
    const scrap = parseQty(line.scrapPercent ?? '0', 'BOM_SCRAP_INVALID', 'Scrap percent');
    if (scrap.lt(0) || scrap.gt(100)) {
      throw new WmsRuleError('BOM_SCRAP_INVALID', 'Scrap percent must be between 0 and 100');
    }
    const withScrap = perUnit.mul(new Decimal(1).plus(scrap.div(100)));
    return { componentItemId: line.componentItemId, qty: withScrap.mul(produce).toFixed(4) };
  });
}

/**
 * Finished-item cost = sum(component average × consumed qty) / produced qty.
 * The service posts the same figures through the moving-average engine.
 */
export function finishedGoodsCost(
  demand: ComponentDemand[],
  averages: Readonly<Record<string, string>>,
  produceQty: string,
): { componentCost: string; unitCost: string } {
  const produce = parseQty(produceQty, 'PRODUCE_QTY_INVALID', 'Produced quantity');
  if (produce.lte(0)) throw new WmsRuleError('PRODUCE_QTY_INVALID', 'Produced quantity must be greater than zero');
  const componentCost = demand.reduce((sum, line) => {
    const average = parseQty(averages[line.componentItemId] ?? '0', 'COMPONENT_COST_INVALID', 'Component average');
    return sum.plus(average.mul(line.qty));
  }, new Decimal(0));
  return {
    componentCost: componentCost.toFixed(4),
    unitCost: componentCost.div(produce).toFixed(4),
  };
}

export function advanceProduction(
  order: { qtyPlanned: string; qtyProduced: string; status: OrderStatus },
  produceQty: string,
): { qtyProduced: string; status: OrderStatus } {
  if (order.status === 'done') {
    throw new WmsRuleError('ORDER_ALREADY_DONE', 'A completed manufacturing order cannot be produced again');
  }
  const planned = parseQty(order.qtyPlanned, 'ORDER_QTY_INVALID', 'Planned quantity');
  const produced = parseQty(order.qtyProduced, 'ORDER_QTY_INVALID', 'Produced quantity');
  const next = parseQty(produceQty, 'PRODUCE_QTY_INVALID', 'Produced quantity');
  if (next.lte(0)) throw new WmsRuleError('PRODUCE_QTY_INVALID', 'Produced quantity must be greater than zero');
  if (next.gt(planned.minus(produced))) {
    throw new WmsRuleError('PRODUCE_QTY_EXCEEDS_PLAN', 'Cannot produce more than the remaining planned quantity');
  }
  const qtyProduced = produced.plus(next);
  return {
    qtyProduced: qtyProduced.toFixed(4),
    status: qtyProduced.gte(planned) ? 'done' : 'in_progress',
  };
}
