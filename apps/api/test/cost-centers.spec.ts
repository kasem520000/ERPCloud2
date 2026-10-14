import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part four — 🌳 مراكز التكلفة.
 *
 * `Form_WPF/frmCostCenter.xaml` («مركز التكلفة 🏢») is the card —
 * `🔢 الرقم · ✏️ الاسم · 🌐 الاسم EN · 📂 البند الرئيسي · 🏬 الفرع · 🏷️ النوع`
 * (`🟢 رئيسي` / `🔵 فرعي`) — beside `🌳 شجرة مراكز التكلفة`, which the window builds by
 * walking `ParentCode` (`LoadTree` / `BuildTreeNodes`).
 *
 * `Form_WPF/frmCostCenterBalance.xaml` («تقرير مركز كلفة») is the report:
 * `🏢 مركز الكلفة · 📊 نوع الرصيد · اسم الحساب · 🌿 الفرع · 📋 نوع القيد ·
 * 📑 نوع التقرير` (`تجميعي`/`تفصيلي`) · `فترة كاملة` · `من`/`إلى`, over a grid of
 * `م · 💸 مدين · 💰 دائن · ⚖️ الرصيد · 📌 الحالة · 🔢 الرقم العام · 📄 رقم السند`.
 *
 * What the cloud was missing is the same thing the directory was missing in part one:
 * the cloud listed cost centres as a flat table with no balance at all, so a centre
 * could not be asked what it had spent. The balance here is the part-one rule applied
 * to centres — posted entries only, a parent carrying its children — so the number on a
 * node of 🌳 شجرة مراكز التكلفة and the number at the foot of 📊 كشف مركز الكلفة are the
 * same number.
 */
describe('Cost centres — مراكز التكلفة', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let otherBranchId = '';
  let rootId = '';
  let childId = '';
  let grandChildId = '';
  let expenseId = '';
  let cashId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: Record<string, unknown>): Array<Record<string, unknown>> => (body.data as Array<Record<string, unknown>>) ?? [];
  const amt = (value: unknown) => Number(value).toFixed(4);
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;
  const iso = (offsetDays: number) => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + offsetDays);
    return at.toISOString().slice(0, 10);
  };

  const centre = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/cost-centers', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const post = async (
    lines: Array<{ accountId: string; debit?: string; credit?: string; costCenterId?: string }>,
    extra: Record<string, unknown> = {},
  ) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: { date: iso(0), description: 'قيد تحقق', lines, ...extra },
    });
    expect(posted.status).toBeLessThan(300);
    return data(posted.body) as { id: string };
  };

  const list = (query = '') => api(ctx.server, 'get', `/api/v1/cost-centers${query ? `?${query}` : ''}`, { token: actor.token });
  const statement = (id: string, query = '') =>
    api(ctx.server, 'get', `/api/v1/statements/cost-center/${id}${query ? `?${query}` : ''}`, { token: actor.token });

  const balanceOf = async (id: string) => {
    const all = rows((await list('with_balances=1')).body);
    const row = all.find((entry) => entry.id === id);
    return (row?.balance ?? {}) as { balance?: string; ownBalance?: string; children?: number; debit?: string; credit?: string };
  };

  beforeAll(async () => {
    ctx = await createTestApp('cost-centers');
    actor = await createActor(ctx, {
      tenantCode: 'cc-tree',
      email: 'owner@cc-tree.test',
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
      tenantCode: 'cc-tree-2',
      email: 'owner@cc-tree-2.test',
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

    const account = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });
    expenseId = await account({ code: '5100', nameAr: 'مصروفات', type: 'expense' });

    // 🌳 مركز رئيسي → فرعي → فرعي تحته.
    rootId = await centre({ code: 'C1', nameAr: 'الإدارة', branchId });
    childId = await centre({ code: 'C11', nameAr: 'المبيعات', parentId: rootId, branchId });
    grandChildId = await centre({ code: 'C111', nameAr: 'معرض', parentId: childId, branchId });

    await post(
      [
        { accountId: expenseId, debit: '200', costCenterId: grandChildId },
        { accountId: cashId, credit: '200' },
      ],
      { date: iso(-6), branchId },
    );
    await post(
      [
        { accountId: expenseId, debit: '50', costCenterId: childId },
        { accountId: cashId, credit: '50' },
      ],
      { date: iso(-4), branchId },
    );
    await post(
      [
        { accountId: expenseId, debit: '30', costCenterId: childId },
        { accountId: cashId, credit: '30' },
      ],
      { date: iso(-2), branchId },
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. 🌳 الشجرة — الأب يجمع أبناءه، والرصيد من المرحّل فقط', async () => {
    const root = await balanceOf(rootId);
    expect(amt((await balanceOf(rootId)).balance)).toBe('280.0000'); // 200 + 50 + 30
    expect(near(Number(root.ownBalance), 0)).toBe(true);
    expect(root.children).toBe(2);

    const child = await balanceOf(childId);
    expect(amt(child.balance)).toBe('280.0000'); // 50 + 30 + ابنه 200
    expect(amt(child.ownBalance)).toBe('80.0000');
    expect(child.children).toBe(1);

    // … and what the tree shows on a node is what its statement closes on.
    const body = (await statement(childId)).body as Record<string, unknown>;
    expect(near(Number((body.totals as { closing?: string }).closing), 280)).toBe(true);
  });

  it('2. وما عُكس ليس مالاً على المركز', async () => {
    const extra = await post(
      [
        { accountId: expenseId, debit: '120', costCenterId: grandChildId },
        { accountId: cashId, credit: '120' },
      ],
      { date: iso(-1) },
    );
    expect(amt((await balanceOf(grandChildId)).balance)).toBe('320.0000');

    const periods = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });
    const open = (data(periods.body) as Array<{ id: string; status: string }>).find((row) => row.status === 'open');
    const reversed = await api(ctx.server, 'post', `/api/v1/journal-entries/${extra.id}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: open?.id, date: iso(0), reason: 'عكس للتحقق' },
    });
    expect(reversed.status).toBeLessThan(300);
    expect(amt((await balanceOf(grandChildId)).balance)).toBe('200.0000');
  });

  it('3. 🏷️ النوع · 📂 البند الرئيسي · المستوى', async () => {
    const all = rows((await list('with_balances=1')).body);
    const root = all.find((row) => row.id === rootId);
    const child = all.find((row) => row.id === childId);
    const leaf = all.find((row) => row.id === grandChildId);

    expect(root?.kind).toBe('main');
    expect(root?.level).toBe(0);
    expect(root?.parentName ?? null).toBeNull();
    expect(child?.kind).toBe('sub');
    expect(child?.level).toBe(1);
    expect(child?.parentName).toBe('الإدارة');
    expect(leaf?.level).toBe(2);
    expect(leaf?.parentName).toBe('المبيعات');
  });

  it('4. 📊 كشف مركز الكلفة — رصيد سابق ورصيد متحرّك', async () => {
    const body = (await statement(childId, `from=${iso(-5)}`)).body as Record<string, unknown>;
    const all = rows(body);
    const opening = all.find((row) => row.rank === 0);

    expect(opening?.description).toBe('رصيد مرحل من فترة سابقة');
    expect(opening?.entryType).toBe('رصيد سابق');
    // The 200 of the grandchild, posted before the period, is where the report starts.
    expect(amt(opening?.debit)).toBe('200.0000');
    expect(opening?.balanceStatus).toBe('مدين');

    const running = all.map((row) => Number(row.runningBalance));
    expect(near(running[0], 200)).toBe(true);
    expect(near(running.at(-1)!, 280)).toBe(true);
    expect(near(Number((body.totals as { closing?: string }).closing), 280)).toBe(true);
  });

  it('5. 📑 نوع التقرير — تجميعي مقابل تفصيلي', async () => {
    await post([
      { accountId: expenseId, debit: '10', costCenterId: childId },
      { accountId: expenseId, debit: '20', costCenterId: childId },
      { accountId: cashId, credit: '30' },
    ]);

    const detailed = rows((await statement(childId, `from=${iso(-5)}`)).body);
    const summary = rows((await statement(childId, `from=${iso(-5)}&summary=1`)).body);

    // One entry carrying two lines on this centre: two rows تفصيلي, one تجميعي.
    console.log('DEBUG summary', JSON.stringify(summary.map((r) => [r.rank, r.debit, r.credit, r.description])));
    expect(detailed.length - summary.length).toBe(1);
    expect(summary.some((row) => amt(row.debit) === '30.0000')).toBe(true);
  });

  it('6. اسم الحساب و🌿 الفرع — تضييق الكشف', async () => {
    await post(
      [
        { accountId: cashId, debit: '15', costCenterId: childId },
        { accountId: expenseId, credit: '15' },
      ],
      { date: iso(-1), branchId: otherBranchId },
    );

    const byAccount = (await statement(childId, `account_id=${cashId}&hide_previous_balance=1`)).body as Record<string, unknown>;
    expect(near(Number((byAccount.totals as { debit?: string }).debit), 15)).toBe(true);

    const byBranch = rows((await statement(childId, `from=${iso(-5)}&branch_id=${otherBranchId}&hide_previous_balance=1`)).body);
    expect(byBranch.every((row) => row.branchName === 'فرع ثان')).toBe(true);
    expect(near(Number(byBranch.reduce((sum, row) => sum + Number(row.debit), 0)), 15)).toBe(true);
  });

  it('7. فترة كاملة — بلا سطر افتتاح، ونفس الرصيد', async () => {
    const body = (await statement(childId, 'full_period=1')).body as Record<string, unknown>;
    expect(rows(body).every((row) => row.rank !== 0)).toBe(true);
    expect(near(Number((body.totals as { closing?: string }).closing), Number((await balanceOf(childId)).balance))).toBe(true);
  });

  it('8. التوافق — القائمة بلا معايير كما كانت تماماً', async () => {
    const all = rows((await list()).body);
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]?.balance).toBeUndefined();
    expect(all[0]).toHaveProperty('code');
    expect(all[0]).toHaveProperty('nameAr');
  });

  it('9. عزل المؤسسات — مركز مؤسسة أخرى غير موجود', async () => {
    const response = await api(ctx.server, 'get', `/api/v1/statements/cost-center/${rootId}`, { token: stranger.token });
    expect(response.status).toBe(404);
  });
});
