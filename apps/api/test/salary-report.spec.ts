import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part five — 📊 تقرير الرواتب (`Form_WPF/frmRptSalary.xaml` «💼 تقرير
 * الرواتب»).
 *
 * The window is a `🔍 عرض` button, two boxes («الشهر:» · «السنة:») disabled while
 * «كل الفترة» is checked (`ckWholePeriod_CheckedChanged` L48), a grid «💼 بيانات
 * الرواتب» of `م · SalId · رقم السند · 👤 الموظف · الراتب الأساسي · بدل سكن · بدل
 * مواصلات · الحوافز · 💰 الإجمالي · الخصومات · 💵 صافي الراتب · 👁️ عرض`, and a
 * `💰 إجمالي الرواتب:` footer. `btnShow_Click` (L58) reads `SalaryPay` with
 * `IS_Deleted=0`, narrows it by `year`/`month` unless «كل الفترة» is on, and computes
 * `gross = tot_salary + Houses + Travel + salary_add` (L104) and `net = gross −
 * salary_sub`, summing the nets for the footer (L113).
 *
 * `SalaryPay` is the cloud's `salary_payments` — the إذن صرف of part three — so the
 * report reads documents the payment window already writes; nothing new is stored.
 *
 * One deviation, named: the window's `gross` has no room for the four allowances the
 * desktop's payment card never shows either, but the cloud's إذن carries them in
 * `other_allowances` (part three, decision 2). A gross that did not add up to the صافي
 * printed on the very same payment would be a lie, so الإجمالي here is
 * `الصافي + الخصومات`.
 */
describe('تقرير الرواتب — frmRptSalary', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let cashLocationId = '';
  let employeeId = '';
  let deductionTypeId = '';
  let removedPaymentId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : (((body as { data?: unknown }).data as unknown[]) ?? [])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });

  const today = () => new Date().toISOString().slice(0, 10);
  const report = (query = '') => get(`/hrm/reports/salary${query ? `?${query}` : ''}`);
  const linesOf = async (query = '') => rowsOf(data((await report(query)).body).rows);

  /** The seven allowances: 5000 + 1000 + 500 + 300 + 200 + 250 + 150 = 7400. */
  const components = { basic: '5000', housing: '1000', transport: '500', food: '300', medical: '200', fixedBonus: '250', other: '150' };

  beforeAll(async () => {
    ctx = await createTestApp('salary-report');
    actor = await createActor(ctx, {
      tenantCode: 'sal-report',
      email: 'owner@sal-report.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'hrm.view',
        'hrm.manage',
        'hrm.adjust.approve',
        'hrm.payroll.post',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.reports.view',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'organization.branch.manage',
        'organization.cashlocation.manage',
        'organization.cashlocation.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.voucher.void',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'sal-report-2',
      email: 'owner@sal-report-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage', 'hrm.payroll.post'],
    });

    const year = new Date().getUTCFullYear();
    // Two years of monthly periods: the إذنات below are spread over future months, and a
    // voucher cannot be posted into a month no fiscal period covers.
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year + 1}-12-31` });
    expect(fiscal.status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    const cashAccountId = data((await post('/accounts', { code: '1211', nameAr: 'الصندوق', type: 'asset' })).body).id as string;
    const safe = await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية', accountId: cashAccountId });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;

    // «موظفين الفرع الرئيسي» — `Class/Common.cs` L998 `isnull(EmployeeAcc,2241)`: the
    // root the card hangs the employee's account under, without which no إذن can be paid.
    const root = await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability', isPostable: false });
    expect(root.status).toBe(201);

    const employee = await post('/hrm/employees', { employeeNo: 'SR-1', name: 'سالم أحمد', branchId, salaryComponents: components });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
    expect(data(employee.body).employeeAccountId).toBeTruthy();

    // 🔴 خصم — so «الخصومات» و«💰 الإجمالي» are not both zero in the report.
    const deduction = await post('/hrm/adjustment-types', { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 1 });
    expect(deduction.status).toBe(201);
    deductionTypeId = data(deduction.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  /** An إذن صرف عن شهر — the document `frmRptSalary` reports on. */
  const pay = (yearMonth: string, extra: Record<string, unknown> = {}) =>
    post('/hrm/salary-payments', {
      employeeId,
      branchId,
      yearMonth,
      paymentDate: `${yearMonth}-01`,
      cashLocationId,
      method: 'cash',
      ...extra,
    });

  const approveDeduction = async (startsOn: string) => {
    const created = await post('/hrm/adjustments', {
      employeeId,
      typeId: deductionTypeId,
      valueText: '120',
      startsOn,
      subFromSalary: true,
    });
    expect(created.status).toBe(201);
    const approved = await post(`/hrm/adjustments/${data(created.body).id}/approve`, {});
    expect([200, 201]).toContain(approved.status);
  };

  it('💼 تقرير الرواتب — «كل الفترة» هي الأصل، والشهر والسنة يضيّقانها', async () => {
    const month = today().slice(0, 7);
    await approveDeduction(today());
    const paid = await pay(month);
    expect(paid.status).toBe(201);

    // «كل الفترة» is checked by default (`ckWholePeriod` L200) and both boxes are
    // disabled with it; the endpoint's default is the same.
    const all = data((await report()).body);
    expect(all.allPeriod).toBe(true);
    expect(rowsOf(all.rows).length).toBeGreaterThan(0);

    const onMonth = data((await report(`all_period=false&year=${month.slice(0, 4)}&month=${month.slice(5)}`)).body);
    expect(rowsOf(onMonth.rows)).toHaveLength(1);

    // A month with nothing in it — the window prints an empty grid rather than refusing.
    const empty = data((await report('all_period=false&year=1999&month=1')).body);
    expect(rowsOf(empty.rows)).toHaveLength(0);
    expect(empty.summary).toMatchObject({ total: '0.0000', count: 0 });
  });

  it('الصفّ — «رقم السند» و«👤 الموظف» وحساب «💰 الإجمالي» و«💵 صافي الراتب»', async () => {
    const month = today().slice(0, 7);
    const [row] = await linesOf(`all_period=false&year=${month.slice(0, 4)}&month=${month.slice(5)}`);
    const payment = data((await post('/hrm/payroll/preview', { yearMonth: month })).body) as { lines: Array<{ employeeId: string; net: string }> };
    const line = payment.lines.find((entry) => entry.employeeId === employeeId);

    expect(row).toMatchObject({
      seq: 1,
      employeeNo: 'SR-1',
      employeeName: 'سالم أحمد',
      branchName: 'الفرع الرئيسي',
      yearMonth: month,
      month: month.slice(5),
      year: month.slice(0, 4),
      basic: '5000.0000',
      housing: '1000.0000',
      transport: '500.0000',
      additions: '0.0000',
      deductions: '120.0000',
      net: line?.net,
      posted: true,
    });
    expect(String(row?.number)).toMatch(/^\d+$/);
    expect(row?.voucherNumber).toBeTruthy();
    // `gross = tot_salary + Houses + Travel + salary_add` (L104) plus the four allowances
    // the window has no box for: الإجمالي − الخصومات = الصافي، دائماً.
    expect(Number(row?.gross) - Number(row?.deductions)).toBeCloseTo(Number(row?.net), 4);
  });

  it('💰 إجمالي الرواتب — مجموع «💵 صافي الراتب»', async () => {
    const shown = data((await report()).body);
    const rows = rowsOf(shown.rows) as Array<{ net: string }>;
    const sum = rows.reduce((accumulated, row) => accumulated + Number(row.net), 0);
    expect(Number((shown.summary as { total: string }).total)).toBeCloseTo(sum, 4);
    expect((shown.summary as { count: number }).count).toBe(rows.length);
  });

  it('إذنٌ بلا صرف يظهر في التقرير بلا سند', async () => {
    // The window reads every `SalaryPay` with `IS_Deleted=0` — a draft is a row the
    // accountant has to see, marked by the سند it does not have.
    const draft = await pay('2030-11', { postVoucher: false });
    expect(draft.status).toBe(201);
    removedPaymentId = data(draft.body).id as string;

    const row = (await linesOf('all_period=false&year=2030&month=11'))[0];
    expect(row).toMatchObject({ posted: false, voucherNumber: null, yearMonth: '2030-11' });
  });

  it('حذف إذن يُسقطه من التقرير', async () => {
    const before = await linesOf('all_period=false&year=2030&month=11');
    expect(before).toHaveLength(1);

    const removed = await del(`/hrm/salary-payments/${removedPaymentId}`);
    expect([200, 204]).toContain(removed.status);

    const after = await linesOf('all_period=false&year=2030&month=11');
    expect(after).toHaveLength(0);
  });

  it('🏢 الفرع — فرعٌ بلا إذنات', async () => {
    const other = await post('/branches', { code: 'BR9', nameAr: 'فرع بلا رواتب' });
    expect(other.status).toBe(201);

    const onBranch = await linesOf(`branch_id=${branchId}`);
    expect(onBranch.length).toBeGreaterThan(0);

    const elsewhere = await linesOf(`branch_id=${data(other.body).id}`);
    expect(elsewhere).toHaveLength(0);
  });

  it('مستأجر آخر لا يرى رواتب هذا المستأجر', async () => {
    const foreign = await api(ctx.server, 'get', '/api/v1/hrm/reports/salary', { token: stranger.token });
    expect(foreign.status).toBe(200);
    expect(rowsOf(data(foreign.body).rows)).toHaveLength(0);
  });
});
