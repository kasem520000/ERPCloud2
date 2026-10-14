import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part five — ⚖️ ميزان المراجعة.
 *
 * `Form_WPF/frmRptBalances.xaml` («أرصدة الحسابات») is the window: a filter panel of
 * `الفروع — كل الفروع` · `الحساب الرئيسي` · `المندوب` · `الفترة — كل الفترة / من / إلى`
 * with `عرض`, and a grid of
 * `الحساب · اسم الحساب · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن ·
 * رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن` plus `تفاصيل`. Under it,
 * `الرصيد:` and `الحالة:`. `Reports/rptAccountBalance.repx` prints the same six columns
 * as `افتتاحي · خلال الفترة المحددة · ختامي` with `الحالة`.
 *
 * The cloud's `GET /statements/trial-balance` was none of that: it returned
 * `accountId / debit / credit / balance` for the whole ledger, with no account names and
 * no period, so a ميزان had to be assembled in the browser out of two endpoints.
 *
 * The arithmetic here is the window's own `ShowResult`:
 *
 *     deptBlc     = max(dept − credit, 0)     creditBlc   = max(credit − dept, 0)
 *     deptFinal   = deptInit + deptBlc        creditFinal = creditInit + creditBlc
 *
 * netted once more before it is placed in a column.
 */
describe('ميزان المراجعة — frmRptBalances', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  const year = new Date().getUTCFullYear();
  let branchId = '';
  let otherBranchId = '';
  let parentId = '';
  let cashId = '';
  let bankId = '';
  let revenueId = '';
  let expenseId = '';
  let salesmanId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: Record<string, unknown>): Array<Record<string, unknown>> => (body.data as Array<Record<string, unknown>>) ?? [];
  const amt = (value: unknown) => Number(value).toFixed(4);

  const trial = (query = '') =>
    api(ctx.server, 'get', `/api/v1/statements/trial-balance${query ? `?${query}` : ''}`, { token: actor.token });

  const post = async (date: string, lines: Array<Record<string, unknown>>, branch?: string) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: { date, branchId: branch ?? branchId, description: `قيد ${date}`, lines },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    return posted;
  };

  beforeAll(async () => {
    ctx = await createTestApp('trial-balance');
    actor = await createActor(ctx, {
      tenantCode: 'mizan-one',
      email: 'owner@mizan-one.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'organization.branch.manage',
        'hrm.manage',
        'hrm.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'mizan-two',
      email: 'owner@mizan-two.test',
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
    parentId = await account({ code: '1000', nameAr: 'الأصول', type: 'asset' });
    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset', parentId });
    // 💰 الرصيد الافتتاحي — money on the books before the first entry.
    bankId = await account({ code: '1200', nameAr: 'البنك', type: 'asset', parentId, openingBalance: '500' });
    revenueId = await account({ code: '4100', nameAr: 'إيرادات', type: 'revenue' });
    expenseId = await account({ code: '5100', nameAr: 'مصروفات', type: 'expense' });

    const employee = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: actor.token,
      body: { employeeNo: 'E-1', name: 'مندوب الميزان', salaryComponents: {} },
    });
    expect(employee.status).toBeLessThan(300);
    salesmanId = data(employee.body).id as string;

    // قبل الفترة — 15 كانون الثاني
    await post(`${year}-01-15`, [
      { accountId: cashId, debit: '1000' },
      { accountId: revenueId, credit: '1000' },
    ]);
    // خلال الفترة
    await post(`${year}-03-15`, [
      { accountId: expenseId, debit: '300' },
      { accountId: cashId, credit: '300' },
    ]);
    // في فرع آخر
    await post(
      `${year}-05-15`,
      [
        { accountId: cashId, debit: '200' },
        { accountId: revenueId, credit: '200' },
      ],
      otherBranchId,
    );
    // بمندوب
    await post(`${year}-06-15`, [
      { accountId: expenseId, debit: '70', salesmanId },
      { accountId: cashId, credit: '70', salesmanId },
    ]);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الأعمدة العشرة — واسم الحساب بدل مُعرّفه', async () => {
    const body = (await trial()).body as Record<string, unknown>;
    const listed = rows(body);
    const cash = listed.find((row) => row.accountId === cashId) as Record<string, unknown>;

    expect(cash.code).toBe('1100');
    expect(cash.name).toBe('النقدية');
    expect(cash.type).toBe('asset');
    // رصيد مدين / رصيد دائن — the netted movement, on whichever side it lands.
    expect(amt(cash.debit)).toBe('1200.0000');
    expect(amt(cash.credit)).toBe('370.0000');
    expect(amt(cash.balanceDebit)).toBe('830.0000');
    expect(amt(cash.balanceCredit)).toBe('0.0000');

    const totals = body.totals as Record<string, string | boolean>;
    expect(amt(totals.debit)).toBe('1570.0000');
    expect(amt(totals.credit)).toBe('1570.0000');
    // Every entry is balanced, so the gross movement balances — that is what a ميزان proves.
    expect(totals.balanced).toBe(true);
  });

  it('2. «من تاريخ» — رصيد افتتاحي وحركة ورصيد ختامي', async () => {
    const body = (await trial(`from=${year}-03-01`)).body as Record<string, unknown>;
    const listed = rows(body);
    const row = (id: string) => listed.find((item) => item.accountId === id) as Record<string, unknown>;

    // 1100: 1000 افتتاحي، حركة 200 مدين و300 و70 دائن → الختامي 830 مدين
    expect(amt(row(cashId).openingDebit)).toBe('1000.0000');
    expect(amt(row(cashId).openingCredit)).toBe('0.0000');
    expect(amt(row(cashId).debit)).toBe('200.0000');
    expect(amt(row(cashId).credit)).toBe('370.0000');
    expect(amt(row(cashId).balanceCredit)).toBe('170.0000');
    expect(amt(row(cashId).closingDebit)).toBe('830.0000');
    expect(amt(row(cashId).closingCredit)).toBe('0.0000');
    expect(row(cashId).status).toBe('مدين');

    // 4100: 1000 افتتاحي دائن، حركته 200 دائن → الختامي 1200 دائن
    expect(amt(row(revenueId).openingCredit)).toBe('1000.0000');
    expect(amt(row(revenueId).closingCredit)).toBe('1200.0000');
    expect(row(revenueId).status).toBe('دائن');

    // 💰 الرصيد الافتتاحي وحده يكفي لظهور الحساب — ميزان يخفيه لا يتوازن.
    expect(amt(row(bankId).openingDebit)).toBe('500.0000');
    expect(amt(row(bankId).debit)).toBe('0.0000');
    expect(amt(row(bankId).closingDebit)).toBe('500.0000');

    const totals = body.totals as Record<string, string | boolean>;
    expect(amt(totals.openingDebit)).toBe('1500.0000'); // 1000 + 500 رصيد افتتاحي
    expect(amt(totals.openingCredit)).toBe('1000.0000');
    expect(amt(totals.debit)).toBe('570.0000');
    expect(amt(totals.credit)).toBe('570.0000');
    expect(totals.balanced).toBe(true);
    // الرصيد / الحالة — the number the window prints under the grid.
    // 830 نقدية + 370 مصروفات + 500 البنك = 1700 مدين، مقابل 1200 إيرادات دائن.
    expect(amt(totals.closingDebit)).toBe('1700.0000');
    expect(amt(totals.closingCredit)).toBe('1200.0000');
    expect(amt(totals.balance)).toBe('500.0000');
    expect(totals.status).toBe('مدين');
  });

  it('3. الفرع — «كل الفروع» مقابل فرعٍ واحد', async () => {
    const all = (await trial()).body as Record<string, unknown>;
    const one = (await trial(`branch_id=${otherBranchId}`)).body as Record<string, unknown>;

    expect(amt((all.totals as Record<string, string>).debit)).toBe('1570.0000');
    expect(amt((one.totals as Record<string, string>).debit)).toBe('200.0000');
    expect(amt((one.totals as Record<string, string>).credit)).toBe('200.0000');
    // 💰 الرصيد الافتتاحي على البطاقة ليس حركة، فهو يظهر مع كل فرع.
    expect(rows(one).map((row) => row.code).sort()).toEqual(['1100', '1200', '4100']);
  });

  it('4. المندوب — حركة الخطوط المنسوبة إليه وحدها', async () => {
    const body = (await trial(`salesman_id=${salesmanId}`)).body as Record<string, unknown>;
    const listed = rows(body);
    // المندوب سمة سطر: السطر المنسوب إليه وحده يُحصى، والرصيد الافتتاحي يبقى.
    expect(listed.map((row) => row.code).sort()).toEqual(['1100', '1200', '5100']);
    expect(amt((body.totals as Record<string, string>).debit)).toBe('70.0000');
    expect(amt((body.totals as Record<string, string>).credit)).toBe('70.0000');
  });

  it('5. الحساب الرئيسي — الميزان على فرعٍ واحد من الشجرة', async () => {
    const body = (await trial(`parent_id=${parentId}`)).body as Record<string, unknown>;
    const codes = rows(body).map((row) => row.code).sort();
    expect(codes).toEqual(['1100', '1200']);
    expect(amt((body.totals as Record<string, string>).debit)).toBe('1200.0000');
    expect(amt((body.totals as Record<string, string>).credit)).toBe('370.0000');
  });

  it('6. إلى تاريخ — الفترة مغلقة من الطرفين', async () => {
    const body = (await trial(`from=${year}-03-01&to=${year}-03-31`)).body as Record<string, unknown>;
    const listed = rows(body);
    const row = (id: string) => listed.find((item) => item.accountId === id) as Record<string, unknown>;
    expect(amt(row(expenseId).debit)).toBe('300.0000');
    expect(amt(row(cashId).credit)).toBe('300.0000');
    expect(amt((body.totals as Record<string, string>).debit)).toBe('300.0000');
    // كانون الثاني صار رصيداً افتتاحياً… وحزيران لم يقع بعد.
    expect(amt(row(cashId).openingDebit)).toBe('1000.0000');
    expect(amt(row(cashId).closingDebit)).toBe('700.0000');
  });

  it('7. والتوافق — من قرأ الاستجابة القديمة ما زال يقرأها', async () => {
    const body = (await trial()).body as Record<string, unknown>;
    const cash = rows(body).find((row) => row.accountId === cashId) as Record<string, unknown>;
    // `accountId` · `debit` · `credit` · `balance` were the old row's four keys.
    expect(cash.accountId).toBe(cashId);
    expect(amt(cash.balance)).toBe('830.0000');
    // `totals` is an addition beside `data`, never a replacement.
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('8. عزل المؤسسات — ميزان مؤسسة لا يظهر في أخرى', async () => {
    const foreign = await api(ctx.server, 'get', '/api/v1/statements/trial-balance', { token: stranger.token });
    expect(rows(foreign.body).length).toBe(0);
    expect(amt((foreign.body as { totals?: Record<string, string> }).totals?.debit)).toBe('0.0000');
  });
});
