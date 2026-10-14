import { Decimal } from 'decimal.js';

export type ScheduleLine = { lineNo: number; dueDate: string; dueValue: string };
export function generateInstallmentSchedule(input: { contractValue: string; downPayment?: string; count: number; firstDueDate: string; periodUnit?: 'days' | 'months'; periodEvery?: number }): ScheduleLine[] {
  if (input.count <= 0) throw new Error('count must be positive');
  const remainder = new Decimal(input.contractValue).minus(input.downPayment ?? '0');
  if (remainder.lt(0)) throw new Error('down payment exceeds contract value');
  const base = remainder.div(input.count).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const lines: ScheduleLine[] = [];
  let running = new Decimal(0);
  for (let index = 1; index <= input.count; index += 1) {
    const dueValue = index === input.count ? remainder.minus(running) : base;
    running = running.plus(dueValue);
    lines.push({ lineNo: index, dueDate: addPeriod(input.firstDueDate, index - 1, input.periodUnit ?? 'months', input.periodEvery ?? 1), dueValue: dueValue.toFixed(4) });
  }
  return lines;
}
function addPeriod(dateText: string, offset: number, unit: 'days' | 'months', every: number): string { const d = new Date(`${dateText}T00:00:00.000Z`); if (unit === 'days') d.setUTCDate(d.getUTCDate() + offset * every); else d.setUTCMonth(d.getUTCMonth() + offset * every); return d.toISOString().slice(0, 10); }
