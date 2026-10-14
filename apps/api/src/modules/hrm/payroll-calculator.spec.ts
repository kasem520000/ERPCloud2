import { describe, expect, it } from 'vitest';

import { calculatePayrollLine, monthEnd } from './payroll-calculator.js';

describe('payroll calculator', () => {
  it('sums components, additions and deductions deterministically', () => {
    const line = calculatePayrollLine({ id: 'e1', name: 'A', components: { basic: '1000.00', housing: '250.00' }, adjustments: [{ kind: 'addition', valueText: '50.00' }, { kind: 'deduction', valueText: '25.00' }] });
    expect(line.gross).toBe('1250.0000');
    expect(line.net).toBe('1275.0000');
  });
  it('applies unpaid-days factor and never returns a negative net', () => {
    const line = calculatePayrollLine({ id: 'e1', name: 'A', components: { basic: '300.00' }, daysInMonth: 30, unpaidDays: 15, adjustments: [{ kind: 'deduction', valueText: '999.00' }] });
    expect(line.gross).toBe('150.0000');
    expect(line.net).toBe('0.0000');
  });
  it('closes a payroll month on its real last day', () => {
    expect(monthEnd('2026-09')).toBe('2026-09-30');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
  });
});
