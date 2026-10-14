import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part six — 💰 تقارير الخزينة والرواتب والمستخدمين: five windows, five reports.
 *
 *   `frmRptKhzna.xaml`         «حركة الصندوق»          → cash-statement
 *   `frmRptSalary.xaml`        «تقرير الرواتب»         → salary-statement
 *   `frmRptReseved.xaml`       «تقرير الرواتب المستحقة» → salary-reserved
 *   `frmrptUsersRecords.xaml`  «سجلات المستخدمين»      → user-records
 *   `frmRptRentInvoices.xaml`  «تقرير فواتير التأجير»  → rent-invoices
 *
 * The sixth window of the part, `frmInvRptType.xaml` «🖨️ افتراضي طباعة الفواتير», is a
 * two-radio settings dialog (`UPDATE sett SET val = 1|2 WHERE id = 1`) and belongs to the
 * printing part, not to this catalogue.
 *
 * The rules the cloud has to keep:
 *   - `frmRptKhzna.xaml.cs` L198-L233 — a «رصيد سابق» line opens the statement whenever a
 *     period is chosen, and every line after it carries `runBalance += dept − credit`;
 *     L299-L300 print ⚖️ الرصيد الإجمالي (the balance at the end of the window) and
 *     📅 رصيد الفترة المحددة (what the window itself moved).
 *   - L159-L164 — the safe's account is found by matching the box's *name* to an account
 *     (`Accounts_Index.AName = Stocks.name AND Type = 2`); the cloud hangs it on the box.
 *   - `frmRptSalary.xaml.cs` L104-L113 — `gross = tot_salary + Houses + Travel + salary_add`
 *     and `net = gross − salary_sub`, and «💰 إجمالي الرواتب» sums the nets.
 *   - `frmRptReseved.xaml.cs` L58-L68 — `Salary_Res` with its month, year, branch and
 *     notes; the cloud's مسيّر الرواتب is that document.
 *   - `frmrptUsersRecords.xaml.cs` L70-L79 — `Log4NetLog` joined to `Employees`, one row
 *     per event; the cloud's سجل التدقيق is the same list.
 *   - `frmRptRentInvoices.xaml.cs` L258-L274 (`CalcIncome`) — `proc_type` 2 is the مرتجع,
 *     4 (حجوزات) is left out of both, and everything else is an إيراد.
 */
describe('التقارير — frmRptKhzna · frmRptSalary · frmRptReseved · frmrptUsersRecords · frmRptRentInvoices', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let cashAccountId = '';
  let cashLocationId = '';
  let otherAccountId = '';

  let employeeAId = '';
  let employeeAName = '';
  let employeeBId = '';
  let actorEmployeeId = '';

  let salaryNets: string[] = [];
  let runNumber = '';
  let reversedRunNotes = '';

  let vesselName = '';
  let groupCode = '';
  let customerName = '';
  let rentalNet = '0';
  let draftRentalNet = '0';
  let reservationNet = '0';

  const today = new Date();
  const year = today.getUTCFullYear();
  /** 📅 The fixtures live in June so nothing else in the tenant can wander into them. */
  const june = (day: number) => `${year}-06-${String(day).padStart(2, '0')}`;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  /** Both a raw body and a `get()` response come through here. */
  const envelope = (value: unknown): Record<string, unknown> =>
    data(((value as { body?: unknown } | undefined)?.body ?? value) as Record<string, unknown>);
  const rowsIn = (value: unknown): Array<Record<string, string>> =>
    (envelope(value) as { rows: Array<Record<string, string>> }).rows ?? [];
  const money = (value2: unknown) => Number(value2 ?? 0).toFixed(2);
  const cardOf = (value: unknown, key: string): string => {
    const cards = (envelope(value) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal ?? [];
    return cards.find((card) => card.key === key)?.amount ?? '0';
  };

  const post = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  const report = (key: string, query = '', token = actor.token) =>
    get(`/reports/${key}?${query ? `${query}&` : ''}from=${year}-06-01&to=${year}-06-30`, token);

  beforeAll(async () => {
    ctx = await createTestApp('report-treasury-hrm');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-trh6',
      email: 'owner@rpt-trh6.test',
      fullName: 'مستخدم تقارير الخزينة',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.voucher.void',
        'organization.cashlocation.manage',
        'organization.postingprofile.view',
        'hrm.view',
        'hrm.manage',
        'hrm.payroll.post',
        'parties.view',
        'parties.manage',
        'marina.view',
        'marina.manage',
        'marina.invoice',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'reporting.view',
        'reporting.export.execute',
      ],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'rpt-trh6',
      email: 'viewer@rpt-trh6.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-trh6-2',
      email: 'owner@rpt-trh6-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    const fiscal = await post('/fiscal-years', {
      name: `FY${year}`,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    });
    expect(fiscal.status).toBe(201);

    const account = async (code: string, nameAr: string, type: string) => {
      const created = await post('/accounts', { code, nameAr, type });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    cashAccountId = await account('9901', 'صندوق التحقق', 'asset');
    otherAccountId = await account('9902', 'حساب مقابل', 'asset');

    const safe = await post('/cash-locations', {
      branchId,
      kind: 'safe',
      name: 'صندوق التحقق',
      accountId: cashAccountId,
      isDefault: true,
    });
    expect(safe.status).toBe(201);
    cashLocationId = data(safe.body).id as string;
    // 💼 A second box for the salary payments: an إذن pays from its own صندوق, and the
    // safe's statement has to stay a statement of the safe alone.
    const salaryBox = await post('/cash-locations', {
      branchId,
      kind: 'safe',
      name: 'صندوق الرواتب',
      accountId: otherAccountId,
    });
    expect(salaryBox.status).toBe(201);
    const salaryCashLocationId = data(salaryBox.body).id as string;

    // ═══ 🏦 حركة الصندوق — 500 وارد قبل الفترة، ثم 1000 قبض و300 صرف و200 قيد ═══
    const journal = async (date: string, lines: Array<Record<string, unknown>>) => {
      const created = await post('/journal-entries', { branchId, date, lines });
      expect(created.status).toBe(201);
      return data(created.body) as { id: string; number: string };
    };
    await journal(june(1), [
      { accountId: cashAccountId, debit: '500', credit: '0' },
      { accountId: otherAccountId, debit: '0', credit: '500' },
    ]);
    await journal(june(20), [
      { accountId: otherAccountId, debit: '200', credit: '0' },
      { accountId: cashAccountId, debit: '0', credit: '200' },
    ]);

    const voucher = async (kind: string, gross: string, description: string) => {
      const draft = await post('/vouchers', {
        branchId,
        kind,
        subtype: 'customer',
        date: june(10),
        cashLocationId,
        method: 'cash',
        amount: gross,
        description,
      });
      expect(draft.status).toBe(201);
      const posted = await post(`/vouchers/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };
    await voucher('receipt', '1000', 'تحصيل نقدي');
    await voucher('payment', '300', 'سداد نقدي');

    // ═══ 💼 تقرير الرواتب — إذنان لشهر حزيران ═══
    const employee = async (employeeNo: string, name: string, extra: Record<string, unknown> = {}) => {
      const created = await post('/hrm/employees', {
        employeeNo,
        name,
        branchId,
        salaryComponents: { basic: '5000', housing: '1000', transport: '500' },
        ...extra,
      });
      expect(created.status).toBe(201);
      return data(created.body) as { id: string; name: string };
    };
    const first = await employee('TRH-A', 'موظف التقارير أ');
    employeeAId = first.id;
    employeeAName = first.name;
    employeeBId = (await employee('TRH-B', 'موظف التقارير ب')).id;
    // 👤 An employee who *is* the actor — the only way «سجلات المستخدمين» can be read for one.
    actorEmployeeId = (await employee('TRH-ME', 'صاحب السجل')).id;
    await patch(`/hrm/employees/${actorEmployeeId}`, { membershipId: actor.membershipId });

    const payment = async (employeeId: string) => {
      const created = await post('/hrm/salary-payments', {
        employeeId,
        yearMonth: `${year}-06`,
        paymentDate: june(15),
        branchId,
        cashLocationId: salaryCashLocationId,
        method: 'cash',
      });
      expect(created.status).toBe(201);
      return data(created.body) as { id: string; number: string; net: string };
    };
    salaryNets = [(await payment(employeeAId)).net, (await payment(employeeBId)).net];

    // ═══ 📋 تقرير الرواتب المستحقة — مسيّران: واحد مُرحَّل وواحد معكوس ═══
    const run = async (yearMonth: string) => {
      const created = await post('/hrm/payroll/runs', { yearMonth });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    const posted = await run(`${year}-06`);
    const postedRun = await post(`/hrm/payroll/runs/${posted}/post`, { branchId });
    expect(postedRun.status).toBe(201);

    const reversed = await run(`${year}-07`);
    reversedRunNotes = 'تصحيح مسيّر التحقق';
    const reversedRun = await post(`/hrm/payroll/runs/${reversed}/post`, { branchId });
    expect(reversedRun.status).toBe(201);
    const reversal = await post(`/hrm/payroll/runs/${reversed}/reverse`, { reason: reversedRunNotes });
    expect(reversal.status).toBe(201);
    runNumber = (data(postedRun.body) as { number?: string }).number ?? '';

    // ═══ 🚢 تقرير فواتير التأجير — فاتورة، وحجزٌ بلا فاتورة ═══
    const party = await post('/parties', { kind: 'customer', name: 'عميل التأجير' });
    expect(party.status).toBe(201);
    const partyId = data(party.body).id as string;
    customerName = data(party.body).name as string;

    const group = await post('/marina/groups', { name: 'قوارب التحقق', code: 'CHK' });
    expect(group.status).toBe(201);
    groupCode = 'CHK';
    const vessel = await post('/marina/vessels', {
      groupId: data(group.body).id,
      code: 'V-CHK',
      name: 'مركب التحقق',
      capacity: 4,
    });
    expect(vessel.status).toBe(201);
    const vesselId = data(vessel.body).id as string;
    vesselName = data(vessel.body).name as string;

    const booking = async (day: number, rentalAmount: string) => {
      const created = await post('/marina/bookings', {
        branchId,
        partyId,
        vesselId,
        documentDate: june(day),
        startsAt: `${june(day)}T08:00:00.000Z`,
        endsAt: `${june(day)}T10:00:00.000Z`,
        periodHours: 2,
        rentalAmount,
        insuranceAmount: '100',
      });
      expect(created.status).toBe(201);
      return data(created.body) as { id: string; number: string };
    };
    const invoiced = await booking(12, '400');
    const pending = await booking(14, '400');
    const draft = await booking(16, '200');
    reservationNet = '500'; // 400 قيمة الفترة + 100 تأمين، بلا إضافات

    const rental = await post(`/marina/bookings/${invoiced.id}/rental-invoice`, {});
    expect(rental.status).toBe(201);
    rentalNet = money((data(rental.body) as { netAmount?: string }).netAmount ?? '0');
    draftRentalNet = money(
      (data((await post(`/marina/bookings/${draft.id}/rental-invoice`, {})).body) as { netAmount?: string }).netAmount ??
        '0',
    );
    // 🚢 The فاتورة مبيعات behind the إيجار is what takes it out of «معلق».
    const saleId = (data(rental.body) as { salesInvoiceId?: string }).salesInvoiceId ?? '';
    expect(saleId).not.toBe('');
    const postedSale = await post(`/sales/invoices/${saleId}/post`, {});
    expect(postedSale.status).toBe(201);
    expect(pending.number.startsWith('BK-')).toBe(true);
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('📚 السجل — التقارير الخمسة بأعمدة الديسكتوب', async () => {
    const catalog = (data((await get('/reports')).body as Record<string, unknown>) as unknown as Array<Record<string, never>>) ?? [];
    const list = (Array.isArray(catalog) ? catalog : catalog) as unknown as Array<{
      key: string;
      titleAr: string;
      params: Array<{ labelAr: string; kind: string; options?: Array<{ value: string; labelAr: string }> }>;
      columns: Array<{ labelAr: string }>;
    }>;
    const byKey = new Map(list.map((entry) => [entry.key, entry]));

    const cash = byKey.get('cash-statement');
    expect(cash?.titleAr).toBe('حركة الصندوق');
    expect(cash?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'م · العملية · الرقم · 📅 التاريخ · 📥 وارد · 📤 صادر · ⚖️ الرصيد · 📝 البيان',
    );
    expect(cash?.params.map((param) => param.labelAr).join(' · ')).toBe(
      'الصندوق · من تاريخ · من وقت (HH:mm) · إلى تاريخ · إلى وقت (HH:mm)',
    );

    const salary = byKey.get('salary-statement');
    expect(salary?.titleAr).toBe('تقرير الرواتب');
    expect(salary?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'م · رقم السند · 👤 الموظف · الراتب الأساسي · بدل سكن · بدل مواصلات · الحوافز · 💰 الإجمالي · الخصومات · 💵 صافي الراتب',
    );
    // 📅 الشهر · السنة — the two boxes of `frmRptSalary`.
    expect(salary?.params.find((param) => param.labelAr === 'الشهر')?.options).toHaveLength(12);

    const reserved = byKey.get('salary-reserved');
    expect(reserved?.titleAr).toBe('تقرير الرواتب المستحقة');
    expect(reserved?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'م · رقم السند · 📅 التاريخ · 🏬 الفرع · الشهر · السنة · عدد الموظفين · الإجمالي · الخصومات · صافي المستحق · 📝 ملاحظات',
    );

    const records = byKey.get('user-records');
    expect(records?.titleAr).toBe('سجلات المستخدمين');
    expect(records?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'م · 📅 التاريخ · 🖥️ الجهاز · 📝 العملية · 👤 المستخدم',
    );

    const rent = byKey.get('rent-invoices');
    expect(rent?.titleAr).toBe('تقرير فواتير التأجير');
    // «ضمن الخطة» is the ninth column of the desktop's grid — the radios `rdAll` ·
    // `rdInPlan` · `rdOutPlan` are the «الخطة» filter.
    expect(rent?.columns.slice(0, 9).map((column) => column.labelAr).join(' · ')).toBe(
      'الرقم · المركب · الفئة · الصافي · التاريخ · العميل · المستخدم · الجوال · ضمن الخطة',
    );
    expect(rent?.params.find((param) => param.labelAr === 'نوع العملية')?.options).toEqual([
      { value: 'rent', labelAr: 'تأجير' },
      { value: 'return', labelAr: 'مرتجع' },
      { value: 'pending', labelAr: 'معلق' },
      { value: 'reservation', labelAr: 'حجوزات' },
    ]);
    expect(rent?.params.find((param) => param.labelAr === 'الخطة')?.options).toEqual([
      { value: 'in_plan', labelAr: 'ضمن الخطة' },
      { value: 'out_plan', labelAr: 'خارج الخطة' },
    ]);
  });

  it('🏦 حركة الصندوق — «رصيد سابق» ورصيدٌ متحرك وبطاقتان', async () => {
    // الفترة تبدأ في 5 حزيران: ما قبلها (500) يصير سطر «رصيد سابق».
    const url = `/reports/cash-statement?cashLocationId=${cashLocationId}&from=${year}-06-05&to=${year}-06-30`;
    const rows = rowsIn((await get(url)).body);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.operation).toBe('رصيد سابق');
    expect(money(rows[0]?.income)).toBe('500.00');
    expect(money(rows[0]?.balance)).toBe('500.00');
    expect(rows[0]?.day).toBe(`${year}-06-04`);

    // 500 + 1000 − 300 − 200 = 1000، والرصيد يتحرّك سطراً بسطر.
    expect(rows[1]?.operation).toBe('سند قبض');
    expect(money(rows[1]?.income)).toBe('1000.00');
    expect(money(rows[1]?.balance)).toBe('1500.00');
    expect(rows[2]?.operation).toBe('سند صرف');
    expect(money(rows[2]?.outcome)).toBe('300.00');
    expect(money(rows[2]?.balance)).toBe('1200.00');
    expect(rows[3]?.operation).toBe('قيد اليومية');
    expect(money(rows[3]?.outcome)).toBe('200.00');
    expect(money(rows[3]?.balance)).toBe('1000.00');

    const body = await get(url);
    expect(money(cardOf(body, 's_all'))).toBe('1000.00');
    expect(money(cardOf(body, 's_period'))).toBe('500.00');
    expect(Number(cardOf(body, 's_count'))).toBe(4);
  });

  it('🏦 حركة الصندوق — بلا صندوقٍ لا شيء، وبلا فترةٍ لا «رصيد سابق»', async () => {
    // «اختر صندوقاً.» — the window refuses to run without one, so the report is empty.
    expect(rowsIn((await report('cash-statement')).body).every((row) => row.operation !== 'سند قبض')).toBe(true);

    const noPeriod = rowsIn((await get(`/reports/cash-statement?cashLocationId=${cashLocationId}`)).body);
    expect(noPeriod.some((row) => row.operation === 'رصيد سابق')).toBe(false);
    // 500 + 1000 − 300 − 200 = 1000 for the whole ledger, with no opening line.
    expect(money(noPeriod.at(-1)?.balance)).toBe('1000.00');
  });

  it('💼 تقرير الرواتب — الإجمالي والصافي وإجمالي الرواتب', async () => {
    const rows = rowsIn((await report('salary-statement', `month=6&year=${year}`)).body);
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.employee === employeeAName);
    expect(first?.doc_no.startsWith('SP-') || first?.doc_no.length > 0).toBe(true);
    // الراتب الأساسي 5000 وبدل سكن 1000 وبدل مواصلات 500 من بطاقة الموظف.
    expect(money(first?.basic)).toBe('5000.00');
    expect(money(first?.housing)).toBe('1000.00');
    expect(money(first?.transport)).toBe('500.00');
    // 💰 الإجمالي = الصافي + الخصومات — the number the window recomputes.
    expect(money(Number(first?.net) + Number(first?.deductions))).toBe(money(first?.gross));

    const body = await report('salary-statement', `month=6&year=${year}`);
    expect(money(cardOf(body, 'net'))).toBe(money(salaryNets.reduce((sum, value) => sum + Number(value), 0)));
    expect(Number(cardOf(body, 's_count'))).toBe(2);

    // «كل الفترة» — the window only filters when it could read **both** boxes.
    const allPeriod = rowsIn((await report('salary-statement')).body);
    expect(allPeriod.length).toBeGreaterThanOrEqual(2);
    // شهرٌ لا رواتب فيه: لا شيء.
    expect(rowsIn((await report('salary-statement', `month=3&year=${year}`)).body)).toHaveLength(0);
  });

  it('📋 تقرير الرواتب المستحقة — المسيّر وعداده ومستحقه وملاحظاته', async () => {
    const rows = rowsIn((await get(`/reports/salary-reserved?from=${year}-01-01&to=${year}-12-31`)).body);
    expect(rows.map((row) => `${row.year}-${row.month}`).sort()).toEqual([`${year}-06`, `${year}-07`]);
    const june = rows.find((row) => row.month === '06');
    expect(june?.year).toBe(String(year));
    // Three employees were hired above, and the مسيّر counts every one of them.
    expect(Number(june?.employees)).toBe(3);
    // صافي المستحق = الإجمالي − الخصومات على سطور المسيّر.
    expect(money(Number(june?.gross) - Number(june?.deductions))).toBe(money(june?.net));
    if (runNumber) expect(june?.doc_no).toBe(runNumber);

    // 📝 ملاحظات — the reversal reason of the مسيّر المعكوس، كما يُقرأ `Salary_Res.Notes`.
    const july = rows.find((row) => row.month === '07');
    expect(july?.notes).toBe(reversedRunNotes);
  });

  it('👤 سجلات المستخدمين — السجل كاملاً وسجلّ موظفٍ واحد', async () => {
    const rows = rowsIn((await get(`/reports/user-records?from=${year}-01-01&to=${year}-12-31`)).body);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.seq).toBe('1');
    expect(rows[0]?.device.length).toBeGreaterThan(0);
    expect(rows[0]?.actor).not.toBe('—');

    // 👤 «المستخدم» — the employee whose membership is the actor of the events. Every
    // fixture above was written by the owner, so the owner's log is the log.
    const mine = rowsIn((await get(`/reports/user-records?salesmanId=${actorEmployeeId}`)).body);
    expect(mine.length).toBe(rows.length);
    expect(mine.length).toBeGreaterThan(0);

    // 👁️ A second person who wrote nothing: the reader's employee, and it has no rows.
    const readerEmployee = await post('/hrm/employees', {
      employeeNo: 'TRH-READ',
      name: 'قارئ السجل',
      branchId,
      membershipId: viewer.membershipId,
    });
    expect(readerEmployee.status).toBe(201);
    expect(rowsIn((await get(`/reports/user-records?salesmanId=${data(readerEmployee.body).id}`)).body)).toHaveLength(0);

    // An employee with no membership never shows in the log.
    expect(rowsIn((await get(`/reports/user-records?salesmanId=${employeeBId}`)).body)).toHaveLength(0);
  });

  it('🚢 تقرير فواتير التأجير — الفاتورة والحجز والإيرادات والمرتجع والصافي', async () => {
    const rows = rowsIn((await report('rent-invoices')).body);
    expect(rows).toHaveLength(3);
    const invoice = rows.find((row) => money(row.net) === rentalNet);
    expect(invoice?.vessel).toBe(vesselName);
    expect(invoice?.category).toBe(groupCode);
    expect(invoice?.customer).toBe(customerName);
    expect(['نعم', 'لا']).toContain(invoice?.in_plan);

    // «حجوزات» — a حجز with no فاتورة تأجير carries its own value.
    const reservation = rows.find((row) => money(row.net) === money(reservationNet));
    expect(reservation).toBeTruthy();

    const body = await report('rent-invoices');
    // `CalcIncome`: 1 و3 إيرادات، و2 مرتجع، و4 خارج الحساب.
    // `CalcIncome`: 1 و3 إيرادات، و2 مرتجع، و4 خارج الحساب.
    expect(money(cardOf(body, 's_income'))).toBe(money(Number(rentalNet) + Number(draftRentalNet)));
    expect(money(cardOf(body, 's_return'))).toBe('0.00');
    expect(money(cardOf(body, 's_net'))).toBe(money(Number(rentalNet) + Number(draftRentalNet)));

    // ⚙️ نوع العملية
    expect(rowsIn((await report('rent-invoices', 'kind=rent')).body)).toHaveLength(1);
    expect(rowsIn((await report('rent-invoices', 'kind=pending')).body)).toHaveLength(1);
    expect(rowsIn((await report('rent-invoices', 'kind=reservation')).body)).toHaveLength(1);
    expect(rowsIn((await report('rent-invoices', 'kind=return')).body)).toHaveLength(0);

    // 🔢 رقم الفاتورة · 👥 العميل · 📁 الفئة
    const byNumber = rowsIn((await report('rent-invoices', `docNo=${invoice?.number ?? '—'}`)).body);
    expect(byNumber).toHaveLength(1);
    expect(rowsIn((await report('rent-invoices', `branchId=00000000-0000-4000-8000-000000000000`)).body)).toHaveLength(0);
  });

  it('📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر', async () => {
    const empty = await get(`/reports/cash-statement?from=2000-01-01&to=2000-01-02&cashLocationId=${cashLocationId}`);
    // The «رصيد سابق» line opens the statement whenever a period is chosen — a zero line,
    // not a missing one.
    expect(rowsIn(empty.body)).toHaveLength(1);
    expect(rowsIn(empty.body)[0]?.operation).toBe('رصيد سابق');
    expect(money(cardOf(empty.body, 's_all'))).toBe('0.00');

    const salary = await get(`/reports/salary-statement?month=1&year=1999`);
    expect(rowsIn(salary.body)).toHaveLength(0);
    expect(money(cardOf(salary.body, 'net'))).toBe('0.00');

    const reserved = await get(`/reports/salary-reserved?from=2000-01-01&to=2000-01-02`);
    expect(rowsIn(reserved.body)).toHaveLength(0);

    const rent = await get(`/reports/rent-invoices?from=2000-01-01&to=2000-01-02`);
    expect(rowsIn(rent.body)).toHaveLength(0);
    expect(money(cardOf(rent.body, 's_income'))).toBe('0.00');
  });

  it('🔒 عزلٌ بين المستأجرين و👁️ صلاحية «reporting.view»', async () => {
    const theirs = await report('cash-statement', `cashLocationId=${cashLocationId}`, stranger.token);
    expect(rowsIn(theirs.body).every((row) => row.operation !== 'سند قبض')).toBe(true);

    const theirSalary = await report('salary-statement', `month=6&year=${year}`, stranger.token);
    expect(rowsIn(theirSalary.body)).toHaveLength(0);

    const theirRent = await report('rent-invoices', '', stranger.token);
    expect(rowsIn(theirRent.body)).toHaveLength(0);

    // 👁️ The read-only viewer sees exactly what the owner sees.
    const mine = await report('salary-statement', `month=6&year=${year}`, viewer.token);
    expect(rowsIn(mine.body)).toHaveLength(2);

    const forbidden = await api(ctx.server, 'get', `/api/v1/reports/salary-statement?month=6&year=${year}`, {
      token: (
        await createActor(ctx, {
          tenantCode: 'rpt-trh6',
          email: 'intruder@rpt-trh6.test',
          permissions: [...ALL_PLATFORM_PERMISSIONS],
        })
      ).token,
    });
    expect(forbidden.status).toBe(403);
  });
});
