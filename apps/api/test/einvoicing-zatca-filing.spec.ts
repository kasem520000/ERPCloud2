import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inspectInvoiceXml, qrFromClearedInvoice } from '../src/modules/einvoicing/zatca/filing.js';
import { decodeQrPayload } from '../src/modules/einvoicing/zatca/qr.js';
import { GENESIS_PIH } from '../src/modules/einvoicing/zatca/ubl.js';
import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🧾 الإرسال والتوقيع والسلسلة — the second half of `Class/ZatcaService.cs`
 * `IntegrateInvoice` (L371-L405) and `Class/InvoiceOper.cs` `SendZatca` (L2213-L2250).
 *
 * What is proved here, in the order the desktop does it:
 *
 * 1. the switch that decides an invoice's fate — `0100000` is **cleared** and comes back as
 *    a re-signed document whose QR replaces ours; `0200000` is **reported** and keeps ours;
 * 2. the QR carries the eight tags, and tag 6 is the hash that chains the next invoice;
 * 3. the chain: the second invoice's PIH is the first invoice's hash, and the counter moves
 *    by exactly one per filing, never by two;
 * 4. a credit note is a 381 that names the invoice it corrects;
 * 5. a gateway that cannot be reached is a *failed filing on a stored document* — not a
 *    lost sale and not a 500 — and إعادة الإرسال re-files that same document, hash included;
 * 6. ⏸ إيقاف الربط stops the filing where it stands, and a second submit of an accepted
 *    invoice is refused instead of being filed twice.
 *
 * Everything runs against the 🧪 simulation gateway except the one test that deliberately
 * points the HTTP gateway at a closed port, so the suite never touches the authority.
 */
describe('zatca filing — الإرسال والتوقيع والسلسلة', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let other: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';
  let invoiceNumber = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, any>;
  const call = (method: 'get' | 'post' | 'put', path: string, options: { token: string; body?: unknown } = { token: '' }) => api(ctx.server, method, `/api/v1${path}`, options);

  async function postedInvoice(options: { partyId?: string; quantity?: string; cashCustomer?: string } = {}) {
    const invoice = await call('post', '/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: options.partyId,
        cashCustomerName: options.cashCustomer,
        lines: [{ itemId, quantity: options.quantity ?? '2', unitPrice: '27.5', taxRate: '15' }],
      },
    });
    const id = body(invoice).id;
    await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    if (!invoiceNumber) invoiceNumber = String(body(invoice).number ?? '');
    return id;
  }

  const submit = async (invoiceId: string, override?: Record<string, unknown>) => body(await call('post', `/sales-invoices/${invoiceId}/einvoice/submit`, { token: actor.token, body: override ?? {} }));

  beforeAll(async () => {
    ctx = await createTestApp('zatca-filing');
    const permissions = [
      ...ALL_PLATFORM_PERMISSIONS,
      ...ALL_ORGANIZATION_PERMISSIONS,
      'catalog.item.view',
      'catalog.item.manage',
      'catalog.unit.manage',
      'catalog.category.manage',
      'inventory.view',
      'inventory.adjust',
      'parties.view',
      'parties.manage',
      'sales.view',
      'sales.invoice.create',
      'sales.invoice.post',
      'sales.return.create',
      'accounting.period.close',
      'einvoice.view',
      'einvoice.manage',
      'einvoice.submit',
      'einvoice.credentials.manage',
    ];
    actor = await createActor(ctx, { tenantCode: 'zatcafil', email: 'owner@zatcafil.test', permissions });
    viewer = await createActor(ctx, { tenantCode: 'zatcafil', email: 'viewer@zatcafil.test', permissions: ['einvoice.view'] });
    other = await createActor(ctx, { tenantCode: 'zatcafil2', email: 'owner@zatcafil2.test', permissions });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    const year = new Date().getUTCFullYear();
    await call('post', '/fiscal-years', { token: actor.token, body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` } });
    warehouseId = body(await call('post', '/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع' } })).id;
    const unitId = body(await call('post', '/organization/catalog/units', { token: actor.token, body: { code: 'PCE', nameAr: 'حبة' } })).id;
    const categoryId = body(await call('post', '/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } })).id;
    itemId = body(await call('post', '/organization/catalog/items', { token: actor.token, body: { sku: 'RICE-5', nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' } })).id;
    partyId = body(await call('post', '/parties', { token: actor.token, body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012' } })).id;

    const profile = await call('put', '/company-profile', {
      token: actor.token,
      body: { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000', address: { street: 'طريق الملك فهد', building: '1234', district: 'العليا', city: 'الرياض', postal: '12345' } },
    });
    if (profile.status >= 300) throw new Error(`company profile: ${profile.status} ${JSON.stringify(profile.body)}`);
    await call('post', '/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000021' }] },
    });

    // The whole onboarding ladder, offline: 🧪 simulation answers every gateway call.
    const ladder: Array<[string, { status: number; body: Record<string, unknown> }]> = [];
    ladder.push(['settings', await call('put', '/einvoice/settings', { token: actor.token, body: { simulation: true, active: true, environment: 'compliance' } })]);
    ladder.push(['fill', await call('post', '/einvoice/settings/fill-from-company', { token: actor.token, body: {} })]);
    // 🏗️ Industry (النشاط التجاري) has no column on the cloud company card — the desktop
    // keeps it on the CSR properties row — so it is typed once here, as a user would.
    ladder.push(['industry', await call('put', '/einvoice/settings', { token: actor.token, body: { csr: { industry: 'تجارة التجزئة' } } })]);
    ladder.push(['csr', await call('post', '/einvoice/csr/generate', { token: actor.token, body: {} })]);
    ladder.push(['compliance', await call('post', '/einvoice/onboarding/compliance-csid', { token: actor.token, body: { otp: '311222' } })]);
    ladder.push(['production', await call('post', '/einvoice/onboarding/production-csid', { token: actor.token, body: {} })]);
    for (const [step, response] of ladder) {
      if (response.status >= 300) throw new Error(`onboarding ${step}: ${response.status} ${JSON.stringify(response.body)}`);
    }
  }, 240_000);

  afterAll(async () => ctx.close());

  it('reports a simplified invoice and keeps the QR it computed', async () => {
    const submission = await submit(await postedInvoice({ cashCustomer: 'عميل نقدي' }));
    expect(submission.status).toBe('reported');
    expect(submission.authorityStatus).toBe('REPORTED');
    expect(submission.response).toMatchObject({ submitted: true, clearance: false, profile: 'simplified', gateway: 'simulation', credential: 'production' });
    // 🧪 dials nothing, so there is no endpoint to report — and no cost to the filing.
    expect(submission.response.endpoint).toBeNull();
    expect(submission.attempts).toBe('1');
    expect(submission.requestPayload.xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    // A simplified invoice is never cleared: there is no document to come back.
    expect(submission.clearedInvoice).toBeNull();
  });

  it('clears a standard invoice and adopts the authority’s document and QR', async () => {
    const submission = await submit(await postedInvoice({ partyId }));
    expect(submission.status).toBe('cleared');
    expect(submission.authorityStatus).toBe('CLEARED');
    expect(submission.response).toMatchObject({ submitted: true, clearance: true, profile: 'standard' });
    expect(submission.requestPayload.xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');

    // `ZatcaService.cs` L390-L392: the cleared document replaces ours, and the QR is read
    // back out of it rather than reused from the request.
    const clearedXml = submission.requestPayload.clearedXml as string;
    expect(clearedXml).toContain('<cbc:ID>QR</cbc:ID>');
    expect(qrFromClearedInvoice(clearedXml)).toBe(submission.qrPayload);
    expect(submission.clearedInvoice).toBe(Buffer.from(clearedXml, 'utf8').toString('base64'));
  });

  it('signs the QR with all eight tags, and tag 6 is the invoice hash', async () => {
    const submission = await submit(await postedInvoice({ partyId }));
    const tags = decodeQrPayload(submission.qrPayload);
    expect(tags.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tags[0]!.value.toString('utf8')).toBe('مؤسسة الأفق للتجارة');
    expect(tags[1]!.value.toString('utf8')).toBe('310000000000003');
    expect(tags[5]!.value.toString('utf8')).toBe(submission.hash);
    // Tag 8 is the SPKI public key of the key that signed tag 7 — 91 bytes of secp256k1.
    expect(tags[7]!.value.length).toBeGreaterThan(80);
    const detail = body(await call('get', `/einvoice/filings/${submission.id}`, { token: actor.token }));
    expect(detail.qr.tags.map((tag: any) => tag.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(detail.qr.tags[5].labelAr).toContain('تجزئة الفاتورة');
  });

  it('chains each filing to the one before it and advances the counter by exactly one', async () => {
    const first = await submit(await postedInvoice({ partyId }));
    const second = await submit(await postedInvoice({ partyId }));
    expect(second.previousHash).toBe(first.hash);
    expect(second.chainIndex).toBe(first.chainIndex + 1);
    expect(second.requestPayload.xml).toContain(first.hash); // the PIH is inside the document

    const chain = body(await call('get', '/einvoice/chain', { token: actor.token }));
    expect(chain.counter).toBe(second.chainIndex);
    expect(chain.lastHash).toBe(second.hash);
    expect(chain.nextCounter).toBe(second.chainIndex + 1);
  });

  it('files a credit note as 381 and names the invoice it corrects', async () => {
    const originalId = await postedInvoice({ partyId, quantity: '3' });
    const original = body(await call('get', `/sales/invoices/${originalId}`, { token: actor.token }));
    const returnId = body(await call('post', `/sales/invoices/${originalId}/return`, {
      token: actor.token,
      body: { branchId, warehouseId, lines: [{ itemId, quantity: '1', unitPrice: '27.5', taxRate: '15' }] },
    })).id;
    await call('post', `/sales/invoices/${returnId}/post`, { token: actor.token, body: {} });

    const submission = await submit(returnId);
    expect(submission.requestPayload.xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(submission.requestPayload.xml).toContain(`<cbc:ID>${original.number}</cbc:ID>`); // ReffNo
    expect(submission.requestPayload.xml).toContain('<cbc:InstructionNote>Refund.</cbc:InstructionNote>');
    expect(submission.requestPayload.referenceNumber).toBe(original.number);
    expect(submission.status).toBe('cleared');
  });

  it('files a debit note as 383', async () => {
    const noteId = body(await call('post', '/sales/invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId, kind: 'debit_note', lines: [{ itemId, quantity: '1', unitPrice: '10', taxRate: '15' }] },
    })).id;
    await call('post', `/sales/invoices/${noteId}/post`, { token: actor.token, body: {} });
    const submission = await submit(noteId);
    expect(submission.requestPayload.xml).toContain('<cbc:InvoiceTypeCode name="0100000">383</cbc:InvoiceTypeCode>');
    expect(submission.requestPayload.xml).toContain('<cbc:InstructionNote>EditPrice.</cbc:InstructionNote>');
  });

  it('records an unreachable gateway as a failed filing on a stored document, then re-files it', async () => {
    const previous = process.env.ZATCA_API_BASE_URL;
    process.env.ZATCA_API_BASE_URL = 'http://127.0.0.1:9/';
    try {
      const failed = await submit(await postedInvoice({ cashCustomer: 'عميل نقدي' }), { environment: 'production' });
      // The document is prepared and signed before anything is dialled, so a dead gateway
      // costs the filing and nothing else: the XML, the hash and the QR are all still there.
      expect(failed.status).toBe('failed');
      expect(failed.attempts).toBe('1');
      expect(failed.response).toMatchObject({ submitted: true, gateway: 'http', clearance: false });
      expect(String(failed.response.endpoint)).toContain('/invoices/reporting/single');
      expect(String(failed.error)).not.toBe('');
      expect(failed.requestPayload.xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');

      // إعادة الإرسال re-files the *same* document: the hash must not move, or the chain
      // behind it stops matching what the authority was told.
      const retried = body(await call('post', `/einvoice/submissions/${failed.id}/retry`, { token: actor.token, body: {} }));
      expect(retried.status).toBe('reported');
      expect(retried.hash).toBe(failed.hash);
      expect(retried.requestPayload.xml).toBe(failed.requestPayload.xml);
      expect(retried.attempts).toBe('2');
    } finally {
      if (previous === undefined) delete process.env.ZATCA_API_BASE_URL;
      else process.env.ZATCA_API_BASE_URL = previous;
    }
  });

  it('refuses to re-file an invoice the authority already accepted', async () => {
    const submission = await submit(await postedInvoice({ cashCustomer: 'عميل نقدي' }));
    const retry = await call('post', `/einvoice/submissions/${submission.id}/retry`, { token: actor.token, body: {} });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('EINVOICE_ALREADY_ACCEPTED');

    const again = await call('post', `/sales-invoices/${submission.invoiceId}/einvoice/submit`, { token: actor.token, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EINVOICE_ALREADY_ACCEPTED');
  });

  it('stops at the document when the link is paused, and resumes when it is switched on', async () => {
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
    const paused = await submit(await postedInvoice({ cashCustomer: 'عميل نقدي' }));
    expect(paused.status).toBe('signed');
    expect(paused.response.reason).toBe('LINK_PAUSED');
    expect(paused.response.message).toContain('الربط موقوف');

    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
    const resumed = body(await call('post', `/einvoice/submissions/${paused.id}/retry`, { token: actor.token, body: {} }));
    expect(resumed.status).toBe('reported');
  });

  it('pages the uploaded invoices newest-first and shows one of them in full', async () => {
    const page = body(await call('get', '/einvoice/filings?pageNo=1&pageSize=3', { token: actor.token }));
    expect(page.items).toHaveLength(3);
    expect(page.pageNo).toBe(1);
    expect(page.pageSize).toBe(3);
    expect(page.total).toBeGreaterThanOrEqual(8);
    expect(page.pages).toBe(Math.ceil(page.total / 3));
    const times = page.items.map((row: any) => Date.parse(row.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The grid shows the invoice, not the submission — the desktop's own columns.
    for (const row of page.items) {
      expect(row.invoice.number).toMatch(/^[A-Z]{2}-\d+$/);
      expect(row.invoice.kind).toBeTruthy();
      expect(row.invoice.partyName).toBeTruthy(); // a named customer, or the cash customer
      expect(row.invoice.branchName).toBeTruthy();
      expect(row.invoice.createdByName).toBeTruthy(); // المُستخدم الذي أرسل
    }

    const detail = body(await call('get', `/einvoice/filings/${page.items[0].id}`, { token: actor.token }));
    expect(detail.document.xml).toContain('<cbc:UUID>');
    expect(detail.chain.previousHash).toBe(detail.submission.previousHash);
    expect(detail.invoice.kind).toBeTruthy();

    const filtered = body(await call('get', '/einvoice/filings?status=cleared&pageSize=50', { token: actor.token }));
    expect(filtered.items.every((row: any) => row.status === 'cleared')).toBe(true);
  });

  it('keeps one tenant’s filings out of another’s and separates reading from filing', async () => {
    const mine = body(await call('get', '/einvoice/filings?pageNo=1&pageSize=1', { token: actor.token }));
    const stolen = await call('get', `/einvoice/filings/${mine.items[0].id}`, { token: other.token });
    expect(stolen.status).toBe(404);
    expect(stolen.body.code).toBe('EINVOICE_SUBMISSION_NOT_FOUND');
    const theirs = await call('get', '/einvoice/filings?pageNo=1&pageSize=20', { token: other.token });
    if (theirs.status !== 200) throw new Error(`other tenant grid: ${theirs.status} ${JSON.stringify(theirs.body)}`);
    expect((theirs.body.data ?? theirs.body).items).toEqual([]);

    // The grid is readable by einvoice.view alone; filing is not.
    expect((await call('get', '/einvoice/filings?pageNo=1&pageSize=1', { token: viewer.token })).status).toBe(200);
    const attempted = await call('post', `/sales-invoices/${mine.items[0].invoiceId}/einvoice/submit`, { token: viewer.token, body: {} });
    expect(attempted.status).toBe(403);
  });

  it('refuses to file a draft, and keeps the ETA adapter stubbed', async () => {
    const draft = body(await call('post', '/sales/invoices', { token: actor.token, body: { branchId, warehouseId, cashCustomerName: 'عميل نقدي', lines: [{ itemId, quantity: '1', unitPrice: '10', taxRate: '15' }] } })).id;
    const refused = await call('post', `/sales-invoices/${draft}/einvoice/submit`, { token: actor.token, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('EINVOICE_INVOICE_NOT_POSTED');

    const eta = await submit(await postedInvoice({ cashCustomer: 'عميل نقدي' }), { authority: 'eta' });
    expect(eta.status).toBe('not_implemented');
  });

  describe('the document checks that run before a filing is sent', () => {
    it('passes the documents it builds itself, with no findings at all', async () => {
      const submission = await submit(await postedInvoice({ partyId }));
      expect(submission.status).toBe('cleared');
      const findings = inspectInvoiceXml(submission.requestPayload.xml);
      expect(findings).toEqual([]);
      expect(submission.response.warningMessages).toEqual([]);
    });

    it('rejects a document whose totals do not close, before it is ever sent', () => {
      const xml = `<Invoice><cbc:ID>SI-1</cbc:ID><cbc:UUID>u</cbc:UUID>
        <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
        <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID></cac:AdditionalDocumentReference>
        <cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject>${GENESIS_PIH}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
        <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>310000000000003</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
        <cac:LegalMonetaryTotal>
          <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
          <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
          <cbc:TaxInclusiveAmount currencyID="SAR">117.00</cbc:TaxInclusiveAmount>
          <cbc:TaxAmount currencyID="SAR">20.00</cbc:TaxAmount>
          <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
          <cbc:PayableAmount currencyID="SAR">117.00</cbc:PayableAmount>
        </cac:LegalMonetaryTotal></Invoice>`;
      const findings = inspectInvoiceXml(xml);
      expect(findings.some((finding) => finding.code === 'TOTAL_MISMATCH')).toBe(true);
      expect(findings.find((finding) => finding.code === 'TOTAL_MISMATCH')!.message).toContain('مجموع المستند غير مغلق');
    });

    it('warns about a seller VAT number that is not shaped like one, without blocking', () => {
      const findings = inspectInvoiceXml(`<Invoice><cbc:ID>SI-1</cbc:ID>
        <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
        <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID></cac:AdditionalDocumentReference>
        <cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject>${GENESIS_PIH}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
        <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>12345</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
        <cac:LegalMonetaryTotal>
          <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
          <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
          <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
          <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
          <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
          <cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>
        </cac:LegalMonetaryTotal></Invoice>`);
      const warning = findings.find((finding) => finding.code === 'SELLER_VAT_SHAPE');
      expect(warning?.kind).toBe('warning');
      expect(warning!.message).toContain('12345');
      expect(findings.filter((finding) => finding.kind === 'error')).toEqual([]);
    });

    it('reports a document with no chain as unfileable', () => {
      const findings = inspectInvoiceXml('<Invoice><cbc:ID>SI-1</cbc:ID></Invoice>');
      expect(findings.map((finding) => finding.code).sort()).toEqual(['NO_ICV', 'NO_PIH', 'NO_SELLER_VAT', 'NO_TYPE_CODE']);
    });
  });
});
