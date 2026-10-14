import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The purchase posting engine — Phase 03 of the desktop-parity programme.
 *
 * The desktop `BindToEntry` purchase mirror (supplier Cr / purchases Dr /
 * discount-received Cr / VAT-input Dr / cash legs), adapted to the cloud's
 * perpetual inventory: stocked value debits inventory at landed cost, services
 * debit purchases, expense costs hit their own accounts, and returns relieve
 * at average with the price-vs-average drift in COGS — all in one transaction.
 */
describe('purchase posting engine', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let serviceItemId = '';
  let supplierId = '';
  let expenseAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('purchase-posting');
    actor = await createActor(ctx, {
      tenantCode: 'purchase-beta',
      email: 'owner@purchase-beta.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'purchase.view',
        'purchase.invoice.create',
        'purchase.invoice.post',
        'purchase.invoice.void',
        'purchase.invoice.pay',
        'purchase.cost.manage',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.close',
        'accounting.account.view',
        'accounting.reports.view',
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
    const categoryId = data(category.body).id as string;
    const baseUnitId = data(unit.body).id as string;
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SKU-PURCH', nameAr: 'صنف شراء', categoryId, baseUnitId, kind: 'stock', purchasePrice: '100.0000' },
    });
    itemId = data(item.body).id as string;
    const service = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: { sku: 'SRV-PURCH', nameAr: 'خدمة شراء', categoryId, baseUnitId, kind: 'service', purchasePrice: '50.0000' },
    });
    serviceItemId = data(service.body).id as string;

    const supplier = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'supplier', name: 'مورد الترحيل' },
    });
    supplierId = data(supplier.body).id as string;

    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=purchase_invoice`, {
      token: actor.token,
    });
    expenseAccountId = (data(resolved.body).mapping as Record<string, string>).purchasesAccountId as string;
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelsOf = async (): Promise<string> => {
    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${itemId}`, {
      token: actor.token,
    });
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return rows[0]?.quantity ?? '0';
  };

  /** الكمية والقيمة والمتوسط معاً — الإلغاء يجب أن يعيد الثلاثة لا الكمية وحدها. */
  const balanceOf = async (): Promise<{ quantity: string; value: string; averageCost: string }> => {
    const levels = await api(ctx.server, 'get', `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${itemId}`, {
      token: actor.token,
    });
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string; value: string; averageCost: string }>;
    return { quantity: rows[0]?.quantity ?? '0', value: rows[0]?.value ?? '0', averageCost: rows[0]?.averageCost ?? '0' };
  };

  const journalOf = async (
    description: string,
  ): Promise<{ id: string; lines: Array<{ accountId: string; debit: string; credit: string; description?: string | null }> }> => {
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; description: string; kind: string }>;
    const entry = entries.find((row) => row.description === description && row.kind !== 'reversal');
    expect(entry).toBeDefined();
    const detail = await api(ctx.server, 'get', `/api/v1/journal-entries/${entry?.id}`, { token: actor.token });
    return data(detail.body) as { id: string; lines: Array<{ accountId: string; debit: string; credit: string; description?: string | null }> };
  };

  /** فاتورة مشتريات مُرحَّلة — الاختصار الذي تحتاجه سبيكات السلسلة. */
  const postPurchase = async (line: { quantity: string; unitPrice: string }): Promise<{ id: string; number: string }> => {
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, taxRate: '15', ...line }] },
    });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    return { id: draft.id, number: (data(posted.body) as { number: string }).number };
  };

  it('resolves the purchase keys from the tenant-wide posting profile', async () => {
    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=purchase_invoice`, {
      token: actor.token,
    });
    expect(resolved.status).toBe(200);
    const mapping = data(resolved.body).mapping as Record<string, string>;
    for (const key of ['purchasesAccountId', 'purchaseReturnAccountId', 'discountReceivedAccountId', 'vatInputAccountId', 'payableAccountId', 'inventoryAccountId', 'cogsAccountId']) {
      expect(mapping[key], key).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('posts with an auto journal, a stock receipt and landed costs', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        invoiceDiscount: '20',
        lines: [{ itemId, quantity: '10', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string; subtotal: string; taxTotal: string; total: string };
    expect(draft.subtotal).toBe('980.0000');
    expect(draft.taxTotal).toBe('147.0000');
    expect(draft.total).toBe('1127.0000');

    const freight = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/costs`, {
      token: actor.token,
      body: { costName: 'شحن', amount: '100', allocationTarget: 'inventory' },
    });
    expect(freight.status).toBe(201);
    const customs = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/costs`, {
      token: actor.token,
      body: { costName: 'جمارك', amount: '50', allocationTarget: 'expense', accountId: expenseAccountId },
    });
    expect(customs.status).toBe(201);

    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string; total: string; additionalCostTotal: string };
    expect(invoice.number).toMatch(/^PI-\d{6}$/);
    expect(invoice.additionalCostTotal).toBe('150.0000');
    expect(invoice.total).toBe('1277.0000');

    // Stock received 10 units at the landed unit cost (980 + 100) / 10 = 108.
    expect(await levelsOf()).toBe('10.0000');
    const reread = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${draft.id}`, { token: actor.token });
    const stored = (data(reread.body) as { lines: Array<{ allocatedCost: string; landedTotal: string; unitCostAtPost: string }> }).lines;
    expect(stored[0]).toMatchObject({ allocatedCost: '100.0000', landedTotal: '1080.0000', unitCostAtPost: '108.0000' });

    // Gross method: Dr inventory 1080 + 20 / Dr VAT 147 / Dr expense 50 /
    // Cr discount-received 20 / Cr payable 1277.
    const journal = await journalOf(`Purchase invoice ${invoice.number}`);
    const byAccount = new Map(journal.lines.map((line) => [line.accountId, line]));
    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=purchase_invoice`, {
      token: actor.token,
    });
    const mapping = data(resolved.body).mapping as Record<string, string>;
    expect(byAccount.get(mapping.inventoryAccountId)?.debit).toBe('1100.0000');
    expect(byAccount.get(mapping.vatInputAccountId)?.debit).toBe('147.0000');
    expect(byAccount.get(expenseAccountId)?.debit).toBe('50.0000');
    expect(byAccount.get(mapping.discountReceivedAccountId)?.credit).toBe('20.0000');
    expect(byAccount.get(mapping.payableAccountId)?.credit).toBe('1277.0000');
    const debit = journal.lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = journal.lines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it('requires a warehouse for stock-moving purchases but not for services', async () => {
    const stocked = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const stockedDraft = data(stocked.body) as { id: string };
    const rejected = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${stockedDraft.id}/post`, { token: actor.token, body: {} });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('PURCHASE_WAREHOUSE_REQUIRED');

    const serviced = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, partyId: supplierId, lines: [{ itemId: serviceItemId, quantity: '2', unitPrice: '50', taxRate: '15' }] },
    });
    const serviceDraft = data(serviced.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${serviceDraft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string };
    const journal = await journalOf(`Purchase invoice ${invoice.number}`);
    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=purchase_invoice`, {
      token: actor.token,
    });
    const mapping = data(resolved.body).mapping as Record<string, string>;
    const byAccount = new Map(journal.lines.map((line) => [line.accountId, line]));
    // Services debit purchases, never inventory.
    expect(byAccount.get(mapping.purchasesAccountId)?.debit).toBe('100.0000');
    expect(byAccount.has(mapping.inventoryAccountId)).toBe(false);
  });

  it('rejects negative purchase totals', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', discountAmount: '200', taxRate: '15' }] },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(422);
    expect(posted.body.code).toBe('PURCHASE_TOTAL_INVALID');
  });

  it('refuses expense costs without an account in the auto path', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const draft = data(created.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/costs`, {
      token: actor.token,
      body: { costName: 'عمولة', amount: '10', allocationTarget: 'expense' },
    });
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(422);
    expect(posted.body.code).toBe('PURCHASE_COST_ACCOUNT_REQUIRED');
  });

  it('returns relieve at average with the drift in COGS', async () => {
    // Average is 108 from the landed receipt; the supplier credits 100/unit.
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        kind: 'purchase_return',
        lines: [{ itemId, quantity: '4', unitPrice: '100', taxRate: '15' }],
      },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string };
    expect(invoice.number).toMatch(/^PR-\d{6}$/);
    expect(await levelsOf()).toBe('6.0000');

    const journal = await journalOf(`Purchase return ${invoice.number}`);
    const resolved = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=purchase_return`, {
      token: actor.token,
    });
    const mapping = data(resolved.body).mapping as Record<string, string>;
    const byAccount = new Map(journal.lines.map((line) => [line.accountId, line]));
    // Dr payable 460 / Cr inventory 432 (4 × 108 average) / Cr VAT 60 /
    // Dr COGS 32 (the freight the supplier does not refund).
    expect(byAccount.get(mapping.payableAccountId)?.debit).toBe('460.0000');
    expect(byAccount.get(mapping.inventoryAccountId)?.credit).toBe('432.0000');
    expect(byAccount.get(mapping.vatInputAccountId)?.credit).toBe('60.0000');
    expect(byAccount.get(mapping.cogsAccountId)?.debit).toBe('32.0000');
    const debit = journal.lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = journal.lines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it('settles a cash purchase against the till and lands it paid', async () => {
    const chart = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const till = ((chart.body.data ?? chart.body) as Array<{ id: string; code: string }>).find((row) => row.code === '1211001');
    expect(till).toBeDefined();

    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, {
      token: actor.token,
      body: { settlement: 'cash', settlementAccountId: till!.id },
    });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string; paymentStatus: string; paidTotal: string };
    expect(invoice.paymentStatus).toBe('paid');
    expect(invoice.paidTotal).toBe('115.0000');

    const journal = await journalOf(`Purchase invoice ${invoice.number}`);
    const tillLeg = journal.lines.find((line) => line.accountId === till!.id);
    expect(tillLeg?.credit).toBe('115.0000');
  });

  it('voids by reversing the journal and the stock, and refuses paid purchases', async () => {
    const before = await levelsOf();
    const beforeBalance = await balanceOf();
    const created = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '15' }] },
    });
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(201);
    const invoice = data(posted.body) as { number: string };
    expect(Number(await levelsOf())).toBeGreaterThan(Number(before));

    const original = await journalOf(`Purchase invoice ${invoice.number}`);
    const voided = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${draft.id}/void`, {
      token: actor.token,
      body: { reason: 'فاتورة مكررة' },
    });
    expect(voided.status).toBe(201);
    expect(await levelsOf()).toBe(before);
    // وليس الكمّ وحده: القيمة تعود أيضاً. قبل R3 كان العكس يصرف بمتوسط اليوم فيعلق فرقٌ
    // في قيمة المخزون ولا يطابق رصيدُ المخزون مجموعَ حركاته.
    const afterBalance = await balanceOf();
    expect(afterBalance.value).toBe(beforeBalance.value);
    expect(afterBalance.averageCost).toBe(beforeBalance.averageCost);

    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; kind: string; reversalOf: string | null }>;
    expect(entries.some((row) => row.kind === 'reversal' && row.reversalOf === original.id)).toBe(true);

    // A paid (cash-settled) purchase cannot be voided while the payment stands.
    const chart = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const till = ((chart.body.data ?? chart.body) as Array<{ id: string; code: string }>).find((row) => row.code === '1211001');
    const paid = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const paidDraft = data(paid.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/purchase-invoices/${paidDraft.id}/post`, {
      token: actor.token,
      body: { settlement: 'cash', settlementAccountId: till!.id },
    });
    const refused = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${paidDraft.id}/void`, {
      token: actor.token,
      body: { reason: 'محاولة إلغاء مدفوعة' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PURCHASE_VOID_HAS_PAYMENTS');
  });

  it('guards the purchase document chain in both directions', async () => {
    const invoice = await postPurchase({ quantity: '2', unitPrice: '100' });
    const returnDraft = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        kind: 'purchase_return',
        referenceInvoiceId: invoice.id,
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(returnDraft.status).toBe(201);
    const credit = data(returnDraft.body) as { id: string };
    const returnPosted = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${credit.id}/post`, { token: actor.token, body: {} });
    expect(returnPosted.status).toBe(201);
    expect((data(returnPosted.body) as { number: string }).number).toMatch(/^PR-\d{6}$/);

    // الإلغاء مرفوض، والرفض يسمّي المستند الذي يحجب.
    const blocked = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاءٌ والمردود قائم' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PURCHASE_VOID_HAS_RETURNS');
    const errors = (blocked.body.errors ?? []) as Array<{ count: number; references: Array<{ id: string }> }>;
    expect(errors[0]?.count).toBe(1);
    expect(errors[0]?.references[0]?.id).toBe(credit.id);

    // والفاتورة لم تُمسّ: الرفض قبل أي كتابة.
    const untouched = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${invoice.id}`, { token: actor.token });
    expect((data(untouched.body) as { status: string }).status).toBe('posted');

    // إلغاء المردود يفتح الباب — لا حبسَ مقصوداً في الحاجز.
    const returnVoided = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${credit.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء المردود أولاً' },
    });
    expect(returnVoided.status).toBe(201);
    const nowAllowed = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'لم يبقَ مردودٌ مُرحَّل' },
    });
    expect(nowAllowed.status).toBe(201);
    expect((data(nowAllowed.body) as { status: string }).status).toBe('voided');
  }, 120_000);

  it('refuses to post a return whose source purchase was voided in the meantime', async () => {
    const invoice = await postPurchase({ quantity: '3', unitPrice: '100' });
    const returnDraft = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: supplierId,
        kind: 'purchase_return',
        referenceInvoiceId: invoice.id,
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
      },
    });
    const credit = data(returnDraft.body) as { id: string };

    // المردود **مسودّة** أثرُه صفر، فلا يحجب الإلغاء.
    const voided = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاءٌ والمردود مسودّة' },
    });
    expect(voided.status).toBe(201);
    expect((data(voided.body) as { status: string }).status).toBe('voided');

    const refused = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${credit.id}/post`, { token: actor.token, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PURCHASE_REFERENCE_VOIDED');
    const still = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${credit.id}`, { token: actor.token });
    expect((data(still.body) as { status: string }).status).toBe('draft');
  }, 120_000);

  it('returns the payment allocations on the invoice (was visible only as paidTotal)', async () => {
    // دفعةٌ نقدية كتبها الترحيل نفسه.
    const chart = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const till = ((chart.body.data ?? chart.body) as Array<{ id: string; code: string }>).find((row) => row.code === '1211001');
    const cash = await api(ctx.server, 'post', '/api/v1/purchase-invoices', {
      token: actor.token,
      body: { branchId, warehouseId, partyId: supplierId, lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }] },
    });
    const cashDraft = data(cash.body) as { id: string };
    await api(ctx.server, 'post', `/api/v1/purchase-invoices/${cashDraft.id}/post`, {
      token: actor.token,
      body: { settlement: 'cash', settlementAccountId: till!.id },
    });
    const settled = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${cashDraft.id}`, { token: actor.token });
    const settledPayments = (data(settled.body) as { payments: Array<{ amount: string; invoiceKind: string }> }).payments;
    expect(settledPayments).toHaveLength(1);
    expect(settledPayments[0]).toMatchObject({ amount: '115.0000', invoiceKind: 'purchase' });

    // ودفعةٌ لاحقة على فاتورةٍ آجلة تظهر هي الأخرى.
    const credit = await postPurchase({ quantity: '1', unitPrice: '100' });
    const added = await api(ctx.server, 'post', `/api/v1/purchase-invoices/${credit.id}/payments`, {
      token: actor.token,
      body: { amount: '50' },
    });
    expect(added.status).toBe(201);
    const reread = await api(ctx.server, 'get', `/api/v1/purchase-invoices/${credit.id}`, { token: actor.token });
    const payments = (data(reread.body) as { payments: Array<{ amount: string }>; paidTotal: string; paymentStatus: string }).payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amount).toBe('50.0000');
    expect((data(reread.body) as { paymentStatus: string }).paymentStatus).toBe('partial');
  }, 120_000);
});
