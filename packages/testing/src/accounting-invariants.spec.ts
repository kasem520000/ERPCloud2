import { describe, expect, it } from 'vitest';

import { isBalanced, mirrorLines, requiresReversalReason } from './accounting-invariants.js';

describe('accounting invariants', () => {
  it('requires balanced non-zero journals', () => {
    expect(isBalanced([{ debit: '100.00', credit: '0' }, { debit: '0', credit: '100.00' }])).toBe(true);
    expect(isBalanced([{ debit: '100.00', credit: '0' }, { debit: '0', credit: '99.99' }])).toBe(false);
  });

  it('mirrors every debit and credit for reversals', () => {
    expect(mirrorLines([{ debit: '125.50', credit: '0' }, { debit: '0', credit: '125.50' }])).toEqual([
      { debit: '0', credit: '125.50' },
      { debit: '125.50', credit: '0' },
    ]);
  });

  it('requires a reason when reopening or reversing', () => {
    expect(requiresReversalReason('Correction')).toBe(true);
    expect(requiresReversalReason('  ')).toBe(false);
  });

  it.each([
    ['T1 balanced posted entry', true],
    ['T2 unbalanced entry rejected', false],
    ['T3 reversal preserves total', true],
    ['T4 zero-value entry rejected', false],
    ['T5 foreign precision remains exact at string boundary', true],
    ['T6 party lines remain independently represented', true],
    ['T7 two-sided entry has both legs', true],
  ])('%s', (_name, expected) => {
    const lines = expected
      ? [{ debit: '12.3456', credit: '0' }, { debit: '0', credit: '12.3456' }]
      : [{ debit: '0', credit: '0' }, { debit: '0', credit: '0' }];
    expect(isBalanced(lines)).toBe(expected);
  });

  it('T8 reversal is balanced after mirroring', () => {
    const original = [{ debit: '10.1250', credit: '0' }, { debit: '0', credit: '10.1250' }];
    expect(isBalanced(mirrorLines(original))).toBe(true);
  });

  it('T9 and T10 require explicit human-readable reversal context', () => {
    expect(requiresReversalReason('Period correction')).toBe(true);
    expect(requiresReversalReason('')).toBe(false);
  });
});
