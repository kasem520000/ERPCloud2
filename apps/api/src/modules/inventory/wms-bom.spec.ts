import { describe, expect, it } from 'vitest';

import {
  WmsRuleError,
  advanceProduction,
  applyBinIssue,
  applyBinReceipt,
  applyBinTransfer,
  componentDemand,
  finishedGoodsCost,
} from './wms-bom.js';

const binA = { id: 'bin-a', warehouseId: 'wh-1', active: true };
const binB = { id: 'bin-b', warehouseId: 'wh-1', active: true };
const otherWarehouse = { id: 'bin-c', warehouseId: 'wh-2', active: true };

describe('wms and light manufacturing', () => {
  it('receives 10 into bin A-01-01', () => {
    const next = applyBinReceipt([], binA, { itemId: 'item', qty: '10' });
    expect(next).toEqual([{ binId: 'bin-a', itemId: 'item', lotId: null, quantity: '10.0000' }]);
  });

  it('issues from a bin and reduces its balance', () => {
    const received = applyBinReceipt([], binA, { itemId: 'item', qty: '10' });
    const next = applyBinIssue(received, binA, { itemId: 'item', qty: '3' });
    expect(next[0]?.quantity).toBe('7.0000');
  });

  it('rejects an issue larger than the bin balance', () => {
    const received = applyBinReceipt([], binA, { itemId: 'item', qty: '10' });
    expect(() => applyBinIssue(received, binA, { itemId: 'item', qty: '11' })).toThrow(WmsRuleError);
  });

  it('transfers between bins without changing the warehouse total', () => {
    const received = applyBinReceipt([], binA, { itemId: 'item', qty: '10' });
    const next = applyBinTransfer(received, binA, binB, { itemId: 'item', qty: '4' });
    const from = next.find((row) => row.binId === 'bin-a');
    const to = next.find((row) => row.binId === 'bin-b');
    expect(from?.quantity).toBe('6.0000');
    expect(to?.quantity).toBe('4.0000');
    expect(Number(from?.quantity) + Number(to?.quantity)).toBe(10);
  });

  it('rejects a transfer that would leave the warehouse', () => {
    const received = applyBinReceipt([], binA, { itemId: 'item', qty: '10' });
    expect(() => applyBinTransfer(received, binA, otherWarehouse, { itemId: 'item', qty: '1' })).toThrow(
      WmsRuleError,
    );
  });

  it('rejects a receipt into an inactive bin', () => {
    expect(() => applyBinReceipt([], { ...binA, active: false }, { itemId: 'item', qty: '10' })).toThrow(
      WmsRuleError,
    );
  });

  it('explodes a BOM of 2Y + 1Z into 10Y and 5Z for an order of 5', () => {
    const demand = componentDemand(
      [
        { componentItemId: 'Y', qty: '2' },
        { componentItemId: 'Z', qty: '1' },
      ],
      '5',
    );
    expect(demand).toEqual([
      { componentItemId: 'Y', qty: '10.0000' },
      { componentItemId: 'Z', qty: '5.0000' },
    ]);
  });

  it('costs the finished item from component averages', () => {
    const demand = componentDemand(
      [
        { componentItemId: 'Y', qty: '2' },
        { componentItemId: 'Z', qty: '1' },
      ],
      '5',
    );
    expect(finishedGoodsCost(demand, { Y: '4', Z: '6' }, '5')).toEqual({
      componentCost: '70.0000',
      unitCost: '14.0000',
    });
  });

  it('increases component demand by the scrap percent', () => {
    const demand = componentDemand([{ componentItemId: 'Y', qty: '2', scrapPercent: '10' }], '5');
    expect(demand[0]?.qty).toBe('11.0000');
  });

  it('keeps a partial produce in progress and rejects producing past the plan', () => {
    const first = advanceProduction({ qtyPlanned: '5', qtyProduced: '0', status: 'draft' }, '2');
    expect(first).toEqual({ qtyProduced: '2.0000', status: 'in_progress' });
    const second = advanceProduction({ qtyPlanned: '5', qtyProduced: first.qtyProduced, status: first.status }, '3');
    expect(second).toEqual({ qtyProduced: '5.0000', status: 'done' });
    expect(() => advanceProduction({ qtyPlanned: '5', qtyProduced: second.qtyProduced, status: second.status }, '1')).toThrow(
      WmsRuleError,
    );
  });
});
