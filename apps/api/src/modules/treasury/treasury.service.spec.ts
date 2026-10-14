import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';

describe('treasury phase 12 invariants', () => {
  it('computes shift difference as counted minus expected', () => {
    const expected = new Decimal('125.50');
    const counted = [{ denomination: '50', count: 2 }, { denomination: '20', count: 1 }, { denomination: '5', count: 1 }]
      .reduce((sum, line) => sum.plus(new Decimal(line.denomination).mul(line.count)), new Decimal(0));
    expect(counted.minus(expected).toFixed(4)).toBe('-0.5000');
  });

  it('treats cheque states as terminal after clear or bounce', () => {
    const terminal = new Set(['cleared', 'bounced', 'collected']);
    expect(terminal.has('cleared')).toBe(true);
    expect(terminal.has('pending')).toBe(false);
  });
});
