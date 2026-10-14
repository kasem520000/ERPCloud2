import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part two — 🎁 الحوافز والجزاءات (`Form_WPF/frmEmpSalaryAddSub.xaml`).
 *
 * The window is «إدخال الحوافز والخصومات للموظفين» over a grid of every document:
 * `الموظف` · `النوع` · `المبلغ` · `التاريخ` · `الوقت` · `طريقة الدفع` (نقدي/بنكي) ·
 * الصندوق أو البنك · `✅ تضاف على الراتب` / `✂️ تخصم من الراتب` · `ملاحظات` ·
 * «رقم السند:», and the grid is
 * `RecordId · EmpId · EmpName · Value · TypeName · RecordDate`, narrowed by employee and
 * by `من`/`إلى`.
 *
 * `frmEmpSalaryAddSub.xaml.cs` is where the rules are:
 *
 *   • L566 `ValidateInputs` — «يجب اختيار موظف» · «يجب اختيار نوع الإجراء» ·
 *     «يجب إدخال مبلغ» · «يجب اختيار الصندوق أو البنك».
 *   • L225 `LoadNextNumber` — «رقم السند» is `ISNULL(MAX(id),0)+1`.
 *   • L665 `CreateReceiptObject` — the note writes itself when it is left empty:
 *     «مكافأة للموظف …» / «خصم للموظف …» / «سلفة للموظف …».
 *   • L718 `BindReceiptToEntry` — one journal entry per document: the employee's own
 *     account (the one Part One creates) on one side, the صندوق or البنك on the other.
 *
 * The cloud had the payroll half of the idea — an approved addition or deduction that a
 * payroll run picks up in its month — and no document at all.
 */
describe('الحوافز والجزاءات — frmEmpSalaryAddSub', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let cashLocationId = '';
  let cashAccountId = '';
  let employeeId = '';
  let employeeAccountId = '';
  let expenseAccountId = '';
  let bonusTypeId = '';
  let deductionTypeId = '';
  let advanceTypeId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });

  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await createTestApp('salary-adjustments');
    actor = await createActor(ctx, {
      tenantCode: 'adj-card',
      email: 'owner@adj-card.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'hrm.view',
        'hrm.manage',
        'hrm.adjust.approve',
        'hrm.payroll.post',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'organization.branch.manage',
        'organization.cashlocation.manage',
        'organization.cashlocation.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'adj-card-2',
      email: 'owner@adj-card-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    // 1211 الصندوق — the account a cash location posts to.
    cashAccountId = data((await post('/accounts', { code: '1211', nameAr: 'الصندوق', type: 'asset' })).body).id as string;
    const safe = await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية', accountId: cashAccountId });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;

    // 3122001 راتب أساسي — the account `BindReceiptToEntry` L718 hard-codes for a مكافأة.
    expenseAccountId = data((await post('/accounts', { code: '3122001', nameAr: 'راتب أساسي', type: 'expense' })).body).id as string;

    // «موظفين الفرع الرئيسي» — `Class/Common.cs` L998 `isnull(EmployeeAcc,2241)`. Part One
    // hangs every employee under it, and `BindReceiptToEntry` debits that account for a
    // خصم or a سلفة; a test tenant is provisioned without the desktop chart, so the root
    // is created here with the code the desktop defaults to.
    const root = await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability', isPostable: false });
    expect(root.status).toBe(201);

    const employee = await post('/hrm/employees', { employeeNo: 'E-1', name: 'سالم أحمد', branchId });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
    employeeAccountId = data(employee.body).employeeAccountId as string;
    expect(employeeAccountId).toBeTruthy();

    // A test tenant is created without `OrgProvisioningService` (the same reason the
    // chart of accounts has to be written by hand in these suites), so the three types
    // `frmEmpSalaryAddSub` names are written here with the codes migration `0050` and the
    // provisioning service seed for a real tenant.
    for (const seed of [
      { code: 'bonus', name: 'مكافأة', kind: 'addition', sortOrder: 1 },
      { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 2 },
      { code: 'advance', name: 'سلفة', kind: 'deduction', sortOrder: 3 },
    ]) {
      const created = await post('/hrm/adjustment-types', seed);
      expect(created.status).toBe(201);
    }
    const types = rows((await get('/hrm/adjustment-types')).body);
    bonusTypeId = types.find((row) => row.code === 'bonus')!.id as string;
    deductionTypeId = types.find((row) => row.code === 'deduction')!.id as string;
    advanceTypeId = types.find((row) => row.code === 'advance')!.id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('الأنواع الثلاثة مزروعة — مكافأة إضافة، وخصم وسلفة خصمان', async () => {
    const types = rows((await get('/hrm/adjustment-types')).body);
    const byCode = (code: string) => types.find((row) => row.code === code);
    expect(byCode('bonus')).toMatchObject({ name: 'مكافأة', kind: 'addition', sortOrder: 1 });
    expect(byCode('deduction')).toMatchObject({ name: 'خصم', kind: 'deduction', sortOrder: 2 });
    expect(byCode('advance')).toMatchObject({ name: 'سلفة', kind: 'deduction', sortOrder: 3 });
  });

  it('الرفوض الأربعة بعبارة النافذة', async () => {
    const noEmployee = await post('/hrm/adjustments', { employeeId: '00000000-0000-0000-0000-000000000000', typeId: bonusTypeId, valueText: '100', startsOn: today() });
    expect(noEmployee.status).toBe(422);
    expect(noEmployee.body).toMatchObject({ code: 'ADJUSTMENT_EMPLOYEE_REQUIRED', detail: 'يجب اختيار موظف' });

    const noType = await post('/hrm/adjustments', { employeeId, valueText: '100', startsOn: today() });
    expect(noType.status).toBe(422);
    expect(noType.body).toMatchObject({ code: 'ADJUSTMENT_TYPE_REQUIRED', detail: 'يجب اختيار نوع الإجراء' });

    const noValue = await post('/hrm/adjustments', { employeeId, typeId: bonusTypeId, valueText: '0', startsOn: today(), subFromSalary: true });
    expect(noValue.status).toBe(422);
    expect(noValue.body).toMatchObject({ code: 'ADJUSTMENT_VALUE_REQUIRED', detail: 'يجب إدخال مبلغ' });

    const noLocation = await post('/hrm/adjustments', { employeeId, typeId: advanceTypeId, valueText: '100', startsOn: today(), subFromSalary: false });
    expect(noLocation.status).toBe(422);
    expect(noLocation.body).toMatchObject({ code: 'ADJUSTMENT_CASH_LOCATION_REQUIRED', detail: 'يجب اختيار الصندوق أو البنك' });
  });

  it('رقم السند يتسلسل من واحد', async () => {
    const first = data((await post('/hrm/adjustments', { employeeId, typeId: bonusTypeId, valueText: '100', startsOn: today(), subFromSalary: true })).body);
    const second = data((await post('/hrm/adjustments', { employeeId, typeId: bonusTypeId, valueText: '200', startsOn: today(), subFromSalary: true })).body);
    expect(first.number).toBe('1');
    expect(second.number).toBe('2');
  });

  it('الملاحظة تُكتب نفسها كما يفعل CreateReceiptObject', async () => {
    const bonus = data((await post('/hrm/adjustments', { employeeId, typeId: bonusTypeId, valueText: '150', startsOn: today(), subFromSalary: true })).body);
    expect(bonus.reason).toBe('مكافأة للموظف سالم أحمد');

    const advance = data((await post('/hrm/adjustments', { employeeId, typeId: advanceTypeId, valueText: '150', startsOn: today(), subFromSalary: true })).body);
    expect(advance.reason).toBe('سلفة للموظف سالم أحمد');

    const written = data((await post('/hrm/adjustments', { employeeId, typeId: deductionTypeId, valueText: '150', startsOn: today(), subFromSalary: true, reason: 'تأخير متكرر' })).body);
    expect(written.reason).toBe('تأخير متكرر');
  });

  it('سلفة تُصرف الآن — قيدٌ: مدين الموظف، دائن الصندوق', async () => {
    const adjustment = data((await post('/hrm/adjustments', {
      employeeId,
      typeId: advanceTypeId,
      valueText: '500',
      startsOn: today(),
      subFromSalary: false,
      paymentMethod: 'cash',
      cashLocationId,
    })).body);
    expect(adjustment.status).toBe('approved');
    expect(adjustment.subFromSalary).toBe(false);
    expect(adjustment.paymentMethod).toBe('cash');

    const entry = await get(`/journal-entries/${adjustment.journalEntryId}`);
    expect(entry.status).toBe(200);
    const lines = rows(data(entry.body).lines ?? data(entry.body).data ?? []) as Array<Record<string, unknown>>;
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: employeeAccountId, debit: '500.0000', credit: '0.0000' }),
        expect.objectContaining({ accountId: cashAccountId, debit: '0.0000', credit: '500.0000' }),
      ]),
    );
  });

  it('مكافأة تُصرف الآن — قيدٌ: مدين راتب أساسي، دائن الصندوق', async () => {
    const adjustment = data((await post('/hrm/adjustments', {
      employeeId,
      typeId: bonusTypeId,
      valueText: '300',
      startsOn: today(),
      subFromSalary: false,
      paymentMethod: 'cash',
      cashLocationId,
    })).body);

    const entry = await get(`/journal-entries/${adjustment.journalEntryId}`);
    const lines = rows(data(entry.body).lines ?? data(entry.body).data ?? []) as Array<Record<string, unknown>>;
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: expenseAccountId, debit: '300.0000', credit: '0.0000' }),
        expect.objectContaining({ accountId: cashAccountId, debit: '0.0000', credit: '300.0000' }),
      ]),
    );
  });

  it('ما يخصم من الراتب لا قيدَ له حتى يعتمد', async () => {
    const created = await post('/hrm/adjustments', { employeeId, typeId: deductionTypeId, valueText: '120', startsOn: today(), subFromSalary: true });
    const adjustment = data(created.body);
    expect(adjustment.status).toBe('draft');
    expect(adjustment.journalEntryId).toBeNull();

    const approved = await post(`/hrm/adjustments/${adjustment.id}/approve`, {});
    expect(approved.status).toBeLessThan(300);
    expect(data(approved.body).status).toBe('approved');

    const yearMonth = new Date().toISOString().slice(0, 7);
    const preview = data((await post('/hrm/payroll/preview', { yearMonth })).body);
    const line = (preview.lines as Array<Record<string, unknown>>).find((entry) => entry.employeeId === employeeId);
    expect(Number(line?.deductions)).toBeGreaterThanOrEqual(120);
  });

  it('قائمة الحركات — الأسماء والفلاتر', async () => {
    const all = rows((await get('/hrm/adjustments')).body);
    const withNames = all.filter((row) => row.employeeId === employeeId);
    expect(withNames.length).toBeGreaterThan(0);
    expect(withNames[0]).toMatchObject({ employeeName: 'سالم أحمد', employeeNo: 'E-1' });
    expect(all.some((row) => row.typeName === 'مكافأة')).toBe(true);

    const byEmployee = rows((await get(`/hrm/adjustments?employee_id=${employeeId}`)).body);
    expect(byEmployee.every((row) => row.employeeId === employeeId)).toBe(true);

    const byType = rows((await get('/hrm/adjustments?type_code=advance')).body);
    expect(byType.length).toBeGreaterThan(0);
    expect(byType.every((row) => row.typeCode === 'advance')).toBe(true);

    const byDate = rows((await get(`/hrm/adjustments?from=${today()}&to=${today()}`)).body);
    expect(byDate.length).toBe(all.length);
  });

  it('لا يمكن حذف حركة مرحَّلة، ولا حركة دخلت مسيراً مُرحَّلاً', async () => {
    const posted = data((await post('/hrm/adjustments', {
      employeeId,
      typeId: advanceTypeId,
      valueText: '100',
      startsOn: today(),
      subFromSalary: false,
      paymentMethod: 'cash',
      cashLocationId,
    })).body);
    const refusal = await del(`/hrm/adjustments/${posted.id}`);
    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ code: 'ADJUSTMENT_POSTED' });

    const onSalary = data((await post('/hrm/adjustments', { employeeId, typeId: deductionTypeId, valueText: '30', startsOn: today(), subFromSalary: true })).body);
    await post(`/hrm/adjustments/${onSalary.id}/approve`, {});
    // A posted run is what makes the adjustment part of the books.
    const run = await post('/hrm/payroll/runs', { yearMonth: new Date().toISOString().slice(0, 7) });
    expect(run.status).toBe(201);
    await post(`/hrm/payroll/runs/${data(run.body).id}/post`, {});

    const refusal2 = await del(`/hrm/adjustments/${onSalary.id}`);
    expect(refusal2.status).toBe(409);
    expect(refusal2.body).toMatchObject({ code: 'ADJUSTMENT_IN_PAYROLL' });
  });

  it('حركة مسوّدة بلا ارتباط تُحذف، ومستأجر آخر لا يراها', async () => {
    const draft = data((await post('/hrm/adjustments', { employeeId, typeId: bonusTypeId, valueText: '25', startsOn: today(), subFromSalary: true })).body);
    const removed = await del(`/hrm/adjustments/${draft.id}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body)).toMatchObject({ id: draft.id, deleted: true });
    expect(rows((await get('/hrm/adjustments')).body).map((row) => row.id)).not.toContain(draft.id);

    const foreign = await api(ctx.server, 'get', `/api/v1/hrm/adjustments/${draft.id}`, { token: stranger.token });
    expect(foreign.status).toBe(404);
    const foreignTypes = await api(ctx.server, 'get', '/api/v1/hrm/adjustment-types', { token: stranger.token });
    expect(rows(foreignTypes.body).map((row) => row.code)).toEqual([]);
  });

  it('نوع جديد، ولا يمكن حذف نوع مستخدم', async () => {
    const created = await post('/hrm/adjustment-types', { code: 'overtime', name: 'عمل إضافي', kind: 'addition', sortOrder: 4 });
    expect(created.status).toBe(201);
    const typeId = data(created.body).id as string;

    await post('/hrm/adjustments', { employeeId, typeId, valueText: '80', startsOn: today(), subFromSalary: true });
    const used = await del(`/hrm/adjustment-types/${typeId}`);
    expect(used.status).toBe(409);
    expect(used.body).toMatchObject({ code: 'ADJUSTMENT_TYPE_IN_USE', detail: 'لا يمكن حذف نوع مستخدم في حركات' });

    const renamed = await api(ctx.server, 'patch', `/api/v1/hrm/adjustment-types/${typeId}`, { token: actor.token, body: { name: 'ساعات إضافية' } });
    expect(renamed.status).toBe(200);
    expect(data(renamed.body).name).toBe('ساعات إضافية');
  });
});
