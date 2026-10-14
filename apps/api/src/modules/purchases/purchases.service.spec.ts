import { describe, expect, it } from 'vitest';

import { PurchasesService } from './purchases.service.js';

describe('PurchasesService phase 11 landed-cost preview', () => {
  it('allocates landed costs by value with the documented largest-line remainder rule', () => {
    const service = Object.create(PurchasesService.prototype) as PurchasesService;
    const result = service.previewLandedCost({
      method: 'value',
      lines: [
        { lineId: 'line-1', itemId: 'item-1', quantity: '2', net: '100' },
        { lineId: 'line-2', itemId: 'item-2', quantity: '1', net: '50' },
      ],
      costs: [{ amount: '10' }, { amount: '5' }, { amount: '0.01' }],
    });

    expect(result.totalCost).toBe('15.01');
    expect(result.lines.map((line) => line.allocatedCost)).toEqual(['10.0067', '5.0033']);
    expect(result.lines.map((line) => line.effectiveUnitCost)).toEqual(['55.0034', '55.0033']);
  });

  it('allocates by quantity and preserves the cost pool total', () => {
    const service = Object.create(PurchasesService.prototype) as PurchasesService;
    const result = service.previewLandedCost({
      method: 'qty',
      lines: [
        { quantity: '1', net: '10' },
        { quantity: '1', net: '10' },
        { quantity: '1', net: '10' },
      ],
      costs: [{ amount: '1' }],
    });

    expect(result.lines.map((line) => line.allocatedCost)).toEqual(['0.3334', '0.3333', '0.3333']);
  });
});
