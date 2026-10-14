export type AccountingLine = { debit: string; credit: string };

export function isBalanced(lines: AccountingLine[], tolerance = 0.00005): boolean {
  const debit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
  return debit > 0 && Math.abs(debit - credit) <= tolerance;
}

export function mirrorLines<T extends AccountingLine>(lines: T[]): T[] {
  return lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }));
}

export function requiresReversalReason(reason: string): boolean {
  return reason.trim().length > 0;
}
