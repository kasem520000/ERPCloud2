/**
 * Number and money formatting.
 *
 * Two rules from Design v3 §4 that this module exists to enforce:
 *   1. digits are always Western Arabic and always Inter (`.num`), even
 *      inside an Arabic sentence;
 *   2. money is never an IEEE `number` in the domain layer — the helpers
 *      below accept the string form the API already sends
 *      (`PROJECT_CONTRACT` §3) and only ever *render* it.
 */

const AR_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Map Eastern-Arabic digits to Western ones, so `٥٦` prints as `56`. */
export function toWesternDigits(input: string): string {
  return input.replace(AR_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Group the integer part of a decimal string without touching the fraction. */
export function groupDigits(value: string, separator = ','): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '', fraction] = unsigned.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  const tail = fraction === undefined ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}${grouped}${tail}`;
}

export type MoneyFormatOptions = {
  /** Currency symbol or ISO code shown after the amount (RTL-friendly). */
  currency?: string;
  /** Decimal places; defaults to 2 (SAR minor units, `PROJECT_CONTRACT` §3). */
  fractionDigits?: number;
  /** Force the sign on positive amounts (accounting statements). */
  alwaysSigned?: boolean;
  locale?: string;
};

/**
 * Render a decimal string as display money. Uses `Intl` only for grouping and
 * symbol placement, never for the numeric value, so a rounding decision is
 * never made in the browser.
 */
export function formatMoney(value: string | number, options: MoneyFormatOptions = {}): string {
  const { currency, fractionDigits = 2, alwaysSigned = false, locale = 'en-US' } = options;
  const raw = toWesternDigits(String(value)).trim();
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return '—';
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: true,
  }).format(Math.abs(numeric));
  const sign = numeric < 0 ? '-' : alwaysSigned ? '+' : '';
  const body = currency ? `${formatted} ${currency}` : formatted;
  return `${sign}${body}`;
}

/** Percent with one decimal — the shape a KPI delta is read in. */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(fractionDigits)}%`;
}

/** Compact money for chart axes and KPI tiles: 12.4K / 3.1M. */
export function formatCompactMoney(value: string | number, currency?: string): string {
  const numeric = Number(toWesternDigits(String(value)));
  if (!Number.isFinite(numeric)) return '—';
  const abs = Math.abs(numeric);
  const sign = numeric < 0 ? '-' : '';
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(1)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(1)}M`;
  else if (abs >= 10_000) body = `${Math.round(abs / 1_000)}K`;
  else if (abs >= 1_000) body = `${(abs / 1_000).toFixed(1)}K`;
  else body = abs.toFixed(0);
  return `${sign}${body}${currency ? ` ${currency}` : ''}`;
}

/** ISO date → a short, locale-stable label (no `toLocaleDateString` drift). */
export function formatDate(iso: string, locale = 'en-GB'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** ISO timestamp → date + 24h clock, the shape an audit row is read in. */
export function formatDateTime(iso: string, locale = 'en-GB'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** «n من m» — the desktop's «موضع القيد: n من m» shape. */
export function formatPosition(current: number, totalCount: number, of = 'من'): string {
  if (totalCount <= 0) return '—';
  return `${current} ${of} ${totalCount}`;
}
