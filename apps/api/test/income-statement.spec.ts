import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part five — 📊 أرباح وخسائر حسابات رئيسية.
 *
 * `Form_WPF/frmRptIncomeStatement.xaml` is the window: `كل الفروع` · `كل الفترة`
 * (`من`/`إلى`, `من وقت`/`إلى وقت`) · `🔍 عرض` over a grid of
 * `الحساب · اسم الحساب · رصيد مدين · رصيد دائن`, and under it three rows —
 * `قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ`, `صافي أرباح العام` (or `صافي خسائر العام`)
 * and «✅ الحسابات متوازنة». `Reports/RptIncomeStatement.repx` prints the same four
 * columns.
 *
 * Which accounts belong on it is `Accounts_Index.FinalAcc = 2`, and
 * `frmAccountsTree.xaml.cs` `DetermineFinalAccount()` is what writes that column: a code
 * beginning `1` or `2` is ميزانية, `3` or `4` is قائمة الدخل. The cloud calls the same two
 * classes `revenue` and `expense`.
 *
 * Then `ShowResult` walks each account up to its parent (`JOIN Accounts_Index AS Parent`)
 * and merges the rows that share one — `_Type == 1`, the default, and the window's title
 * says «حسابات رئيسية». Closing stock goes to the credit side (`CalcStockCost`), and the
 * profit is the plug that makes the two columns meet.
 *
 * The cloud had no income statement at all: it had a trial balance and nothing above it.
 */
describe('قائمة الدخل — frmRptIncomeStatement', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  const year = new Date().getUTCFullYear();
  let branchId = '';
  let otherBranchId = '';
  let cashId = '';
  let revenueParentId = '';
  let salesId = '';
  let servicesId = '';
  let expenseParentId = '';
  let salariesId = '';
  let rentId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: Record<string, unknown>): Array<Record<string, unknown>> => (body.data as Array<Record<string, unknown>>) ?? [];
  const totalsOf = (body: Record<string, unknown>) => body.totals as Record<string, string | boolean>;
  const amt = (value: unknown) => Number(value).toFixed(4);

  const statement = (query = '') =>
    api(ctx.server, 'get', `/api/v1/statements/income-statement${query ? `?${query}` : ''}`, { token: actor.token });

  const post = async (date: string, lines: Array<Record<string, unknown>>, branch?: string) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: { date, branchId: branch ?? branchId, description: `قيد ${date}`, lines },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    return posted;
  };

  beforeAll(async () => {
    ctx = await createTestApp('income-statement');
    actor = await createActor(ctx, {
      tenantCode: 'income-one',
      email: 'owner@income-one.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'inventory.view',
        'inventory.adjust',
        'organization.warehouse.view',
        'organization.warehouse.manage',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.view',
        'catalog.category.manage',
        'catalog.unit.view',
        'catalog.unit.manage',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'income-two',
      email: 'owner@income-two.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'accounting.reports.view'],
    });

    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const branch = await api(ctx.server, 'post', '/api/v1/branches', { token: actor.token, body: { code: 'BR1', nameAr: 'الفرع الرئيسي' } });
    branchId = data(branch.body).id as string;
    const second = await api(ctx.server, 'post', '/api/v1/branches', { token: actor.token, body: { code: 'BR2', nameAr: 'فرع ثان' } });
    otherBranchId = data(second.body).id as string;

    const account = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    // FinalAcc = 2 — حسابات قائمة الدخل: codes beginning 3 or 4.
    revenueParentId = await account({ code: '4000', nameAr: 'الإيرادات', type: 'revenue' });
    salesId = await account({ code: '4100', nameAr: 'مبيعات', type: 'revenue', parentId: revenueParentId });
    servicesId = await account({ code: '4200', nameAr: 'خدمات', type: 'revenue', parentId: revenueParentId });
    expenseParentId = await account({ code: '5000', nameAr: 'المصروفات', type: 'expense' });
    salariesId = await account({ code: '5100', nameAr: 'رواتب', type: 'expense', parentId: expenseParentId });
    rentId = await account({ code: '5200', nameAr: 'إيجار', type: 'expense', parentId: expenseParentId });
    // FinalAcc = 1 — حسابات الميزانية: it must never appear on this report.
    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });

    await post(`${year}-01-20`, [
      { accountId: cashId, debit: '1000' },
      { accountId: salesId, credit: '1000' },
    ]);
    await post(`${year}-02-20`, [
      { accountId: salariesId, debit: '250' },
      { accountId: cashId, credit: '250' },
    ]);
    await post(`${year}-03-20`, [
      { accountId: rentId, debit: '150' },
      { accountId: cashId, credit: '150' },
    ]);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. حسابات رئيسية — تجميعي يرفع كل حساب إلى أبيه', async () => {
    const body = (await statement()).body as Record<string, unknown>;
    const listed = rows(body);
    const accounts = listed.filter((row) => row.kind === 'account');

    expect(accounts.map((row) => row.code)).toEqual(['4000', '5000']);
    const revenue = accounts.find((row) => row.code === '4000') as Record<string, unknown>;
    const expense = accounts.find((row) => row.code === '5000') as Record<string, unknown>;
    expect(amt(revenue.credit)).toBe('1000.0000');
    expect(amt(revenue.balanceCredit)).toBe('1000.0000');
    expect(revenue.status).toBe('دائن');
    expect(amt(expense.debit)).toBe('400.0000');
    expect(amt(expense.balanceDebit)).toBe('400.0000');
    expect(expense.status).toBe('مدين');

    // 1100 is ميزانية: it belongs on the ميزان, not here.
    expect(listed.some((row) => row.code === '1100')).toBe(false);
  });

  it('2. summary=0 — تفصيلي: صفّ لكل حساب لا لكل أب', async () => {
    const body = (await statement('summary=0')).body as Record<string, unknown>;
    const accounts = rows(body).filter((row) => row.kind === 'account');
    expect(accounts.map((row) => row.code)).toEqual(['4100', '5100', '5200']);
    expect(amt(accounts.find((row) => row.code === '4100')?.balanceCredit)).toBe('1000.0000');
    expect(amt(accounts.find((row) => row.code === '5100')?.balanceDebit)).toBe('250.0000');
    expect(amt(accounts.find((row) => row.code === '5200')?.balanceDebit)).toBe('150.0000');
  });

  it('3. صافي أرباح العام — والعمودان يلتقيان', async () => {
    const body = (await statement()).body as Record<string, unknown>;
    const totals = totalsOf(body);
    expect(totals.profitLabel).toBe('صافي أرباح العام');
    expect(amt(totals.profit)).toBe('600.0000'); // 1000 إيرادات − 400 مصروفات
    expect(amt(totals.debit)).toBe('1000.0000');
    expect(amt(totals.credit)).toBe('1000.0000');
    expect(totals.balanced).toBe(true);
    expect(totals.balancedLabel).toBe('✅ الحسابات متوازنة');

    const profit = rows(body).find((row) => row.kind === 'profit') as Record<string, unknown>;
    expect(profit.name).toBe('صافي أرباح العام');
    expect(amt(profit.debit)).toBe('600.0000');
    expect(amt(profit.credit)).toBe('0.0000');
  });

  it('4. الفترة — من/إلى يقصّان الحركة لا الحساب', async () => {
    const body = (await statement(`from=${year}-03-01&to=${year}-03-31`)).body as Record<string, unknown>;
    const accounts = rows(body).filter((row) => row.kind === 'account');
    expect(accounts.map((row) => row.code)).toEqual(['5000']);
    expect(amt(accounts[0]?.balanceDebit)).toBe('150.0000');
    const totals = totalsOf(body);
    // لا إيرادات في آذار: الخسارة 150 تُسجَّل في جانب الإيرادات ليستوي العمودان.
    expect(totals.profitLabel).toBe('صافي خسائر العام');
    expect(amt(totals.profit)).toBe('150.0000');
    expect(amt(totals.debit)).toBe('150.0000');
    expect(amt(totals.credit)).toBe('150.0000');
  });

  it('5. الفرع — كل الفروع مقابل فرعٍ واحد', async () => {
    await post(
      `${year}-04-20`,
      [
        { accountId: cashId, debit: '300' },
        { accountId: servicesId, credit: '300' },
      ],
      otherBranchId,
    );

    const all = (await statement()).body as Record<string, unknown>;
    expect(amt((all.totals as Record<string, string>).profit)).toBe('900.0000');

    const one = (await statement(`branch_id=${otherBranchId}`)).body as Record<string, unknown>;
    const accounts = rows(one).filter((row) => row.kind === 'account');
    expect(accounts.map((row) => row.code)).toEqual(['4000']);
    expect(amt(accounts[0]?.balanceCredit)).toBe('300.0000');
  });

  it('6. قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ', async () => {
    // with_stock=0 — the row is not printed at all.
    const without = (await statement('with_stock=0')).body as Record<string, unknown>;
    expect(rows(without).some((row) => row.kind === 'stock')).toBe(false);

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
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        sku: 'SKU-1',
        nameAr: 'بضاعة آخر المدة',
      },
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH1', name: 'المستودع' },
    });
    expect(warehouse.status, JSON.stringify(warehouse.body)).toBe(201);

    // 10 حبة × 20 = 200 على حساب المخزون، تُضاف إلى جانب الدائن (تخفض تكلفة البضاعة).
    const received = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId: data(item.body).id,
            warehouseId: data(warehouse.body).id,
            qty: '10',
            unitCost: '20',
            direction: 'in',
            docType: 'stock_voucher',
            docId: randomUUID(),
          },
        ],
      },
    });
    expect(received.status, JSON.stringify(received.body)).toBeLessThan(300);

    const body = (await statement()).body as Record<string, unknown>;
    const stock = rows(body).find((row) => row.kind === 'stock') as Record<string, unknown>;
    expect(stock.name).toBe('قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ');
    expect(amt(stock.credit)).toBe('200.0000');
    expect(amt(totalsOf(body).stock)).toBe('200.0000');
    // 1000 + 300 إيرادات + 200 مخزون − 400 مصروفات = 1100 ربحاً، يُسجَّل في جانب المدين.
    expect(amt(totalsOf(body).profit)).toBe('1100.0000');
    expect(amt(totalsOf(body).debit)).toBe('1500.0000');
    expect(amt(totalsOf(body).credit)).toBe('1500.0000');
  });

  it('7. عزل المؤسسات — قائمة دخل مؤسسة لا تُقرأ من أخرى', async () => {
    const foreign = await api(ctx.server, 'get', '/api/v1/statements/income-statement', { token: stranger.token });
    // لا حسابات: صفّ المخزون وصفّ الربح، وكلاهما صفر.
    expect(rows(foreign.body).map((row) => row.kind)).toEqual(['stock', 'profit']);
    expect(amt((foreign.body as { totals?: Record<string, string> }).totals?.profit)).toBe('0.0000');
  });
});
