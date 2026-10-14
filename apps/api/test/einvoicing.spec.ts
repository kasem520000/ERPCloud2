import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeQrPayload } from '../src/modules/einvoicing/zatca/qr.js';
import { GENESIS_PIH } from '../src/modules/einvoicing/zatca/ubl.js';
import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * ZATCA e-invoicing.
 *
 * What is proved here is the part that does not need the authority: a posted invoice produces
 * a real UBL 2.1 document, the document is hashed and chained to the one before it, the
 * counter advances by exactly one, and the QR carries the five phase-1 tags built from the
 * tenant's own registration — not a placeholder. Equally important is what the system refuses
 * to claim: with no credentials uploaded the submission is `prepared`, never "accepted".
 */
describe('zatca e-invoicing', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, string>;

  async function postedInvoice(quantity: string) {
    const invoice = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId, lines: [{ itemId, quantity, unitPrice: '27.5', taxRate: '15' }] },
    });
    const id = body(invoice).id;
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestApp('zatca-einvoicing');
    actor = await createActor(ctx, {
      tenantCode: 'zatcaco',
      email: 'owner@zatcaco.test',
      permissions: [
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
        'accounting.period.close',
        'einvoice.view',
        'einvoice.submit',
        'einvoice.credentials.manage',
      ],
    });


    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);
    warehouseId = body(await api(ctx.server, 'post', '/api/v1/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع' } })).id;
    const unitId = body(await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCE', nameAr: 'حبة' } })).id;
    const categoryId = body(await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } })).id;
    itemId = body(
      await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: actor.token,
        body: { sku: 'RICE-5', nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' },
      }),
    ).id;
    partyId = body(await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012' } })).id;

    const profile = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: actor.token,
      body: { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000', address: { street: 'طريق الملك فهد', building: '1234', district: 'العليا', city: 'الرياض', postal: '12345' } },
    });
    if (profile.status >= 300) throw new Error(`company profile: ${profile.status} ${JSON.stringify(profile.body)}`);
    await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000021' }] },
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('produces a real UBL document for a posted invoice and refuses to call it accepted', async () => {
    const invoiceId = await postedInvoice('4');
    const response = await api(ctx.server, 'post', `/api/v1/sales-invoices/${invoiceId}/einvoice/submit`, { token: actor.token, body: {} });
    expect(response.status).toBe(201);
    const submission = body(response) as unknown as { status: string; hash: string; previousHash: string; qrPayload: string; requestPayload: { xml: string; counter: number; profile: string }; response: Record<string, unknown> };

    expect(submission.status).toBe('prepared');
    expect(submission.response.submitted).toBe(false);
    expect(submission.response.reason).toBe('NO_CREDENTIALS');

    const xml = submission.requestPayload.xml;
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(xml).toContain('<cbc:CompanyID>310000000000003</cbc:CompanyID>'); // seller VAT from the company card
    expect(xml).toContain('310000000000012'); // buyer VAT
    expect(xml).toContain('أرز بسمتي ٥ كجم');
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>'); // buyer has a VAT number -> standard
    expect(submission.requestPayload.profile).toBe('standard');
    expect(submission.requestPayload.counter).toBe(1);
    expect(submission.previousHash).toBe(GENESIS_PIH);
    expect(Buffer.from(submission.hash, 'base64')).toHaveLength(32);
  });

  it('puts the tenant’s own registration in the QR, not a placeholder', async () => {
    const invoiceId = await postedInvoice('2');
    const submission = body(await api(ctx.server, 'post', `/api/v1/sales-invoices/${invoiceId}/einvoice/submit`, { token: actor.token, body: {} })) as unknown as { qrPayload: string };
    const tags = decodeQrPayload(submission.qrPayload);
    expect(tags.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5]); // no phase-2 tags without a key
    expect(tags[0]!.value.toString('utf8')).toBe('مؤسسة الأفق للتجارة');
    expect(tags[1]!.value.toString('utf8')).toBe('310000000000003');
    expect(tags[2]!.value.toString('utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number(tags[3]!.value.toString('utf8'))).toBeCloseTo(63.25, 2); // 2 × 27.5 + 15%
    expect(Number(tags[4]!.value.toString('utf8'))).toBeCloseTo(8.25, 2);
  });

  it('chains each invoice to the previous one and advances the counter by exactly one', async () => {
    const first = body(await api(ctx.server, 'post', `/api/v1/sales-invoices/${await postedInvoice('1')}/einvoice/submit`, { token: actor.token, body: {} })) as unknown as { hash: string; requestPayload: { counter: number } };
    const second = body(await api(ctx.server, 'post', `/api/v1/sales-invoices/${await postedInvoice('1')}/einvoice/submit`, { token: actor.token, body: {} })) as unknown as { previousHash: string; requestPayload: { counter: number; xml: string } };
    expect(second.previousHash).toBe(first.hash);
    expect(second.requestPayload.counter).toBe(first.requestPayload.counter + 1);
    expect(second.requestPayload.xml).toContain(first.hash); // the PIH is embedded in the document
  });

  it('signs the invoice once a private key is uploaded, and says so', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    await api(ctx.server, 'put', '/api/v1/einvoice/credentials', {
      token: actor.token,
      body: { authority: 'zatca', environment: 'simulation', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), csr: 'MIIB...' },
    });

    const submission = body(await api(ctx.server, 'post', `/api/v1/sales-invoices/${await postedInvoice('3')}/einvoice/submit`, { token: actor.token, body: {} })) as unknown as {
      status: string;
      hash: string;
      qrPayload: string;
      response: Record<string, unknown>;
    };
    expect(submission.status).toBe('signed');
    expect(submission.response.signed).toBe(true);
    expect(submission.response.curve).toBe('secp256k1');
    expect(submission.response.reason).toBe('NO_GATEWAY_CONFIGURED'); // honest: nothing was filed
    const tags = decodeQrPayload(submission.qrPayload);
    expect(tags.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tags[5]!.value.toString('utf8')).toBe(submission.hash);
  });

  it('never leaks a stored secret back out', async () => {
    const credentials = await api(ctx.server, 'get', '/api/v1/einvoice/credentials', { token: actor.token });
    const rows = (credentials.body.data ?? credentials.body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('BEGIN PRIVATE KEY');
    expect(rows[0]!.privateKeyMasked).toMatch(/^\*\*\*\*/);
  });

  it('refuses to file a draft invoice', async () => {
    const draft = body(await api(ctx.server, 'post', '/api/v1/sales/invoices', { token: actor.token, body: { branchId, warehouseId, partyId, lines: [{ itemId, quantity: '1', unitPrice: '10', taxRate: '15' }] } })).id;
    const response = await api(ctx.server, 'post', `/api/v1/sales-invoices/${draft}/einvoice/submit`, { token: actor.token, body: {} });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EINVOICE_INVOICE_NOT_POSTED');
  });
});
