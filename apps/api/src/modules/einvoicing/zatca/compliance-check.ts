import { createHash } from 'node:crypto';

import { GENESIS_PIH, buildInvoiceXml, type ZatcaParty } from './ubl.js';

/**
 * «🧪 اختبار الربط — Test Compliance» — the six documents ZATCA wants proved before it will
 * let a taxpayer file.
 *
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml.cs` L397-L437 runs them in this
 * order and stops at the first failure, showing
 * `"{checkName} compliance check failed.\n{response.ResponseObject}"`; on success the window
 * shows «تم بنجاح». The matrix is reproduced exactly, including the two switches that decide
 * the type code: `value = ProcType != 2 ? "388" : "381"` then `if (isDebit) value = "383"`,
 * and `name = IsSimplified ? "0200000" : "0100000"` (L735-L737).
 *
 * The sample document is the desktop's own (L617-L650): UUID
 * `8d487816-70b8-4ade-a618-9d620b73814a`, PIH = the genesis hash, one line «قلم رصاص» × 2 at
 * 2.00, VAT 15%, so 4.00 + 0.60 = 4.60, paid by `PayType 1` → payment means `10`, sold to
 * «Acme Widget's LTD 2» (VAT 311111111111113, Jeddah). Only the seller changes: it is the
 * tenant's own company card, because that is whose compliance is being tested.
 */

export type ComplianceExpectation = {
  key: string;
  /** The desktop's own English name, kept for the failure line it prints. */
  labelEn: string;
  labelAr: string;
  kind: 'sale' | 'debit' | 'return';
  profile: 'standard' | 'simplified';
  /** `cbc:InvoiceTypeCode` value — 388 invoice · 381 credit · 383 debit. */
  invoiceTypeCode: string;
  /** `cbc:InvoiceTypeCode/@name` — 0100000 standard · 0200000 simplified. */
  typeName: string;
  /** Standard invoices are cleared; simplified ones are reported. */
  clearance: boolean;
};

export const COMPLIANCE_MATRIX: ComplianceExpectation[] = [
  { key: 'standard-invoice', labelEn: 'Standard Invoice', labelAr: 'فاتورة ضريبية', kind: 'sale', profile: 'standard', invoiceTypeCode: '388', typeName: '0100000', clearance: true },
  { key: 'standard-debit-note', labelEn: 'Standard Debit Note', labelAr: 'إشعار مدين', kind: 'debit', profile: 'standard', invoiceTypeCode: '383', typeName: '0100000', clearance: true },
  { key: 'standard-credit-note', labelEn: 'Standard Credit Note', labelAr: 'إشعار دائن', kind: 'return', profile: 'standard', invoiceTypeCode: '381', typeName: '0100000', clearance: true },
  { key: 'simplified-invoice', labelEn: 'Simplified Invoice', labelAr: 'فاتورة مبسطة', kind: 'sale', profile: 'simplified', invoiceTypeCode: '388', typeName: '0200000', clearance: false },
  { key: 'simplified-debit-note', labelEn: 'Simplified Debit Note', labelAr: 'إشعار مدين مبسط', kind: 'debit', profile: 'simplified', invoiceTypeCode: '383', typeName: '0200000', clearance: false },
  { key: 'simplified-credit-note', labelEn: 'Simplified Credit Note', labelAr: 'إشعار دائن مبسط', kind: 'return', profile: 'simplified', invoiceTypeCode: '381', typeName: '0200000', clearance: false },
];

/** The desktop's test customer — the same one for all six cases (L636-L646). */
const SAMPLE_BUYER: ZatcaParty = {
  nameAr: "Acme Widget's LTD 2",
  nameEn: "Acme Widget's LTD 2",
  vatNo: '311111111111113',
  crNo: '4020000000',
  street: 'TST',
  buildingNumber: '1234',
  district: 'TST',
  city: 'Jeddah',
  postalZone: '1224',
  countryCode: 'SA',
};

/** The desktop's test line: «قلم رصاص» × 2 at 2.00, VAT 15% (L649-L657). */
const SAMPLE_LINE = { lineNo: 1, name: 'قلم رصاص', unitCode: 'PCE', quantity: '2', unitPrice: '2', net: '4', discount: '0', tax: '0.6', taxRate: '15' };

const SAMPLE_UUID = '8d487816-70b8-4ade-a618-9d620b73814a';
const SAMPLE_NUMBER = '1';

export type ComplianceDocument = {
  expectation: ComplianceExpectation;
  xml: string;
  hash: string;
  uuid: string;
  counter: number;
  /** Empty when the document is sound; otherwise the reasons it is not. */
  findings: string[];
};

export type ComplianceCheckRow = {
  key: string;
  labelEn: string;
  labelAr: string;
  invoiceTypeCode: string;
  typeName: string;
  profile: 'standard' | 'simplified';
  clearance: boolean;
  success: boolean;
  /** `CLEARED` · `REPORTED` · `FAILED`, the vocabulary of `frmZatcaSetting.xaml.cs` L918. */
  status: string;
  hash: string;
  messages: string[];
};

function amountBetween(xml: string, tag: string): number | null {
  const match = new RegExp(`<cbc:${tag}[^>]*>([-0-9.]+)</cbc:${tag}>`).exec(xml);
  return match ? Number(match[1]) : null;
}

/**
 * Builds one sample document and checks it.
 *
 * The findings are what a real authority would say about the document — the arithmetic has
 * to close, the buyer of a standard invoice has to carry a VAT registration, and a taxpayer
 * cannot be tested for compliance before declaring its own VAT number.
 */
export function buildComplianceDocument(expectation: ComplianceExpectation, seller: ZatcaParty, counter: number): ComplianceDocument {
  const issuedAt = new Date();
  const xml = buildInvoiceXml({
    number: SAMPLE_NUMBER,
    uuid: SAMPLE_UUID,
    issuedAt,
    kind: expectation.kind,
    profile: expectation.profile,
    currency: 'SAR',
    seller,
    buyer: expectation.profile === 'standard' ? SAMPLE_BUYER : { ...SAMPLE_BUYER, vatNo: undefined, crNo: undefined },
    lines: [SAMPLE_LINE],
    invoiceDiscount: '0',
    subtotal: '4',
    taxTotal: '0.6',
    total: '4.6',
    paymentMeansCode: '10',
    counter,
    previousHash: GENESIS_PIH,
    referenceNumber: expectation.kind === 'return' || expectation.kind === 'debit' ? SAMPLE_NUMBER : undefined,
  });

  const hash = createHash('sha256').update(xml, 'utf8').digest('base64');
  const findings: string[] = [];

  const typeCode = new RegExp(`<cbc:InvoiceTypeCode name="([^"]*)">([^<]*)</cbc:InvoiceTypeCode>`).exec(xml);
  if (typeCode?.[1] !== expectation.typeName || typeCode?.[2] !== expectation.invoiceTypeCode) {
    findings.push(`نوع الفاتورة ${typeCode?.[2] ?? '—'} / ${typeCode?.[1] ?? '—'} لا يطابق المطلوب ${expectation.invoiceTypeCode} / ${expectation.typeName}`);
  }
  if (!xml.includes(`<cbc:UUID>${SAMPLE_UUID}</cbc:UUID>`)) findings.push('معرّف الفاتورة (UUID) مفقود');
  if (!xml.includes(GENESIS_PIH)) findings.push('تجزئة الفاتورة السابقة (PIH) مفقودة');
  if (!new RegExp(`<cbc:ID>ICV</cbc:ID>\\s*<cbc:UUID>${counter}</cbc:UUID>`).test(xml)) findings.push('الرقم التسلسلي للفاتورة (ICV) مفقود');

  const lineExtension = amountBetween(xml, 'LineExtensionAmount');
  const taxAmount = amountBetween(xml, 'TaxAmount');
  const taxInclusive = amountBetween(xml, 'TaxInclusiveAmount');
  if (lineExtension === null || taxAmount === null || taxInclusive === null) {
    findings.push('مجاميع الفاتورة (LegalMonetaryTotal) غير مكتملة');
  } else if (Math.abs(lineExtension + taxAmount - taxInclusive) > 0.01) {
    findings.push(`المجموع لا يغلق: ${lineExtension.toFixed(2)} + ${taxAmount.toFixed(2)} ≠ ${taxInclusive.toFixed(2)}`);
  }

  if (!seller.vatNo) findings.push('الرقم الضريبي للمنشأة غير معبأ في بطاقة المنشأة');
  if (expectation.profile === 'standard' && !xml.includes('311111111111113')) {
    findings.push('الفاتورة الضريبية تتطلب رقم ضريبي للعميل');
  }

  return { expectation, xml, hash, uuid: SAMPLE_UUID, counter, findings };
}

/** The six rows, in the desktop's order, before the authority is asked. */
export function buildComplianceDocuments(seller: ZatcaParty, startCounter = 1): ComplianceDocument[] {
  return COMPLIANCE_MATRIX.map((expectation, index) => buildComplianceDocument(expectation, seller, startCounter + index));
}

export function rowOf(document: ComplianceDocument, verdict: { status: string; validationResults: string[] }): ComplianceCheckRow {
  return {
    key: document.expectation.key,
    labelEn: document.expectation.labelEn,
    labelAr: document.expectation.labelAr,
    invoiceTypeCode: document.expectation.invoiceTypeCode,
    typeName: document.expectation.typeName,
    profile: document.expectation.profile,
    clearance: document.expectation.clearance,
    success: verdict.status === 'CLEARED' || verdict.status === 'REPORTED',
    status: verdict.status,
    hash: document.hash,
    messages: verdict.validationResults.length > 0 ? verdict.validationResults : document.findings,
  };
}

/** The desktop's failure line, kept word for word: `"{name} compliance check failed."`. */
export function failureLine(row: ComplianceCheckRow): string {
  return `${row.labelEn} compliance check failed.`;
}
