import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { allocateDiscount, averageCost, issueAtAverage, receiveAtCost } from './inventory-valuation.js';

describe('inventory valuation parity', () => {
  it('matches the legacy moving average fixture', () => {
    let pool = { quantity: new Decimal(0), value: new Decimal(0) };
    pool = receiveAtCost(pool, '10', '100');
    pool = receiveAtCost(pool, '5', '110');
    expect(averageCost(pool)).toBe('103.3333');
    pool = issueAtAverage(pool, '3');
    expect(pool.quantity.toFixed(4)).toBe('12.0000');
    expect(averageCost(pool)).toBe('103.3333');
  });

  it('allocates invoice discounts pro rata by line value', () => {
    expect(allocateDiscount(['800', '200'], '50')).toEqual(['40.0000', '10.0000']);
  });

  it('preserves value on a same-cost transfer', () => {
    const source = issueAtAverage(receiveAtCost({ quantity: new Decimal(0), value: new Decimal(0) }, '10', '100'), '4');
    const destination = receiveAtCost({ quantity: new Decimal(0), value: new Decimal(0) }, '4', '100');
    expect(source.value.plus(destination.value).toFixed(4)).toBe('1000.0000');
  });
});
