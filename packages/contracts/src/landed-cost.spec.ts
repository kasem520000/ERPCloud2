import { describe, expect, it } from 'vitest';

import { allocateLandedCost } from './invoice-math.js';

describe('landed cost allocation', () => {
  it('allocates three costs by line value with deterministic largest-line remainder', () => {
    const result = allocateLandedCost({
      method: 'value',
      scale: 2,
      costs: [{ amount: '10' }, { amount: '5' }, { amount: '0.01' }],
      lines: [
        { lineId: 'a', itemId: 'item-a', quantity: '2', net: '100' },
        { lineId: 'b', itemId: 'item-b', quantity: '1', net: '50' },
      ],
    });

    expect(result.totalCost).toBe('15.01');
    expect(result.lines.map((line) => line.allocatedCost)).toEqual(['10.01', '5']);
    expect(result.lines.map((line) => line.effectiveUnitCost)).toEqual(['55.01', '55']);
  });

  it('preserves the total additional cost exactly', () => {
    const result = allocateLandedCost({
      method: 'qty',
      scale: 4,
      costs: [{ amount: '1' }],
      lines: [
        { quantity: '1', net: '10' },
        { quantity: '1', net: '10' },
        { quantity: '1', net: '10' },
      ],
    });
    expect(result.lines.map((line) => line.allocatedCost)).toEqual(['0.3334', '0.3333', '0.3333']);
  });
});
