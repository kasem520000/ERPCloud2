import { Decimal } from 'decimal.js';

export type BillTermInput = { termId: string; qty: string; unitValue: string; previouslyBilled: string; billPct?: string; billValue?: string };
export type BillLine = { termId: string; billPct: string; billValue: string; previousValue: string; remainingValue: string };
export function computeProgressBill(terms: BillTermInput[], retentionPct: string) {
  const lines: BillLine[] = terms.map((term) => {
    const termValue = new Decimal(term.qty).mul(term.unitValue);
    const requested = term.billValue ? new Decimal(term.billValue) : termValue.mul(new Decimal(term.billPct ?? '0')).div(100);
    const prior = new Decimal(term.previouslyBilled || '0');
    const cumulative = prior.plus(requested);
    if (cumulative.gt(termValue.plus('0.0001'))) throw new Error('cumulative billing exceeds term value');
    return { termId: term.termId, billPct: termValue.isZero() ? '0.0000' : requested.div(termValue).mul(100).toFixed(4), billValue: requested.toFixed(4), previousValue: prior.toFixed(4), remainingValue: termValue.minus(cumulative).toFixed(4) };
  });
  const workValue = sum(lines.map((line) => line.billValue));
  const previousValue = sum(lines.map((line) => line.previousValue));
  const retentionValue = workValue.mul(new Decimal(retentionPct || '0')).div(100);
  return { lines, workValue: workValue.toFixed(4), previousValue: previousValue.toFixed(4), retentionValue: retentionValue.toFixed(4), netDue: workValue.minus(retentionValue).toFixed(4), remainingAfter: sum(lines.map((line) => line.remainingValue)).toFixed(4) };
}
function sum(values: string[]) { return values.reduce((acc, item) => acc.plus(new Decimal(item)), new Decimal(0)); }
