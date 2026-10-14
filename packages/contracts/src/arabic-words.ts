import { Decimal } from 'decimal.js';

/**
 * Arabic "tafqeet" (moved here from the API print module so staff screens spell
 * the same words the server prints — one dictionary, zero drift).
 * — writing an amount in words, the way every printed voucher and
 * invoice in the region does ("فقط خمسة آلاف وسبعمائة ريال وخمسون هللة لا غير").
 *
 * Arabic numerals are gendered and case-marked; a full grammatical treatment is a
 * research project. What is implemented here is the conventional accounting form used on
 * documents: units before tens joined with "و", the dual forms (مئتان، ألفان، مليونان),
 * and the classic 3/10 inversion (ثلاثة آلاف، ثلاثمائة).
 */

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

/** singular / dual / plural (3–10) / plural (11+) for each scale. */
const SCALES: Array<[string, string, string, string]> = [
  ['', '', '', ''],
  ['ألف', 'ألفان', 'آلاف', 'ألفاً'],
  ['مليون', 'مليونان', 'ملايين', 'مليوناً'],
  ['مليار', 'ملياران', 'مليارات', 'ملياراً'],
  ['تريليون', 'تريليونان', 'تريليونات', 'تريليوناً'],
];

/** Currency names in the singular / plural forms used after numbers, plus the fraction. */
const CURRENCIES: Record<string, { one: string; many: string; fraction: string }> = {
  SAR: { one: 'ريال', many: 'ريالاً', fraction: 'هللة' },
  YER: { one: 'ريال', many: 'ريالاً', fraction: 'فلس' },
  AED: { one: 'درهم', many: 'درهماً', fraction: 'فلس' },
  EGP: { one: 'جنيه', many: 'جنيهاً', fraction: 'قرش' },
  USD: { one: 'دولار', many: 'دولاراً', fraction: 'سنت' },
  EUR: { one: 'يورو', many: 'يورو', fraction: 'سنت' },
  KWD: { one: 'دينار', many: 'ديناراً', fraction: 'فلس' },
  QAR: { one: 'ريال', many: 'ريالاً', fraction: 'درهم' },
  OMR: { one: 'ريال', many: 'ريالاً', fraction: 'بيسة' },
  BHD: { one: 'دينار', many: 'ديناراً', fraction: 'فلس' },
  JOD: { one: 'دينار', many: 'ديناراً', fraction: 'قرش' },
};

/** Below one thousand: hundreds, then tens and units joined the Arabic way (٣ و٢٠). */
function underThousand(value: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]!);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]!);
    else {
      const unit = rest % 10;
      const ten = Math.floor(rest / 10);
      parts.push(unit ? `${ONES[unit]} و${TENS[ten]}` : TENS[ten]!);
    }
  }
  return parts.join(' و');
}

/** The scale word agrees with its count: ألف / ألفان / ثلاثة آلاف / أحد عشر ألفاً. */
function scaleWord(count: number, scale: number): string {
  const forms = SCALES[scale]!;
  if (scale === 0) return '';
  if (count === 1) return forms[0];
  if (count === 2) return forms[1];
  if (count >= 3 && count <= 10) return forms[2];
  return forms[3];
}

/** Whole-number part in words. Returns 'صفر' for zero so callers never print an empty string. */
export function integerInArabicWords(value: number | string | Decimal): string {
  let remaining = new Decimal(value).abs().trunc();
  if (remaining.isZero()) return 'صفر';

  const groups: number[] = [];
  while (remaining.gt(0)) {
    groups.push(Number(remaining.mod(1000).toFixed(0)));
    remaining = remaining.div(1000).trunc();
  }

  const chunks: string[] = [];
  for (let scale = groups.length - 1; scale >= 0; scale -= 1) {
    const group = groups[scale]!;
    if (!group) continue;
    if (scale === 0) {
      chunks.push(underThousand(group));
      continue;
    }
    const word = scaleWord(group, scale);
    // "ألف" and "ألفان" carry their own count, so the digit is not repeated before them.
    chunks.push(group === 1 || group === 2 ? word : `${underThousand(group)} ${word}`);
  }
  return chunks.join(' و');
}

/**
 * The full line printed on a document: the amount, its currency, and the fraction when
 * there is one. `currency` accepts an ISO code; unknown codes are printed as-is.
 */
export function amountInArabicWords(input: number | string, currency = 'SAR'): string {
  const value = new Decimal(input || 0).abs();
  const whole = value.trunc();
  const fraction = Number(value.minus(whole).mul(100).toFixed(0));

  const names = CURRENCIES[currency.toUpperCase()] ?? { one: currency, many: currency, fraction: '' };
  // The counted noun follows the *last two digits*: 11–99 take the accusative singular
  // (خمسة عشر ريالاً) while anything ending in a round hundred or in 1–10 stays plain
  // (خمسة آلاف وسبعمائة ريال).
  const tail = Number(whole.mod(100).toFixed(0));
  const currencyName = tail >= 11 && tail <= 99 ? names.many : names.one;

  const parts = [`${integerInArabicWords(whole)} ${currencyName}`];
  if (fraction > 0 && names.fraction) {
    parts.push(`${integerInArabicWords(fraction)} ${names.fraction}`);
  }
  const sign = new Decimal(input || 0).isNegative() ? 'سالب ' : '';
  return `${sign}${parts.join(' و')} لا غير`;
}
