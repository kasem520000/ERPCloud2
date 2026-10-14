import { Decimal } from 'decimal.js';

// Decimal.js requires numeric precision arguments; monetary values remain Decimal/string based.
/* eslint-disable no-restricted-syntax */

export type InventoryPool = { quantity: Decimal; value: Decimal };

export function receiveAtCost(pool: InventoryPool, quantity: string, unitCost: string): InventoryPool {
  const qty = new Decimal(quantity);
  return { quantity: pool.quantity.plus(qty), value: pool.value.plus(qty.mul(unitCost)) };
}

export function issueAtAverage(pool: InventoryPool, quantity: string): InventoryPool {
  const qty = new Decimal(quantity);
  const average = pool.quantity.isZero() ? new Decimal('0') : pool.value.div(pool.quantity);
  return { quantity: pool.quantity.minus(qty), value: pool.value.minus(qty.mul(average)) };
}

export function allocateDiscount(lineValues: string[], discount: string): string[] {
  const total = lineValues.reduce((sum, value) => sum.plus(value), new Decimal('0'));
  if (total.isZero()) return lineValues.map(() => '0.0000');
  return lineValues.map((value) => new Decimal(discount).mul(value).div(total).toDecimalPlaces(4).toFixed(4));
}

export function averageCost(pool: InventoryPool): string {
  return pool.quantity.isZero() ? '0.0000' : pool.value.div(pool.quantity).toDecimalPlaces(4).toFixed(4);
}
