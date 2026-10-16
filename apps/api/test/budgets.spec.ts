import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📊 M6.4 — الموازنات والمقارنة بالفعلي.
 *
 * قاعدتان تُختبران هنا كما صُمّمتا في `budgets/README.md`:
 *
 *   1. **لا رصيد ثانٍ** — «الفعلي» حركة القيود المُرحَّلة بإشارة الرصيد الطبيعي، والموازنة
 *      SUM سطورها؛ فالتقرير محسوب لا مخزَّن ولا يمكنه أن ينحرف عن الدفتر.
 *   2. **الاعتماد يجمّد** — سطور المسودة تُستبدل شهرًا شهرًا للموسمية، والاعتماد يقفلها
 *      (409)، والموازنة المعتمدة لا تُحذف والمسودة تُحذف ناعمًا.
 *
 * ويُثبت التوزيع قاعدته الموروثة من جدول الإهلاك (M6.1): قسط متساوٍ HALF_UP بدقة 4،
 * والفترة الأخيرة تحمل الباقي بالضبط فيتساوى المجموع مع السنوي تساوياً تاماً.
 */
describe('Budgets — الموازنات والمقارنة بالفعلي', () => {
  let ctx: TestApp;
  let owner: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let fiscalYearId = '';
  let revenueAccountId = '';
  let expenseAccountId = '';
  let unbudgetedAccountId = '';
  let telescopeAccountId = '';
  let cashAccountId = '';
  let planId = '';
  let sidePlanId = '';

  const dataOf = (body: Record<string, unknown>) => (body.data ?? body) as Record<string, unknown>;

  const createBudget = (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/budgets', { token: owner.token, body });

  const readBudget = (id: string, token = owner.token) =>
    api(ctx.server, 'get', `/api/v1/budgets/${id}`, { token });

  const patchBudget = (id: string, body: Record<string, unknown>, token = owner.token) =>
    api(ctx.server, 'patch', `/api/v1/budgets/${id}`, { token, body });

  const variance = (id: string, to?: string) =>
    api(ctx.server, 'get', `/api/v1/budgets/${id}/variance${to ? `?to=${to}` : ''}`, { token: owner.token });

  /** قيد يومية يدوي متوازن — الفعلي الذي تُقاس عليه الموازنة يأتي من هنا ومن لا شيء آخر. */
  const postEntry = (date: string, lines: Array<Record<string, string>>) =>
    api(ctx.server, 'post', '/api/v1/journal-entries', { token: owner.token, body: { date, lines } });

  beforeAll(async () => {
    ctx = await createTestApp('budgets');
    owner = await createActor(ctx, {
      tenantCode: 'budgets',
      tenantName: 'مخابز الموازنات',
      email: 'owner@budgets.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.reports.view',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.budget.view',
        'accounting.budget.manage',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });
    viewer = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'budgets',
      email: 'viewer@budgets.test',
      permissions: ['accounting.budget.view'],
      isOwner: false,
    });
    stranger = await createActor(ctx, {
      tenantCode: 'budgets-other',
      tenantName: 'منشأة أخرى',
      email: 'owner@budgets-other.test',
      permissions: ['accounting.budget.view', 'accounting.budget.manage'],
      isOwner: true,
    });

    // فرعٌ افتراضي للتهيئة — القيود اليدوية تستنتجه من التاريخ عبر نقطة النهاية.
    await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);
    fiscalYearId = dataOf(fiscal.body).id as string;

    const account = async (code: string, nameAr: string, type: string) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', {
        token: owner.token,
        body: { code, nameAr, type },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return dataOf(created.body).id as string;
    };
    revenueAccountId = await account('4300001', 'إيرادات مقررة', 'revenue');
    expenseAccountId = await account('5300001', 'مصروفات مقررة', 'expense');
    unbudgetedAccountId = await account('5300002', 'مصروف غير موظف', 'expense');
    telescopeAccountId = await account('5300003', 'مصروف كسور التوزيع', 'expense');
    cashAccountId = await account('1100001', 'الصندوق', 'asset');
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('creates a draft and distributes the annual amounts with an exact telescoping last period', async () => {
    const created = await createBudget({
      name: 'الخطة الأساسية',
      fiscalYearId,
      notes: 'موازنة العام',
      lines: [
        { accountId: revenueAccountId, annualAmount: '120000' },
        { accountId: expenseAccountId, annualAmount: '60000' },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    planId = dataOf(created.body).id as string;

    const read = dataOf((await readBudget(planId)).body) as {
      status: string;
      totalAmount: string;
      lines: Array<{ accountId: string; periodName: string; amount: string }>;
    };
    expect(read.status).toBe('draft');
    expect(read.totalAmount).toBe('180000.0000');
    expect(read.lines).toHaveLength(24); // حسابان × 12 فترة.
    const revenueLines = read.lines.filter((line) => line.accountId === revenueAccountId);
    expect(revenueLines.map((line) => line.amount)).toEqual(Array(12).fill('10000.0000'));
    const expenseLines = read.lines.filter((line) => line.accountId === expenseAccountId);
    expect(expenseLines.map((line) => line.amount)).toEqual(Array(12).fill('5000.0000'));

    // الكسور: 100 ÷ 12 = 8.3333، والأخيرة تحمل الباقي بالضبط فيكتمل المجموع 100.
    const side = await createBudget({
      name: 'الخطة الفرعية',
      fiscalYearId,
      lines: [{ accountId: telescopeAccountId, annualAmount: '100' }],
    });
    expect(side.status, JSON.stringify(side.body)).toBe(201);
    sidePlanId = dataOf(side.body).id as string;
    const sideRead = dataOf((await readBudget(sidePlanId)).body) as { totalAmount: string; lines: Array<{ amount: string }> };
    expect(sideRead.lines).toHaveLength(12);
    expect(sideRead.lines.slice(0, 11).map((line) => line.amount)).toEqual(Array(11).fill('8.3333'));
    expect(sideRead.lines[11]?.amount).toBe('8.3337');
    expect(sideRead.totalAmount).toBe('100.0000');

    // الرفض: مبلغ غير موجب، وحساب مكرر، وسنة مالية غريبة.
    expect((await createBudget({ name: 'بلا مقدار', fiscalYearId, lines: [{ accountId: revenueAccountId, annualAmount: '0' }] })).status).toBe(422);
    expect(
      (
        await createBudget({
          name: 'مكرر',
          fiscalYearId,
          lines: [
            { accountId: revenueAccountId, annualAmount: '10' },
            { accountId: revenueAccountId, annualAmount: '20' },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await createBudget({ name: 'سنة غريبة', fiscalYearId: '00000000-0000-0000-0000-000000000000', lines: [{ accountId: revenueAccountId, annualAmount: '10' }] })).status).toBe(404);
  });

  it('refuses a duplicate name per fiscal year and isolates tenants', async () => {
    const clash = await createBudget({ name: 'الخطة الأساسية', fiscalYearId, lines: [{ accountId: revenueAccountId, annualAmount: '10' }] });
    expect(clash.status).toBe(409);
    expect((clash.body as { code?: string }).code).toBe('BUDGET_NAME_TAKEN');

    // المستأجر الآخر: قائمته فارغة وبطاقة غيره غير موجودة — عزل لا رفض.
    const otherList = await api(ctx.server, 'get', '/api/v1/budgets', { token: stranger.token });
    expect(otherList.status).toBe(200);
    expect((otherList.body as { data?: unknown[] }).data).toEqual([]);
    expect((await readBudget(planId, stranger.token)).status).toBe(404);
  });

  it('replaces monthly lines on a draft then freezes them on approval', async () => {
    // فترات السنة مرتبة — من نقطة النهاية الرسمية نفسها التي تقرأ بها الشاشة.
    // الشاشة تعرضها تنازليًا (أحدث فترة أولًا) — التوزيع يصعّدها بنفسه؛ هنا نطلبها صاعدة.
    const periods = dataOf(
      (await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: owner.token })).body,
    ) as Array<{ id: string; fiscalYearId: string; startDate: string }>;
    const yearPeriods = periods
      .filter((period) => period.fiscalYearId === fiscalYearId)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
      .map((period) => period.id);
    expect(yearPeriods).toHaveLength(12);

    // الاستبدال كامل كخريطة الربط المحاسبي: موسمية صريحة للمصروف (6000 في يناير
    // وفبراير و4800 للباقي = 60000) مع بقاء سطور الإيراد كما وزّعها الإنشاء.
    const seasonal = [
      { accountId: expenseAccountId, fiscalPeriodId: yearPeriods[0]!, amount: '6000' },
      { accountId: expenseAccountId, fiscalPeriodId: yearPeriods[1]!, amount: '6000' },
      ...yearPeriods.slice(2).map((periodId) => ({ accountId: expenseAccountId, fiscalPeriodId: periodId, amount: '4800' })),
      ...yearPeriods.map((periodId) => ({ accountId: revenueAccountId, fiscalPeriodId: periodId, amount: '10000' })),
    ];
    const replaced = await patchBudget(planId, { lines: seasonal });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const after = dataOf((await readBudget(planId)).body) as { totalAmount: string; lines: Array<{ accountId: string; amount: string }> };
    expect(after.totalAmount).toBe('180000.0000'); // الإيراد لم يُمَس.
    const expenseLines = after.lines.filter((line) => line.accountId === expenseAccountId);
    expect(expenseLines[0]?.amount).toBe('6000.0000');
    expect(expenseLines[2]?.amount).toBe('4800.0000');

    // فترة من سنة أخرى في السطور — مرفوضة صراحة.
    const nextYear = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${new Date().getUTCFullYear() + 1}`, startDate: `${new Date().getUTCFullYear() + 1}-01-01`, endDate: `${new Date().getUTCFullYear() + 1}-12-31` },
    });
    expect(nextYear.status).toBe(201);
    const nextYearId = dataOf(nextYear.body).id as string;
    const nextYearPeriods = (
      dataOf((await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: owner.token })).body) as Array<{ id: string; fiscalYearId: string }>
    ).filter((period) => period.fiscalYearId === nextYearId);
    expect(nextYearPeriods.length).toBeGreaterThan(0);
    const wrongPeriod = await patchBudget(sidePlanId, {
      lines: [{ accountId: telescopeAccountId, fiscalPeriodId: nextYearPeriods[0]!.id, amount: '10' }], // فترة غريبة — يُرفض قبل أن يمسّ شيئًا
    });
    expect(wrongPeriod.status).toBe(422);
    expect((wrongPeriod.body as { code?: string }).code).toBe('BUDGET_PERIOD_INVALID');

    // الاعتماد يجمّد: السطور بعده مرفوضة، والاعتماد مرتين مرفوض، والحذف مرفوض.
    const approved = await patchBudget(planId, { status: 'approved' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(dataOf(approved.body).status).toBe('approved');
    expect(dataOf(approved.body).approvedAt).toBeTruthy();
    expect((await patchBudget(planId, { lines: seasonal })).status).toBe(409);
    expect((await patchBudget(planId, { status: 'approved' })).status).toBe(409);
    expect((await api(ctx.server, 'delete', `/api/v1/budgets/${planId}`, { token: owner.token })).status).toBe(409);
  });

  it('computes the variance against posted actuals with a to-date cutoff', async () => {
    const year = new Date().getUTCFullYear();
    // الفعلي: بيع نقدي 9000، ومصروف مقرر 5500 في يناير؛ ومصروف غير موظف 700 في فبراير.
    expect((await postEntry(`${year}-01-15`, [
      { accountId: cashAccountId, debit: '9000' },
      { accountId: revenueAccountId, credit: '9000' },
    ])).status).toBe(201);
    expect((await postEntry(`${year}-01-20`, [
      { accountId: expenseAccountId, debit: '5500' },
      { accountId: cashAccountId, credit: '5500' },
    ])).status).toBe(201);
    expect((await postEntry(`${year}-02-10`, [
      { accountId: unbudgetedAccountId, debit: '700' },
      { accountId: cashAccountId, credit: '700' },
    ])).status).toBe(201);

    // حتى نهاية يناير: موازنة يناير فقط مقابل فعلي يناير فقط.
    const january = dataOf((await variance(planId, `${year}-01-31`)).body) as {
      from: string;
      to: string;
      rows: Array<{ accountId: string; budgeted: string; actual: string; variance: string; variancePct: string | null; inBudget: boolean }>;
      totals: { budgetedResult: string; actualResult: string; variance: string };
    };
    expect(january.to).toBe(`${year}-01-31`);
    const byId = new Map(january.rows.map((row) => [row.accountId, row]));
    expect(byId.get(revenueAccountId)).toMatchObject({ budgeted: '10000.0000', actual: '9000.0000', variance: '1000.0000', variancePct: '10.00', inBudget: true });
    expect(byId.get(expenseAccountId)).toMatchObject({ budgeted: '6000.0000', actual: '5500.0000', variance: '500.0000' });
    // فبراير خارج النطاق: المصروف غير الموظف غائب والصندوق بحركة يناير وحدها.
    expect(byId.has(unbudgetedAccountId)).toBe(false);
    expect(byId.get(cashAccountId)).toMatchObject({ budgeted: '0.0000', actual: '3500.0000', inBudget: false });
    expect(january.totals).toEqual({ budgetedResult: '4000.0000', actualResult: '3500.0000', variance: '500.0000' });

    // الافتراضي (السنة كاملة): الموازنة كاملة، والغير موظف يظهر بفعله، و`to` فوق نهاية
    // السنة تُقصّ عليها.
    const full = dataOf((await variance(planId, '2099-01-01')).body) as {
      to: string;
      rows: Array<{ accountId: string; budgeted: string; actual: string; variance: string; inBudget: boolean }>;
      totals: { budgetedResult: string; actualResult: string; variance: string };
    };
    expect(full.to).toBe(`${year}-12-31`);
    const fullById = new Map(full.rows.map((row) => [row.accountId, row]));
    expect(fullById.get(revenueAccountId)).toMatchObject({ budgeted: '120000.0000', actual: '9000.0000', variance: '111000.0000' });
    expect(fullById.get(expenseAccountId)).toMatchObject({ budgeted: '60000.0000', actual: '5500.0000' });
    expect(fullById.get(unbudgetedAccountId)).toMatchObject({ budgeted: '0.0000', actual: '700.0000', variance: '-700.0000', inBudget: false });
    // النتيجة: الموازنة 60000 والفعلي 2800 (يشمل غير الموظف — الفعلي فعلي).
    expect(full.totals).toEqual({ budgetedResult: '60000.0000', actualResult: '2800.0000', variance: '57200.0000' });
  });

  it('deletes a draft softly and refuses what is not a draft', async () => {
    const deleted = await api(ctx.server, 'delete', `/api/v1/budgets/${sidePlanId}`, { token: owner.token });
    expect(deleted.status).toBe(200);
    expect((await readBudget(sidePlanId)).status).toBe(404);
    const list = dataOf((await api(ctx.server, 'get', '/api/v1/budgets', { token: owner.token })).body) as Array<{ id: string }>;
    expect(list.map((row) => row.id)).not.toContain(sidePlanId);
  });

  it('splits the permission: the viewer reads everything and writes nothing', async () => {
    expect((await api(ctx.server, 'get', '/api/v1/budgets', { token: viewer.token })).status).toBe(200);
    expect((await api(ctx.server, 'get', `/api/v1/budgets/${planId}/variance`, { token: viewer.token })).status).toBe(200);
    expect((await readBudget(planId, viewer.token)).status).toBe(200);
    expect((await createBudget({ name: 'محاولة', fiscalYearId, lines: [{ accountId: revenueAccountId, annualAmount: '10' }] })).status).toBe(201); // owner
    expect(
      (
        await api(ctx.server, 'post', '/api/v1/budgets', {
          token: viewer.token,
          body: { name: 'لا صلاحية', fiscalYearId, lines: [{ accountId: revenueAccountId, annualAmount: '10' }] },
        })
      ).status,
    ).toBe(403);
    expect((await patchBudget(planId, { notes: 'قراءة فقط' }, viewer.token)).status).toBe(403);
    expect((await api(ctx.server, 'delete', `/api/v1/budgets/${planId}`, { token: viewer.token })).status).toBe(403);
  });
});
