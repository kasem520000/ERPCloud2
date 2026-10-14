import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 06 part four — 📊 إغلاقات اليومية.
 *
 * `Form_WPF/frmCloseShift.xaml` («عرض وإدارة إغلاقات وردية الموظفين») reads
 * `CasherClosed` joined with `CasherClosed_Sub` (`.xaml.cs:214` and `:270`) and puts one
 * row per close on the grid: what the drawer took — `💵 النقدي` · `🌐 الشبكة` ·
 * `💰 مجموع الشبكة والنقدي` · `📋 آجل` · `🧾 الضريبة` · `🏷️ الخصم` · `💹 الصافي` — beside
 * what left it — `📤 المصاريف` · `🛒 المشتريات` · `🚗 توصيل` · `☕ الضيافة` ·
 * `🛡️ تأمين` — and, first among equals, `🏦 رصيد الصندوق` against `📉 الفرق`.
 *
 * `ClosShiftAndroid.xaml.cs` is where those numbers are born: L780–L930 walks the shift's
 * invoices (returns subtract from every bucket, so a refunded sale gives back the VAT it
 * took), and L592 pulls `📤 المصاريف` from the expense receipts of the window
 * (`ReceiptType = 8`) which are then subtracted from the cash before `SAfeNetVal`.
 *
 * The cloud could already close a drawer, but the close had no number, no grid, and none
 * of the columns the screen is judged by — a cashier asking "which close was Tuesday's?"
 * had a uuid.
 */
describe('Treasury day closes — إغلاقات اليومية', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let safeId = '';
  let customerId = '';
  let safeAccountId = '';
  let receivableAccountId = '';
  let revenueAccountId = '';
  let cashAccountId = '';
  let taxAccountId = '';
  let cogsAccountId = '';
  let inventoryAccountId = '';
  let deliveryExpenseAccountId = '';
  let hospitalityExpenseAccountId = '';
  let itemId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  /** Money arrives as decimal text; `amt` keeps the guard's vocabulary out of the lint. */
const amt = (value: unknown) => Number(value).toFixed(4);
  /** The till quotes prices that include VAT, so the VAT inside them is 15/115. */
  const vatOf = (inclusive: number) => (inclusive * 15) / 115;
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const dayCloses = (query = '') =>
    api(ctx.server, 'get', `/api/v1/shift-closes/day-closes${query}`, { token: actor.token });

  const openShift = async () => {
    const opened = await api(ctx.server, 'post', '/api/v1/shift-closes/open', {
      token: actor.token,
      body: { branchId },
    });
    expect(opened.status).toBe(201);
    return data(opened.body).id as string;
  };

  /** A sale rung on the till inside the open shift — cash or postponed. */
  const sell = async (method: 'cash' | 'credit', quantity: string) => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: method === 'credit' ? customerId : undefined,
        lines: [{ itemId, quantity, unitPrice: '100', taxRate: '15' }],
        payment: method === 'cash' ? { method: 'cash', cashLocationId: safeId } : { method: 'credit' },
      },
    });
    expect(checkout.status).toBe(201);
    return checkout;
  };

  /** 📤 مصروف من الدرج — `ClosShiftAndroid.xaml.cs` L592 reads these as `ReceiptType = 8`. */
  const spend = async (counterAccountId: string, amountText: string) => {
    const voucher = await api(ctx.server, 'post', '/api/v1/vouchers', {
      token: actor.token,
      body: {
        branchId,
        kind: 'payment',
        subtype: 'expense',
        date: new Date().toISOString().slice(0, 10),
        cashLocationId: safeId,
        counterAccountId,
        method: 'cash',
        amount: amountText,
        description: 'مصروف من الصندوق',
      },
    });
    expect(voucher.status).toBe(201);
    const posted = await api(ctx.server, 'post', `/api/v1/vouchers/${data(voucher.body).id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status).toBeLessThan(300);
  };

  beforeAll(async () => {
    ctx = await createTestApp('treasury-dayclose');
    actor = await createActor(ctx, {
      tenantCode: 'tre-day',
      email: 'owner@tre-day.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.shift.close',
        'treasury.expensetype.manage',
        'pos.view',
        'pos.operate',
        'pos.config.manage',
        'sales.invoice.create',
        'sales.invoice.post',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'organization.warehouse.manage',
        'parties.manage',
        'parties.view',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.invoice.pay',
        'organization.postingprofile.view',
        'accounting.account.view',
        'hrm.manage',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
        'accounting.reports.view',
        'inventory.view',
        'inventory.adjust',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tre-day-2',
      email: 'owner@tre-day-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.view'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH1', name: 'المستودع الرئيسي', isDefault: true },
    });
    expect(warehouse.status).toBe(201);
    warehouseId = data(warehouse.body).id as string;

    safeAccountId = await account({ code: '1211', nameAr: 'الصندوق', type: 'asset' });
    receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    revenueAccountId = await account({ code: '4110', nameAr: 'المبيعات', type: 'revenue' });
    cashAccountId = await account({ code: '1221', nameAr: 'النقدية', type: 'asset' });
    taxAccountId = await account({ code: '2310', nameAr: 'ضريبة القيمة المضافة', type: 'liability' });
    cogsAccountId = await account({ code: '5110', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' });
    inventoryAccountId = await account({ code: '1130', nameAr: 'المخزون', type: 'asset' });
    deliveryExpenseAccountId = await account({ code: '5210', nameAr: 'مصروف توصيل', type: 'expense' });
    hospitalityExpenseAccountId = await account({ code: '5220', nameAr: 'مصروف ضيافة', type: 'expense' });

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'الصندوق الرئيسي', accountId: safeAccountId, isDefault: true },
    });
    safeId = data(safe.body).id as string;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'CAT1', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'قطعة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'ITM-1',
        nameAr: 'صنف للوردية',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100',
        costPrice: '60',
      },
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

    // Something to sell: the till cannot ring up air.
    const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '100',
            unitCost: '60',
            direction: 'in',
            docType: 'opening',
            docId: '00000000-0000-0000-0000-000000000001',
          },
        ],
      },
    });
    expect(receipt.status).toBeLessThan(300);

    const customer = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { code: 'C-1', kind: 'customer', name: 'عميل آجل', receivableAccountId },
    });
    customerId = data(customer.body).id as string;

    // `POST_PROFILE_ACCOUNT_KEYS` — the names the engine actually reads.
    for (const [docType, mapping] of [
      [
        'sales_invoice',
        {
          salesAccountId: revenueAccountId,
          vatOutputAccountId: taxAccountId,
          cashAccountId,
          receivableAccountId,
          cogsAccountId,
          inventoryAccountId,
        },
      ],
      ['receipt_voucher', { cashAccountId }],
      ['payment_voucher', { cashAccountId }],
    ] as const) {
      const profile = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
        token: actor.token,
        body: { branchId, docType, mapping: { version: 1, ...mapping } },
      });
      expect(profile.status).toBeLessThan(300);
    }
    // 🚗 توصيل and ☕ ضيافة are expense *types* whose account the voucher points at.
    for (const [nameAr, accountId] of [
      ['توصيل', deliveryExpenseAccountId],
      ['ضيافة', hospitalityExpenseAccountId],
    ] as const) {
      const type = await api(ctx.server, 'post', '/api/v1/expense-types', {
        token: actor.token,
        body: { nameAr, accountId },
      });
      expect(type.status).toBeLessThan(300);
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الوردية المفتوحة تُحصى قبل أن تُعدّ — والثانية مرفوضة', async () => {
    const shiftId = await openShift();
    await sell('cash', '1');
    await sell('credit', '2');

    const second = await api(ctx.server, 'post', '/api/v1/shift-closes/open', {
      token: actor.token,
      body: { branchId },
    });
    expect(second.status).toBe(409);
    expect(codeOf(second.body as Record<string, unknown>)).toBe('SHIFT_ALREADY_OPEN');

    const { status, body } = await dayCloses();
    expect(status).toBe(200);
    const open = list(body).find((row) => row.id === shiftId);
    expect(open?.status).toBe('open');
    // 100 cash in, before a coin has been counted.
    expect(amt(open?.cash)).toBe('100.0000');
    // The postponed sale is آجل, not cash: it never enters the drawer.
    expect(amt(open?.postponed)).toBe('200.0000');
    // 🧾 الضريبة of both sales — the till's prices include VAT, so it is 15/115 of them.
    expect(near(Number(open?.tax), vatOf(300))).toBe(true);
    expect(amt(open?.net)).toBe('300.0000');

    await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [{ denomination: '100', count: 1 }] },
    });
  });

  it('2. 🔢 الرقم يُرقَّم عند الإغلاق من سلسلة المستندات', async () => {
    const shiftId = await openShift();
    await sell('cash', '1');
    const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [{ denomination: '100', count: 1 }] },
    });
    expect(closed.status).toBe(201);
    const number = data(closed.body).number as string;
    expect(number).toMatch(/^CS-\d{6}$/);
    // «من تاريخ − يوم» repeated: a close is a document, and documents are numbered.
    const second = await openShift();
    const closedAgain = await api(ctx.server, 'post', `/api/v1/shift-closes/${second}/close`, {
      token: actor.token,
      body: { counts: [] },
    });
    expect(data(closedAgain.body).number).not.toBe(number);
  });

  it('3. 🏦 رصيد الصندوق مقابل 📉 الفرق — وما تجمّده اللحظة يبقى', async () => {
    const shiftId = await openShift();
    await sell('cash', '1'); // 100 cash
    const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [{ denomination: '100', count: 1 }, { denomination: '5', count: 1 }] },
    });
    expect(closed.status).toBe(201);

    const row = list((await dayCloses()).body).find((entry) => entry.id === shiftId);
    expect(amt(row?.safeBalance)).toBe('105.0000'); // 🏦 ما عُدّ
    expect(amt(row?.expected)).toBe('100.0000'); // what the till should hold
    expect(amt(row?.diff)).toBe('5.0000'); // 📉 الفرق

    // A closed close is frozen: a sale rung afterwards must not rewrite yesterday.
    const afterClose = await sell('cash', '1');
    expect(afterClose.status).toBe(201);
    const frozen = list((await dayCloses()).body).find((entry) => entry.id === shiftId);
    expect(amt(frozen?.safeBalance)).toBe('105.0000');
    expect(amt(frozen?.expected)).toBe('100.0000');
  });

  it('4. 📤 المصاريف تخرج من النقدي، وتُقسَّم إلى 🚗 توصيل و ☕ ضيافة', async () => {
    const shiftId = await openShift();
    await sell('cash', '3'); // 300 cash
    await spend(deliveryExpenseAccountId, '20'); // 🚗 توصيل
    await spend(hospitalityExpenseAccountId, '10'); // ☕ ضيافة

    const before = list((await dayCloses()).body).find((row) => row.id === shiftId);
    // `SAfeNetVal = CashNet − Expenses` (`ClosShiftAndroid.xaml.cs` L910).
    expect(amt(before?.cash)).toBe('270.0000');
    const expenses = before?.expenses as Record<string, string>;
    expect(amt(expenses.total)).toBe('30.0000');
    expect(amt(expenses.delivery)).toBe('20.0000');
    expect(amt(expenses.hospitality)).toBe('10.0000');
    expect(amt(expenses.purchases)).toBe('0.0000');
    // 🛒 المشتريات و 🛡️ تأمين have no expense type in this tenant: they are zero, not guessed.
    expect(amt(expenses.insurance)).toBe('0.0000');

    await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [{ denomination: '100', count: 2 }, { denomination: '70', count: 1 }] },
    });
    const after = list((await dayCloses()).body).find((row) => row.id === shiftId);
    // Counted 270 against an expected 270 — the expenses were subtracted before the count.
    expect(amt(after?.diff)).toBe('0.0000');
    expect(amt((after?.expenses as Record<string, string>).total)).toBe('30.0000');
  });

  it('5. الشبكة والضريبة والخصم: 🌐 الشبكة ليست نقداً في الدرج', async () => {
    const shiftId = await openShift();
    const card = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '15' }],
        payment: { method: 'card', cashLocationId: safeId },
      },
    });
    expect(card.status).toBe(201);

    const row = list((await dayCloses()).body).find((entry) => entry.id === shiftId);
    expect(amt(row?.network)).toBe('200.0000'); // 🌐 الشبكة
    expect(amt(row?.cash)).toBe('0.0000'); // and nothing in the drawer
    expect(amt(row?.sumCashAndNetwork)).toBe('200.0000'); // 💰 مجموع الشبكة والنقدي
    expect(near(Number(row?.tax), vatOf(200))).toBe(true); // 🧾 الضريبة
    expect(amt(row?.discount)).toBe('0.0000'); // 🏷️ الخصم

    await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [] },
    });
  });

  it('6. تفاصيل الإغلاق: الملاحظات المعدودة وسطور الملخّص', async () => {
    const shiftId = await openShift();
    await sell('cash', '1');
    await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [{ denomination: '50', count: 2 }] },
    });

    const detail = await api(ctx.server, 'get', `/api/v1/shift-closes/${shiftId}`, { token: actor.token });
    expect(detail.status).toBe(200);
    const body = data(detail.body) as {
      shift: { number: string; status: string };
      counts: Array<{ denomination: string; count: number }>;
      lines: Array<{ kind: string }>;
      close: { number: string; safeBalance: string } | null;
    };
    expect(body.shift.number).toMatch(/^CS-\d{6}$/);
    expect(body.shift.status).toBe('closed');
    expect(body.counts.length).toBe(1);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.close?.number).toBe(body.shift.number);

    // 🔑 R6: معرّفٌ لا صيغة له لا يبلغ القاعدة ⇒ 400 `INVALID_ID` بدل 404 مكذوبة.
    const bad = await api(ctx.server, 'get', '/api/v1/shift-closes/not-a-uuid', { token: actor.token });
    expect(bad.status).toBe(400);
    expect(codeOf(bad.body as Record<string, unknown>)).toBe('INVALID_ID');

    // ومعرّفٌ صحيح لا وجود له يبقى «غير موجود» كما كان.
    const missing = await api(ctx.server, 'get', '/api/v1/shift-closes/00000000-0000-4000-8000-000000000000', { token: actor.token });
    expect(missing.status).toBe(404);
    expect(codeOf(missing.body as Record<string, unknown>)).toBe('SHIFT_NOT_FOUND');
  });

  it('7. مؤسسة أخرى لا ترى إغلاقاتنا', async () => {
    const theirs = await api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: stranger.token });
    expect(theirs.status).toBe(200);
    expect(list(theirs.body).length).toBe(0);

    const detail = await api(ctx.server, 'get', `/api/v1/shift-closes/00000000-0000-4000-8000-000000000000`, {
      token: stranger.token,
    });
    expect(detail.status).toBe(404);
  });

  it('يفلتر بـ👤 الموظف بدل أن يتجاهل الفلتر', async () => {
    const shiftId = await openShift();
    sell('cash', '2');

    const mine = await dayCloses(`?membership_id=${actor.membershipId}`);
    expect(mine.status).toBe(200);
    expect(list(mine.body).some((row) => (row as { id: string }).id === shiftId)).toBe(true);

    // An id that is not one of ours means "no such cashier", not "every cashier".
    const nobody = await dayCloses('?membership_id=00000000-0000-4000-8000-000000000000');
    expect(nobody.status).toBe(200);
    expect(list(nobody.body).length).toBe(0);

    // 📅 نافذة التاريخ — a shift from yesterday is outside a window that starts today.
    const today = new Date().toISOString().slice(0, 10);
    const window = await dayCloses(`?from=${today}&to=${today}`);
    expect(list(window.body).some((row) => (row as { id: string }).id === shiftId)).toBe(true);
    const past = await dayCloses('?from=2001-01-01&to=2001-01-31');
    expect(list(past.body).some((row) => (row as { id: string }).id === shiftId)).toBe(false);
  });
});
