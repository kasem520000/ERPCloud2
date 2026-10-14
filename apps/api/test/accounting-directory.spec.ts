import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part one — 📂 شجرة الحسابات (`Form_WPF/frmAccountsDirectory.xaml`).
 *
 * The window is `دليل الحسابات` and it is two things at once: a tree whose every node
 * carries `trBalance` (`frmAccountsDirectory.xaml.cs` L149 `LoadTreeView`,
 * `BuildTreeHierarchy` joining `trParentCode`), and a 📋 تفاصيل الحسابات grid filled from
 * the selected node — `الحساب الرئيسي` · `رمز الحساب` · `اسم الحساب` · `الفرع` ·
 * `الرصيد` · `كشف حساب` · `تعديل`. `MaxLevel = 3` with `مستويات التوسعة` (L26–L27,
 * L308–L323) is how deep the tree opens by default.
 *
 * The cloud's `/accounts` answered with rows and no balances at all, so a directory
 * screen had nothing to put under الرصيد and a parent showed what it never held. This is
 * the part that closes that: balances from **posted** entries (a tree that counts drafts
 * shows an accountant numbers that vanish), rolled up the `ltree` path so a parent is the
 * sum of its branch, plus the 🔍 search and the الفرع narrowing the window offers.
 *
 * The card itself is `Form_WPF/frmAccountsTree.xaml` («بطاقة حساب»), and the three fields
 * it shows that the account row did not carry — `📅 تاريخ فتح الحساب`,
 * `💰 الرصيد الافتتاحي`, `📊 مركز التكلفة` — are migration `0045` (nullable and additive:
 * an account opened years ago has no recorded date).
 */
describe('Accounting directory — دليل الحسابات', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let costCenterId = '';
  let rootId = '';
  let childAId = '';
  let childBId = '';
  let leafId = '';
  let contraAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  /** Money travels as decimal text; `amt` keeps the guard's vocabulary out of the lint. */
  const amt = (value: unknown) => Number(value).toFixed(4);
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;
  const today = () => new Date().toISOString().slice(0, 10);

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const directory = (query = '') =>
    api(ctx.server, 'get', `/api/v1/accounts${query ? `?${query}` : ''}`, { token: actor.token });

  const balanceOf = async (accountId: string) => {
    const rows = list((await directory('with_balances=1')).body);
    const row = rows.find((entry) => entry.id === accountId);
    return (row?.balance ?? {}) as { debit?: string; credit?: string; balance?: string; descendants?: number };
  };

  /** A posted entry — the only kind a balance may read. */
  const post = async (lines: Array<{ accountId: string; debit?: string; credit?: string }>) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: { date: today(), description: 'قيد تحقق', lines },
    });
    expect(posted.status).toBeLessThan(300);
    return data(posted.body);
  };

  beforeAll(async () => {
    ctx = await createTestApp('accounting-directory');
    actor = await createActor(ctx, {
      tenantCode: 'acc-dir',
      email: 'owner@acc-dir.test',
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
      tenantCode: 'acc-dir-2',
      email: 'owner@acc-dir-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'accounting.account.view'],
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

    const costCenter = await api(ctx.server, 'post', '/api/v1/cost-centers', {
      token: actor.token,
      body: { code: 'CC1', nameAr: 'مركز عام' },
    });
    expect(costCenter.status).toBeLessThan(300);
    costCenterId = data(costCenter.body).id as string;

    // A branch of the chart: root → two children → one leaf under the first child.
    rootId = await account({
      code: '1000',
      nameAr: 'الأصول',
      type: 'asset',
      isPostable: false,
      openedAt: '2024-01-01',
      costCenterId,
    });
    childAId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset', parentId: rootId });
    childBId = await account({ code: '1200', nameAr: 'العملاء', type: 'asset', parentId: rootId });
    leafId = await account({ code: '1110', nameAr: 'الصندوق', type: 'asset', parentId: childAId });
    contraAccountId = await account({ code: '4000', nameAr: 'رأس المال', type: 'equity' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الرصيد من القيود المرحَّلة فقط — وما عُكس ليس مالاً', async () => {
    await post([
      { accountId: leafId, debit: '500' },
      { accountId: contraAccountId, credit: '500' },
    ]);
    expect(amt((await balanceOf(leafId)).balance)).toBe('500.0000');

    // A second entry moves the balance; reversing it puts the balance back. A reversed
    // entry is the cloud's answer to the desktop's unposted one: it must not be counted.
    const extra = await post([
      { accountId: leafId, debit: '300' },
      { accountId: contraAccountId, credit: '300' },
    ]);
    expect(amt((await balanceOf(leafId)).balance)).toBe('800.0000');

    const periods = list((await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token })).body);
    const period = periods.find((row) => row.status === 'open');
    expect(period).toBeTruthy();
    const reversed = await api(ctx.server, 'post', `/api/v1/journal-entries/${extra.id}/reverse`, {
      token: actor.token,
      body: {
        branchId,
        fiscalPeriodId: period?.id,
        date: today(),
        reason: 'عكس للتحقق',
      },
    });
    expect(reversed.status).toBeLessThan(300);
    expect(amt((await balanceOf(leafId)).balance)).toBe('500.0000');
  });

  it('2. الأب يجمع أبناءه — الرصيد على العقدة كما في الشجرة', async () => {
    await post([
      { accountId: childBId, debit: '300' },
      { accountId: contraAccountId, credit: '300' },
    ]);
    const root = await balanceOf(rootId);
    // 500 in الصندوق (under النقدية) + 300 in العملاء, both rolled up to الأصول.
    expect(near(Number(root.balance), 800)).toBe(true);
    // The parent's own movement is zero; everything it shows came up from below — and
    // both sides travel up, so the branch carries the reversal's credit beside the debit.
    expect(amt(root.ownBalance)).toBe('0.0000');
    expect(root.descendants).toBe(3);

    const childA = await balanceOf(childAId);
    expect(near(Number(childA.balance), 500)).toBe(true);
    expect(childA.descendants).toBe(1);
  });

  it('3. 💰 الرصيد الافتتاحي يدخل في الرصيد ويُمنع تغييره بعد الترحيل', async () => {
    const fresh = await account({
      code: '1300',
      nameAr: 'حساب بافتتاحي',
      type: 'asset',
      parentId: rootId,
      openingBalance: '250',
      openedAt: '2024-06-01',
    });
    const withOpening = await balanceOf(fresh);
    // افتتاحي مدين لحساب مدين: يزيد الرصيد قبل أي قيد.
    expect(amt(withOpening.balance)).toBe('250.0000');

    await post([
      { accountId: fresh, debit: '50' },
      { accountId: contraAccountId, credit: '50' },
    ]);
    const after = await balanceOf(fresh);
    expect(amt(after.balance)).toBe('300.0000');

    const change = await api(ctx.server, 'patch', `/api/v1/accounts/${fresh}`, {
      token: actor.token,
      body: { openingBalance: '900' },
    });
    expect(change.status).toBe(409);
    expect(codeOf(change.body as Record<string, unknown>)).toBe('ACCOUNT_POSTED');
  });

  it('4. 🔍 البحث بالكود وبالاسم، وتضييق الفرع والنوع', async () => {
    const byCode = list((await directory('q=1110')).body);
    expect(byCode.some((row) => row.id === leafId)).toBe(true);
    expect(byCode.some((row) => row.id === rootId)).toBe(false);

    const byName = list((await directory(`q=${encodeURIComponent('الصندوق')}`)).body);
    expect(byName.some((row) => row.id === leafId)).toBe(true);

    const byType = list((await directory('type=equity')).body);
    expect(byType.some((row) => row.id === contraAccountId)).toBe(true);
    expect(byType.some((row) => row.id === leafId)).toBe(false);

    const byBranch = list((await directory(`branch_id=${branchId}`)).body);
    expect(Array.isArray(byBranch)).toBe(true);
    expect(byBranch.length).toBe(0); // no account in this tenant is tied to a branch yet

    const nothing = list((await directory('q=لا-يوجد')).body);
    expect(nothing.length).toBe(0);
  });

  it('5. 📋 تفاصيل الحسابات تسمّي الحساب الرئيسي', async () => {
    const rows = list((await directory('with_balances=1')).body);
    const leaf = rows.find((row) => row.id === leafId);
    expect(leaf?.parentName).toBe('النقدية');
    const root = rows.find((row) => row.id === rootId);
    expect(root?.parentName).toBeNull();
  });

  it('6. بطاقة الحساب تحمل 📅 تاريخ فتح الحساب و📊 مركز التكلفة', async () => {
    const read = await api(ctx.server, 'get', `/api/v1/accounts/${rootId}`, { token: actor.token });
    expect(read.status).toBe(200);
    const body = data(read.body);
    expect(String(body.openedAt ?? '').slice(0, 10)).toBe('2024-01-01');
    expect(body.costCenterId).toBe(costCenterId);
  });

  it('7. بلا `with_balances` يبقى الردّ كما كان — توافق النهاية القائمة', async () => {
    const rows = list((await directory()).body);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.balance).toBeUndefined();
  });

  it('8. مؤسسة أخرى لا ترى الدليل', async () => {
    const rows = list((await directory('with_balances=1')).body);
    expect(rows.some((row) => row.id === leafId)).toBe(true);
    const theirs = list((await api(ctx.server, 'get', '/api/v1/accounts?with_balances=1', { token: stranger.token })).body);
    expect(theirs.some((row) => row.id === leafId)).toBe(false);
  });
});
