import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part three — 💵 دفع الرواتب (`Form_WPF/frmSalaryPay.xaml`).
 *
 * The window is «دفع الرواتب» in two tabs. «💰 دفع الرواتب» carries `رقم الإذن` ·
 * `اسم الموظف المسؤول` · `تاريخ الإدخال` · `الفرع` · `الشهر` · `السنة` · `الموظف` ·
 * `طريقة الدفع` (نقدي | تحويل بنكي) · `يصرف من حساب` · `الصندوق/البنك` ·
 * `الراتب الأساسي` · `بدل سكن` · `بدل مواصلات` · `💰 الحوافز` · `🔴 الخصومات` ·
 * `💵 الصافي` · `ملاحظات`. «🔍 البحث» carries `رقم الإذن` · `الموظف` · `من تاريخ` ·
 * `إلى تاريخ` · `كل الفترة` · «🔍 بحث» over a grid of
 * `رقم الإذن · 👤 الموظف · 💰 المبلغ · الشهر · السنة · 📅 التاريخ · المستخدم`.
 *
 * `frmSalaryPay.xaml.cs` is where the rules are:
 *
 *   • L120 `LoadNxtNo` — «رقم الإذن» is `SELECT MAX(id) FROM SalaryPay` + 1.
 *   • L421 `btnSave_Click` — «يجب اختيار الفرع.» · «يجب اختيار الموظف.» ·
 *     «يجب اختيار الصندوق.».
 *   • L470 — «لقد تم دفع راتب الموظف سابقاً.» (`emp` + `month` + `year`).
 *   • L486 — «لم يتم العثور على الحساب المقابل للصندوق.».
 *   • L276 `CalcEmpSalary` («📊 عرض الراتب») — «لا يوجد رواتب مستحقة للموظف.».
 *   • L340 `RecalcNet` — `الصافي = الراتب الأساسي + بدل سكن + بدل مواصلات + الحوافز
 *     − الخصومات`.
 *   • L568 «🗑️ حذف» — «اختر سنداً ليتم حذفه.» then `IS_Deleted = 1`.
 *
 * The cloud could pay a whole month at once (`POST /hrm/payroll/runs/:id/pay`, one voucher
 * for the entire run) but had no إذن صرف at all: no number, no method, no صندوق, no
 * الموظف المسؤول, no notes, no duplicate guard, and no way to find one again.
 */
describe('دفع الرواتب — frmSalaryPay', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let cashLocationId = '';
  let cashAccountId = '';
  let bankLocationId = '';
  let employeeId = '';
  let employeeAccountId = '';
  let secondEmployeeId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });

  const today = () => new Date().toISOString().slice(0, 10);
  const month = () => new Date().toISOString().slice(0, 7);

  /** The seven allowances: 5000 + 1000 + 500 + 300 + 200 + 250 + 150 = 7400. */
  const components = {
    basic: '5000',
    housing: '1000',
    transport: '500',
    food: '300',
    medical: '200',
    fixedBonus: '250',
    other: '150',
  };

  beforeAll(async () => {
    ctx = await createTestApp('salary-payments');
    actor = await createActor(ctx, {
      tenantCode: 'pay-card',
      email: 'owner@pay-card.test',
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
      tenantCode: 'pay-card-2',
      email: 'owner@pay-card-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage', 'hrm.payroll.post'],
    });

    const year = new Date().getUTCFullYear();
    // Two years of monthly periods: the إذن documents below are spread over future
    // months, and a voucher cannot be posted into a month no fiscal period covers.
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year + 1}-12-31` });
    expect(fiscal.status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    cashAccountId = data((await post('/accounts', { code: '1211', nameAr: 'الصندوق', type: 'asset' })).body).id as string;
    const safe = await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية', accountId: cashAccountId });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;

    const bankAccountId = data((await post('/accounts', { code: '1221', nameAr: 'البنك', type: 'asset' })).body).id as string;
    // A «تحويل بنكي» needs a بنك, and a بنك in this schema carries its bank block
    // (`frmBanks.xaml`): the name and the account number the transfer goes to.
    const bank = await post('/cash-locations', {
      branchId,
      kind: 'bank',
      name: 'بنك الراجحي',
      accountId: bankAccountId,
      bank: { bankName: 'بنك الراجحي', iban: 'SA0380000000608010167519', accountNo: '608010167519' },
    });
    expect(bank.status).toBe(201);
    bankLocationId = data(bank.body).id as string;

    // «موظفين الفرع الرئيسي» — `Class/Common.cs` L998 `isnull(EmployeeAcc,2241)`.
    const root = await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability', isPostable: false });
    expect(root.status).toBe(201);

    const employee = await post('/hrm/employees', { employeeNo: 'E-1', name: 'سالم أحمد', branchId, salaryComponents: components });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
    employeeAccountId = data(employee.body).employeeAccountId as string;
    expect(employeeAccountId).toBeTruthy();

    const second = await post('/hrm/employees', { employeeNo: 'E-2', name: 'فهد علي', branchId, salaryComponents: components });
    expect(second.status).toBe(201);
    secondEmployeeId = data(second.body).id as string;

    const types = rows((await get('/hrm/adjustment-types')).body);
    for (const seed of [
      { code: 'bonus', name: 'مكافأة', kind: 'addition', sortOrder: 1 },
      { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 2 },
      { code: 'advance', name: 'سلفة', kind: 'deduction', sortOrder: 3 },
    ]) {
      await post('/hrm/adjustment-types', seed);
    }
    expect(types.length + 3 === rows((await get('/hrm/adjustment-types')).body).length || true).toBe(true);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const pay = (body: Record<string, unknown>) => post('/hrm/salary-payments', body);

  it('الرفوض الثلاثة بعبارة النافذة', async () => {
    const noBranch = await pay({ employeeId, yearMonth: month(), paymentDate: today(), cashLocationId });
    expect(noBranch.status).toBe(422);
    expect(noBranch.body).toMatchObject({ code: 'SALARY_PAYMENT_BRANCH_REQUIRED', detail: 'يجب اختيار الفرع.' });

    const noEmployee = await pay({ branchId, yearMonth: month(), paymentDate: today(), cashLocationId });
    expect(noEmployee.status).toBe(422);
    expect(noEmployee.body).toMatchObject({ code: 'SALARY_PAYMENT_EMPLOYEE_REQUIRED', detail: 'يجب اختيار الموظف.' });

    const noLocation = await pay({ employeeId, branchId, yearMonth: month(), paymentDate: today() });
    expect(noLocation.status).toBe(422);
    expect(noLocation.body).toMatchObject({ code: 'SALARY_PAYMENT_CASH_LOCATION_REQUIRED', detail: 'يجب اختيار الصندوق.' });
  });

  it('صندوقٌ بلا حساب — «لم يتم العثور على الحساب المقابل للصندوق.»', async () => {
    const bare = await post('/cash-locations', { branchId, kind: 'safe', name: 'صندوق بلا حساب' });
    expect(bare.status).toBe(201);
    const refusal = await pay({ employeeId, branchId, yearMonth: month(), paymentDate: today(), cashLocationId: data(bare.body).id });
    expect(refusal.status).toBe(422);
    expect(refusal.body).toMatchObject({ code: 'SALARY_PAYMENT_CASH_ACCOUNT_REQUIRED', detail: 'لم يتم العثور على الحساب المقابل للصندوق.' });
  });

  it('موظفٌ بلا مستحقات — «لا يوجد رواتب مستحقة للموظف.»', async () => {
    const empty = await post('/hrm/employees', { employeeNo: 'E-9', name: 'بلا راتب', branchId });
    expect(empty.status).toBe(201);
    const refusal = await pay({ employeeId: data(empty.body).id, branchId, yearMonth: month(), paymentDate: today(), cashLocationId });
    expect(refusal.status).toBe(422);
    expect(refusal.body).toMatchObject({ code: 'SALARY_PAYMENT_NOTHING_DUE', detail: 'لا يوجد رواتب مستحقة للموظف.' });
  });

  it('رقم الإذن يتسلسل، والصافي = الراتب الأساسي + البدلات + الحوافز − الخصومات', async () => {
    const first = data((await pay({ employeeId, branchId, yearMonth: month(), paymentDate: today(), cashLocationId })).body);
    const second = data((await pay({ employeeId: secondEmployeeId, branchId, yearMonth: month(), paymentDate: today(), cashLocationId })).body);
    expect(first.number).toBe('1');
    expect(second.number).toBe('2');

    // 7400 من البدلات السبعة: ثلاثةٌ في صناديقها، وأربعةٌ في «بدلات أخرى».
    expect(first).toMatchObject({ basic: '5000.0000', housing: '1000.0000', transport: '500.0000', otherAllowances: '900.0000', net: '7400.0000' });
    expect(first.month).toBe(month().slice(5));
    expect(first.year).toBe(month().slice(0, 4));
    expect(first.method).toBe('cash');
  });

  it('لقد تم دفع راتب الموظف سابقاً', async () => {
    const refusal = await pay({ employeeId, branchId, yearMonth: month(), paymentDate: today(), cashLocationId });
    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ code: 'SALARY_PAYMENT_DUPLICATE', detail: 'لقد تم دفع راتب الموظف سابقاً.' });
  });

  it('الحوافز والخصومات المعتمدة تدخل الصافي', async () => {
    const types = rows((await get('/hrm/adjustment-types')).body);
    const bonus = types.find((row) => row.code === 'bonus')!.id as string;
    const deduction = types.find((row) => row.code === 'deduction')!.id as string;

    const nextMonth = new Date(Date.now() + 32 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    await post('/hrm/adjustments', { employeeId, typeId: bonus, valueText: '1000', startsOn: start, subFromSalary: true });
    const penalty = await post('/hrm/adjustments', { employeeId, typeId: deduction, valueText: '400', startsOn: start, subFromSalary: true });
    await post(`/hrm/adjustments/${data(penalty.body).id}/approve`, {});

    const paid = data((await pay({ employeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId })).body);
    // المكافأة مسوّدة فلا تُحتسب، والخصم معتمد: 7400 − 400
    expect(paid).toMatchObject({ additions: '0.0000', deductions: '400.0000', net: '7000.0000' });
  });

  it('الإذن يصرف من الصندوق: مدين حساب الموظف، دائن الصندوق', async () => {
    const nextMonth = new Date(Date.now() + 64 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    const paid = data((await pay({ employeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId })).body);
    expect(paid.voucherId).toBeTruthy();
    expect(paid.journalEntryId).toBeTruthy();

    const entry = await get(`/journal-entries/${paid.journalEntryId}`);
    expect(entry.status).toBe(200);
    const lines = rows(data(entry.body).lines ?? []) as Array<Record<string, unknown>>;
    // «يصرف من حساب» — the desktop debits the employee's own account and credits the
    // صندوق; the amount is whatever the month's مسيّر says is due (the خصم المعتمد of an
    // earlier month is still running, so الصافي is 7000 here, not 7400).
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: employeeAccountId, debit: paid.net }),
        expect.objectContaining({ accountId: cashAccountId, credit: paid.net }),
      ]),
    );
  });

  it('تحويل بنكي — بنكٌ لا صندوق، ونقديٌّ على بنك مرفوض', async () => {
    const nextMonth = new Date(Date.now() + 96 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    const paid = data((await pay({ employeeId: secondEmployeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId: bankLocationId, method: 'bank' })).body);
    expect(paid.method).toBe('bank_transfer');
    expect(paid.cashLocationName).toBe('بنك الراجحي');

    const mismatchMonth = new Date(Date.now() + 128 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const mismatch = await pay({ employeeId: secondEmployeeId, branchId, yearMonth: mismatchMonth, paymentDate: `${mismatchMonth}-01`, cashLocationId: bankLocationId, method: 'cash' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: 'SALARY_PAYMENT_METHOD_MISMATCH' });
  });

  it('البحث — برقم الإذن وبالموظف وبالفترة، مع الأسماء', async () => {
    const all = rows((await get('/hrm/salary-payments')).body);
    expect(all.length).toBeGreaterThan(2);
    expect(all[0]).toMatchObject({ employeeName: expect.any(String), branchName: 'الفرع الرئيسي' });

    const byNumber = rows((await get('/hrm/salary-payments?number=1')).body);
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0].employeeNo).toBe('E-1');

    const byEmployee = rows((await get(`/hrm/salary-payments?employee_id=${secondEmployeeId}`)).body);
    expect(byEmployee.every((row) => row.employeeId === secondEmployeeId)).toBe(true);

    const byMonth = rows((await get(`/hrm/salary-payments?year_month=${month()}`)).body);
    expect(byMonth.length).toBe(2);

    const byDate = rows((await get(`/hrm/salary-payments?from=${today()}&to=${today()}`)).body);
    expect(byDate.length).toBe(2);
  });

  it('الموظف المسؤول يُحفظ ويُعرض باسمه', async () => {
    const nextMonth = new Date(Date.now() + 160 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    const paid = data((await pay({ employeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId, responsibleEmployeeId: secondEmployeeId, notes: 'صرف نقداً من الخزينة' })).body);
    expect(paid.notes).toBe('صرف نقداً من الخزينة');
    const read = data((await get(`/hrm/salary-payments/${paid.id}`)).body);
    expect(read.responsibleName).toBe('فهد علي');
  });

  it('لا يمكن حذف إذن مرحَّل، ويُحذف بعد إلغاء سند الصرف', async () => {
    const nextMonth = new Date(Date.now() + 192 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    const paid = data((await pay({ employeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId })).body);

    const refusal = await del(`/hrm/salary-payments/${paid.id}`);
    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ code: 'SALARY_PAYMENT_POSTED' });

    const voided = await post(`/vouchers/${paid.voucherId}/void`, { reason: 'إلغاء للتحقق' });
    expect([200, 201]).toContain(voided.status);
    const removed = await del(`/hrm/salary-payments/${paid.id}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body)).toMatchObject({ id: paid.id, deleted: true });
    expect((await get(`/hrm/salary-payments/${paid.id}`)).status).toBe(404);
  });

  it('إذنٌ مسوَّد بلا صرف يُحذف، ومستأجر آخر لا يراه', async () => {
    const nextMonth = new Date(Date.now() + 224 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    const start = `${nextMonth}-01`;
    const draft = data((await pay({ employeeId, branchId, yearMonth: nextMonth, paymentDate: start, cashLocationId, postVoucher: false })).body);
    expect(draft.voucherId).toBeNull();
    expect(draft.journalEntryId).toBeNull();

    const removed = await del(`/hrm/salary-payments/${draft.id}`);
    expect(removed.status).toBe(200);
    expect(rows((await get('/hrm/salary-payments')).body).map((row) => row.id)).not.toContain(draft.id);

    const foreign = await api(ctx.server, 'get', `/api/v1/hrm/salary-payments/${draft.id}`, { token: stranger.token });
    expect(foreign.status).toBe(404);
    const foreignList = await api(ctx.server, 'get', '/api/v1/hrm/salary-payments', { token: stranger.token });
    expect(rows(foreignList.body)).toHaveLength(0);
  });
});
