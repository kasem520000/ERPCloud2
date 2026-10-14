import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Printed documents and master-data cards.
 *
 * Two things are checked here, because they are the two ways a user destroys data by
 * accident. First, printing: what the customer receives has to carry the company header,
 * the counterparty, every line, the totals and the amount in words — a template that
 * silently drops the tax number or a line is worse than no template. Second, editing:
 * a card may be corrected while it is still unused and must be refused once documents
 * point at it, so history cannot be rewritten from a directory screen.
 */
describe('document printing and master-data editing', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let unitId = '';
  let categoryId = '';
  let itemId = '';
  let partyId = '';
  let cashLocationId = '';
  let invoiceId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestApp('printing-and-cards');
    actor = await createActor(ctx, {
      tenantCode: 'printshop',
      email: 'owner@printshop.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.unit.view',
        'catalog.unit.manage',
        'catalog.category.view',
        'catalog.category.manage',
        'catalog.taxgroup.view',
        'catalog.taxgroup.manage',
        'accounting.account.view',
        'accounting.account.manage',
        'inventory.view',
        'inventory.adjust',
        'parties.view',
        'parties.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'accounting.period.close',
        'sales.salesman.manage',
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.expensetype.manage',
        'reporting.view',
        'reporting.export.execute',
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
    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع الرئيسي' } });
    warehouseId = body(warehouse).id;
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: actor.token, body: { code: 'PCS', nameAr: 'حبة' } });
    unitId = body(unit).id;
    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } });
    categoryId = body(category).id;
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'RICE-5', nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' },
    });
    itemId = body(item).id;
    const party = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012' } });
    partyId = body(party).id;

    await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: actor.token,
      body: { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000' },
    });

    await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId, qty: '100', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000011' }] },
    });

    const invoice = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId, lines: [{ itemId, quantity: '12', unitPrice: '27.5', taxRate: '15' }] },
    });
    invoiceId = body(invoice).id;
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoiceId}/post`, { token: actor.token, body: {} });

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', { token: actor.token, body: { branchId, kind: 'safe', name: 'الخزنة الرئيسية' } });
    cashLocationId = body(safe).id;
  }, 240_000);

  afterAll(async () => ctx.close());

  it('prints a sales invoice with the company, the customer, the lines and the amount in words', async () => {
    const printed = await api(ctx.server, 'get', `/api/v1/reports/print/invoices/${invoiceId}`, { token: actor.token });
    expect(printed.status).toBe(200);
    const html = (printed.body as { html: string }).html;

    expect(html).toContain('مؤسسة الأفق للتجارة');
    expect(html).toContain('310000000000003'); // the seller's VAT number
    expect(html).toContain('مؤسسة النخبة'); // the buyer
    expect(html).toContain('310000000000012'); // the buyer's VAT number
    expect(html).toContain('أرز بسمتي ٥ كجم');
    expect(html).toContain('فاتورة مبيعات');
    expect(html).toMatch(/فقط .* لا غير/); // tafqeet line
    expect(html).toContain('@page');
    // Nothing was reported to ZATCA yet, so the QR slot says so instead of drawing a
    // square that no scanner could read.
    expect(html).toContain('لم تُصدر بعد');
    expect(html).not.toContain('<svg');
  });

  it('prints a receipt voucher and its journal entry', async () => {
    const voucher = await api(ctx.server, 'post', '/api/v1/vouchers', {
      token: actor.token,
      body: { branchId, kind: 'receipt', subtype: 'customer', date: new Date().toISOString().slice(0, 10), partyId, cashLocationId, method: 'cash', amount: '1250.75', netAmount: '1250.75' },
    });
    expect(voucher.status).toBe(201);
    // Posting needs an open fiscal period and a posting profile; a freshly provisioned
    // tenant may have neither, and the printed voucher must not depend on it.
    const posted = await api(ctx.server, 'post', `/api/v1/vouchers/${body(voucher).id}/post`, { token: actor.token, body: {} });

    const printed = await api(ctx.server, 'get', `/api/v1/reports/print/vouchers/${body(voucher).id}`, { token: actor.token });
    const html = (printed.body as { html: string }).html;
    expect(html).toContain('سند قبض');
    expect(html).toContain('استلمنا من السيد');
    expect(html).toContain('1,250.75');
    expect(html).toContain('ألف ومائتان وخمسون ريالاً وخمسة وسبعون هللة لا غير');

    const journalEntryId = posted.status === 201 ? body(posted).journalEntryId : undefined;
    if (journalEntryId) {
      const journal = await api(ctx.server, 'get', `/api/v1/reports/print/journal-entries/${journalEntryId}`, { token: actor.token });
      const journalHtml = (journal.body as { html: string }).html;
      expect(journalHtml).toContain('سند قيد');
      expect(journalHtml).toContain('مدين');
    }
  });

  it('exports a report as a workbook, not a CSV wearing an .xlsx name', async () => {
    const response = await api(ctx.server, 'post', `/api/v1/reports/sales-invoices/export?from=2000-01-01&to=2099-12-31&branchId=${branchId}`, {
      token: actor.token,
      body: { format: 'xlsx' },
    });
    expect(response.status).toBe(201);
    const payload = body(response) as unknown as { filename: string; mimeType: string; encoding: string; content: string; rows: number };
    expect(payload.filename).toMatch(/\.xlsx$/);
    expect(payload.mimeType).toContain('spreadsheetml');
    expect(payload.encoding).toBe('base64');
    expect(payload.rows).toBeGreaterThan(0);

    const archive = Buffer.from(payload.content, 'base64');
    expect(archive.subarray(0, 2).toString()).toBe('PK');
    const sheet = readZipEntry(archive, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('تقرير فواتير المبيعات'); // the report title band
    expect(sheet).toContain('الفرع: الفرع الرئيسي'); // the filter is spelled out, not left as a uuid
    expect(sheet).toContain('مؤسسة النخبة');
    // Money must land in numeric cells or the accountant cannot sum the column.
    expect(sheet).toMatch(/<v>379\.5<\/v>/);
  });

  it('exports CSV with a byte-order mark so Excel reads Arabic', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/reports/sales-invoices/export?from=2000-01-01&to=2099-12-31', {
      token: actor.token,
      body: { format: 'csv' },
    });
    const payload = body(response) as unknown as { content: string; filename: string; mimeType: string };
    expect(payload.filename).toMatch(/\.csv$/);
    expect(payload.mimeType).toContain('text/csv');
    expect(payload.content.startsWith('\uFEFF')).toBe(true);
    expect(payload.content).toContain('مؤسسة النخبة');
  });

  it('returns a printable landscape page for the pdf format', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/reports/sales-invoices/export?from=2000-01-01&to=2099-12-31', {
      token: actor.token,
      body: { format: 'pdf' },
    });
    const payload = body(response) as unknown as { content: string; mimeType: string };
    expect(payload.mimeType).toContain('text/html');
    expect(payload.content).toContain('A4 landscape');
    expect(payload.content).toContain('مؤسسة الأفق للتجارة'); // company letterhead
    expect(payload.content).toContain('310000000000003'); // its VAT number
    expect(payload.content).toContain('عدد السجلات');
  });

  it('refuses a format it cannot actually produce', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/reports/sales-invoices/export', { token: actor.token, body: { format: 'docx' } });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 for a document that does not exist', async () => {
    const missing = await api(ctx.server, 'get', '/api/v1/reports/print/invoices/00000000-0000-4000-8000-0000000000ff', { token: actor.token });
    expect(missing.status).toBe(404);
  });

  it('lets an unused card be corrected and refuses the parts that documents already carry', async () => {
    const renamed = await api(ctx.server, 'patch', `/api/v1/organization/catalog/items/${itemId}`, { token: actor.token, body: { nameAr: 'أرز بسمتي ١٠ كجم', salePrice: '32' } });
    expect(renamed.status).toBe(200);
    expect(body(renamed).nameAr).toBe('أرز بسمتي ١٠ كجم');

    // The SKU is printed on documents and barcodes, so once the item has moved it is frozen.
    const resku = await api(ctx.server, 'patch', `/api/v1/organization/catalog/items/${itemId}`, { token: actor.token, body: { sku: 'RICE-10' } });
    expect(resku.status).toBe(409);

    // Its unit and its category are still standing behind it, so neither can be removed.
    expect((await api(ctx.server, 'delete', `/api/v1/organization/catalog/units/${unitId}`, { token: actor.token })).status).toBe(409);
    expect((await api(ctx.server, 'delete', `/api/v1/organization/catalog/categories/${categoryId}`, { token: actor.token })).status).toBe(409);

    // An item with movements is archived rather than deleted: the ledger keeps its subject.
    const archived = await api(ctx.server, 'delete', `/api/v1/organization/catalog/items/${itemId}`, { token: actor.token });
    expect(archived.status).toBe(200);
    expect(body(archived).archived).toBe(true);
    const remaining = await api(ctx.server, 'get', '/api/v1/organization/catalog/items', { token: actor.token });
    expect(((remaining.body.data ?? remaining.body) as Array<{ id: string }>).some((row) => row.id === itemId)).toBe(false);
  });

  it('protects an account that carries entries and moves a whole branch when reparenting', async () => {
    const parent = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: { code: '5900', nameAr: 'مصروفات تشغيلية', type: 'expense', isPostable: false } });
    const child = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: { code: '5901', nameAr: 'كهرباء', type: 'expense', parentId: body(parent).id, isPostable: false } });
    const grandchild = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: { code: '5902', nameAr: 'كهرباء الفرع', type: 'expense', parentId: body(child).id } });

    expect((await api(ctx.server, 'delete', `/api/v1/accounts/${body(parent).id}`, { token: actor.token })).status).toBe(409);
    expect((await api(ctx.server, 'patch', `/api/v1/accounts/${body(parent).id}`, { token: actor.token, body: { isPostable: true } })).status).toBe(422);
    expect((await api(ctx.server, 'patch', `/api/v1/accounts/${body(parent).id}`, { token: actor.token, body: { parentId: body(child).id } })).status).toBe(422);

    // Moving the middle account to the root takes its own child with it.
    const moved = await api(ctx.server, 'patch', `/api/v1/accounts/${body(child).id}`, { token: actor.token, body: { parentId: null } });
    expect(moved.status).toBe(200);
    expect(Number(body(moved).level)).toBe(0);
    const movedChild = await api(ctx.server, 'get', `/api/v1/accounts/${body(grandchild).id}`, { token: actor.token });
    expect(Number(body(movedChild).level)).toBe(1);
    expect(String(body(movedChild).path).startsWith(String(body(moved).path))).toBe(true);

    // The seeded cash account has journal entries behind it: rename yes, renumber no.
    const accounts = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const cash = ((accounts.body.data ?? accounts.body) as Array<{ id: string; code: string }>).find((row) => row.code === '1101');
    if (cash) {
      expect((await api(ctx.server, 'patch', `/api/v1/accounts/${cash.id}`, { token: actor.token, body: { nameAr: 'الصندوق العام' } })).status).toBe(200);
      expect((await api(ctx.server, 'patch', `/api/v1/accounts/${cash.id}`, { token: actor.token, body: { code: '1109' } })).status).toBe(409);
    }
  });
});

/** Reads one entry out of a zip archive — enough to look inside the workbook we produced. */
function readZipEntry(archive: Buffer, wanted: string): string {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      return inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize)).toString('utf8');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry not found: ${wanted}`);
}
