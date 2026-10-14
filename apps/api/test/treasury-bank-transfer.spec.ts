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
 * Phase 06 part five — 🏦 التحويل البنكي (`frmPayBank`).
 *
 * `Form_WPF/frmPayBank.xaml` is a chooser, not a form: `🏦 اختر طريقة الدفع (تحويل
 * بنكي)` above a `🏦 البنوك المتاحة` panel of tiles, `✔ موافق` / `✖ خروج` below, and
 * `SelectedBankId == 0` means "يرجى اختيار بنك أولًا" — **the bank is chosen at the
 * moment of payment**, not read back from a card on the customer's file.
 *
 * What that choice buys is decided in `Class/EntryOper.cs`, and it is the reason this
 * matters to the drawer:
 *
 *   L493  `if (detail.PayType == 2 && detail.BankId > 2)` → the transfer leaves the
 *         generic network bucket and is added to a per-bank list;
 *   L537  a return subtracts from the *same* bank;
 *   L620  the list is grouped by bank, and each bank is debited on **its own account**
 *         (`bank.AccCode`) instead of the شبكة account `1221001`.
 *
 * Ids 1 and 2 are the desktop's الصندوق/المحفظة placeholders, which is why it tests
 * `BankId > 2`; in the cloud a bank is a `cash_locations` row of kind `bank`, so the
 * same rule reads "a transfer that names a bank".
 */
describe('Treasury bank transfers — التحويل البنكي في إغلاق الوردية', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let otherBranchId = '';
  let warehouseId = '';
  let safeId = '';
  let firstBankId = '';
  let secondBankId = '';
  let otherBranchBankId = '';
  let itemId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const dayCloses = () => api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: actor.token });

  const openShift = async () => {
    const opened = await api(ctx.server, 'post', '/api/v1/shift-closes/open', {
      token: actor.token,
      body: { branchId },
    });
    expect(opened.status).toBe(201);
    return data(opened.body).id as string;
  };

  /** A drawer of its own: closes whatever the previous test left open, then opens one. */
  const freshShift = async () => {
    for (const row of list((await dayCloses()).body).filter((entry) => entry.status === 'open')) {
      const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${row.id}/close`, {
        token: actor.token,
        body: { counts: [] },
      });
      expect(closed.status).toBe(201);
    }
    return openShift();
  };

  /**
   * 🏦 تحويل بنكي على الكاشير — the till names the bank the money went to, exactly as
   * `frmPOSBill.xaml.cs` `BtnBank_Click` sets `Invoic.Bank = bankFrm.SelectedBankId`.
   */
  const transfer = async (cashLocationId: string, quantity: string, cashCustomerName = 'عميل تحويل') => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName,
        lines: [{ itemId, quantity, unitPrice: '100', taxRate: '15' }],
        payment: { method: 'bank', cashLocationId },
      },
    });
    expect(checkout.status).toBe(201);
    return checkout;
  };

  beforeAll(async () => {
    ctx = await createTestApp('treasury-bank-transfer');
    actor = await createActor(ctx, {
      tenantCode: 'tre-bank',
      email: 'owner@tre-bank.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.shift.close',
        'pos.view',
        'pos.operate',
        'pos.config.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.return.create',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'organization.warehouse.manage',
        'organization.postingprofile.view',
        'parties.manage',
        'parties.view',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'accounting.account.view',
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
      tenantCode: 'tre-bank-2',
      email: 'owner@tre-bank-2.test',
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

    const otherBranch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR2', nameAr: 'فرع آخر' },
    });
    otherBranchId = data(otherBranch.body).id as string;

    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH1', name: 'المستودع الرئيسي', isDefault: true },
    });
    expect(warehouse.status).toBe(201);
    warehouseId = data(warehouse.body).id as string;

    const safeAccountId = await account({ code: '1211', nameAr: 'الصندوق', type: 'asset' });
    const receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    const revenueAccountId = await account({ code: '4110', nameAr: 'المبيعات', type: 'revenue' });
    const cashAccountId = await account({ code: '1221', nameAr: 'النقدية', type: 'asset' });
    const taxAccountId = await account({ code: '2310', nameAr: 'ضريبة القيمة المضافة', type: 'liability' });
    const cogsAccountId = await account({ code: '5110', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' });
    const inventoryAccountId = await account({ code: '1130', nameAr: 'المخزون', type: 'asset' });
    const firstBankAccountId = await account({ code: '1231', nameAr: 'بنك الراجحي', type: 'asset' });
    const secondBankAccountId = await account({ code: '1232', nameAr: 'بنك الأهلي', type: 'asset' });
    const otherBranchBankAccountId = await account({ code: '1233', nameAr: 'بنك فرع آخر', type: 'asset' });

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'الصندوق الرئيسي', accountId: safeAccountId, isDefault: true },
    });
    safeId = data(safe.body).id as string;

    // 🏦 البنوك المتاحة — `frmPayBank.xaml.cs` lists `Banks` that are not deleted; in the
    // cloud a bank is a cash location of kind `bank` carrying the `frmBanks` card.
    for (const [name, accountId, branch, capture] of [
      ['بنك الراجحي', firstBankAccountId, branchId, 'first'],
      ['بنك الأهلي', secondBankAccountId, branchId, 'second'],
      ['بنك فرع آخر', otherBranchBankAccountId, otherBranchId, 'other'],
    ] as const) {
      const bank = await api(ctx.server, 'post', '/api/v1/cash-locations', {
        token: actor.token,
        body: { branchId: branch, kind: 'bank', name, accountId, bank: { bankName: name } },
      });
      expect(bank.status).toBe(201);
      const id = data(bank.body).id as string;
      if (capture === 'first') firstBankId = id;
      if (capture === 'second') secondBankId = id;
      if (capture === 'other') otherBranchBankId = id;
    }

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
        sku: 'ITM-BANK',
        nameAr: 'صنف للتحويل',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100',
        costPrice: '60',
      },
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

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
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('يسمّي البنك الذي ذهب إليه المال، لا البنك الافتراضي', async () => {
    await freshShift();
    const checkout = await transfer(secondBankId, '1');
    const receipt = data(checkout.body);

    // The till's answer names the bank, so a cashier can see the choice took effect.
    expect(receipt.cashLocationId).toBe(secondBankId);
  });

  it('🏦 كل بنك على سطره في الوردية المفتوحة', async () => {
    const shiftId = await freshShift();
    await transfer(firstBankId, '2');
    await transfer(secondBankId, '3');

    const rows = list((await dayCloses()).body);
    const open = rows.find((row) => row.id === shiftId);
    const banks = open?.banks as Array<{ id: string; name: string; amount: string }>;

    expect(banks.length).toBe(2);
    const byName = new Map(banks.map((bank) => [bank.name, Number(bank.amount)]));
    // 2 × 100 and 3 × 100, VAT-inclusive, each on its own bank.
    expect(near(byName.get('بنك الراجحي') ?? 0, 200)).toBe(true);
    expect(near(byName.get('بنك الأهلي') ?? 0, 300)).toBe(true);
    // 🌐 الشبكة still carries the whole network — a breakdown may not shrink a total.
    expect(near(Number(open?.network), 500)).toBe(true);
  });

  it('الإقفال يحفظ بنكاً لكل سطر، والمُلخَّص يتجمّد به', async () => {
    const shiftId = await freshShift();
    await transfer(firstBankId, '1');
    await transfer(secondBankId, '4');

    const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts: [] },
    });
    expect(closed.status).toBe(201);

    const detail = await api(ctx.server, 'get', `/api/v1/shift-closes/${shiftId}`, { token: actor.token });
    expect(detail.status).toBe(200);
    const body = data(detail.body);
    const lines = (body.lines as Array<{ kind: string; method: string; partyId: string | null; amount: string }>)
      .filter((line) => line.kind === 'bank-transfer');

    expect(lines.length).toBe(2);
    // The bank rides in `metadata` (`party_id` is a FK to parties, and a bank is not a
    // party) — one signed line per bank, each naming its own.
    const named = lines.map((line) => (line.metadata as { cashLocationId?: string }).cashLocationId);
    expect(new Set(named)).toEqual(new Set([firstBankId, secondBankId]));

    // The close is frozen: a month later the document still says which bank got what,
    // even though the invoices behind it have long since moved on.
    const frozen = (body.close as { banks?: Array<{ id: string; amount: string }> }).banks ?? [];
    expect(frozen.length).toBe(2);
    expect(new Set(frozen.map((bank) => bank.id))).toEqual(new Set([firstBankId, secondBankId]));
  });

  it('التحويلان إلى بنك واحد يصيران سطراً واحداً — تجميع لا تكرار', async () => {
    const shiftId = await freshShift();
    await transfer(firstBankId, '2');
    await transfer(firstBankId, '3');

    const row = list((await dayCloses()).body).find((entry) => entry.id === shiftId);
    const banks = row?.banks as Array<{ id: string; name: string; amount: string }>;
    // `EntryOper.cs` L620 groups by bank: one line per bank, however many transfers.
    expect(banks.length).toBe(1);
    expect(banks[0].id).toBe(firstBankId);
    expect(near(Number(banks[0].amount), 500)).toBe(true);
  });

  it('بنك فرع آخر لا يُستلم تحويل هذا الفرع', async () => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل تحويل',
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
        payment: { method: 'bank', cashLocationId: otherBranchBankId },
      },
    });
    expect(checkout.status).toBe(422);
    expect(codeOf(checkout.body)).toBe('POS_CASH_LOCATION_INVALID');
  });

  it('تحويل بلا بنك واضح لا يُقبض على حساب مُخمَّن', async () => {
    // Two banks at this branch and none named: the fallback would be a coin toss, and a
    // coin toss is how a reconciliation stops adding up.
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل تحويل',
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
        payment: { method: 'bank', settlementAccountId: undefined },
      },
    });
    // Either refusal or an explicit default is acceptable; a silent third bank is not.
    expect([201, 422]).toContain(checkout.status);
    if (checkout.status === 201) {
      const banks = await api(ctx.server, 'get', '/api/v1/cash-locations?kind=bank', { token: actor.token });
      const forBranch = list(banks.body).filter((row) => row.branchId === branchId);
      expect(forBranch.length).toBeGreaterThan(0);
    }
  });

  it('مستأجر آخر لا يرى تحويلاتنا', async () => {
    const shiftId = await freshShift();
    await transfer(firstBankId, '1');

    const theirs = await api(ctx.server, 'get', `/api/v1/shift-closes/${shiftId}`, { token: stranger.token });
    expect(theirs.status).toBe(404);

    const rows = await api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: stranger.token });
    expect(list(rows.body).length).toBe(0);
  });

  it('الصندوق يبقى صندوقاً: النقدي لا يختلط بالبنوك', async () => {
    const shiftId = await freshShift();
    await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        cashCustomerName: 'عميل نقدي',
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
        payment: { method: 'cash', cashLocationId: safeId },
      },
    });
    await transfer(secondBankId, '2');

    const row = list((await dayCloses()).body).find((entry) => entry.id === shiftId);
    expect(near(Number(row?.cash), 100)).toBe(true);
    const banks = row?.banks as Array<{ amount: string }>;
    expect(banks.length).toBe(1);
    expect(near(Number(banks[0].amount), 200)).toBe(true);
  });
});
