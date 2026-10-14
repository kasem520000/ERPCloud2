import { Decimal } from 'decimal.js';

export type PayrollEmployeeInput = { id: string; name: string; components: Record<string, string>; unpaidDays?: number; daysInMonth?: number; adjustments?: Array<{ kind: 'addition' | 'deduction'; valueText: string }> };
export type PayrollLineResult = { employeeId: string; employeeName: string; components: Record<string, string>; additions: string; deductions: string; gross: string; net: string; unpaidFactor: string };

/**
 * Last calendar day of a `YYYY-MM` month.
 * Payroll windows used to be built as `${yearMonth}-31`, which is not a real date in
 * 30-day months and made Postgres reject the whole adjustments query.
 */
export function monthEnd(yearMonth: string): string {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${String(last).padStart(2, '0')}`;
}

export function calculatePayrollLine(input: PayrollEmployeeInput): PayrollLineResult {
  const base = Object.values(input.components).reduce((sum, valueText) => sum.plus(new Decimal(valueText || '0')), new Decimal(0));
  const days = new Decimal(input.daysInMonth ?? 30);
  const unpaid = new Decimal(input.unpaidDays ?? 0);
  const unpaidFactor = Decimal.max(new Decimal(0), days.minus(unpaid)).div(days);
  const adjustedBase = base.mul(unpaidFactor);
  const additions = (input.adjustments ?? []).filter((entry) => entry.kind === 'addition').reduce((sum, entry) => sum.plus(new Decimal(entry.valueText)), new Decimal(0));
  const deductions = (input.adjustments ?? []).filter((entry) => entry.kind === 'deduction').reduce((sum, entry) => sum.plus(new Decimal(entry.valueText)), new Decimal(0));
  const net = Decimal.max(0, adjustedBase.plus(additions).minus(deductions));
  return { employeeId: input.id, employeeName: input.name, components: input.components, additions: additions.toFixed(4), deductions: deductions.toFixed(4), gross: adjustedBase.toFixed(4), net: net.toFixed(4), unpaidFactor: unpaidFactor.toFixed(6) };
}
