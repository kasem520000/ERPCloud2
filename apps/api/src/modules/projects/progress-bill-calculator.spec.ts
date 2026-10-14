import { describe, expect, it } from 'vitest';

import { computeProgressBill } from './progress-bill-calculator.js';

describe('computeProgressBill', () => {
  it('computes value, retention, previous and net due', () => {
    const bill = computeProgressBill([
      { termId: 'a', qty: '10', unitValue: '100', previouslyBilled: '200', billPct: '30' },
      { termId: 'b', qty: '1', unitValue: '500', previouslyBilled: '0', billValue: '125' },
    ], '10');
    expect(bill.workValue).toBe('425.0000');
    expect(bill.previousValue).toBe('200.0000');
    expect(bill.retentionValue).toBe('42.5000');
    expect(bill.netDue).toBe('382.5000');
    expect(bill.lines[0]?.remainingValue).toBe('500.0000');
  });

  it('rejects overbilling beyond a BOQ term value', () => {
    expect(() => computeProgressBill([{ termId: 'a', qty: '1', unitValue: '100', previouslyBilled: '90', billValue: '20' }], '0')).toThrow('cumulative billing exceeds term value');
  });
});
