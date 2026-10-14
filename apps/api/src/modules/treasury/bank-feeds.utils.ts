import { Decimal } from 'decimal.js';

export type ParsedBankStatementLine = {
  lineNo: number;
  txnDate: string;
  description: string;
  reference: string | null;
  amount: string;
  balance: string | null;
};

type ColumnMap = {
  date?: number;
  description?: number;
  reference?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  balance?: number;
};

export type BankMatchCandidate = {
  id: string;
  type: 'sale' | 'purchase' | 'voucher';
  date: string;
  amount: string;
  number?: string | null;
  reference?: string | null;
  partyName?: string | null;
  kind?: 'receipt' | 'payment';
};

export type BankMatchScore = {
  confidence: number;
  reason: string;
};

const HEADER_ALIASES: Record<keyof ColumnMap, string[]> = {
  date: ['date', 'transactiondate', 'transaction_date', 'txndate', 'valuedate', 'postingdate', 'تاريخ', 'تاريخالحركة', 'تاريخالقيد'],
  description: ['description', 'details', 'narrative', 'memo', 'particulars', 'الوصف', 'البيان', 'التفاصيل', 'الحركة'],
  reference: ['reference', 'ref', 'referenceno', 'transactionid', 'checkno', 'chequeno', 'المرجع', 'رقمالمرجع', 'رقمالحركة'],
  amount: ['amount', 'transactionamount', 'value', 'المبلغ', 'القيمة', 'قيمةالحركة'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'out', 'مدين', 'مسحوبات', 'مدفوعات', 'صادر'],
  credit: ['credit', 'deposit', 'deposits', 'in', 'دائن', 'إيداعات', 'مقبوضات', 'وارد'],
  balance: ['balance', 'runningbalance', 'closingbalance', 'الرصيد', 'الرصيدالجاري', 'الرصيدالختامي'],
};

function normaliseDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function normaliseHeader(value: string): string {
  return normaliseDigits(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[\uFEFF\s_\-./()[\]{}:،,]/g, '');
}

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|'];
  const counts = candidates.map((delimiter) => ({ delimiter, count: line.split(delimiter).length - 1 }));
  return counts.sort((left, right) => right.count - left.count)[0]?.delimiter ?? ',';
}

/** RFC-4180 enough for bank exports: quoted commas, escaped quotes and newlines. */
export function parseDelimitedRows(input: string, delimiter?: string): string[][] {
  const source = input.replace(/^\uFEFF/, '');
  const separator = delimiter ?? detectDelimiter(source.split(/\r?\n/, 1)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      cell += character;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field');
  return rows;
}

function findColumn(headers: string[], aliases: string[]): number | undefined {
  const aliasSet = new Set(aliases.map(normaliseHeader));
  const index = headers.findIndex((header) => aliasSet.has(normaliseHeader(header)));
  return index === -1 ? undefined : index;
}

function inferColumns(row: string[]): ColumnMap {
  return {
    date: 0,
    description: 1,
    amount: 2,
    balance: row.length > 3 ? 3 : undefined,
  };
}

function columnsFor(headers: string[]): ColumnMap {
  const result: ColumnMap = {};
  for (const key of Object.keys(HEADER_ALIASES) as Array<keyof ColumnMap>) {
    const index = findColumn(headers, HEADER_ALIASES[key]);
    if (index !== undefined) result[key] = index;
  }
  return result;
}

function numericValue(raw: string | undefined, field: string, rowNo: number): string {
  const original = normaliseDigits(raw?.trim() ?? '');
  if (!original) throw new Error(`row ${rowNo}: ${field} is required`);

  const negative = /^\(.*\)$/.test(original) || original.startsWith('-');
  const unsigned = original.replace(/^\(|\)$/g, '').replace(/[^0-9.,+-]/g, '');
  const hasDot = unsigned.includes('.');
  const commaParts = unsigned.split(',');
  let normalised = unsigned;
  if (hasDot) {
    normalised = unsigned.replace(/,/g, '');
  } else if (commaParts.length > 1 && (commaParts.at(-1)?.length ?? 0) === 2) {
    normalised = `${commaParts.slice(0, -1).join('')}.${commaParts.at(-1)}`;
  } else {
    normalised = unsigned.replace(/,/g, '');
  }
  const value = new Decimal(normalised.replace(/^[+]/, ''));
  if (!value.isFinite()) throw new Error(`row ${rowNo}: ${field} is not a number`);
  return (negative ? value.abs().negated() : value).toFixed(4);
}

function dateValue(raw: string | undefined, rowNo: number): string {
  const value = normaliseDigits(raw?.trim() ?? '');
  const match = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/.exec(value);
  if (!match) throw new Error(`row ${rowNo}: date is invalid`);

  const first = match[1];
  const second = match[2];
  const third = match[3];
  if (!first || !second || !third) throw new Error(`row ${rowNo}: date is invalid`);
  let year: number;
  let month: number;
  let day: number;
  if (first.length === 4) {
    year = Number(first);
    month = Number(second);
    day = Number(third);
  } else if (third.length === 4) {
    day = Number(first);
    month = Number(second);
    year = Number(third);
  } else {
    throw new Error(`row ${rowNo}: date must include a four-digit year`);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`row ${rowNo}: date is invalid`);
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/**
 * Parses the common CSV exports produced by Saudi banks. Headerless files are accepted
 * using the stable fallback date, description, amount, balance order.
 */
export function parseBankStatementCsv(input: string): ParsedBankStatementLine[] {
  if (!input.trim()) throw new Error('CSV is empty');
  const rows = parseDelimitedRows(input);
  if (rows.length === 0) throw new Error('CSV has no rows');

  const headerColumns = columnsFor(rows[0] ?? []);
  const hasHeader = headerColumns.date !== undefined && (headerColumns.amount !== undefined || headerColumns.debit !== undefined || headerColumns.credit !== undefined);
  const columns = hasHeader ? headerColumns : inferColumns(rows[0] ?? []);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  if (columns.date === undefined) throw new Error('CSV needs a date column');
  if (columns.amount === undefined && columns.debit === undefined && columns.credit === undefined) {
    throw new Error('CSV needs an amount, debit or credit column');
  }
  const dateColumn = columns.date;

  return dataRows.map((row, index) => {
    const rowNo = index + (hasHeader ? 2 : 1);
    const debit = columns.debit === undefined ? undefined : row[columns.debit];
    const credit = columns.credit === undefined ? undefined : row[columns.credit];
    let signedText: string;
    if (columns.amount !== undefined) {
      signedText = numericValue(row[columns.amount], 'amount', rowNo);
    } else {
      const debitValue = debit?.trim() ? new Decimal(numericValue(debit, 'debit', rowNo)) : new Decimal(0);
      const creditValue = credit?.trim() ? new Decimal(numericValue(credit, 'credit', rowNo)) : new Decimal(0);
      if (debitValue.isZero() && creditValue.isZero()) throw new Error(`row ${rowNo}: amount is required`);
      signedText = creditValue.minus(debitValue).toFixed(4);
    }

    const description = (columns.description === undefined ? '' : row[columns.description] ?? '').trim();
    const reference = (columns.reference === undefined ? '' : row[columns.reference] ?? '').trim();
    const balanceText = columns.balance === undefined || !row[columns.balance]?.trim()
      ? null
      : numericValue(row[columns.balance], 'balance', rowNo);

    return {
      lineNo: index + 1,
      txnDate: dateValue(row[dateColumn], rowNo),
      description,
      reference: reference || null,
      amount: signedText,
      balance: balanceText,
    };
  });
}

function dayDistance(left: string, right: string): number {
  const start = Date.parse(`${left}T00:00:00Z`);
  const end = Date.parse(`${right}T00:00:00Z`);
  return Math.round(Math.abs(start - end) / 86_400_000);
}

function hasReference(line: ParsedBankStatementLine, candidate: BankMatchCandidate): boolean {
  const text = `${line.description} ${line.reference ?? ''}`.toLocaleLowerCase();
  return [candidate.number, candidate.reference]
    .filter((value): value is string => Boolean(value?.trim()))
    .some((value) => text.includes(value.toLocaleLowerCase().trim()));
}

function hasPartyName(line: ParsedBankStatementLine, candidate: BankMatchCandidate): boolean {
  const text = `${line.description} ${line.reference ?? ''}`.toLocaleLowerCase();
  const words = (candidate.partyName ?? '').toLocaleLowerCase().split(/\s+/).filter((word) => word.length >= 3);
  return words.some((word) => text.includes(word));
}

/**
 * Deterministic matching score used by the API and unit tests. It intentionally never
 * creates an accounting entry: reconciliation is a proposal/association layer.
 */
export function scoreBankMatch(line: ParsedBankStatementLine, candidate: BankMatchCandidate): BankMatchScore {
  const amountMatches = new Decimal(line.amount).abs().eq(new Decimal(candidate.amount).abs());
  const dateMatches = dayDistance(line.txnDate, candidate.date) <= 3;
  const referenceMatches = hasReference(line, candidate);
  const partyMatches = hasPartyName(line, candidate);
  const directionMatches = candidate.kind === undefined || (line.amount.startsWith('-') ? candidate.kind === 'payment' : candidate.kind === 'receipt');

  let score = 0;
  const reasons: string[] = [];
  if (amountMatches) {
    score += 0.65;
    reasons.push('المبلغ مطابق');
  }
  if (dateMatches) {
    score += 0.15;
    reasons.push('التاريخ ضمن ثلاثة أيام');
  }
  if (referenceMatches) {
    score += 0.15;
    reasons.push('المرجع موجود في البيان');
  } else if (partyMatches) {
    score += 0.15;
    reasons.push('اسم العميل أو المورد موجود في البيان');
  }
  if (candidate.kind !== undefined && directionMatches) {
    score += 0.05;
    reasons.push('نوع الحركة مطابق');
  }
  if (candidate.kind !== undefined && !directionMatches) score -= 0.2;

  return {
    confidence: Math.max(0, Math.min(0.99, Number(score.toFixed(4)))),
    reason: reasons.join(' + ') || 'لا توجد قرائن كافية',
  };
}

export function bestBankMatch(
  line: ParsedBankStatementLine,
  candidates: BankMatchCandidate[],
): { candidate: BankMatchCandidate; score: BankMatchScore } | undefined {
  return candidates
    .map((candidate) => ({ candidate, score: scoreBankMatch(line, candidate) }))
    .filter((entry) => entry.score.confidence >= 0.6)
    .sort((left, right) => right.score.confidence - left.score.confidence)[0];
}
