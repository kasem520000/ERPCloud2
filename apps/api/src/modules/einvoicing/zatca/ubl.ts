/**
 * ZATCA UBL 2.1 invoice XML.
 *
 * The Saudi e-invoicing rules do not accept "an XML with the totals in it" — they accept a
 * UBL 2.1 `Invoice` with a prescribed set of elements in a prescribed order: the seller and
 * buyer parties with their VAT registrations, an invoice-counter value, the hash of the
 * previous invoice, one `cac:TaxSubtotal` per VAT vatRate, and `cac:LegalMonetaryTotal` whose
 * arithmetic has to close. This module builds exactly that document from our own tables.
 *
 * What is deliberately *not* here: the XAdES enveloped signature and the `UBLExtensions`
 * block that carries it. That step needs a production CSID issued by ZATCA against a CSR
 * generated on the customer's own device; until the tenant uploads one there is nothing to
 * sign with, and shipping a fake signature would be worse than shipping none. Everything the
 * signature wraps — the document, its hash and the QR — is produced here and is real.
 */

import { Decimal } from 'decimal.js';

export type ZatcaParty = {
  nameAr: string;
  nameEn?: string;
  vatNo?: string;
  crNo?: string;
  street?: string;
  buildingNumber?: string;
  district?: string;
  city?: string;
  postalZone?: string;
  countryCode?: string;
};

export type ZatcaLine = {
  lineNo: number;
  name: string;
  unitCode: string;
  quantity: string;
  unitPrice: string;
  /** Line value after its own discount and before VAT. */
  net: string;
  discount: string;
  tax: string;
  taxRate: string;
};

export type ZatcaInvoiceInput = {
  /** Human document number — `cbc:ID`. Must be unique and gap-free per ZATCA. */
  number: string;
  uuid: string;
  /** UTC instant the invoice was issued. */
  issuedAt: Date;
  /** `sale` → tax invoice, `return` → credit note. */
  kind: string;
  /** `standard` (B2B, buyer VAT required) or `simplified` (B2C, QR-driven). */
  profile: 'standard' | 'simplified';
  currency: string;
  seller: ZatcaParty;
  buyer?: ZatcaParty;
  lines: ZatcaLine[];
  /** Document-level discount, already excluded from the line nets. */
  invoiceDiscount: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  paymentMeansCode: string;
  /** Invoice counter value: 1 for the first invoice of the chain, +1 each time. */
  counter: number;
  /** Base64 SHA-256 of the previous invoice; the genesis value is the hash of "0". */
  previousHash: string;
  /** Number of the invoice being corrected — mandatory on a credit note. */
  referenceNumber?: string;
};

/** ZATCA's genesis PIH: base64 SHA-256 of the single character "0". */
export const GENESIS_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/**
 * The invoice type code, and — above it — the desktop's own vocabulary.
 *
 * `ZatcaService.IntegrateInvoice` (L62-L95) decides between 388 (tax invoice), 381 (credit
 * note) and 383 (debit note) from the invoice's type and `ProcType`, where a *return*
 * (`ProcType == 2`) of a sale is a credit note and a debit note is its own kind (`21`).
 * Our kinds are named rather than numbered, so both spellings of each are listed: the
 * legacy `return`/`debit` and the kinds the sales module actually writes
 * (`sale_return`, `credit_note`, `debit_note`). A kind that is not listed is a tax
 * invoice, which is what the desktop defaults to (`value = "388"`).
 */
const INVOICE_TYPE_CODES: Record<string, string> = {
  sale: '388',
  contracting: '388',
  return: '381',
  sale_return: '381',
  credit_note: '381',
  debit: '383',
  debit_note: '383',
};

/**
 * `ZatcaService.cs` L113-L130: the payment instruction says *why* the money moved —
 * ` Refund.` on a returned sale and ` EditPrice.` on a debit note. Purely descriptive, and
 * part of the document the authority receives, so it is kept.
 */
const INSTRUCTION_NOTES: Record<string, string> = { '381': 'Refund.', '383': 'EditPrice.' };

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * AUD-17 — الحساب المالي في مستند الضريبة يمرّ بـ`Decimal` لا بـ`Number`.
 *
 * كان `Number(value).toFixed(2)` يقرّب *نصف القيمة* تقريبًا ثنائيًا، فيخرج
 * `15.075 → 15.07` و`2.675 → 2.67` و`1.0000005 → 1.000000`؛ أي هللةً ناقصة في
 * `cbc:TaxAmount` لمستندٍ رسمي (ضريبة 15% على 100.50 = 15.075) — وهي القيم التي
 * تُخزَّن أصلًا `numeric(18,4)`. التقريب الآن نصفٌ إلى الأعلى على العشريّ
 * (`ROUND_HALF_UP` = البُعد عن الصفر)، وهو تقريب ZATCA التجاري المعروف.
 */
function decimalOf(value: string | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return new Decimal(0);
  try {
    const parsed = new Decimal(text as string | number | Decimal);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** ZATCA compares amounts to two decimals; anything else is a validation warning. */
function amountOf(value: string | number | Decimal | null | undefined): string {
  return decimalOf(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function quantityOf(value: string | number | Decimal | null | undefined): string {
  // `toString()` already drops trailing zeros, keeping the previous output shape ("2", not "2.000000").
  return decimalOf(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toString();
}

function rateOf(value: string | number | Decimal | null | undefined): string {
  return decimalOf(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function postalAddress(party: ZatcaParty): string {
  return `<cac:PostalAddress>
        <cbc:StreetName>${escapeXml(party.street || 'N/A')}</cbc:StreetName>
        <cbc:BuildingNumber>${escapeXml(party.buildingNumber || '0000')}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${escapeXml(party.district || 'N/A')}</cbc:CitySubdivisionName>
        <cbc:CityName>${escapeXml(party.city || 'N/A')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(party.postalZone || '00000')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${escapeXml(party.countryCode || 'SA')}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;
}

function partyBlock(party: ZatcaParty): string {
  const identification = party.crNo
    ? `<cac:PartyIdentification><cbc:ID schemeID="CRN">${escapeXml(party.crNo)}</cbc:ID></cac:PartyIdentification>\n      `
    : '';
  const taxScheme = party.vatNo
    ? `<cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(party.vatNo)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>\n      `
    : '';
  return `<cac:Party>
      ${identification}${postalAddress(party)}
      ${taxScheme}<cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(party.nameEn || party.nameAr)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>`;
}

/** One `cac:TaxSubtotal` per VAT rate, which is how ZATCA wants mixed-rate invoices declared. */
function taxSubtotals(lines: ZatcaLine[], currency: string): string {
  const byRate = new Map<string, { taxable: Decimal; tax: Decimal }>();
  for (const line of lines) {
    const vatRate = rateOf(line.taxRate);
    const bucket = byRate.get(vatRate) ?? { taxable: new Decimal(0), tax: new Decimal(0) };
    bucket.taxable = bucket.taxable.plus(decimalOf(line.net));
    bucket.tax = bucket.tax.plus(decimalOf(line.tax));
    byRate.set(vatRate, bucket);
  }
  return [...byRate.entries()]
    .map(
      ([vatRate, bucket]) => `<cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currency)}">${amountOf(bucket.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${amountOf(bucket.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${decimalOf(vatRate).gt(0) ? 'S' : 'Z'}</cbc:ID>
        <cbc:Percent>${vatRate}</cbc:Percent>
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join('\n    ');
}

function invoiceLine(line: ZatcaLine, currency: string): string {
  const vatRate = rateOf(line.taxRate);
  const lineTotal = decimalOf(line.net).plus(decimalOf(line.tax));
  const discount = decimalOf(line.discount);
  return `<cac:InvoiceLine>
    <cbc:ID>${line.lineNo}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${escapeXml(line.unitCode || 'PCE')}">${quantityOf(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${amountOf(line.net)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${amountOf(line.tax)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${escapeXml(currency)}">${amountOf(lineTotal)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(line.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${decimalOf(vatRate).gt(0) ? 'S' : 'Z'}</cbc:ID>
        <cbc:Percent>${vatRate}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${escapeXml(currency)}">${amountOf(line.unitPrice)}</cbc:PriceAmount>
      ${
        discount.gt(0)
          ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="${escapeXml(currency)}">${amountOf(discount)}</cbc:Amount></cac:AllowanceCharge>`
          : ''
      }
    </cac:Price>
  </cac:InvoiceLine>`;
}

/**
 * Builds the UBL document. The element order matters: UBL's schema is sequenced, and ZATCA's
 * validator rejects a document whose children are shuffled even when every value is right.
 */
export function buildInvoiceXml(input: ZatcaInvoiceInput): string {
  const currency = input.currency || 'SAR';
  const issued = input.issuedAt.toISOString();
  const typeCode = INVOICE_TYPE_CODES[input.kind] ?? '388';
  // 01 = standard (B2B), 02 = simplified (B2C); the remaining five digits are transaction flags.
  const typeName = input.profile === 'standard' ? '0100000' : '0200000';
  // `cbc:PrepaidAmount` is always zero, and deliberately so: ZatcaIntegrationSDK.Invoice —
  // the desktop's own document model (`ZatcaService.cs` L60-L360) — has no prepayment field
  // at all, so the desktop's documents declare none. Writing the cash the till took in here
  // would be a second claim about the sale: BR-CO-16 requires PayableAmount to be
  // TaxInclusiveAmount − PrepaidAmount, so a fully-paid sale would then have to declare a
  // payable amount of zero. The settlement lives in the treasury and in the payment-means
  // code; the tax document states what is owed.
  const discount = decimalOf(input.invoiceDiscount);
  const instruction = INSTRUCTION_NOTES[typeCode];
  const instructionNote = instruction ? `<cbc:InstructionNote>${escapeXml(instruction)}</cbc:InstructionNote>` : '';
  const billingReference =
    typeCode !== '388' && input.referenceNumber
      ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(input.referenceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>\n  `
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(input.number)}</cbc:ID>
  <cbc:UUID>${escapeXml(input.uuid)}</cbc:UUID>
  <cbc:IssueDate>${issued.slice(0, 10)}</cbc:IssueDate>
  <cbc:IssueTime>${issued.slice(11, 19)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${typeName}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  ${billingReference}<cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${input.counter}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(input.previousHash || GENESIS_PIH)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    ${partyBlock(input.seller)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    ${partyBlock(input.buyer ?? { nameAr: 'عميل نقدي', nameEn: 'Cash customer' })}
  </cac:AccountingCustomerParty>
  <cac:Delivery><cbc:ActualDeliveryDate>${issued.slice(0, 10)}</cbc:ActualDeliveryDate></cac:Delivery>
  <cac:PaymentMeans><cbc:PaymentMeansCode>${escapeXml(input.paymentMeansCode || '10')}</cbc:PaymentMeansCode>${instructionNote}</cac:PaymentMeans>
  ${
    discount.gt(0)
      ? `<cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${escapeXml(currency)}">${amountOf(discount)}</cbc:Amount>
  </cac:AllowanceCharge>\n  `
      : ''
  }<cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${amountOf(input.taxTotal)}</cbc:TaxAmount>
    ${taxSubtotals(input.lines, currency)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${amountOf(input.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${amountOf(decimalOf(input.subtotal).minus(discount))}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${amountOf(input.total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${escapeXml(currency)}">${amountOf(discount)}</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="${escapeXml(currency)}">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${amountOf(input.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${input.lines.map((line) => invoiceLine(line, currency)).join('\n  ')}
</Invoice>`;
}
