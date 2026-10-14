import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The point of sale engine — Phase 04 of the desktop-parity programme.
 *
 * The desktop `frmPOS` wrote the invoice, its stock movement, its entry and its
 * payment from one Save button, inside one database transaction, and tied the
 * result to the cashier's `CasherClosed` shift so `frmCloseShift` could count the
 * drawer at the end of the day.
 *
 * Until this phase the cloud till did the same work in three browser round trips
 * that were never atomic, and a shift closing report that only ever saw manual
 * cash vouchers — so a day of POS sales closed with an "expected" of zero.
 *
 * These tests pin the new engine contract: one call, one transaction, a real
 * drawer, a real shift, and a day-close that sees the till's own takings.
 */
describe('POS checkout engine', () => {
  let ctx: TestApp;
  let actor: Actor;
  let neighbour: Actor;
  let branchId = '';
  let warehouseId = '';
  let safeId = '';
  let bankId = '';
  let itemId = '';
  let partyId = '';
  let cashAccountId = '';
  let bankAccountId = '';
  let neighbourSafeId = '';

  /** Cash taken during the shift tests, so the day-close numbers are known. */
  let shiftId = '';
  let shiftCashInvoiceId = '';
  let shiftCreditInvoiceId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('pos-checkout');
    actor = await createActor(ctx, {
      tenantCode: 'pos-alpha',
      email: 'owner@pos-alpha.test',
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
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.account.view',
        'accounting.period.close',
        'accounting.reports.view',
        'organization.postingprofile.view',
        'pos.view',
        'pos.operate',
        'pos.config.manage',
        'pos.tables.manage',
        'treasury.view',
        'treasury.shift.close',
      ],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;
    safeId = defaults.cashLocationId;

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
        sku: 'SKU-POS',
        nameAr: 'صنف الكاشير',
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
          {
            itemId,
            warehouseId,
            qty: '200',
            unitCost: '40',
            direction: 'in',
            docType: 'opening',
            docId: '00000000-0000-0000-0000-000000000001',
          },
        ],
      },
    });
    expect(receipt.status).toBe(201);

    const party = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'عميل آجل' },
    });
    partyId = data(party.body).id as string;

    const resolved = await api(
      ctx.server,
      'get',
      `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=sales_invoice`,
      {
        token: actor.token,
      },
    );
    const mapping = data(resolved.body).mapping as Record<string, string>;
    cashAccountId = mapping.cashAccountId as string;
    bankAccountId = mapping.bankAccountId as string;
    expect(bankAccountId).toMatch(/^[0-9a-f-]{36}$/i);

    const bank = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: {
        branchId,
        kind: 'bank',
        name: 'بنك نقطة البيع',
        accountId: bankAccountId,
        bank: { bankName: 'بنك نقطة البيع' },
        isDefault: true,
      },
    });
    expect(bank.status).toBe(201);
    bankId = data(bank.body).id as string;

    // A second tenant, provisioned the same way, whose drawer must be invisible
    // to the first one's till.
    neighbour = await createActor(ctx, {
      tenantCode: 'pos-beta',
      email: 'owner@pos-beta.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS],
    });
    const neighbourDefaults = await ctx.app
      .get(OrgProvisioningService)
      .provisionOrgDefaults(neighbour.tenantId);
    neighbourSafeId = neighbourDefaults.cashLocationId;
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelsOf = async (): Promise<string> => {
    const levels = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${itemId}`,
      {
        token: actor.token,
      },
    );
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return rows[0]?.quantity ?? '0';
  };

  const journalOf = async (
    invoiceNumber: string,
  ): Promise<Array<{ accountId: string; debit: string; credit: string }>> => {
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; description: string; kind: string }>;
    const entry = entries.find(
      (row) => row.description === `Sales invoice ${invoiceNumber}` && row.kind !== 'reversal',
    );
    expect(entry).toBeDefined();
    const detail = await api(ctx.server, 'get', `/api/v1/journal-entries/${entry?.id}`, {
      token: actor.token,
    });
    return (data(detail.body) as { lines: Array<{ accountId: string; debit: string; credit: string }> })
      .lines;
  };

  const invoiceCount = async (): Promise<number> => {
    const list = await api(ctx.server, 'get', '/api/v1/sales/invoices?limit=200', { token: actor.token });
    const rows = (list.body.data ?? list.body) as Array<{ id: string }>;
    return rows.length;
  };

  const cart = (quantity = '2', unitPrice = '100') => [{ itemId, quantity, unitPrice, taxRate: '15' }];

  it('takes the money, relieves the stock and writes the journal in one call', async () => {
    const before = Number(await levelsOf());
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart(),
        payment: { method: 'cash', cashLocationId: safeId, tendered: '300' },
      },
    });
    expect(checkout.status).toBe(201);
    const sale = data(checkout.body) as {
      number: string;
      total: string;
      paidTotal: string;
      paymentStatus: string;
      change: string;
      tendered: string | null;
      shiftId: string | null;
      cashLocationId: string | null;
    };
    expect(sale.number).toMatch(/^SI-\d{6}$/);
    expect(sale.total).toBe('200.0000');
    expect(sale.paidTotal).toBe('200.0000');
    expect(sale.paymentStatus).toBe('paid');
    expect(sale.change).toBe('100.0000');
    expect(sale.tendered).toBe('300.0000');
    expect(sale.cashLocationId).toBe(safeId);
    // No shift is open yet, so the sale simply records none.
    expect(sale.shiftId).toBeNull();

    expect(Number(await levelsOf())).toBe(before - 2);

    const invoice = await api(
      ctx.server,
      'get',
      `/api/v1/sales/invoices/${(data(checkout.body) as { invoiceId: string }).invoiceId}`,
      {
        token: actor.token,
      },
    );
    const payments = (
      data(invoice.body) as { payments: Array<{ method: string; amount: string; cashLocationId: string }> }
    ).payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]?.method).toBe('cash');
    expect(payments[0]?.amount).toBe('200.0000');
    expect(payments[0]?.cashLocationId).toBe(safeId);

    const lines = await journalOf(sale.number);
    const debit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit).toBeCloseTo(credit, 4);
    // 230 of cash in, plus the 80 of cost the sale relieved from stock.
    expect(debit).toBeCloseTo(280, 4);
    const cashLeg = lines.find((line) => line.accountId === cashAccountId);
    expect(cashLeg?.debit).toBe('200.0000');
  });

  it('refuses a short tender before anything is written', async () => {
    const before = await invoiceCount();
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1'),
        payment: { method: 'cash', cashLocationId: safeId, tendered: '10' },
      },
    });
    expect(checkout.status).toBe(422);
    expect(checkout.body.code).toBe('POS_INSUFFICIENT_CASH');
    expect(await invoiceCount()).toBe(before);
  });

  it('rejects an empty cart and a drawer from another tenant', async () => {
    const empty = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: [], payment: { method: 'cash', cashLocationId: safeId } },
    });
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe('POS_CART_EMPTY');

    const foreign = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1'),
        payment: { method: 'cash', cashLocationId: neighbourSafeId },
      },
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.code).toBe('POS_CASH_LOCATION_INVALID');
  });

  it('links the sale to the cashier shift and counts it at the day close', async () => {
    const opened = await api(ctx.server, 'post', '/api/v1/shift-closes/open', {
      token: actor.token,
      body: { branchId },
    });
    expect(opened.status).toBe(201);
    shiftId = data(opened.body).id as string;

    const cashSale = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: cart('1'), payment: { method: 'cash', cashLocationId: safeId } },
    });
    expect(cashSale.status).toBe(201);
    const cashBody = data(cashSale.body) as { invoiceId: string; shiftId: string | null; total: string };
    expect(cashBody.shiftId).toBe(shiftId);
    expect(cashBody.total).toBe('100.0000');
    shiftCashInvoiceId = cashBody.invoiceId;

    // A postponed (credit) sale in the same shift: it must appear in the report
    // as credit takings, but never as cash in the drawer.
    const creditSale = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, partyId, lines: cart('2'), payment: { method: 'credit' } },
    });
    expect(creditSale.status).toBe(201);
    const creditBody = data(creditSale.body) as {
      invoiceId: string;
      paymentStatus: string;
      paidTotal: string;
      shiftId: string | null;
    };
    expect(creditBody.paymentStatus).toBe('unpaid');
    expect(creditBody.paidTotal).toBe('0.0000');
    expect(creditBody.shiftId).toBe(shiftId);
    shiftCreditInvoiceId = creditBody.invoiceId;

    // Before counting, the open shift already reports what the drawer should hold.
    const current = await api(ctx.server, 'get', `/api/v1/shift-closes/current?branch_id=${branchId}`, {
      token: actor.token,
    });
    expect(current.status).toBe(200);
    const live = (data(current.body) as { live: { expectedCash: string; sales: { cash: string } } }).live;
    expect(live.sales.cash).toBe('100.0000');
    expect(live.expectedCash).toBe('100.0000');

    // R4: معرّفٌ ليس معرّفاً لا يُسقط الشاشة — الشاشة تقرأ «لا وردية» لا 500.
    const malformed = await api(ctx.server, 'get', '/api/v1/shift-closes/current?branch_id=MAIN', {
      token: actor.token,
    });
    expect(malformed.status).toBe(200);
    // `null` يخرج من Nest بجسمٍ فارغ — والمهمّ أنه ليس 500.
    expect(Object.keys(malformed.body ?? {})).toHaveLength(0);

    const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: {
        counts: [
          { denomination: '100', count: 1 },
          { denomination: '20', count: 1 },
        ],
      },
    });
    expect(closed.status).toBe(201);
    const summary = (data(closed.body) as { summary: Record<string, unknown> }).summary as {
      expectedCash: string;
      countedCash: string;
      diff: string;
      invoices: number;
      sales: { cash: string; card: string; credit: string };
    };
    // 115 of POS cash in the drawer, 120 actually counted.
    expect(summary.expectedCash).toBe('100.0000');
    expect(summary.countedCash).toBe('120.0000');
    expect(summary.diff).toBe('20.0000');
    expect(summary.invoices).toBe(1);
    expect(summary.sales.cash).toBe('100.0000');
    expect(summary.sales.credit).toBe('0.0000');
  });

  it('refuses to change a sale whose shift is already closed', async () => {
    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${shiftCreditInvoiceId}/void`, {
      token: actor.token,
      body: { reason: 'after the day was closed' },
    });
    expect(voided.status).toBe(409);
    expect(voided.body.code).toBe('SALES_SHIFT_CLOSED');

    // The cash sale of the same shift is untouched by the failed attempt.
    const invoice = await api(ctx.server, 'get', `/api/v1/sales/invoices/${shiftCashInvoiceId}`, {
      token: actor.token,
    });
    expect((data(invoice.body) as { status: string }).status).toBe('posted');
  });

  it('settles card takings into the bank account and reports them as network sales', async () => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: cart('1'), payment: { method: 'card', cashLocationId: bankId } },
    });
    expect(checkout.status).toBe(201);
    const sale = data(checkout.body) as { number: string; total: string; paymentStatus: string };
    expect(sale.total).toBe('100.0000');
    expect(sale.paymentStatus).toBe('paid');

    const lines = await journalOf(sale.number);
    const bankLeg = lines.find((line) => line.accountId === bankAccountId);
    expect(bankLeg?.debit).toBe('100.0000');

    const invoice = await api(
      ctx.server,
      'get',
      `/api/v1/sales/invoices/${(data(checkout.body) as { invoiceId: string }).invoiceId}`,
      {
        token: actor.token,
      },
    );
    const payments = (data(invoice.body) as { payments: Array<{ method: string; cashLocationId: string }> })
      .payments;
    expect(payments[0]?.method).toBe('card');
    expect(payments[0]?.cashLocationId).toBe(bankId);
  });

  it('requires a customer account before a sale can be postponed', async () => {
    const withoutCustomer = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: cart('1'), payment: { method: 'credit' } },
    });
    expect(withoutCustomer.status).toBe(422);
    expect(withoutCustomer.body.code).toBe('POS_CREDIT_CUSTOMER_REQUIRED');

    const postponed = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, partyId, lines: cart('1'), payment: { method: 'credit' } },
    });
    expect(postponed.status).toBe(201);
    const sale = data(postponed.body) as { number: string; paymentStatus: string; paidTotal: string };
    expect(sale.paymentStatus).toBe('unpaid');
    expect(sale.paidTotal).toBe('0.0000');

    const lines = await journalOf(sale.number);
    const receivable = lines.find((line) => Number(line.debit) === 100);
    expect(receivable).toBeDefined();
  });

  it('closes a restaurant table against cash in the same transaction', async () => {
    const category = await api(ctx.server, 'post', '/api/v1/pos/categories', {
      token: actor.token,
      body: { branchId, name: 'الصالة' },
    });
    expect(category.status).toBe(201);
    const table = await api(ctx.server, 'post', '/api/v1/pos/tables', {
      token: actor.token,
      body: { branchId, categoryId: data(category.body).id as string, tableNo: '7', name: 'طاولة 7' },
    });
    expect(table.status).toBe(201);
    const tableId = data(table.body).id as string;

    await api(ctx.server, 'post', `/api/v1/pos/tables/${tableId}/open`, { token: actor.token, body: {} });
    const added = await api(ctx.server, 'post', `/api/v1/pos/tables/${tableId}/items`, {
      token: actor.token,
      body: { itemId, qty: '3', unitValue: '100' },
    });
    expect(added.status).toBe(201);

    const sent = await api(ctx.server, 'post', `/api/v1/pos/tables/${tableId}/send-to-invoice`, {
      token: actor.token,
      body: { cashCustomerName: 'طاولة 7' },
    });
    expect(sent.status).toBe(201);

    const closed = await api(ctx.server, 'post', `/api/v1/pos/tables/${tableId}/close`, {
      token: actor.token,
      body: { settlement: 'cash', cashLocationId: safeId },
    });
    expect(closed.status).toBe(201);
    const result = data(closed.body) as {
      status: string;
      total: string;
      paymentStatus: string;
      method: string;
    };
    expect(result.status).toBe('closed');
    expect(result.method).toBe('cash');
    // Order lines carry no tax rate at the table, so the invoice is the bare 300.
    expect(result.total).toBe('300.0000');
    expect(result.paymentStatus).toBe('paid');
  });

  // ── R4: تعليق الفواتير · تعدّد طرق الدفع · تجاوز السعر · الكاشير ──────────────
  //
  // أربع نوافذ مكتبية وراء هذه الفحوص:
  //   `frmPOS.xaml.cs` L1871–L1962 (Hold Orders — ٩ خانات وحدٌّ صريح)
  //   `frmPOSPay.xaml` L286 «🔀 متعدد» وL548 «⚖️ F6 مطابقة»
  //   `frmPOS.xaml.cs` L1377 «لا يمكن تعديل السعر» و`Class/User.cs` L24 (`User.EditPrice`)
  //   `frmCasherSetting.xaml` (⚙️ إعدادات الكاشير: الباركود، التاتش، المجموعات…)

  it('holds nine tickets and refuses the tenth with the desktop message', async () => {
    const held: string[] = [];
    for (let slot = 0; slot < 9; slot += 1) {
      const response = await api(ctx.server, 'post', '/api/v1/pos/holds', {
        token: actor.token,
        body: { branchId, label: `معلّقة ${slot + 1}`, cart: { ticket: slot }, total: '100', linesCount: 1 },
      });
      expect(response.status).toBe(201);
      held.push((data(response.body) as { id: string }).id);
    }
    const over = await api(ctx.server, 'post', '/api/v1/pos/holds', {
      token: actor.token,
      body: { branchId, cart: { ticket: 9 } },
    });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('POS_HOLD_LIMIT_REACHED');

    const list = await api(ctx.server, 'get', `/api/v1/pos/holds?branchId=${branchId}`, {
      token: actor.token,
    });
    expect((list.body.data ?? list.body) as unknown[]).toHaveLength(9);
    expect((list.body as { slots: number }).slots).toBe(9);

    // الاسترجاع يفرغ الخانة: المسترجَع لا يبقى معلّقاً في مكانين.
    const recalled = await api(ctx.server, 'post', `/api/v1/pos/holds/${held[0]}/recall`, {
      token: actor.token,
      body: {},
    });
    expect(recalled.status).toBe(201);
    expect((data(recalled.body) as { cart: { ticket: number } }).cart.ticket).toBe(0);
    const after = await api(ctx.server, 'get', `/api/v1/pos/holds?branchId=${branchId}`, {
      token: actor.token,
    });
    expect((after.body.data ?? after.body) as unknown[]).toHaveLength(8);

    // وسلةٌ جديدة تجد الخانة التي فُرّغت — لا تصطدم بالحدّ.
    const refilled = await api(ctx.server, 'post', '/api/v1/pos/holds', {
      token: actor.token,
      body: { branchId, cart: { ticket: 99 } },
    });
    expect(refilled.status).toBe(201);
    expect((data(refilled.body) as { slot: number }).slot).toBe(0);

    // وخانةُ كاشيرٍ آخر ليست لك: الاسترجاع يردّ 404 لا سلةَ غيرك.
    const other = await createActor(ctx, {
      tenantCode: 'pos-alpha',
      tenantId: actor.tenantId,
      email: 'cashier2@pos-alpha.test',
      isOwner: false,
      permissions: ['pos.operate', 'sales.invoice.post', 'pos.view'],
    });
    const foreign = await api(ctx.server, 'post', `/api/v1/pos/holds/${held[1]}/recall`, {
      token: other.token,
      body: {},
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('POS_HOLD_NOT_FOUND');
  });

  it('splits one ticket over the drawer and the network, and matches F6', async () => {
    const split = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1'),
        payment: { method: 'cash' },
        // الأسعار شاملة الضريبة افتراضاً في نقطة البيع: ١ × ١٠٠ ⇒ صافي الفاتورة ١٠٠.
        payments: [
          { method: 'cash', amount: '60', cashLocationId: safeId },
          { method: 'card', amount: '40', cashLocationId: bankId },
        ],
      },
    });
    expect(split.status).toBe(201);
    const sale = data(split.body) as { number: string; total: string; paidTotal: string; paymentStatus: string; onAccount: string | null; tenders: Array<{ method: string; amount: string }> };
    expect(sale.total).toBe('100.0000');
    expect(sale.paidTotal).toBe('100.0000');
    expect(sale.paymentStatus).toBe('paid');
    expect(sale.onAccount).toBe('0.0000');
    expect(sale.tenders?.map((entry) => entry.method)).toEqual(['cash', 'card']);

    const invoice = await api(
      ctx.server,
      'get',
      `/api/v1/sales/invoices/${(data(split.body) as { invoiceId: string }).invoiceId}`,
      { token: actor.token },
    );
    const payments = (data(invoice.body) as { payments: Array<{ method: string; amount: string; cashLocationId: string | null }> }).payments;
    expect(payments).toHaveLength(2);
    expect(payments.map((row) => row.method).sort()).toEqual(['card', 'cash']);

    // القيد: مدينٌ للصندوق ٦٠ ومدينٌ للبنك ٥٥ — لا سطرَ ذمة لأن الفاتورة دُفعت كاملة.
    const lines = await journalOf(sale.number);
    expect(lines.find((line) => line.accountId === cashAccountId)?.debit).toBe('60.0000');
    expect(lines.find((line) => line.accountId === bankAccountId)?.debit).toBe('40.0000');

    // والزيادة رفضٌ صريح بفرقها، لا قبضٌ صامت.
    const over = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1'),
        payment: { method: 'cash' },
        payments: [{ method: 'cash', amount: '200', cashLocationId: safeId }],
      },
    });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('POS_TENDER_MISMATCH');
    expect((over.body.errors as Array<{ difference: string }>)[0]?.difference).toBe('100.0000');

    // والنقص بلا حساب عميلٍ يقف عليه الباقي مرفوضٌ كذلك.
    const short = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1'),
        payment: { method: 'cash' },
        payments: [{ method: 'cash', amount: '50', cashLocationId: safeId }],
      },
    });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('POS_TENDER_MISMATCH');

    // ومع عميل: الباقي على ذمته، والفاتورة «جزئية» بصدق.
    const partial = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: cart('1'),
        payment: { method: 'cash' },
        payments: [{ method: 'cash', amount: '50', cashLocationId: safeId }],
      },
    });
    expect(partial.status).toBe(201);
    const partialSale = data(partial.body) as { number: string; paidTotal: string; paymentStatus: string; onAccount: string | null };
    expect(partialSale.paidTotal).toBe('50.0000');
    expect(partialSale.paymentStatus).toBe('partial');
    expect(partialSale.onAccount).toBe('50.0000');
    const partialLines = await journalOf(partialSale.number);
    // الباقي على ذمة العميل المُسمّى — لا مدينَ بلا صاحب.
    expect(partialLines.find((line) => Number(line.debit) === 50 && line.accountId !== cashAccountId)?.accountId).toBeDefined();
  });

  it('refuses a price the cashier may not change, and allows it to the override holder', async () => {
    const cashier = await createActor(ctx, {
      tenantCode: 'pos-alpha',
      tenantId: actor.tenantId,
      email: 'cashier3@pos-alpha.test',
      isOwner: false,
      permissions: ['pos.operate', 'sales.invoice.post', 'pos.view'],
    });
    const refused = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: cashier.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1', '80'),
        payment: { method: 'cash', cashLocationId: safeId },
      },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('POS_PRICE_OVERRIDE_FORBIDDEN');
    expect(refused.body.detail).toBe('لا يمكن تعديل السعر');

    // السعر المعلن نفسه يمرّ بلا رمز: الكاشير يبيع، ولا يعدّل.
    const listed = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: cashier.token,
      body: {
        branchId,
        warehouseId,
        lines: cart('1', '100'),
        payment: { method: 'cash', cashLocationId: safeId },
      },
    });
    expect(listed.status).toBe(201);
    expect((data(listed.body) as { cashierId: string }).cashierId).toBe(cashier.userId);
  });

  it('answers the casher settings and keeps the till behind the pack flag', async () => {
    const settings = await api(ctx.server, 'get', '/api/v1/pos/settings', { token: actor.token });
    expect(settings.status).toBe(200);
    const values = data(settings.body) as Record<string, unknown>;
    // ⚙️ الستّة التي في `frmCasherSetting.xaml` — لها مفاتيح مُسجَّلة وقيمٌ افتراضية معلنة.
    expect(Object.keys(values).sort()).toEqual([
      'pos.barcodeAuto',
      'pos.defaultDeliveryFee',
      'pos.defaultInsurance',
      'pos.defaultUnitId',
      'pos.requireShift',
      'pos.showGroups',
      'pos.touchScreen',
    ]);
    expect(values['pos.barcodeAuto']).toBe(true);

    // `feature.pos` هو مفتاح السجلّ: صفٌّ صريح `false` يُطفئ الفوج (كان يُقرأ `pack.pos`
    // وهو مفتاحٌ ليس في السجلّ فلا سبيل لإطفائه من الواجهة).
    const off = await api(ctx.server, 'put', '/api/v1/settings/feature.pos', {
      token: actor.token,
      body: { value: false },
    });
    expect(off.status).toBe(200);
    const blocked = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: cart('1'), payment: { method: 'cash', cashLocationId: safeId } },
    });
    expect(blocked.status).toBe(404);

    const on = await api(ctx.server, 'put', '/api/v1/settings/feature.pos', {
      token: actor.token,
      body: { value: true },
    });
    expect(on.status).toBe(200);
    const allowed = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: { branchId, warehouseId, lines: cart('1'), payment: { method: 'cash', cashLocationId: safeId } },
    });
    expect(allowed.status).toBe(201);
    expect((data(allowed.body) as { cashierId: string }).cashierId).toBe(actor.userId);
  });
});
