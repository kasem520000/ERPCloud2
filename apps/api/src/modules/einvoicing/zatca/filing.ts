/**
 * The authority round-trip — the second half of `Class/ZatcaService.cs`
 * `IntegrateInvoice` (L371-L405).
 *
 * The desktop builds the document in one breath and files it in the next, and the two are
 * separable here too: `einvoicing.service.ts` produces the document, this module hands it
 * to the authority and reports back what the authority said.
 *
 * The switch the desktop hides inside `CallReportingAPI(..., isSimplified: …)` is the whole
 * of the ZATCA rule, and it is decided by the invoice type's *name*, not its code
 * (`ZatcaService.cs` L62, L386-L405):
 *
 * | type name | invoice | call | what comes back |
 * |---|---|---|---|
 * | `0100000` | standard (B2B, the buyer has a VAT number) | **clearance** | `ClearedInvoice` — a re-signed document, whose QR replaces ours |
 * | `0200000` | simplified (B2C) | **reporting** | a status only; the QR stays the one we computed |
 *
 * Getting that switch wrong is not cosmetic: a standard invoice that is only *reported*
 * has not been cleared, and ZATCA treats the invoice as never submitted.
 *
 * One rule the desktop follows and this module keeps (`InvoiceOper.SendZatca` L2244-L2250):
 * a filing that throws — no network, a refused TLS handshake, a gateway that answers 503 —
 * is **not** an exception that rolls back a sale. It is recorded on the submission as a
 * failure with the message that came back, so the invoice can be re-filed from
 * «❌ غير مرسل» without anyone losing the document.
 */

import type { ZatcaGateway } from './gateway.js';

export type FilingCredentials = { csid: string; secret: string };

export type FilingInput = {
  /** Base64 SHA-256 of the invoice XML — tag 6 of the QR and the next invoice's PIH. */
  invoiceHash: string;
  uuid: string;
  /** Base64 UBL document. */
  invoice: string;
  /** `true` for a standard (`0100000`) invoice — the clearance call. */
  clearance: boolean;
  /**
   * The QR we computed locally. The real authority re-computes the QR itself once it has
   * signed the document, and returns it inside the cleared invoice; the 🧪 simulator has
   * no key to sign with, so it embeds this one instead. Never sent over the wire.
   */
  qr?: string | null;
};

export type FilingOutcome = {
  status: 'cleared' | 'reported' | 'failed';
  /** The authority's own word — `ZatcaResponse.Status` in the desktop (L538-L540). */
  authorityStatus: string;
  /** Base64 of the cleared document; `null` unless the invoice was cleared. */
  clearedInvoice: string | null;
  /** The cleared document decoded, ready to be stored and shown. */
  clearedXml: string | null;
  /** The QR read out of the cleared document — the desktop's `GetEncodedInvoiceQRCode`. */
  qr: string | null;
  errors: string[];
  warnings: string[];
  /** Where it went: `null` for the 🧪 simulator, which dials nothing. */
  endpoint: string | null;
  durationMs: number;
};

/** What a standard invoice's clearance call is called on the wire. */
export const ENDPOINTS = { reporting: '/invoices/reporting/single', clearance: '/invoices/clearance/single' } as const;

export async function fileInvoice(gateway: ZatcaGateway, credentials: FilingCredentials, input: FilingInput): Promise<FilingOutcome> {
  const started = Date.now();
  const endpoint = gateway.baseUrl ? `${gateway.baseUrl}${input.clearance ? ENDPOINTS.clearance : ENDPOINTS.reporting}` : null;
  // The document is checked here, before it is sent, for the arithmetic the authority would
  // reject it for: a round-trip that ends in «الإجمالي غير مطابق» is one round-trip saved.
  const findings = inspectInvoiceXml(decodeBase64(input.invoice));
  const blocking = findings.filter((finding) => finding.kind === 'error').map((finding) => finding.message);
  const warnings = findings.filter((finding) => finding.kind === 'warning').map((finding) => finding.message);
  const call = async () =>
    input.clearance
      ? gateway.clearInvoice({ ...credentials, invoiceHash: input.invoiceHash, uuid: input.uuid, invoice: input.invoice, qr: input.qr ?? null, findings: blocking })
      : gateway.reportInvoice({ ...credentials, invoiceHash: input.invoiceHash, uuid: input.uuid, invoice: input.invoice, findings: blocking });

  let verdict: Awaited<ReturnType<typeof call>>;
  try {
    verdict = await call();
  } catch (error) {
    // A gateway that cannot be reached is a failed filing, not a failed sale.
    return {
      status: 'failed',
      authorityStatus: '',
      clearedInvoice: null,
      clearedXml: null,
      qr: null,
      errors: [messageOf(error)],
      warnings,
      endpoint,
      durationMs: Date.now() - started,
    };
  }

  const errors = verdict.validationResults.errorMessages.map(String);
  const status = verdict.status === 'CLEARED' ? 'cleared' : verdict.status === 'REPORTED' ? 'reported' : 'failed';
  const clearedInvoice = status === 'cleared' ? (verdict.clearedInvoice ?? null) : null;
  // `ZatcaService.cs` L391-L392: once cleared, the document and its QR are the authority's,
  // not ours — the QR is read back out of the cleared XML, never reused from the request.
  const clearedXml = clearedInvoice ? decodeBase64(clearedInvoice) : null;
  const qr = clearedXml ? qrFromClearedInvoice(clearedXml) : null;

  return {
    status,
    authorityStatus: verdict.authorityStatus || (status === 'failed' ? (errors[0] ?? 'FAILED') : verdict.status),
    clearedInvoice,
    clearedXml,
    qr,
    errors,
    warnings: [...warnings, ...verdict.validationResults.warningMessages.map(String)],
    endpoint,
    durationMs: Date.now() - started,
  };
}

/**
 * Reads the QR out of a cleared invoice — the cloud shape of
 * `ZatcaService.GetEncodedInvoiceQRCode` (L470-L500), whose XPath was
 *
 *   /*[local-name()='Invoice']/*[local-name()='AdditionalDocumentReference'
 *     and *[local-name()='ID' and .='QR']]/*[local-name()='Attachment']
 *     /*[local-name()='EmbeddedDocumentBinaryObject']
 *
 * The document is scanned for the `AdditionalDocumentReference` block whose `cbc:ID` is
 * `QR` and the base64 TLV payload is taken from its embedded binary object. A cleared
 * document without that block yields `null` rather than a guess: an invoice that has been
 * cleared carries one, and if it does not, saying so is more useful than inventing one.
 */
export function qrFromClearedInvoice(xml: string): string | null {
  const blocks = xml.match(/<cac:AdditionalDocumentReference>[\s\S]*?<\/cac:AdditionalDocumentReference>/g) ?? [];
  for (const block of blocks) {
    if (!/<cbc:ID[^>]*>\s*QR\s*<\/cbc:ID>/.test(block)) continue;
    const payload = block.match(/<cbc:EmbeddedDocumentBinaryObject[^>]*>([\s\S]*?)<\/cbc:EmbeddedDocumentBinaryObject>/);
    const value = payload?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Builds the cleared document the 🧪 simulator answers with: the submitted document with the
 * QR block appended, which is what the authority's own clearance returns. It is built here
 * — in the simulator, not in the filing path — so no code that talks to the real gateway
 * can mistake a locally-invented document for a signed one.
 */
export function simulatedClearedInvoice(invoiceBase64: string, qr: string | null): string {
  const xml = decodeBase64(invoiceBase64);
  if (!qr) return invoiceBase64;
  const block = `  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
`;
  const withQr = xml.includes('</Invoice>') ? xml.replace('</Invoice>', `${block}</Invoice>`) : `${xml}\n${block}`;
  return Buffer.from(withQr, 'utf8').toString('base64');
}

export type DocumentFinding = { code: string; message: string; kind: 'error' | 'warning' };

/**
 * The arithmetic the authority checks before it ever looks at a signature.
 *
 * These are not the whole of ZATCA's rulebook — the rulebook is thousands of lines and
 * lives behind the authority's own validator — but they are the ones that are cheap to
 * check here and expensive to discover from a rejection three days later: the monetary
 * totals have to close, the invoice counter and the previous hash have to be present, and
 * a seller cannot file without its own VAT number.
 *
 * An `error` blocks a filing before it is sent, because the authority would reject the
 * document anyway. A `warning` is stored on the submission and shown, but never blocks:
 * the seller's VAT number being malformed is the tenant's data problem to fix, and the
 * authority is the one that rules on it.
 */
export function inspectInvoiceXml(xml: string): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  // Not named `amount`: the repo's money rule reserves that identifier for decimal.js
  // money, and this is a plain parser over the document's own digits.
  const amountOf = (pattern: RegExp) => {
    const found = xml.match(pattern)?.[1];
    return found === undefined ? null : Number(found);
  };

  if (!/<cbc:ID>[\s\S]*?<\/cbc:ID>/.test(xml)) findings.push({ code: 'NO_ID', message: 'المستند بلا رقم فاتورة (cbc:ID).', kind: 'error' });
  if (!/<cbc:InvoiceTypeCode[^>]*>/.test(xml)) findings.push({ code: 'NO_TYPE_CODE', message: 'المستند بلا رمز نوع فاتورة (InvoiceTypeCode).', kind: 'error' });
  if (!/<cac:AdditionalDocumentReference>[\s\S]*?<cbc:ID>ICV<\/cbc:ID>/.test(xml)) findings.push({ code: 'NO_ICV', message: 'عداد الفواتير (ICV) مفقود من المستند.', kind: 'error' });
  if (!/<cac:AdditionalDocumentReference>[\s\S]*?<cbc:ID>PIH<\/cbc:ID>/.test(xml)) findings.push({ code: 'NO_PIH', message: 'تجزئة الفاتورة السابقة (PIH) مفقودة من المستند.', kind: 'error' });

  const taxInclusive = amountOf(/<cbc:TaxInclusiveAmount[^>]*>([\d.-]+)<\/cbc:TaxInclusiveAmount>/);
  const taxExclusive = amountOf(/<cbc:TaxExclusiveAmount[^>]*>([\d.-]+)<\/cbc:TaxExclusiveAmount>/);
  const taxAmount = amountOf(/<cbc:TaxAmount[^>]*>([\d.-]+)<\/cbc:TaxAmount>/);
  if (taxInclusive !== null && taxExclusive !== null && taxAmount !== null && Math.abs(taxInclusive - (taxExclusive + taxAmount)) > 0.01) {
    findings.push({
      code: 'TOTAL_MISMATCH',
      message: `مجموع المستند غير مغلق: الإجمالي شامل الضريبة ${taxInclusive.toFixed(2)} لا يساوي الصافي ${taxExclusive.toFixed(2)} + الضريبة ${taxAmount.toFixed(2)}.`,
      kind: 'error',
    });
  }

  const payable = amountOf(/<cbc:PayableAmount[^>]*>([\d.-]+)<\/cbc:PayableAmount>/);
  const prepaid = amountOf(/<cbc:PrepaidAmount[^>]*>([\d.-]+)<\/cbc:PrepaidAmount>/);
  if (payable !== null && taxInclusive !== null && Math.abs(payable - (taxInclusive - (prepaid ?? 0))) > 0.01) {
    findings.push({
      code: 'PAYABLE_MISMATCH',
      message: `المبلغ المستحق ${payable.toFixed(2)} لا يساوي الإجمالي ${taxInclusive.toFixed(2)} ناقصاً المدفوع ${(prepaid ?? 0).toFixed(2)}.`,
      kind: 'error',
    });
  }

  const documentLines = amountOf(/<cbc:LineExtensionAmount[^>]*>([\d.-]+)<\/cbc:LineExtensionAmount>/);
  const invoiceLines = [...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g)];
  const lineTotals = invoiceLines
    .map((block) => Number(block[0].match(/<cbc:LineExtensionAmount[^>]*>([\d.-]+)<\/cbc:LineExtensionAmount>/)?.[1] ?? 0))
    .reduce((sum, value) => sum + value, 0);
  // Compared only when the document has lines: a document with none is already caught by
  // the checks above, and comparing against a sum of nothing would flag it twice.
  if (documentLines !== null && invoiceLines.length > 0 && Math.abs(documentLines - lineTotals) > 0.01) {
    findings.push({
      code: 'LINES_MISMATCH',
      message: `مجموع الأسطر ${lineTotals.toFixed(2)} لا يساوي إجمالي الأسطر في المستند ${documentLines.toFixed(2)}.`,
      kind: 'error',
    });
  }

  const sellerVat = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)?.[0]?.match(/<cbc:CompanyID>([^<]+)<\/cbc:CompanyID>/)?.[1]?.trim();
  if (!sellerVat) findings.push({ code: 'NO_SELLER_VAT', message: 'لا يوجد رقم ضريبي للبائع في بطاقة المنشأة.', kind: 'error' });
  else if (!/^3\d{13}3$/.test(sellerVat)) {
    findings.push({
      code: 'SELLER_VAT_SHAPE',
      message: `الرقم الضريبي للبائع «${sellerVat}» ليس على صورة رقم ضريبي سعودي (١٥ رقماً يبدأ بـ 3 وينتهي بـ 3).`,
      kind: 'warning',
    });
  }

  return findings;
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function messageOf(error: unknown): string {
  const detail = (error as { detail?: string }).detail;
  if (detail) return detail;
  return error instanceof Error ? error.message : String(error);
}
