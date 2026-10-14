import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part two — 📄 كشف الحساب.
 *
 * The desktop has two statement windows and this endpoint is both of them:
 *
 *   `Form_WPF/frmAccountBalance.xaml` — «كشف حساب تفصيلي». Its grid is
 *   `م · التاريخ · النوع · رقم السند · الرقم العام · الفرع · البيان · مدين · دائن ·
 *   الرصيد · الحالة · تفاصيل`, الرصيد is a running total (`frmAccountBalance.xaml.cs`
 *   L216 `runningBalance += (dept - credit)`), the period opens with a `رصيد سابق` row
 *   whose البيان is `رصيد مرحل من فترة سابقة` (`AddPreviousBalanceRow` L351), and
 *   `تجميعي (ملخص)` collapses the lines of one entry into a single row while
 *   `تفصيلي (كامل)` keeps every line (`GetAccountMovements` L307).
 *
 *   `Form_WPF/frmAccountsStatement.xaml` — «كشف حساب رئيسي». The same report over an
 *   account **and its descendants**: the stored procedure `GetAccountStatement` walks an
 *   `AccountHierarchy` CTE, and its grid carries `رمز الحساب` and `الحساب` instead of a
 *   running balance.
 *
 * Both read posted entries only (`Entry.state = 1`). What the cloud was missing is the
 * whole left half of the report: the endpoint returned bare lines with no period, no
 * opening and no running total, and the screen filtered by date *after* the fact — so a
 * statement for one month started its الرصيد at zero and disagreed with 📂 شجرة الحسابات
 * on the same account. The invariant these tests hold is that they can no longer
 * disagree: the closing balance of a statement over all time is the balance the
 * directory shows.
 *
 * One desktop bug is deliberately not copied: `balanceStatus = runningBalance >= 0 ?
 * "مدين" : "دائن"` reports a liability sitting on its own credit side as `مدين`. الحالة
 * names the side the money is on, which is a fact about the balance, not the account.
 */
describe('Accounting statement — كشف الحساب', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let otherBranchId = '';
  let cashId = '';      // 1100 النقدية — debit-natured, the account under report
  let drawerId = '';    // 1110 الصندوق — a child of it, for كشف حساب رئيسي
  let payableId = '';   // 2100 الموردون — credit-natured
  let capitalId = '';   // 4000 رأس المال
  let openingId = '';   // 1300 حساب برصيد افتتاحي ولا حركة

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  /** The statement envelope: `data` is the grid, `totals` and `account` ride beside it. */
  const rows = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    (body.data as Array<Record<string, unknown>>) ?? [];
  const totalsOf = (body: Record<string, unknown>) =>
    (body.totals ?? {}) as {
      debit?: string;
      credit?: string;
      periodDebit?: string;
      periodCredit?: string;
      closing?: string;
      closingStatus?: string;
    };
  const amt = (value: unknown) => Number(value).toFixed(4);
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;

  /** Dates are relative to today: an entry needs a period that is still open. */
  const iso = (offsetDays: number) => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + offsetDays);
    return at.toISOString().slice(0, 10);
  };

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const post = async (
    lines: Array<{ accountId: string; debit?: string; credit?: string }>,
    extra: Record<string, unknown> = {},
  ) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: { date: iso(0), description: 'قيد تحقق', lines, ...extra },
    });
    expect(posted.status).toBeLessThan(300);
    return data(posted.body) as { id: string };
  };

  const statement = (accountId: string, query = '') =>
    api(ctx.server, 'get', `/api/v1/statements/general-ledger/${accountId}${query ? `?${query}` : ''}`, {
      token: actor.token,
    });

  /** The balance 📂 شجرة الحسابات shows for the same account (Phase 07 part one). */
  const directoryBalance = async (accountId: string) => {
    const listed = await api(ctx.server, 'get', '/api/v1/accounts?with_balances=1', { token: actor.token });
    const row = rows(listed.body).find((entry) => entry.id === accountId);
    return Number(((row?.balance ?? {}) as { balance?: string }).balance ?? 0);
  };

  beforeAll(async () => {
    ctx = await createTestApp('accounting-statement');
    actor = await createActor(ctx, {
      tenantCode: 'acc-stmt',
      email: 'owner@acc-stmt.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'organization.branch.manage',
        'organization.cashlocation.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'acc-stmt-2',
      email: 'owner@acc-stmt-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'accounting.reports.view'],
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
    const second = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR2', nameAr: 'فرع ثان' },
    });
    otherBranchId = data(second.body).id as string;

    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });
    drawerId = await account({ code: '1110', nameAr: 'الصندوق', type: 'asset', parentId: cashId });
    payableId = await account({ code: '2100', nameAr: 'الموردون', type: 'liability' });
    capitalId = await account({ code: '4000', nameAr: 'رأس المال', type: 'equity' });
    openingId = await account({ code: '1300', nameAr: 'أوراق قبض', type: 'asset', openingBalance: '1000' });

    // Before the period: 300 in.
    await post(
      [
        { accountId: cashId, debit: '300' },
        { accountId: capitalId, credit: '300' },
      ],
      { date: iso(-8) },
    );
    // In the period: +200 …
    await post(
      [
        { accountId: cashId, debit: '200' },
        { accountId: capitalId, credit: '200' },
      ],
      { date: iso(-4) },
    );
    // … one entry with two lines on the same account (تجميعي collapses these) …
    await post(
      [
        { accountId: cashId, debit: '50' },
        { accountId: cashId, debit: '70' },
        { accountId: capitalId, credit: '120' },
      ],
      { date: iso(-3) },
    );
    // … and 100 out.
    await post(
      [
        { accountId: payableId, debit: '100' },
        { accountId: cashId, credit: '100' },
      ],
      { date: iso(-2) },
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الرصيد السابق — ما قبل الفترة يُفتتح به الكشف ولا يُحسب مرتين', async () => {
    const body = (await statement(cashId, `from=${iso(-6)}`)).body;
    const all = rows(body);
    const opening = all.find((row) => row.rank === 0);

    expect(opening).toBeDefined();
    // `AddPreviousBalanceRow`: البيان «رصيد مرحل من فترة سابقة» والنوع «رصيد سابق».
    expect(opening?.description).toBe('رصيد مرحل من فترة سابقة');
    expect(opening?.entryType).toBe('رصيد سابق');
    expect(opening?.entryId).toBeNull();
    expect(amt(opening?.debit)).toBe('300.0000');
    expect(opening?.balanceStatus).toBe('مدين');

    // The 300 is *not* repeated among the period's movements.
    const period = all.filter((row) => row.rank !== 0);
    expect(period.reduce((sum, row) => sum + Number(row.debit), 0)).toBe(320);
    expect(period.reduce((sum, row) => sum + Number(row.credit), 0)).toBe(100);
  });

  it('2. الرصيد — تراكمي، وآخره هو رصيد الحساب في 📂 شجرة الحسابات', async () => {
    const body = (await statement(cashId, `from=${iso(-6)}`)).body;
    const all = rows(body);
    const running = all.map((row) => Number(row.runningBalance));

    expect(near(running[0], 300)).toBe(true); // الرصيد السابق
    expect(near(running[1], 500)).toBe(true); // + 200
    expect(near(running.at(-1)!, 520)).toBe(true); // + 50 + 70 − 100
    // The invariant of Phase 07: a كشف and a شجرة cannot print different numbers.
    expect(near(Number(totalsOf(body).closing), 520)).toBe(true);
    expect(near(await directoryBalance(cashId), 520)).toBe(true);
  });

  it('3. الحالة — الجانب الذي يقف عليه المال، لا طبيعة الحساب', async () => {
    // الموردون (خصوم) تحركت مديناً 100 فقط؛ رصيدها إذن في الجانب المدين.
    const debitSide = (await statement(payableId, `from=${iso(-6)}`)).body;
    expect(totalsOf(debitSide).closingStatus).toBe('مدين');

    // والصندوق (أصول) رصيده مدين كذلك. أما رأس المال (حقوق ملكية، طبيعتها دائن)
    // فقد تحرك دائناً 620، فحالته «دائن» — وهي التي يسمّيها الديسكتوب «مدين» لأنه
    // يقرأ الحالة من رصيدٍ موقّع بطبيعة الحساب.
    const creditSide = (await statement(capitalId, `from=${iso(-6)}`)).body;
    expect(totalsOf(creditSide).closingStatus).toBe('دائن');
    expect(near(Number(totalsOf(creditSide).closing), 620)).toBe(true);
  });

  it('4. 📊 طريقة العرض — تجميعي (ملخص) يجمع سطور القيد، وتفصيلي (كامل) يبقيها', async () => {
    const detailed = rows((await statement(cashId, `from=${iso(-6)}`)).body);
    const summary = rows((await statement(cashId, `from=${iso(-6)}&summary=1`)).body);

    // The entry with two debit lines on this account is two rows تفصيلي and one تجميعي.
    expect(detailed.length - summary.length).toBe(1);
    const collapsed = summary.find((row) => amt(row.debit) === '120.0000');
    expect(collapsed).toBeDefined();
    expect(detailed.filter((row) => Number(row.debit) === 50 || Number(row.debit) === 70)).toHaveLength(2);
  });

  it('5. كشف حساب رئيسي — الحساب وفرعه، وبلا رصيد تراكمي', async () => {
    await post(
      [
        { accountId: drawerId, debit: '80' },
        { accountId: capitalId, credit: '80' },
      ],
      { date: iso(-1) },
    );

    const own = rows((await statement(cashId, `from=${iso(-6)}`)).body);
    const branch = rows((await statement(cashId, `from=${iso(-6)}&with_descendants=1`)).body);

    expect(branch.some((row) => row.accountCode === '1110')).toBe(true);
    expect(branch.length).toBeGreaterThan(own.length);
    // `frmAccountsStatement` has no الرصيد column: a running total over accounts of
    // different natures is not a number anyone can read.
    expect(branch.every((row) => row.runningBalance === null)).toBe(true);
    // … but the branch still closes on something: 520 of the parent + 80 of the child.
    const body = (await statement(cashId, `from=${iso(-6)}&with_descendants=1`)).body;
    expect(near(Number(totalsOf(body).closing), 600)).toBe(true);
  });

  it('6. فترة كاملة (من البداية) — بلا سطر افتتاح، وبنفس الرصيد', async () => {
    const full = (await statement(cashId, 'full_period=1')).body;
    const all = rows(full);

    expect(all.some((row) => row.rank === 0)).toBe(false);
    // The account on its own closes on 520 …
    expect(near(Number(totalsOf(full).closing), 520)).toBe(true);
    // … and with `with_descendants` the كشف becomes the branch, which is exactly what
    // 📂 شجرة الحسابات shows on this node: 520 of the parent + 80 of the child.
    const branch = (await statement(cashId, 'full_period=1&with_descendants=1')).body;
    expect(near(Number(totalsOf(branch).closing), await directoryBalance(cashId))).toBe(true);
    expect(near(Number(totalsOf(branch).closing), 600)).toBe(true);
  });

  it('7. عدم إظهار الرصيد السابق — يُخفي السطر ولا يُسقط المال', async () => {
    const hidden = rows((await statement(cashId, `from=${iso(-6)}&hide_previous_balance=1`)).body);

    expect(hidden.some((row) => row.rank === 0)).toBe(false);
    // The row is a display choice; the running balance still opens on the 300 that
    // really is there, because a كشف that starts at zero for a mid-period report is wrong.
    expect(near(Number(hidden[0]?.runningBalance), 500)).toBe(true);
    expect(near(Number(hidden.at(-1)?.runningBalance), 520)).toBe(true);
  });

  it('8. الفرع — `كل الفروع` تجمعه و`الفرع` يضيّقه', async () => {
    const branchAccountId = await account({ code: '1400', nameAr: 'بريد', type: 'asset' });
    await post(
      [
        { accountId: branchAccountId, debit: '100' },
        { accountId: capitalId, credit: '100' },
      ],
      { date: iso(-2), branchId },
    );
    await post(
      [
        { accountId: branchAccountId, debit: '900' },
        { accountId: capitalId, credit: '900' },
      ],
      { date: iso(-1), branchId: otherBranchId },
    );

    /** الرصيد السابق is not one of the period's movements, so it is not counted here. */
    const debits = (list: Array<Record<string, unknown>>) =>
      list.filter((row) => row.rank !== 0).reduce((sum, row) => sum + Number(row.debit), 0);
    const everyBranch = rows((await statement(branchAccountId, `from=${iso(-6)}`)).body);
    const oneBranch = rows((await statement(branchAccountId, `from=${iso(-6)}&branch_id=${otherBranchId}`)).body);

    expect(debits(everyBranch)).toBe(1000);
    expect(debits(oneBranch)).toBe(900);
    const movements = oneBranch.filter((row) => row.rank !== 0);
    expect(movements.every((row) => row.branchName === 'فرع ثان')).toBe(true);
    // The opening row is still there — it says «لا شيء قبل هذا التاريخ» in numbers —
    // and it has no branch of its own, because it is a total over the branch filter.
    expect(oneBranch.some((row) => row.rank === 0)).toBe(true);
    expect(Number(oneBranch.find((row) => row.rank === 0)?.debit)).toBe(0);
  });

  it('9. 💰 الرصيد الافتتاحي — داخل الرصيد السابق، ومعه يتفق الدليل', async () => {
    const body = (await statement(openingId, `from=${iso(-6)}`)).body;
    const opening = rows(body).find((row) => row.rank === 0);

    expect(amt(opening?.debit)).toBe('1000.0000');
    expect(opening?.balanceStatus).toBe('مدين');
    expect(near(Number(totalsOf(body).closing), 1000)).toBe(true);
    expect(near(await directoryBalance(openingId), 1000)).toBe(true);
  });

  it('10. إجمالي مدين وإجمالي دائن ورصيد الفترة', async () => {
    const totals = totalsOf((await statement(cashId, `from=${iso(-6)}`)).body);

    expect(amt(totals.debit)).toBe('320.0000');
    expect(amt(totals.credit)).toBe('100.0000');
    // `UpdateTotalsUI` (frmAccountBalance.xaml.cs L401): the period's balance is shown
    // on the side that is bigger, and zero on the other.
    expect(amt(totals.periodDebit)).toBe('220.0000');
    expect(amt(totals.periodCredit)).toBe('0.0000');
  });

  it('11. التوافق — الطلب بلا معايير يردّ نفس الدفتر القديم', async () => {
    const response = await statement(cashId);
    expect(response.status).toBe(200);
    const all = rows(response.body);

    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row).toHaveProperty('entryId');
      expect(row).toHaveProperty('date');
      expect(row).toHaveProperty('debit');
      expect(row).toHaveProperty('credit');
      expect(row).toHaveProperty('description');
    }
    // Old callers read `data` only; `totals` and `account` are additions beside it.
    expect((response.body as Record<string, unknown>).totals).toBeDefined();
    expect((response.body as Record<string, unknown>).account).toBeDefined();
  });

  it('13. ⏰ الوقت — اليوم يُقسَّم بساعته، لا بليلته كلها', async () => {
    // `frmAccountBalance` puts a time box beside each date box (`BuildDateTimeFilter`
    // L458-L463), so a period that opens at noon must not carry a قيد posted at nine.
    const clockId = await account({ code: '1500', nameAr: 'حساب الوقت', type: 'asset' });
    const morning = await post(
      [
        { accountId: clockId, debit: '70' },
        { accountId: capitalId, credit: '70' },
      ],
      { date: iso(0), time: '09:00:00', description: 'قيد الصباح' },
    );
    const evening = await post(
      [
        { accountId: clockId, debit: '30' },
        { accountId: capitalId, credit: '30' },
      ],
      { date: iso(0), time: '21:00:00', description: 'قيد المساء' },
    );

    const numbersIn = (list: Array<Record<string, unknown>>) =>
      list.filter((row) => row.rank !== 0).map((row) => row.number);

    const fromNoon = rows((await statement(clockId, `from=${iso(0)}&from_time=12:00`)).body);
    expect(numbersIn(fromNoon)).toEqual([data(evening).number]);
    // The nine o'clock قيد did not vanish: it is what the الرصيد السابق is carrying.
    expect(amt(fromNoon.find((row) => row.rank === 0)?.debit)).toBe('70.0000');

    const untilNoon = rows((await statement(clockId, `from=${iso(0)}&to=${iso(0)}&to_time=12:00`)).body);
    expect(numbersIn(untilNoon)).toEqual([data(morning).number]);

    // Nothing sent means the whole day, as it always did.
    const wholeDay = rows((await statement(clockId, `from=${iso(0)}&to=${iso(0)}`)).body);
    expect(numbersIn(wholeDay).sort()).toEqual([data(morning).number, data(evening).number].sort());
  });

  it('14. 📋 نوع القيد — «كل الأنواع» تعني الكل، ونوعٌ واحد يُقصّ ما سواه', async () => {
    const movementsIn = async (query: string) =>
      rows((await statement(cashId, query)).body).filter((row) => row.rank !== 0);

    const all = await movementsIn('full_period=1');
    const manual = await movementsIn('full_period=1&kind=manual');
    // Every قيد in these fixtures is a manual one, so the filter takes nothing away …
    expect(manual.length).toBe(all.length);
    expect(manual.length).toBeGreaterThan(0);
    // … and a type nothing here belongs to empties the كشف.
    expect(await movementsIn('full_period=1&kind=sales_invoice')).toHaveLength(0);
    expect(await movementsIn('full_period=1&kind=voucher_receipt')).toHaveLength(0);

    // ⚖️ الرصيد السابق counts the same type and nothing else: the 300 before the period
    // was posted by hand, so it is there for `manual` and absent for an invoice.
    const openingOf = async (query: string) =>
      rows((await statement(cashId, query)).body).find((row) => row.rank === 0);
    expect(amt((await openingOf(`from=${iso(-6)}&kind=manual`))?.debit)).toBe('300.0000');
    expect(amt((await openingOf(`from=${iso(-6)}&kind=sales_invoice`))?.debit)).toBe('0.0000');
  });

  it('12. عزل المؤسسات — حساب مؤسسة أخرى غير موجود', async () => {
    const response = await api(
      ctx.server,
      'get',
      `/api/v1/statements/general-ledger/${cashId}`,
      { token: stranger.token },
    );
    expect(response.status).toBe(404);
  });
});
