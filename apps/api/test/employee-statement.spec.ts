import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part four — 📄 كشف حساب موظف (`Form_WPF/frmEmpAccountGet.xaml`).
 *
 * The window («كشف حساب موظف») is three filters over one grid:
 *
 *   • «اسم الموظف» — `Employees WHERE AccCode <> -1` (its value is the **account**)
 *   • «🏢 الفرع» with «كل الفروع»
 *   • «📅 الفترة الزمنية» with «فترة كاملة» and `من:` / `إلى:`
 *
 * and the grid is `م · مدين · دائن · الموظف · رقم القيد · تاريخ القيد · البيان`, with
 * «💳 إجمالي المدين» · «💵 إجمالي الدائن» · «⚖️ الرصيد المدين» · «⚖️ الرصيد الدائن»
 * underneath.
 *
 * `frmEmpAccountGet.xaml.cs` is where the rules are:
 *
 *   • `ShowAccount` — «اختر موظف» when no employee is chosen.
 *   • the query joins `Entry ⋈ Entry_sub ⋈ Accounts_Index` and keeps
 *     `Entry.IS_Deleted = 0 AND Entry.state = 1` — **posted entries only** — grouped by
 *     `Entry.GlobalID, Entry.date, Entry_sub.notes, Entry_sub.acc_no`.
 *   • `to` is `txtDateTo.DateTime.AddHours(24)` — the last day is inclusive.
 *   • `UpdateSummary` — the balance sits on **one** side: if مدين > دائن the difference is
 *     «الرصيد المدين» and «الرصيد الدائن» is zero, and the other way round.
 *
 * The cloud already had the statement (`GET /accounting/statements/general-ledger/:id`)
 * with the same رصيد سابق row and the same running balance; what it did not have was the
 * employee half of the window — pick a موظف, get their حساب.
 */
describe('كشف حساب موظف — frmEmpAccountGet', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let otherBranchId = '';
  let cashLocationId = '';
  let employeeId = '';
  let employeeAccountId = '';
  let expenseAccountId = '';
  let employeeNo = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  /**
   * «اليوم» كما يحسبه التقرير — بمنطقة المستأجر الزمنية (`tenant_settings['locale.timezone']`
   * ← `tenants.timezone` ← `Asia/Riyadh`)، لا بـUTC. الاختبار كان يحسبها بـ`toISOString`
   * (UTC)، فبين 21:00 و24:00 UTC يكون «اليوم» في الرياض غداً: نافذة التقرير الافتراضية
   * تصير يوماً آخر وتخرج الفواتير منها، فيفشل كل اختبار في الملف بلا عيبٍ في السلوك.
   */
  const TENANT_TZ = 'Asia/Riyadh';
  const dayAt = (offsetDays = 0) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TENANT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + offsetDays * 24 * 3600 * 1000));
  const today = () => dayAt(0);
  const statement = (query: string) => get(`/hrm/employee-statement?${query}`);
  /** الحركات وحدها — the «رصيد سابق» row carries no قيد of its own. */
  const movementsOf = (body: unknown) => rows((data(body as Record<string, unknown>).rows as unknown[]) ?? []).filter((row) => row.entryId !== null);
  const money = (value: unknown) => Number(value ?? 0).toFixed(4);

  beforeAll(async () => {
    ctx = await createTestApp('employee-statement');
    actor = await createActor(ctx, {
      tenantCode: 'stmt-tenant',
      email: 'owner@stmt.test',
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
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'stmt-tenant-2',
      email: 'owner@stmt-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year + 1}-12-31` });
    expect(fiscal.status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    const other = await post('/branches', { code: 'BR2', nameAr: 'فرع الشمال' });
    expect(other.status).toBe(201);
    otherBranchId = data(other.body).id as string;

    const cashAccountId = data((await post('/accounts', { code: '1211', nameAr: 'الصندوق', type: 'asset' })).body).id as string;
    const safe = await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية', accountId: cashAccountId });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;

    // «موظفين الفرع الرئيسي» — `Class/Common.cs` L998 `isnull(EmployeeAcc,2241)`.
    const root = await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability', isPostable: false });
    expect(root.status).toBe(201);

    const expenseAccount = await post('/accounts', { code: '3122001', nameAr: 'راتب أساسي', type: 'expense' });
    expect(expenseAccount.status).toBe(201);
    expenseAccountId = data(expenseAccount.body).id as string;

    employeeNo = 'ST-1';
    const employee = await post('/hrm/employees', {
      employeeNo,
      name: 'سالم أحمد',
      branchId,
      salaryComponents: { basic: '5000', housing: '1000', transport: '500', food: '300', medical: '200', fixedBonus: '250', other: '150' },
    });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
    employeeAccountId = data(employee.body).employeeAccountId as string;
    expect(employeeAccountId).toBeTruthy();

    // 🎁 أنواع الحركات — the سلفة below needs its type.
    for (const seed of [
      { code: 'bonus', name: 'مكافأة', kind: 'addition', sortOrder: 1 },
      { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 2 },
      { code: 'advance', name: 'سلفة', kind: 'deduction', sortOrder: 3 },
    ]) {
      await post('/hrm/adjustment-types', seed);
    }
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('اختر موظف — بلا موظف أو بموظف غير موجود', async () => {
    const none = await get('/hrm/employee-statement');
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED', detail: 'اختر موظف' });

    const missing = await get('/hrm/employee-statement?employee_id=00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED', detail: 'اختر موظف' });
  });

  it('موظفٌ بلا حساب لا كشف له', async () => {
    const bare = await post('/hrm/employees', { employeeNo: 'ST-9', name: 'موظف بلا حساب' });
    expect(bare.status).toBe(201);
    // Part One writes the account against the 2241 root; an employee saved before it existed has none.
    const withoutAccount = data(bare.body).employeeAccountId;
    if (withoutAccount) {
      const shown = await statement(`employee_id=${data(bare.body).id}`);
      expect(shown.status).toBe(200);
      return;
    }
    const refusal = await statement(`employee_id=${data(bare.body).id}`);
    expect(refusal.status).toBe(422);
    expect(refusal.body).toMatchObject({ code: 'EMPLOYEE_STATEMENT_ACCOUNT_REQUIRED', detail: 'لا يوجد حساب للموظف في دليل الحسابات' });
  });

  it('كشفٌ فارغ قبل أي حركة', async () => {
    const shown = data((await statement(`employee_id=${employeeId}`)).body);
    expect(shown.employee).toMatchObject({ employeeNo, name: 'سالم أحمد', accountId: employeeAccountId });
    expect(rows(shown.rows)).toHaveLength(0);
    expect(shown.summary).toMatchObject({ totalDebit: '0.0000', totalCredit: '0.0000', balanceDebit: '0.0000', balanceCredit: '0.0000' });
  });

  it('سلفة تُصرف الآن تظهر مديناً على حساب الموظف', async () => {
    const types = rows((await get('/hrm/adjustment-types')).body);
    const advance = types.find((row) => row.code === 'advance')!.id as string;
    const paid = data((await post('/hrm/adjustments', {
      employeeId,
      typeId: advance,
      valueText: '500',
      startsOn: today(),
      subFromSalary: false,
      paymentMethod: 'cash',
      cashLocationId,
    })).body);
    expect(paid.status).toBe('approved');

    const shown = data((await statement(`employee_id=${employeeId}`)).body);
    const movements = rows(shown.rows);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ seq: 1, entryId: paid.journalEntryId, employee: 'سالم أحمد' });
    expect(money(movements[0].debit)).toBe('500.0000');
    expect(money(movements[0].credit)).toBe('0.0000');
    expect(movements[0].description).toBe('سلفة للموظف سالم أحمد');
    expect(shown.summary).toMatchObject({ totalDebit: '500.0000', totalCredit: '0.0000', balanceDebit: '500.0000', balanceCredit: '0.0000' });
  });

  it('إذن صرف راتب يُضاف مديناً على حساب الموظف', async () => {
    const month = today().slice(0, 7);
    const paid = data((await post('/hrm/salary-payments', {
      employeeId,
      branchId,
      yearMonth: month,
      paymentDate: today(),
      cashLocationId,
      method: 'cash',
    })).body);
    expect(paid.voucherId).toBeTruthy();

    const shown = data((await statement(`employee_id=${employeeId}`)).body);
    const movements = rows(shown.rows);
    expect(movements).toHaveLength(2);
    // 2241 «موظفين الفرع الرئيسي» التزام: السلفة تُسلَّف منه، والراتب يُسدَّد منه — كلتاهما مدين.
    expect(movements.every((row) => Number(row.credit) === 0)).toBe(true);
    const payment = movements.find((row) => String(row.description).startsWith('صرف راتب'));
    expect(money(payment?.debit)).toBe(money(paid.net));
    expect(Number(shown.summary.totalDebit)).toBeCloseTo(500 + Number(paid.net), 2);
    expect(money(shown.summary.totalCredit)).toBe('0.0000');
    expect(Number(shown.summary.balanceDebit)).toBeCloseTo(500 + Number(paid.net), 2);
    expect(money(shown.summary.balanceCredit)).toBe('0.0000');
  });

  it('استحقاق الشهر يُضاف دائناً، والرصيد يقف على جانبٍ واحد', async () => {
    const month = today().slice(0, 7);
    const run = await post('/hrm/payroll/runs', { yearMonth: month });
    expect(run.status).toBe(201);
    const periods = rows((await get('/fiscal-periods')).body);
    const period = periods.find((row) => row.status === 'open' && String(row.startDate ?? '').startsWith(month));
    const accrual = '20000';
    // الراتب المستحق: مدين «راتب أساسي»، دائن حساب الموظف — الجانب الآخر من الحساب.
    const posted = await post(`/hrm/payroll/runs/${data(run.body).id}/post`, {
      branchId,
      fiscalPeriodId: period?.id,
      journalLines: [
        { accountId: expenseAccountId, debit: accrual, credit: '0' },
        { accountId: employeeAccountId, debit: '0', credit: accrual },
      ],
    });
    expect([200, 201]).toContain(posted.status);

    const shown = data((await statement(`employee_id=${employeeId}`)).body);
    const creditRow = rows(shown.rows).find((row) => Number(row.credit) > 0);
    expect(money(creditRow?.credit)).toBe('20000.0000');
    // `UpdateSummary` — الفرق يقف على جانبٍ واحد، ولا يظهر على الجانبين معاً.
    expect(Number(shown.summary.balanceDebit) * Number(shown.summary.balanceCredit)).toBe(0);
    expect(Number(shown.summary.totalCredit)).toBeCloseTo(Number(accrual), 2);
    expect(Number(shown.summary.balanceCredit)).toBeCloseTo(Number(accrual) - Number(shown.summary.totalDebit), 2);
  });

  it('الفترة — «فترة كاملة» مقابل «من»/«إلى»، واليوم الأخير داخلها', async () => {
    const full = await statement(`employee_id=${employeeId}&full_period=true`);
    expect(movementsOf(full.body)).toHaveLength(3);

    const outside = await statement(`employee_id=${employeeId}&from=2000-01-01&to=2000-01-31`);
    expect(movementsOf(outside.body)).toHaveLength(0);

    const inside = await statement(`employee_id=${employeeId}&from=${today()}&to=${today()}`);
    expect(movementsOf(inside.body)).toHaveLength(3);

    const tomorrow = dayAt(1);
    const after = await statement(`employee_id=${employeeId}&from=${tomorrow}&to=${tomorrow}`);
    expect(movementsOf(after.body)).toHaveLength(0);
  });

  it('الفرع — «كل الفروع» مقابل فرعٍ بلا حركات', async () => {
    const all = await statement(`employee_id=${employeeId}`);
    expect(movementsOf(all.body)).toHaveLength(3);

    const onBranch = await statement(`employee_id=${employeeId}&branch_id=${branchId}`);
    expect(movementsOf(onBranch.body)).toHaveLength(3);

    const other = await statement(`employee_id=${employeeId}&branch_id=${otherBranchId}`);
    expect(movementsOf(other.body)).toHaveLength(0);
  });

  it('الرصيد السابق يُرحَّل عند طلب فترة تبدأ بعد أول حركة', async () => {
    const tomorrow = dayAt(1);
    const shown = data((await statement(`employee_id=${employeeId}&from=${tomorrow}&to=${tomorrow}`)).body);
    const movements = rows(shown.rows);
    // `فترة كاملة` is off because `من` is set: the رصيد سابق row carries what came before.
    expect(movements).toHaveLength(1);
    expect(movements[0].entryType).toBe('رصيد سابق');
    expect(movements[0].description).toBe('رصيد مرحل من فترة سابقة');

    const hidden = await statement(`employee_id=${employeeId}&from=${tomorrow}&to=${tomorrow}&hide_previous_balance=true`);
    expect(rows(data(hidden.body).rows)).toHaveLength(0);
    // The desktop's checkboxes arrive as `1`, `true` and `on` — one flag, three spellings.
    for (const value of ['1', 'true', 'on']) {
      const spelled = await statement(`employee_id=${employeeId}&from=${tomorrow}&to=${tomorrow}&hide_previous_balance=${value}`);
      expect(rows(data(spelled.body).rows), value).toHaveLength(0);
    }
    const kept = await statement(`employee_id=${employeeId}&from=${tomorrow}&to=${tomorrow}&hide_previous_balance=false`);
    expect(rows(data(kept.body).rows)).toHaveLength(1);
  });

  it('📊 تفصيلي — سطرٌ لكل سطر قيد لا لكل قيد', async () => {
    const detailed = data((await statement(`employee_id=${employeeId}&detailed=true`)).body);
    expect(rows(detailed.rows).length).toBeGreaterThanOrEqual(2);
  });

  it('مستأجر آخر لا يرى كشف الموظف', async () => {
    const foreign = await api(ctx.server, 'get', `/api/v1/hrm/employee-statement?employee_id=${employeeId}`, { token: stranger.token });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ code: 'EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED' });
  });
});
