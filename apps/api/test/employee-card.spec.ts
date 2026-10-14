import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part one — 👤 تعريف موظف (`Form_WPF/frmEmployees.xaml`).
 *
 * The window has five regions:
 *
 *   • «بيانات الموظف الأساسية» — اسم الموظف · رقم الحساب · الإدارة · القسم · الوظيفة ·
 *     الحالة · تاريخ الميلاد · تاريخ التعيين · رقم التأمينات · الحالة الاجتماعية ·
 *     الجنسية · النوع · رقم الهاتف · رقم الموبايل · البريد الإلكتروني
 *   • «الرواتب والمستحقات» — الراتب الأساسي · بدل سكن · بدل مواصلات · طعام · طبي ·
 *     مكافأة ثابتة · أخرى · إجمالي الرواتب والمستحقات
 *   • «البيانات التكميلية» — العنوان · رقم الهوية · رقم الحساب البنكي · اسم البنك · ملاحظات
 *   • «صورة الموظف» / «فروع الموظف»
 *   • «قائمة الموظفين» — الرقم · الاسم · إجمالي المرتب (with «اسم الموظف:» + 🔍 بحث)
 *
 * and the rules are in `frmEmployees.xaml.cs`: L520 refuses an empty name
 * («يجب إدخال اسم الموظف»), L600 `SaveAccounts` writes a `TreeAccount` row named after
 * the employee under the branch's employee account and renames it when the code already
 * exists, and L730 refuses to delete an employee with a user («لا يمكن حذف موظف مرتبط
 * بمستخدم») or with invoices («لا يمكن حذف موظف مرتبط بفواتير»).
 *
 * The cloud's `employees` row held the payroll half of the card and nothing else.
 */
describe('بطاقة الموظف — frmEmployees', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let rootAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });

  const management = async (code: string, name: string) => {
    const created = await post('/hrm/departments', { code, name });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  /** The card, in the order the window lays it out. */
  const card = (suffix: string, extra: Record<string, unknown> = {}) => ({
    employeeNo: `E-${suffix}`,
    name: `موظف ${suffix}`,
    branchId,
    hireDate: '2024-01-15',
    birthDate: '1990-05-02',
    insuranceNo: `INS-${suffix}`,
    nationalId: `1099${suffix}`,
    maritalStatus: 'متزوج',
    nationality: 'يمني',
    gender: 'male',
    phone: '01-234567',
    mobile: '771234567',
    email: `emp${suffix}@example.com`,
    address: 'صنعاء - شارع حدة',
    notes: 'موظف تحقق',
    salaryComponents: { basic: '5000', housing: '1000', transport: '500', food: '300', medical: '200', fixedBonus: '250', other: '150' },
    bank: { iban: 'SA0380000000608010167519', bankNo: '123456', bankName: 'بنك اليمن' },
    ...extra,
  });

  const employee = async (suffix: string, extra: Record<string, unknown> = {}) => {
    const created = await post('/hrm/employees', card(suffix, extra));
    expect(created.status).toBe(201);
    return data(created.body);
  };

  beforeAll(async () => {
    ctx = await createTestApp('employee-card');
    actor = await createActor(ctx, {
      tenantCode: 'emp-card',
      email: 'owner@emp-card.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'hrm.view',
        'hrm.manage',
        'hrm.adjust.approve',
        'hrm.payroll.post',
        'accounting.account.view',
        'accounting.account.manage',
        'organization.branch.manage',
        'sales.invoice.create',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'emp-card-2',
      email: 'owner@emp-card-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    // «موظفين الفرع الرئيسي» — `Common.CurrentBranch.EmployeeAcc`, default 2241
    // (`Class/Common.cs` L998 `isnull(EmployeeAcc,2241)`). A provisioned tenant's chart
    // carries it; a test tenant is provisioned without the desktop chart, so the root is
    // created here with the code the desktop defaults to.
    const root = await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability', isPostable: false });
    expect(root.status).toBe(201);
    rootAccountId = data(root.body).id as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('يرفض الحفظ بلا اسم — «يجب إدخال اسم الموظف»', async () => {
    const response = await post('/hrm/employees', { employeeNo: 'E-NONE', name: '   ' });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_NAME_REQUIRED', detail: 'يجب إدخال اسم الموظف' });
  });

  it('يرفض الحفظ بلا رقم موظف', async () => {
    const response = await post('/hrm/employees', { employeeNo: '  ', name: 'بلا رقم' });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_NO_REQUIRED' });
  });

  it('يحفظ البطاقة كلها ويردّها كما يقرأها الديسكتوب', async () => {
    const row = await employee('1001');
    const read = await get(`/hrm/employees/${row.id}`);
    expect(read.status).toBe(200);
    expect(data(read.body)).toMatchObject({
      employeeNo: 'E-1001',
      name: 'موظف 1001',
      hireDate: '2024-01-15',
      birthDate: '1990-05-02',
      insuranceNo: 'INS-1001',
      nationalId: '10991001',
      maritalStatus: 'متزوج',
      nationality: 'يمني',
      gender: 'male',
      genderLabel: 'ذكر',
      phone: '01-234567',
      mobile: '771234567',
      email: 'emp1001@example.com',
      address: 'صنعاء - شارع حدة',
      notes: 'موظف تحقق',
      status: 'active',
      statusLabel: 'نشط',
    });
    // «رقم الحساب البنكي» / «اسم البنك» live in `bank`, and the IBAN comes back masked.
    expect(data(read.body).bank).toMatchObject({ iban: 'SA03********7519', bankNo: '123456', bankName: 'بنك اليمن' });
  });

  it('إجمالي الرواتب والمستحقات = مجموع البدلات السبعة', async () => {
    const row = await employee('1002');
    expect(row.totalSalary).toBe('7400.0000');
    const read = await get(`/hrm/employees/${row.id}`);
    expect(data(read.body).totalSalary).toBe('7400.0000');
  });

  it('رقم الحساب — يُنشأ حساب باسم الموظف تحت «موظفين الفرع الرئيسي»', async () => {
    const row = await employee('1003');
    expect(row.employeeAccountId).toBeTruthy();
    // `MaxId("Code", "Accounts_Index", EmployeeAcc)` — the next free child of 2241.
    expect(row.accountCode as string).toMatch(/^2241\d{4}$/);

    const account = await get(`/accounts/${row.employeeAccountId}`);
    expect(account.status).toBe(200);
    expect(data(account.body)).toMatchObject({
      code: row.accountCode,
      nameAr: 'موظف 1003',
      parentId: rootAccountId,
      type: 'liability',
      isPostable: true,
    });
  });

  it('تغيير اسم الموظف يغيّر اسم الحساب — كما يفعل SaveAccounts', async () => {
    const row = await employee('1004');
    const renamed = await patch(`/hrm/employees/${row.id}`, { name: 'موظف 1004 بعد التعديل' });
    expect(renamed.status).toBe(200);
    expect(data(renamed.body).name).toBe('موظف 1004 بعد التعديل');

    const account = await get(`/accounts/${row.employeeAccountId}`);
    expect(data(account.body).nameAr).toBe('موظف 1004 بعد التعديل');
  });

  it('كل موظف يأخذ الرقم التالي تحت الأب', async () => {
    const first = await employee('1005');
    const second = await employee('1006');
    expect(Number(second.accountCode)).toBe(Number(first.accountCode) + 1);
    expect(second.employeeAccountId).not.toBe(first.employeeAccountId);
  });

  it('رقم الحساب المستعمل مرفوض', async () => {
    const taken = await employee('1007');
    const response = await post('/hrm/employees', card('1008', { accountCode: taken.accountCode }));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_ACCOUNT_CODE_TAKEN' });
  });

  it('الإدارة والقسم مستويان: لا قسم تحت قسم', async () => {
    const managId = await management('M1', 'الإدارة المالية');
    const section = await post('/hrm/departments', { code: 'S1', name: 'قسم الخزينة', parentId: managId });
    expect(section.status).toBe(201);

    const nested = await post('/hrm/departments', { code: 'S2', name: 'قسم تحت القسم', parentId: data(section.body).id });
    expect(nested.status).toBe(422);
    expect(nested.body).toMatchObject({ code: 'DEPARTMENT_LEVEL_INVALID', detail: 'لا يمكن إضافة قسم تحت قسم آخر' });
  });

  it('البطاقة تقرأ الإدارة من القسم ولا تخزّنها مرتين', async () => {
    const managId = await management('M2', 'إدارة العمليات');
    const section = await post('/hrm/departments', { code: 'S3', name: 'قسم المستودعات', parentId: managId });
    expect(section.status).toBe(201);

    const row = await employee('1014', { departmentId: data(section.body).id });
    expect(row).toMatchObject({
      departmentKind: 'section',
      managementId: managId,
      managementName: 'إدارة العمليات',
      sectionName: 'قسم المستودعات',
    });

    // Filtering by الإدارة finds the employee who sits in one of its أقسام.
    const inManagement = await get(`/hrm/employees?department_id=${managId}`);
    expect(rows(inManagement.body).map((entry) => entry.employeeNo)).toContain('E-1014');
  });

  it('قائمة الموظفين — البحث بالاسم أو بالرقم', async () => {
    await employee('2001', { name: 'خالد عبدالله منصور' });
    const byName = await get('/hrm/employees?q=منصور');
    expect(rows(byName.body).map((entry) => entry.employeeNo)).toContain('E-2001');

    const byNo = await get('/hrm/employees?q=E-2001');
    expect(rows(byNo.body).map((entry) => entry.name)).toContain('خالد عبدالله منصور');

    const nothing = await get('/hrm/employees?q=لا-يوجد');
    expect(rows(nothing.body)).toHaveLength(0);
  });

  it('لا يمكن حذف إدارة لها أقسام، ولا قسم عليه موظفون', async () => {
    const managId = await management('M3', 'إدارة المشتريات');
    const section = await post('/hrm/departments', { code: 'S4', name: 'قسم التوريد', parentId: managId });
    const sectionId = data(section.body).id as string;
    await employee('1009', { departmentId: sectionId });

    const withSections = await del(`/hrm/departments/${managId}`);
    expect(withSections.status).toBe(409);
    expect(withSections.body).toMatchObject({ code: 'DEPARTMENT_HAS_SECTIONS', detail: 'لا يمكن حذف إدارة لها أقسام' });

    const withEmployees = await del(`/hrm/departments/${sectionId}`);
    expect(withEmployees.status).toBe(409);
    expect(withEmployees.body).toMatchObject({ code: 'DEPARTMENT_IN_USE' });
  });

  it('لا يمكن حذف موظف مرتبط بمستخدم', async () => {
    const row = await employee('1010');
    const linked = await patch(`/hrm/employees/${row.id}`, { membershipId: actor.membershipId });
    expect(linked.status).toBe(200);

    const response = await del(`/hrm/employees/${row.id}`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_HAS_USER', detail: 'لا يمكن حذف موظف مرتبط بمستخدم' });
  });

  it('لا يمكن حذف موظف مرتبط بفواتير', async () => {
    const row = await employee('1011');
    const invoice = await post('/sales/invoices', {
      branchId,
      salesmanId: row.id,
      cashCustomerName: 'عميل نقدي للتحقق',
      lines: [{ description: 'فاتورة تحقق', quantity: '1', unitPrice: '100' }],
    });
    expect(invoice.status).toBe(201);

    const response = await del(`/hrm/employees/${row.id}`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_HAS_INVOICES', detail: 'لا يمكن حذف موظف مرتبط بفواتير' });
  });

  it('لا يمكن حذف موظف له مسير رواتب', async () => {
    const row = await employee('1012');
    const yearMonth = new Date().toISOString().slice(0, 7);
    const run = await post('/hrm/payroll/runs', { yearMonth });
    expect(run.status).toBe(201);
    expect(rows(data(run.body).lines).map((line) => line.employeeId)).toContain(row.id);

    const response = await del(`/hrm/employees/${row.id}`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMPLOYEE_ON_PAYROLL', detail: 'لا يمكن حذف موظف له مسير رواتب' });
  });

  it('موظف بلا ارتباط يُحذف، وبطاقة مستأجر آخر غير مرئية', async () => {
    const row = await employee('1013');
    const removed = await del(`/hrm/employees/${row.id}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body)).toMatchObject({ id: row.id, deleted: false, archived: true });

    const gone = await get(`/hrm/employees/${row.id}`);
    expect(gone.status).toBe(404);
    const remaining = rows((await get('/hrm/employees')).body).map((entry) => entry.id);
    expect(remaining).not.toContain(row.id);

    const foreign = await api(ctx.server, 'get', `/api/v1/hrm/employees/${row.id}`, { token: stranger.token });
    expect(foreign.status).toBe(404);

    const foreignList = await api(ctx.server, 'get', '/api/v1/hrm/employees', { token: stranger.token });
    expect(rows(foreignList.body)).toHaveLength(0);
  });
});
