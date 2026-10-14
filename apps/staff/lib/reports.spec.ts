import { describe, expect, it } from 'vitest';

import { currentMonthRange, formatCell, initialFilters, isNumericColumn, type ReportParam } from './reports';

describe('report cell formatting', () => {
  it('formats each column type the way the desktop reports do', () => {
    expect(formatCell('1234.5', 'money')).toBe('1,234.50');
    expect(formatCell('3', 'qty')).toBe('3');
    expect(formatCell('7', 'int')).toBe('7');
    expect(formatCell('12.345', 'percent')).toBe('12.35%');
    expect(formatCell('2026-01-05', 'date')).toBe('2026-01-05');
    expect(formatCell('نقدي', 'text')).toBe('نقدي');
  });

  it('renders blanks as a dash instead of NaN or empty cells', () => {
    expect(formatCell('', 'money')).toBe('—');
    expect(formatCell('—', 'text')).toBe('—');
  });

  it('right-aligns only numeric columns', () => {
    expect(isNumericColumn({ key: 'total', labelAr: 'الإجمالي', type: 'money' })).toBe(true);
    expect(isNumericColumn({ key: 'party', labelAr: 'العميل', type: 'text' })).toBe(false);
    expect(isNumericColumn({ key: 'day', labelAr: 'اليوم', type: 'date' })).toBe(false);
  });
});

describe('report filters', () => {
  const params: ReportParam[] = [
    { name: 'from', labelAr: 'من', kind: 'date' },
    { name: 'to', labelAr: 'إلى', kind: 'date' },
    { name: 'branchId', labelAr: 'الفرع', kind: 'branch' },
  ];

  it('prefills the current month and leaves lookups on "all"', () => {
    const range = currentMonthRange();
    expect(initialFilters(params)).toEqual({ from: range.from, to: range.to, branchId: '' });
  });

  it('spans a whole month, first day to last', () => {
    const range = currentMonthRange();
    expect(range.from.endsWith('-01')).toBe(true);
    expect(range.from.slice(0, 7)).toBe(range.to.slice(0, 7));
    expect(Number(range.to.slice(8))).toBeGreaterThanOrEqual(28);
  });
});
