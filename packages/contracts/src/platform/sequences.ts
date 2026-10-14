/**
 * Document numbering — DATABASE_DESIGN §3 (`document_sequences`), BL-1.
 *
 * `docType` is the business document a number is allocated for. The list is frozen
 * forward-only: a later phase adds its own type here, never a bare string literal, so
 * that "which sequences exist" is answerable from the contract package alone.
 */

export const documentTypes = {
  JOURNAL_ENTRY: 'journal_entry',
  SALES_INVOICE: 'sales_invoice',
  SALES_RETURN: 'sales_return',
  PURCHASE_INVOICE: 'purchase_invoice',
  PURCHASE_RETURN: 'purchase_return',
  RECEIPT_VOUCHER: 'receipt_voucher',
  PAYMENT_VOUCHER: 'payment_voucher',
  STOCK_ADJUSTMENT: 'stock_adjustment',
  STOCK_TRANSFER: 'stock_transfer',
  PARTY: 'party',
  OFFER: 'offer',
} as const;

export type DocumentType = (typeof documentTypes)[keyof typeof documentTypes];

export const DOCUMENT_TYPES: readonly string[] = Object.values(documentTypes);

export function isDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPES.includes(value);
}

/** One allocation from `Sequences.next()`. */
export type SequenceAllocation = {
  /** Monotonic counter value inside the scope (tenant, branch, docType, fiscalYear). */
  value: number;
  /** `prefix` + zero-padded `value`, e.g. `INV-000042`. */
  display: string;
  prefix: string;
  padding: number;
};

/**
 * Formats an allocation for display. Kept in the contract package because the admin UI
 * previews numbering settings without calling the API (ADMIN_PANEL §1, "Sequences /
 * numbering admin").
 */
export function formatSequenceNumber(value: number, prefix = '', padding = 6): string {
  const digits = String(value);
  return `${prefix}${digits.length >= padding ? digits : digits.padStart(padding, '0')}`;
}
