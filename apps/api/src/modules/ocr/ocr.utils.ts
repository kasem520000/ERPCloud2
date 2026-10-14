import type { OcrExtraction, OcrLine } from './ocr.types.js';

type JsonObject = Record<string, unknown>;

const FIELD_ALIASES = {
  supplierName: ['supplierName', 'supplier', 'vendor', 'vendorName', 'vendor_name', 'المورد', 'اسم المورد'],
  supplierTaxNumber: ['supplierTaxNumber', 'supplierTaxNo', 'vendorTaxNumber', 'taxNumber', 'taxNo', 'الرقم الضريبي'],
  invoiceNumber: ['invoiceNumber', 'invoiceNo', 'invoice_number', 'number', 'رقم الفاتورة', 'رقم الفاتوره'],
  invoiceDate: ['invoiceDate', 'date', 'invoice_date', 'تاريخ الفاتورة', 'تاريخ الفاتوره'],
  subtotal: ['subtotal', 'subTotal', 'net', 'netAmount', 'subtotalAmount', 'الإجمالي قبل الضريبة', 'الصافي'],
  taxAmount: ['taxAmount', 'tax', 'vat', 'vatAmount', 'tax_total', 'الضريبة', 'ضريبة القيمة المضافة'],
  total: ['total', 'grandTotal', 'totalAmount', 'amountDue', 'الإجمالي', 'المجموع'],
  currency: ['currency', 'currencyCode', 'العملة'],
} as const;

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function objectOf(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function firstObject(...values: unknown[]): JsonObject | undefined {
  for (const value of values) {
    const candidate = objectOf(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function unwrapPayload(value: unknown): JsonObject {
  const root = objectOf(value) ?? {};
  const pages = Array.isArray(root.pages) ? root.pages : [];
  const firstPage = objectOf(pages[0]);
  const data = firstObject(root.data, root.result);
  const fields = firstObject(data?.fields, root.fields, firstPage?.fields);
  // Provider responses differ (`data.fields`, `result`, `pages`). The first page is
  // intentionally merged last: multi-page PDFs are accepted, but page two must never
  // overwrite the invoice header used for the first-page review.
  return { ...root, ...(data ?? {}), ...(fields ?? {}), ...(firstPage ?? {}) };
}

function unwrapField(value: unknown): { value: unknown; confidence?: number } {
  const object = objectOf(value);
  if (!object) return { value };
  const candidate = object.value ?? object.text ?? object.content ?? object.rawValue ?? object.raw_text;
  return {
    value: candidate === undefined ? value : candidate,
    confidence: normaliseConfidence(object.confidence ?? object.score ?? object.probability),
  };
}

function normaliseConfidence(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace('%', '')) : NaN;
  if (!Number.isFinite(number)) return undefined;
  const score = number > 1 ? number / 100 : number;
  return Math.max(0, Math.min(1, score));
}

function readField(root: JsonObject, aliases: readonly string[]): { value: unknown; confidence?: number } {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(root, alias)) return unwrapField(root[alias]);
  }
  return { value: undefined };
}

function toText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function normaliseDigits(value: string): string {
  return [...value]
    .map((char) => {
      const arabic = ARABIC_DIGITS.indexOf(char);
      if (arabic >= 0) return String(arabic);
      const persian = PERSIAN_DIGITS.indexOf(char);
      return persian >= 0 ? String(persian) : char;
    })
    .join('');
}

/** Keep money as a decimal string; never let a provider's locale number become a JS float. */
export function normaliseMoney(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const raw = normaliseDigits(text)
    .replace(/[٬،]/g, ',')
    .replace(/٫/g, '.')
    .replace(/\s/g, '')
    .replace(/[^0-9,.-]/g, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalised = raw;
  if (lastComma >= 0 && lastDot >= 0) {
    // The last separator is the decimal separator in mixed-locale values.
    normalised = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const fractionLength = raw.length - lastComma - 1;
    normalised = fractionLength === 3 && lastComma > 0 ? raw.replace(/,/g, '') : raw.replace(',', '.');
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalised)) return null;
  return normalised;
}

export function normaliseDate(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const digits = normaliseDigits(text).replace(/[.]/g, '/').replace(/-/g, '/');
  const iso = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(digits);
  if (iso) {
    const [, year = '', month = '', day = ''] = iso;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(digits);
  if (dmy) {
    const [, day = '', month = '', year = ''] = dmy;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normaliseLine(value: unknown): OcrLine | null {
  const line = objectOf(value);
  if (!line) return null;
  const description = toText(line.description ?? line.name ?? line.item ?? line.product ?? line['الوصف'] ?? line['الصنف']);
  if (!description) return null;
  return {
    description,
    quantity: normaliseMoney(line.quantity ?? line.qty ?? line['الكمية']) ?? undefined,
    unitPrice: normaliseMoney(line.unitPrice ?? line.price ?? line.unit_price ?? line['سعر الوحدة']) ?? undefined,
    taxRate: normaliseMoney(line.taxRate ?? line.vatRate ?? line.tax_rate ?? line['نسبة الضريبة']) ?? undefined,
    total: normaliseMoney(line.total ?? line.amount ?? line.lineTotal ?? line['الإجمالي']) ?? undefined,
    confidence: normaliseConfidence(line.confidence ?? line.score),
  };
}

function readLines(root: JsonObject): OcrLine[] {
  const raw = root.lines ?? root.items ?? root.lineItems ?? root['البنود'] ?? root['الأصناف'];
  if (!Array.isArray(raw)) return [];
  return raw.map(normaliseLine).filter((line): line is OcrLine => line !== null);
}

function rootConfidence(root: JsonObject): number | undefined {
  return normaliseConfidence(root.confidence ?? root.score ?? root.probability);
}

/**
 * Convert a provider response into the contract stored in `ocr_jobs.extracted`.
 * It accepts both primitive fields and common `{ value, confidence }` field objects,
 * understands Arabic labels/digits, and always uses only the first PDF page.
 */
export function normaliseOcrPayload(payload: unknown): OcrExtraction {
  const root = unwrapPayload(payload);
  const confidenceByField: Record<string, number> = {};

  const read = <K extends keyof typeof FIELD_ALIASES>(field: K): unknown => {
    const result = readField(root, FIELD_ALIASES[field]);
    if (result.confidence !== undefined) confidenceByField[field] = result.confidence;
    return result.value;
  };

  const supplierName = toText(read('supplierName'));
  const supplierTaxNumber = toText(read('supplierTaxNumber'));
  const invoiceNumber = toText(read('invoiceNumber'));
  const invoiceDate = normaliseDate(read('invoiceDate'));
  const subtotal = normaliseMoney(read('subtotal'));
  const taxAmount = normaliseMoney(read('taxAmount'));
  const totalAmount = normaliseMoney(read('total'));
  const currency = toText(read('currency'));
  const lines = readLines(root);

  const suppliedConfidences = objectOf(root.confidenceByField);
  if (suppliedConfidences) {
    for (const field of Object.keys(FIELD_ALIASES)) {
      const supplied = normaliseConfidence(suppliedConfidences[field]);
      if (supplied !== undefined && confidenceByField[field] === undefined) confidenceByField[field] = supplied;
    }
  }
  if (lines.length > 0) {
    const lineConfidence = lines.flatMap((line) => (line.confidence === undefined ? [] : [line.confidence]));
    if (lineConfidence.length > 0) confidenceByField.lines = lineConfidence.reduce((sum, value) => sum + value, 0) / lineConfidence.length;
  }

  const knownConfidences = Object.values(confidenceByField);
  const confidence =
    knownConfidences.length > 0
      ? knownConfidences.reduce((sum, value) => sum + value, 0) / knownConfidences.length
      : rootConfidence(root) ?? 0;

  const rawText = toText(root.rawText ?? root.text ?? root.content ?? root['النص']);
  return {
    supplierName,
    supplierTaxNumber,
    invoiceNumber,
    invoiceDate,
    subtotal,
    taxAmount,
    total: totalAmount,
    currency,
    lines,
    confidenceByField,
    confidence: Math.max(0, Math.min(1, confidence)),
    rawText: rawText ? rawText.slice(0, 20_000) : null,
  };
}

export type ConfidenceBand = 'high' | 'medium' | 'low';

/** UI colours: green >90%, yellow 70–90% inclusive, red below 70%. */
export function confidenceBand(value: number | null | undefined): ConfidenceBand {
  const score = value ?? 0;
  if (score > 0.9) return 'high';
  if (score >= 0.7) return 'medium';
  return 'low';
}
