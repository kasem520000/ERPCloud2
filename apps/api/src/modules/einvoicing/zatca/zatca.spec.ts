import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildQrPayload, decodeQrPayload, hashInvoiceXml, signInvoiceHash } from './qr.js';
import { GENESIS_PIH, buildInvoiceXml, type ZatcaInvoiceInput } from './ubl.js';

const seller = { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', vatNo: '310000000000003', crNo: '1010000000', city: 'الرياض', street: 'طريق الملك فهد', buildingNumber: '1234', postalZone: '12345' };

function invoice(overrides: Partial<ZatcaInvoiceInput> = {}): ZatcaInvoiceInput {
  return {
    number: 'SI-000006',
    uuid: '01a08321-4d23-75f1-8716-8f4ffa0935db',
    issuedAt: new Date('2026-09-07T10:15:30.000Z'),
    kind: 'sale',
    profile: 'simplified',
    currency: 'SAR',
    seller,
    lines: [
      { lineNo: 1, name: 'أرز بسمتي ٥ كجم', unitCode: 'PCE', quantity: '12', unitPrice: '27.5', net: '330', discount: '0', tax: '49.5', taxRate: '15' },
      { lineNo: 2, name: 'زيت ذرة', unitCode: 'PCE', quantity: '2', unitPrice: '20', net: '40', discount: '0', tax: '0', taxRate: '0' },
    ],
    invoiceDiscount: '0',
    subtotal: '370',
    taxTotal: '49.5',
    total: '419.5',
    paymentMeansCode: '10',
    counter: 1,
    previousHash: GENESIS_PIH,
    ...overrides,
  };
}

describe('ZATCA UBL document', () => {
  it('carries the elements the authority validates on', () => {
    const xml = buildInvoiceXml(invoice());
    expect(xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(xml).toContain('<cbc:ID>SI-000006</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-09-07</cbc:IssueDate>');
    expect(xml).toContain('<cbc:IssueTime>10:15:30</cbc:IssueTime>');
    // 0200000 = simplified (B2C); 388 = tax invoice.
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:CompanyID>310000000000003</cbc:CompanyID>');
    expect(xml).toContain('<cbc:ID schemeID="CRN">1010000000</cbc:ID>');
    expect(xml).toContain('<cbc:UUID>1</cbc:UUID>'); // ICV
    expect(xml).toContain(GENESIS_PIH); // PIH
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">419.50</cbc:PayableAmount>');
  });

  it('declares one tax subtotal per rate', () => {
    const xml = buildInvoiceXml(invoice());
    const subtotals = xml.match(/<cac:TaxSubtotal>/g) ?? [];
    expect(subtotals).toHaveLength(2);
    expect(xml).toContain('<cbc:Percent>15.00</cbc:Percent>');
    expect(xml).toContain('<cbc:Percent>0.00</cbc:Percent>');
    expect(xml).toContain('<cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">Z</cbc:ID>'); // zero-rated line
  });

  it('marks a buyer with a VAT number as a standard invoice and a credit note as 381', () => {
    const xml = buildInvoiceXml(invoice({ profile: 'standard', kind: 'return', referenceNumber: 'SI-000006', buyer: { nameAr: 'مؤسسة النخبة', vatNo: '310000000000012' } }));
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cac:BillingReference>');
    expect(xml).toContain('310000000000012');
  });

  it('closes the monetary arithmetic when a document discount is applied', () => {
    const xml = buildInvoiceXml(invoice({ invoiceDiscount: '20', subtotal: '370', total: '399.50' }));
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="SAR">370.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="SAR">350.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">20.00</cbc:AllowanceTotalAmount>');
  });

  it('escapes values instead of breaking the document', () => {
    const xml = buildInvoiceXml(invoice({ lines: [{ lineNo: 1, name: 'صنف <"&"> غريب', unitCode: 'PCE', quantity: '1', unitPrice: '1', net: '1', discount: '0', tax: '0', taxRate: '0' }] }));
    expect(xml).toContain('صنف &lt;&quot;&amp;&quot;&gt; غريب');
    expect(xml).not.toContain('<"&">');
  });

  it('is stable: the same invoice hashes to the same value', () => {
    expect(hashInvoiceXml(buildInvoiceXml(invoice()))).toBe(hashInvoiceXml(buildInvoiceXml(invoice())));
    expect(hashInvoiceXml(buildInvoiceXml(invoice()))).not.toBe(hashInvoiceXml(buildInvoiceXml(invoice({ total: '420.00' }))));
    expect(hashInvoiceXml('x')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(hashInvoiceXml('x'), 'base64')).toHaveLength(32);
  });
});

describe('ZATCA QR', () => {
  it('encodes the five phase-1 tags as TLV', () => {
    const payload = buildQrPayload({ sellerName: 'مؤسسة الأفق للتجارة', vatNo: '310000000000003', timestamp: '2026-09-07T10:15:30Z', grandTotal: '419.50', vatTotal: '49.50' });
    const tags = decodeQrPayload(payload);
    expect(tags.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(tags[0]!.value.toString('utf8')).toBe('مؤسسة الأفق للتجارة');
    expect(tags[1]!.value.toString('utf8')).toBe('310000000000003');
    expect(tags[2]!.value.toString('utf8')).toBe('2026-09-07T10:15:30Z');
    expect(tags[3]!.value.toString('utf8')).toBe('419.50');
    expect(tags[4]!.value.toString('utf8')).toBe('49.50');
  });

  it('adds the phase-2 tags only when the invoice was actually signed', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const hash = hashInvoiceXml(buildInvoiceXml(invoice()));
    const signed = signInvoiceHash(hash, pem);
    expect(signed).not.toBeNull();
    expect(signed!.curve).toBe('secp256k1');

    const unsigned = decodeQrPayload(buildQrPayload({ sellerName: 'A', vatNo: '1', timestamp: 't', grandTotal: '1', vatTotal: '0' }));
    expect(unsigned.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5]);

    const withSignature = decodeQrPayload(
      buildQrPayload({ sellerName: 'A', vatNo: '1', timestamp: 't', grandTotal: '1', vatTotal: '0', invoiceHash: hash, signature: signed!.signature, publicKeyDer: signed!.publicKeyDer }),
    );
    expect(withSignature.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(withSignature[5]!.value.toString('utf8')).toBe(hash);
  });

  it('refuses to sign with a key that is missing, malformed or not an EC key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(signInvoiceHash('hash', 'not a key')).toBeNull();
    expect(signInvoiceHash('hash', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toBeNull();
  });
});
