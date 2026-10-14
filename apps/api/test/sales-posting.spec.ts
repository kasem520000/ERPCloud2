import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The sales posting engine — Phase 02 of the desktop-parity programme.
 *
 * Posting a draft must do what the desktop `SaveInvoice` + `BindToEntry` pair did in
 * one transaction: relieve the warehouse at average cost, stamp each line's cost, and
 * write the balanced journal from the resolved posting profile — never from
 * caller-supplied lines. Returns mirror the legs, and voiding reverses all three
 * (journal, stock, status) instead of only flipping a flag.
 */
describe('sales posting engine', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('sales-posting');
    actor = await createActor(ctx, {
      tenantCode: 'posting-alpha',
      email: 'owner@posting-alpha.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.invoice.pay',
        'sales.invoice.void',
        'sales.return.create',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'accounting.account.view',
        'organization.postingprofile.view',
      ],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'SKU-POST',
        nameAr: 'صنف الترحيل',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100.0000',
      },
    });
    itemId = data(item.body).id as string;

    const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          { itemId, warehouseId, qty: '100', unitCost: '40', direction: 'in', docType: 'opening', docId: '00000000-0000-0000-0000-000000000001' },
        ],
      },
    });
    expect(receipt.status).toBe(201);

    const party = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'عميل الترحيل' },
    });
    partyId = data(party.body).id as string;
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelsOf = async (): Promise<string> => {
    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${itemId}`, {
      token: actor.token,
    });
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return rows[0]?.quantity ?? '0';
  };

  const journalOf = async (invoiceNumber: string): Promise<{ id: string; lines: Array<{ accountId: string; debit: string; credit: string }> }> => {
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; description: string; kind: string }>;
    const entry = entries.find((row) => row.description === `Sales invoice ${invoiceNumber}` && row.kind !== 'reversal');
    expect(entry).toBeDefined();
    const detail = await api(ctx.server, 'get', `/api/v1/journal-entries/${entry?.id}`, { token: actor.token });
    return data(detail.body) as { id: string; lines: Array<{ accountId: string; debit: string; credit: string }> };
  };

  it('seeds a resolvable tenant-wide posting profile during provisioning', async () => {
    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=sales_invoice`, {
      token: actor.token,
    });
    expect(resolved.status).toBe(200);
    const mapping = data(resolved.body).mapping as Record<string, string>;
    for (const key of ['salesAccountId', 'vatOutputAccountId', 'receivableAccountId', 'inventoryAccountId', 'cogsAccountId']) {
      expect(mapping[key], key).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('recomputes VAT after the header discount at creation', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        invoiceDiscount: '20',
        lines: [{ itemId, quantity: '10', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(created.status).toBe(201);
    const invoice = data(created.body) as { subtotal: string; taxTotal: string; total: string };
    expect(invoice.subtotal).toBe('980.0000');
    expect(invoice.taxTotal).toBe('147.0000');
    expect(invoice.total).toBe('1127.0000');
  });

  it('posts with an auto journal, stock relief and stamped COGS', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '10', unitPrice: '100', taxRate: '15' }],
      },
    });
    const draft = data(created.body) as { id: string };

    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as {
      status: string;
      number: string;
      lines: Array<{ costTotal: string }>;
    };
    expect(invoice.status).toBe('posted');
    expect(invoice.number).toMatch(/^SI-\d{6}$/);
    expect(invoice.lines[0]?.costTotal).toBe('400.0000');
    expect(await levelsOf()).toBe('90.0000');

    const journal = await journalOf(invoice.number);
    const debit = journal.lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = journal.lines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit).toBeCloseTo(credit, 4);
    expect(debit).toBeCloseTo(1150 + 400, 4);
  });

  it('requires a warehouse for stock-moving invoices', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: { branchId, partyId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(422);
    expect(posted.body.code).toBe('SALES_WAREHOUSE_REQUIRED');
  });

  it('rejects negative sales totals', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '1', unitPrice: '100', discountAmount: '200', taxRate: '15' }],
      },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(422);
    expect(posted.body.code).toBe('SALES_TOTAL_INVALID');
  });

  it('returns restore stock at the original cost with a mirrored journal', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '10', unitPrice: '100', taxRate: '15' }],
      },
    });
    const draft = data(created.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(await levelsOf()).toBe('80.0000');

    const returned = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/return`, {
      token: actor.token,
      body: { branchId, warehouseId, partyId, lines: [{ itemId, quantity: '4', unitPrice: '100', taxRate: '15' }] },
    });
    expect(returned.status).toBe(201);
    const returnDraft = data(returned.body) as { id: string; kind: string };
    expect(returnDraft.kind).toBe('sale_return');

    const postedReturn = await api(ctx.server, 'post', `/api/v1/sales/invoices/${returnDraft.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(postedReturn.status).toBe(201);
    expect(await levelsOf()).toBe('84.0000');
    const postedReturnInvoice = data(postedReturn.body) as { number: string };

    const journal = await journalOf(postedReturnInvoice.number);
    const debit = journal.lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = journal.lines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit).toBeCloseTo(credit, 4);
    expect(debit).toBeCloseTo(460 + 160, 4);
  });

  it('settles a cash sale against the till with a payment row in the same transaction', async () => {
    const chart = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const till = ((chart.body.data ?? chart.body) as Array<{ id: string; code: string }>).find((row) => row.code === '1211001');
    expect(till).toBeDefined();

    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'sale',
        cashCustomerName: 'زبون نقدي',
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string };

    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, {
      token: actor.token,
      body: { settlement: 'cash', settlementAccountId: till!.id },
    });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string; paymentStatus: string; paidTotal: string };

    // Landed fully paid with a visible payment row.
    expect(invoice.paymentStatus).toBe('paid');
    expect(invoice.paidTotal).toBe('115.0000');
    const reread = await api(ctx.server, 'get', `/api/v1/sales/invoices/${draft.id}`, { token: actor.token });
    const payments = (data(reread.body) as { payments: Array<{ method: string; amount: string }> }).payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'cash', amount: '115.0000' });

    // And the journal debits the till — with no party subledger on cash.
    const journal = await journalOf(invoice.number);
    const tillLeg = journal.lines.find((line) => line.accountId === till!.id);
    expect(tillLeg?.debit).toBe('115.0000');
    expect((tillLeg as { partyId?: string | null }).partyId).toBeNull();
  });

  it('voids by reversing the journal and the stock, and refuses paid invoices', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '5', unitPrice: '100', taxRate: '15' }],
      },
    });
    const draft = data(created.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(await levelsOf()).toBe('78.0000');

    const paid = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/payments`, {
      token: actor.token,
      body: { method: 'credit', amount: '100', idempotencyKey: `pay-${draft.id}` },
    });
    expect(paid.status).toBe(201);

    const blocked = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/void`, {
      token: actor.token,
      body: { reason: 'خطأ' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SALES_VOID_HAS_PAYMENTS');

    const fresh = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '5', unitPrice: '100', taxRate: '15' }],
      },
    });
    const freshDraft = data(fresh.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${freshDraft.id}/post`, { token: actor.token, body: {} });
    expect(await levelsOf()).toBe('73.0000');

    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${freshDraft.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء بطلب العميل' },
    });
    expect(voided.status).toBe(201);
    expect((data(voided.body) as { status: string }).status).toBe('voided');
    expect(await levelsOf()).toBe('78.0000');

    const freshPosted = await api(ctx.server, 'get', `/api/v1/sales/invoices/${freshDraft.id}`, { token: actor.token });
    const freshNumber = (data(freshPosted.body) as { number: string }).number;
    const original = await journalOf(freshNumber);
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; kind: string; reversalOf: string | null }>;
    expect(entries.some((row) => row.kind === 'reversal' && row.reversalOf === original.id)).toBe(true);
  });

  /**
   * R2 — سلسلة المستندات لا تُترك معلّقة. الديسكتوب كان يرفض **الإرجاع الثاني**
   * (`isReturned`, `Class/InvoiceOper.cs:812` → «الفاتورة تم إرجاعها سابقاً أو بعض الأصناف»,
   * `frmInvSale.xaml.cs:1702`)، والسحابة تضبط الوجهين: لا إلغاء لفاتورةٍ عليها مستندٌ مشتقّ
   * مُرحَّل، ولا ترحيلُ مستندٍ مشتقّ إلى فاتورةٍ ملغاة. والاختبار يقطع السلسلة كاملة:
   * إلغاءٌ مرفوض ⇒ إلغاءُ المرتجع ⇒ إلغاءٌ يمرّ.
   */
  it('refuses to void an invoice that has a posted return, and allows it once the return is voided', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '4', unitPrice: '100', taxRate: '15' }],
      },
    });
    const invoice = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBe(201);

    const returned = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/return`, {
      token: actor.token,
      body: { branchId, warehouseId, lines: [{ itemId, quantity: '2', unitPrice: '100' }] },
    });
    expect(returned.status).toBe(201);
    const credit = data(returned.body) as { id: string };
    const returnPosted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${credit.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(returnPosted.status).toBe(201);

    const blocked = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء بعد مرتجع' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SALES_VOID_HAS_RETURNS');
    const errors = (blocked.body.errors ?? []) as Array<{ count: number; references: Array<{ id: string }> }>;
    expect(errors[0]?.count).toBe(1);
    expect(errors[0]?.references[0]?.id).toBe(credit.id);

    // الفاتورة لم تُمسّ: الإلغاء المرفوض لا يكتب شيئاً.
    const untouched = await api(ctx.server, 'get', `/api/v1/sales/invoices/${invoice.id}`, { token: actor.token });
    expect((data(untouched.body) as { status: string }).status).toBe('posted');

    const returnVoided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${credit.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء المرتجع أولاً' },
    });
    expect(returnVoided.status).toBe(201);

    const nowAllowed = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'لم يبقَ مستندٌ مشتقّ' },
    });
    expect(nowAllowed.status).toBe(201);
    expect((data(nowAllowed.body) as { status: string }).status).toBe('voided');
  }, 120_000);

  it('refuses to post a return whose source invoice was voided in the meantime', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: '3', unitPrice: '100', taxRate: '15' }],
      },
    });
    const invoice = data(created.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/post`, { token: actor.token, body: {} });

    // مسودّة مرتجعٍ تُنشأ قبل الإلغاء (لا قيد لها ولا مخزون)، ثم تُلغى الفاتورة — والمسودّة
    // وحدها لا تمنع الإلغاء لأن أثرها صفر.
    const returned = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/return`, {
      token: actor.token,
      body: { branchId, warehouseId, lines: [{ itemId, quantity: '1', unitPrice: '100' }] },
    });
    const credit = data(returned.body) as { id: string };
    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء والمرتجع مسودّة' },
    });
    expect(voided.status).toBe(201);

    const refused = await api(ctx.server, 'post', `/api/v1/sales/invoices/${credit.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SALES_REFERENCE_VOIDED');

    const stillDraft = await api(ctx.server, 'get', `/api/v1/sales/invoices/${credit.id}`, { token: actor.token });
    expect((data(stillDraft.body) as { status: string }).status).toBe('draft');
  }, 120_000);
});
