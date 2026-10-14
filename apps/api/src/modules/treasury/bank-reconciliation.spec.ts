import { describe, expect, it } from 'vitest';

import {
  bestBankMatch,
  parseBankStatementCsv,
  parseDelimitedRows,
  scoreBankMatch,
  type ParsedBankStatementLine,
} from './bank-feeds.utils.js';

const line: ParsedBankStatementLine = {
  lineNo: 1,
  txnDate: '2026-09-01',
  description: 'تحويل مبيعات INV-1001 شركة المدى',
  reference: 'INV-1001',
  amount: '1250.0000',
  balance: '5250.0000',
};

describe('bank reconciliation import and matching', () => {
  it('parses a 100-row CSV without losing rows', () => {
    const rows = ['Date,Description,Amount,Balance', ...Array.from({ length: 100 }, (_, index) => `2026-09-${String((index % 28) + 1).padStart(2, '0')},Invoice INV-${index + 1},${index + 1}.00,${index + 1}.00`)].join('\n');
    const parsed = parseBankStatementCsv(rows);
    expect(parsed).toHaveLength(100);
    expect(parsed[0]).toMatchObject({ lineNo: 1, amount: '1.0000' });
    expect(parsed[99]).toMatchObject({ lineNo: 100, amount: '100.0000' });
  });

  it('accepts Arabic headers and converts debit/credit to a signed amount', () => {
    const parsed = parseBankStatementCsv('تاريخ,البيان,مدين,دائن,الرصيد\n01/09/2026,فاتورة بيع,0,1,101\n02/09/2026,مصروف بنكي,25,0,76');
    expect(parsed.map((row) => row.txnDate)).toEqual(['2026-09-01', '2026-09-02']);
    expect(parsed.map((row) => row.amount)).toEqual(['1.0000', '-25.0000']);
  });

  it('handles quoted commas, escaped quotes and a semicolon delimiter', () => {
    expect(parseDelimitedRows('date;description;amount\n2026-09-01;"رسوم، ""بنك""";10.50')).toEqual([
      ['date', 'description', 'amount'],
      ['2026-09-01', 'رسوم، "بنك"', '10.50'],
    ]);
    expect(parseBankStatementCsv('date,description,amount\n2026-09-01,"شركة, المدى",10.50')[0]?.description).toBe('شركة, المدى');
  });

  it('accepts headerless exports in date, description, amount, balance order', () => {
    const parsed = parseBankStatementCsv('2026-09-01,تحويل,1,101\n2026-09-02,سداد,-2,99');
    expect(parsed.map((row) => row.amount)).toEqual(['1.0000', '-2.0000']);
    expect(parsed[1]?.balance).toBe('99.0000');
  });

  it('rejects malformed dates and empty amounts with a useful row number', () => {
    expect(() => parseBankStatementCsv('date,description,amount\nnot-a-date,رسوم,10')).toThrow('row 2');
    expect(() => parseBankStatementCsv('date,description,amount\n2026-09-01,رسوم,')).toThrow('amount is required');
  });

  it('gives a high confidence to exact amount, nearby date and reference', () => {
    const result = scoreBankMatch(line, {
      id: 'invoice-1',
      type: 'sale',
      date: '2026-09-03',
      amount: '1250.0000',
      number: 'INV-1001',
      partyName: 'شركة المدى',
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    expect(result.reason).toContain('المرجع');
  });

  it('uses a party name as the second matching signal', () => {
    const result = scoreBankMatch(line, {
      id: 'invoice-1',
      type: 'sale',
      date: '2026-09-03',
      amount: '1250.0000',
      number: 'OTHER-1',
      partyName: 'شركة المدى',
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.reason).toContain('اسم العميل');
  });

  it('chooses the strongest candidate and ignores amount-only noise', () => {
    const result = bestBankMatch(line, [
      { id: 'weak', type: 'sale', date: '2025-01-01', amount: '1250.0000', number: 'OLD' },
      { id: 'strong', type: 'sale', date: '2026-09-02', amount: '1250.0000', number: 'INV-1001' },
    ]);
    expect(result?.candidate.id).toBe('strong');
    expect(result?.score.confidence).toBe(0.95);
    expect(bestBankMatch({ ...line, amount: '999.0000', description: 'غير معروف', reference: null }, [{ id: 'x', type: 'sale', date: line.txnDate, amount: '1250' }])).toBeUndefined();

    const benchmarkLines = Array.from({ length: 100 }, (_, index) => ({
      lineNo: index + 1,
      txnDate: '2026-09-15',
      description: `تحصيل INV-BENCH-${index + 1}`,
      reference: `INV-BENCH-${index + 1}`,
      amount: `${index + 1}.0000`,
      balance: null,
    }));
    const benchmarkCandidates = benchmarkLines.slice(0, 60).map((row) => ({
      id: `candidate-${row.lineNo}`,
      type: 'sale' as const,
      date: row.txnDate,
      amount: row.amount,
      number: row.reference ?? undefined,
    }));
    const matchedBenchmarkLines = benchmarkLines.filter((row) => bestBankMatch(row, benchmarkCandidates));
    expect(matchedBenchmarkLines).toHaveLength(60);
    expect(matchedBenchmarkLines.length / benchmarkLines.length).toBeGreaterThanOrEqual(0.6);
  });
});
