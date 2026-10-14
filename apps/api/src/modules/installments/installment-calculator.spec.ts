import { describe, expect, it } from 'vitest';

import { generateInstallmentSchedule } from './installment-calculator.js';

describe('generateInstallmentSchedule', () => {
  it('splits remainder after down payment across monthly installments', () => {
    const lines = generateInstallmentSchedule({ contractValue: '1000', downPayment: '100', count: 3, firstDueDate: '2026-01-15' });
    expect(lines).toEqual([
      { lineNo: 1, dueDate: '2026-01-15', dueValue: '300.0000' },
      { lineNo: 2, dueDate: '2026-02-15', dueValue: '300.0000' },
      { lineNo: 3, dueDate: '2026-03-15', dueValue: '300.0000' },
    ]);
  });

  it('keeps rounding difference on the final line', () => {
    const lines = generateInstallmentSchedule({ contractValue: '100', count: 3, firstDueDate: '2026-01-01', periodUnit: 'days', periodEvery: 10 });
    expect(lines.map((line) => line.dueValue)).toEqual(['33.3300', '33.3300', '33.3400']);
    expect(lines.map((line) => line.dueDate)).toEqual(['2026-01-01', '2026-01-11', '2026-01-21']);
  });
});
