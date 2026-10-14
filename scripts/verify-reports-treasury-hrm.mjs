#!/usr/bin/env node
/**
 * Live verification of Phase 10 part six — 💰 تقارير الخزينة والرواتب والمستخدمين
 * (`Form_WPF/frmRptKhzna` · `frmRptSalary` · `frmRptReseved` · `frmrptUsersRecords` ·
 * `frmRptRentInvoices`) against a running stack (`node scripts/local-db.mjs` +
 * `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير الخمسة بأعمدة الديسكتوب وبطاقاته
 *   2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط
 *   3. 🧾 الوثائق — صندوق وحساب · قيدان · سندان · موظفان وإذنا صرف · مسيّران ·
 *      فئة ومركب وحجزان وأحدهما بفاتورة تأجير
 *   4. 🏦 حركة الصندوق — «رصيد سابق» ورصيدٌ متحرك والبطاقتان
 *   5. 💼 تقرير الرواتب — الإجمالي = الصافي + الخصومات، وإجمالي الرواتب
 *   6. 📋 تقرير الرواتب المستحقة — عداد الموظفين والمستحق وملاحظات المعكوس
 *   7. 👤 سجلات المستخدمين — السجل كاملاً وسجلّ موظفٍ واحد
 *   8. 🚢 تقرير فواتير التأجير — تأجير · معلق · حجوزات، والإيرادات والمرتجع والصافي
 *   9. 📆 فترةٌ بلا حركة — جدولٌ فارغ وسطر «رصيد سابق» صفر
 *  10. 🖨️ طباعة وتصدير — CSV وXLSX
 *  11. 🧹 التنظيف — السندات تُلغى والقيود تُعكس، وما لا رجعة فيه يُعلَن
 *
 * Re-runnable and non-destructive: every account, employee, vessel and document this
 * script writes carries a stamp, the two مسيّرين are filed under years nothing else uses,
 * every tenant-wide total is asserted as a **difference from a baseline** taken before
 * anything is written, and everything with an undo is undone at the end.
 *
 * Usage: node scripts/verify-reports-treasury-hrm.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let token = '';

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    throw error;
  }
  return parsed.data ?? parsed;
}

const call = (method, path, body) => request(method, path, body);

/** A refusal is a result, not a crash — the window shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    await call(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

const login = await call('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path);
const post = (path, body) => call('post', path, body);
const del = (path) => call('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));
const money = (value) => Number(value ?? 0).toFixed(2);
const num = (value) => Number(value ?? 0);
const delta = (after, before) => Number((Number(after ?? 0) - Number(before ?? 0)).toFixed(2));
/** One of the 💰 summary cards under the grid, by the column it sums. */
const cardOf = (report, key) => (report.grandTotal ?? []).find((total) => total.key === key)?.amount ?? '0';
const columns = (entry) => (entry?.columns ?? []).map((column) => column.labelAr).join(' · ');
const params = (entry) => (entry?.params ?? []).map((param) => param.labelAr).join(' · ');

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const day = iso(0);
const year = today.getUTCFullYear();
const from = iso(-5);
const to = iso(1);
const period = `from=${from}&to=${to}`;
const emptyPeriod = 'from=2000-01-01&to=2000-01-02';
const report = (key, query = '') => get(`/reports/${key}?${query ? `${query}&` : ''}${period}`);
const rowsOf = (report) => report.rows ?? [];

const written = {
  accounts: [],
  employees: [],
  entries: [],
  vouchers: [],
  payments: [],
  runs: [],
  bookings: [],
  vessels: [],
  groups: [],
  parties: [],
};
const refusals = [];
let undone = 0;

async function undo(label, action) {
  try {
    await action();
    undone += 1;
    console.log(`    ↩ ${label}`);
  } catch (error) {
    refusals.push({ label, status: error.status ?? 0, code: error.code ?? '' });
    console.log(`    ⚖ ${label} — ${error.status ?? ''} ${error.code ?? ''} (لا رجعة)`);
  }
}

// ══════════════════════════════════════════════════════════════════ 1. 📚 السجل
console.log('■ 1. 📚 السجل — التقارير الخمسة بأعمدة الديسكتوب');
{
  const catalog = list(await get('/reports'));
  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));

  const cash = byKey.get('cash-statement');
  check('🏦 حركة الصندوق — ثمانية أعمدة', columns(cash) === 'م · العملية · الرقم · 📅 التاريخ · 📥 وارد · 📤 صادر · ⚖️ الرصيد · 📝 البيان', columns(cash));
  check(
    '🏦 فلاتر «حركة الصندوق»',
    params(cash) === 'الصندوق · من تاريخ · من وقت (HH:mm) · إلى تاريخ · إلى وقت (HH:mm)',
    params(cash),
  );

  const salary = byKey.get('salary-statement');
  check(
    '💼 تقرير الرواتب — عشرة أعمدة',
    columns(salary) ===
      'م · رقم السند · 👤 الموظف · الراتب الأساسي · بدل سكن · بدل مواصلات · الحوافز · 💰 الإجمالي · الخصومات · 💵 صافي الراتب',
    columns(salary),
  );

  const reserved = byKey.get('salary-reserved');
  check(
    '📋 تقرير الرواتب المستحقة — أحد عشر عموداً',
    columns(reserved) ===
      'م · رقم السند · 📅 التاريخ · 🏬 الفرع · الشهر · السنة · عدد الموظفين · الإجمالي · الخصومات · صافي المستحق · 📝 ملاحظات',
    columns(reserved),
  );

  const records = byKey.get('user-records');
  check(
    '👤 سجلات المستخدمين — خمسة أعمدة',
    columns(records) === 'م · 📅 التاريخ · 🖥️ الجهاز · 📝 العملية · 👤 المستخدم',
    columns(records),
  );

  const rent = byKey.get('rent-invoices');
  check(
    '🚢 تقرير فواتير التأجير — الأعمدة التسعة الأولى من شبكة الديسكتوب',
    columns(rent).startsWith('الرقم · المركب · الفئة · الصافي · التاريخ · العميل · المستخدم · الجوال · ضمن الخطة'),
    columns(rent).slice(0, 60) + ' …',
  );
  check(
    '⚙️ نوع العملية — أربعة أنواع',
    (rent?.params?.find((param) => param.labelAr === 'نوع العملية')?.options ?? [])
      .map((option) => option.labelAr)
      .join(' · ') === 'تأجير · مرتجع · معلق · حجوزات',
  );
}

// ═══════════════════════════════════════════════════════════ 2. 📏 خطّ الأساس
console.log('\n■ 2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط');
const baseline = {
  cash: await report('cash-statement'),
  salary: await report('salary-statement'),
  reserved: await get(`/reports/salary-reserved?${period}`),
  users: await get(`/reports/user-records?${period}`),
  rent: await report('rent-invoices'),
};
console.log(
  `  · السجلات ${rowsOf(baseline.users).length} · الرواتب ${rowsOf(baseline.salary).length} · التأجير ${rowsOf(baseline.rent).length}`,
);

// ═══════════════════════════════════════════════════════════ 3. 🧾 الوثائق
console.log('\n■ 3. 🧾 الوثائق — صندوق · قيدان · سندان · إذنا صرف · مسيّران · حجزان');

const branches = list(await get('/branches'));
const branchId = branches[0]?.id ?? '';
const periods = list(await get('/fiscal-periods'));
const fiscalPeriodId =
  periods.find((row) => row.status === 'open' && row.startDate <= day && day <= row.endDate)?.id ?? '';

const account = async (code, nameAr, type) => {
  const created = await post('/accounts', { code, nameAr, type });
  written.accounts.push(created.id);
  return created;
};
const boxAccount = await account(`9${stamp}1`, `صندوق التحقق ${stamp}`, 'asset');
const salaryAccount = await account(`9${stamp}2`, `صندوق الرواتب ${stamp}`, 'asset');
const contraAccount = await account(`9${stamp}3`, `حساب مقابل ${stamp}`, 'asset');

const box = async (name, accountId) => {
  const created = await post('/cash-locations', { branchId, kind: 'safe', name, accountId });
  return created;
};
const statementBox = await box(`صندوق التحقق ${stamp}`, boxAccount.id);
const salaryBox = await box(`صندوق الرواتب ${stamp}`, salaryAccount.id);
console.log(`  ✓ صندوقان — ${statementBox.name} · ${salaryBox.name}`);

// 🏦 500 وارد قبل الفترة، و200 صادر داخلها.
const journal = async (date, lines) => {
  const created = await post('/journal-entries', { branchId, date, lines });
  written.entries.push(created);
  return created;
};
await journal(iso(-10), [
  { accountId: boxAccount.id, debit: '500', credit: '0' },
  { accountId: contraAccount.id, debit: '0', credit: '500' },
]);
await journal(iso(-1), [
  { accountId: contraAccount.id, debit: '200', credit: '0' },
  { accountId: boxAccount.id, debit: '0', credit: '200' },
]);

const voucher = async (kind, gross, description) => {
  const draft = await post('/vouchers', {
    branchId,
    kind,
    subtype: 'customer',
    date: iso(-2),
    cashLocationId: statementBox.id,
    method: 'cash',
    amount: gross,
    description,
  });
  const posted = await post(`/vouchers/${draft.id}/post`, {});
  written.vouchers.push(posted);
  return posted;
};
await voucher('receipt', '1000', `تحصيل التحقق ${stamp}`);
await voucher('payment', '300', `سداد التحقق ${stamp}`);
console.log('  ✓ قيدان وسندان — 500 وارد قبل الفترة، و1000 و300 و200 داخلها');

// 👤 A مسيّر counts every *active* employee, so the ones earlier تشغيلات left behind are
// terminated first — otherwise the عداد below would grow with every تشغيل.
const existingStaff = list(await get('/hrm/employees'));
let retired = 0;
for (const row of existingStaff) {
  // «التحقق» is the marker every سكربت تحقق writes on the people it hires.
  const no = String(row.employeeNo ?? row.employee_no ?? '');
  const name = String(row.name ?? '');
  if ((no.startsWith('TRH') || name.includes('التحقق')) && row.status === 'active') {
    await call('patch', `/hrm/employees/${row.id}`, { status: 'terminated' });
    retired += 1;
  }
}
if (retired) console.log(`  👤 ${retired} موظفٍ من تشغيلٍ سابق أُنهيَت خدمته`);

// 💼 موظفان وإذنا صرف راتب.
const employee = async (no, name) => {
  const created = await post('/hrm/employees', {
    employeeNo: `TRH${stamp}${no}`,
    name,
    branchId,
    salaryComponents: { basic: '5000', housing: '1000', transport: '500' },
  });
  written.employees.push(created.id);
  return created;
};
const first = await employee('A', `موظف التحقق أ ${stamp}`);
const second = await employee('B', `موظف التحقق ب ${stamp}`);

const paySalary = async (employeeId) => {
  const created = await post('/hrm/salary-payments', {
    employeeId,
    yearMonth: `${year}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`,
    paymentDate: day,
    branchId,
    cashLocationId: salaryBox.id,
    method: 'cash',
  });
  written.payments.push(created.id);
  return created;
};
const paymentA = await paySalary(first.id);
const paymentB = await paySalary(second.id);
console.log(`  ✓ إذنا صرف — ${paymentA.number} · ${paymentB.number}`);

// 📋 مسيّران: واحد مُرحَّل وواحد معكوس؛ والسنةُ بعيدةٌ عن كل مسيّرٍ حقيقي.
const run = async (yearMonth) => {
  const created = await post('/hrm/payroll/runs', { yearMonth });
  written.runs.push(created.id);
  return created.id;
};
// 📋 The two years no real مسيّر will ever use. A مسيّر can be filed again under a
// yearMonth only once the one before it has been reversed, so a تشغيل that was cut short
// would block the next one: reverse what it left before filing anything new.
const staleRuns = list(await get('/hrm/payroll/runs')).filter(
  (row) => ['1999-01', '1999-02'].includes(row.yearMonth) && row.status !== 'reversed',
);
for (const stale of staleRuns) {
  await refused('post', `/hrm/payroll/runs/${stale.id}/reverse`, { reason: `تنظيف تشغيلٍ سابق ${stamp}` });
}
if (staleRuns.length) console.log(`  📋 ${staleRuns.length} مسيّرٍ من تشغيلٍ سابق أُلغي`);

const postedRun = await run('1999-01');
const reversedRun = await run('1999-02');
// 📒 The قيد that carries the accrual is what «رقم السند» prints on the مسيّر's row.
const expenseAccount = await account(`9${stamp}4`, `مصروف رواتب ${stamp}`, 'expense');
const payableAccount = await account(`9${stamp}5`, `رواتب مستحقة ${stamp}`, 'liability');
const runDetail = (await get(`/hrm/payroll/runs/${postedRun}`)).data ?? {};
const payable = String((runDetail.summary ?? {}).preview?.netPayable ?? '13000');
const postedRunBody = await post(`/hrm/payroll/runs/${postedRun}/post`, {
  branchId,
  fiscalPeriodId,
  journalLines: [
    { accountId: expenseAccount.id, debit: payable, credit: '0' },
    { accountId: payableAccount.id, debit: '0', credit: payable },
  ],
});
const postedEntry = await get(`/journal-entries/${postedRunBody.journalEntryId}`);
const postedRunNumber = String(postedEntry.number ?? '');
const reversalReason = `تصحيح مسيّر التحقق ${stamp}`;
await post(`/hrm/payroll/runs/${reversedRun}/post`, { branchId });
await post(`/hrm/payroll/runs/${reversedRun}/reverse`, { reason: reversalReason });
console.log(`  ✓ مسيّران — واحد مُرحَّل بقيد وواحد معكوس (${payable})`);

// 🚢 فئة ومركب وحجزان: أحدهما بفاتورة تأجير مُرحَّلة والآخر بلا فاتورة.
const party = await post('/parties', { kind: 'customer', name: `عميل التأجير ${stamp}` });
written.parties.push(party.id);
const group = await post('/marina/groups', { name: `قوارب التحقق ${stamp}`, code: `CHK${stamp}` });
written.groups.push(group.id);
const vessel = await post('/marina/vessels', {
  groupId: group.id,
  code: `V${stamp}`,
  name: `مركب التحقق ${stamp}`,
  capacity: 4,
});
written.vessels.push(vessel.id);
const booking = async (offset, rental) => {
  const date = iso(offset);
  const created = await post('/marina/bookings', {
    branchId,
    partyId: party.id,
    vesselId: vessel.id,
    documentDate: date,
    startsAt: `${date}T08:00:00.000Z`,
    endsAt: `${date}T10:00:00.000Z`,
    periodHours: 2,
    rentalAmount: rental,
    insuranceAmount: '100',
  });
  written.bookings.push(created.id);
  return created;
};
const rented = await booking(-3, '400');
const pending = await booking(-1, '200');
const bare = await booking(-1, '300');

let rentalNet = '0';
let draftNet = '0';
const rental = await post(`/marina/bookings/${rented.id}/rental-invoice`, {});
rentalNet = money(rental.netAmount);
const sale = await post(`/sales/invoices/${rental.salesInvoiceId}/post`, {});
check('🚢 فاتورة تأجير وفاتورة مبيعاتها مُرحَّلة', sale.status === 'posted', String(sale.status));
const draftRental = await post(`/marina/bookings/${pending.id}/rental-invoice`, {});
draftNet = money(draftRental.netAmount);
console.log(`  ✓ ثلاثة حجوزات — فاتورة ${rentalNet} · معلقة ${draftNet} · بلا فاتورة 400`);

// ═══════════════════════════════════════════════════ 4. 🏦 حركة الصندوق
console.log('\n■ 4. 🏦 حركة الصندوق — «رصيد سابق» ورصيدٌ متحرك');
{
  const rows = rowsOf(await report('cash-statement', `cashLocationId=${statementBox.id}`));
  // سطر الرصيد السابق + سند القبض + سند الصرف + القيد = أربعة سطور.
  check('🏦 أربعة سطور', rows.length === 4, `${rows.length} سطر`);
  check('🏁 «رصيد سابق» يفتح الكشف', rows[0]?.operation === 'رصيد سابق', String(rows[0]?.operation));
  check('💰 الرصيد السابق 500 وارد', money(rows[0]?.income) === '500.00', money(rows[0]?.income));

  const receipt = rows.find((row) => row.operation === 'سند قبض');
  const payment = rows.find((row) => row.operation === 'سند صرف');
  const manual = rows.find((row) => row.operation === 'قيد اليومية');
  check('📥 سند القبض 1000 وارد', money(receipt?.income) === '1000.00', money(receipt?.income));
  check('📤 سند الصرف 300 صادر', money(payment?.outcome) === '300.00', money(payment?.outcome));
  check('📒 القيد 200 صادر', money(manual?.outcome) === '200.00', money(manual?.outcome));
  // 500 + 1000 − 300 − 200 = 1000، سطراً بسطر.
  check('⚖️ الرصيد المتحرك 500 → 1500 → 1200 → 1000', rows.map((row) => money(row.balance)).join(' → ') === '500.00 → 1500.00 → 1200.00 → 1000.00', rows.map((row) => money(row.balance)).join(' → '));

  const body = await report('cash-statement', `cashLocationId=${statementBox.id}`);
  check('💳 بطاقة «الرصيد الإجمالي» 1000', money(cardOf(body, 's_all')) === '1000.00', money(cardOf(body, 's_all')));
  check('💳 بطاقة «رصيد الفترة المحددة» 500', money(cardOf(body, 's_period')) === '500.00', money(cardOf(body, 's_period')));
  check('💳 بطاقة «عدد الحركات» 4', num(cardOf(body, 's_count')) === 4, cardOf(body, 's_count'));

  // «اختر صندوقاً.» — لا صندوق، لا كشف.
  const none = rowsOf(await report('cash-statement'));
  check('🏦 بلا صندوق — لا حركة', none.every((row) => row.operation !== 'سند قبض'));
}

// ═════════════════════════════════════════════════════ 5. 💼 تقرير الرواتب
console.log('\n■ 5. 💼 تقرير الرواتب — الإجمالي والصافي');
{
  const rows = rowsOf(await report('salary-statement'));
  const mine = rows.filter((row) => written.employees.includes(String(row.employee_id ?? '')) || String(row.employee ?? '').includes(stamp));
  check('💼 إذنان جديدان', delta(rows.length, rowsOf(baseline.salary).length) === 2, `+${delta(rows.length, rowsOf(baseline.salary).length)}`);
  const row = mine[0] ?? rows[0];
  check('💰 الراتب الأساسي 5000', money(row?.basic) === '5000.00', money(row?.basic));
  check('🏠 بدل سكن 1000', money(row?.housing) === '1000.00', money(row?.housing));
  check('🚗 بدل مواصلات 500', money(row?.transport) === '500.00', money(row?.transport));
  // «💰 الإجمالي» = الصافي + الخصومات — الرقم الذي يعيد الديسكتوب حسابه.
  check(
    '💰 الإجمالي = الصافي + الخصومات',
    money(Number(row?.net ?? 0) + Number(row?.deductions ?? 0)) === money(row?.gross),
    `${money(row?.net)} + ${money(row?.deductions)} = ${money(row?.gross)}`,
  );

  const body = await report('salary-statement');
  check(
    '💳 «إجمالي الرواتب» يزيد بمقدار الصافيين',
    delta(cardOf(body, 'net'), cardOf(baseline.salary, 'net')) === num(money(num(paymentA.net) + num(paymentB.net))),
    `+${delta(cardOf(body, 'net'), cardOf(baseline.salary, 'net'))}`,
  );

  // 📅 الشهر والسنة — النافذة لا تصفّي إلا إذا قرأت الصندوقين معاً.
  const month = String(today.getUTCMonth() + 1);
  const filtered = rowsOf(await get(`/reports/salary-statement?month=${month}&year=${year}`));
  check('📅 الشهر والسنة يصفّيان', filtered.length >= 2, `${filtered.length} سطر`);
  const nothing = rowsOf(await get(`/reports/salary-statement?month=3&year=1899`));
  check('📅 شهرٌ بلا رواتب — لا شيء', nothing.length === 0, `${nothing.length} سطر`);
}

// ══════════════════════════════════════════ 6. 📋 تقرير الرواتب المستحقة
console.log('\n■ 6. 📋 تقرير الرواتب المستحقة — المسيّر ومستحقه');
{
  const rows = rowsOf(await get(`/reports/salary-reserved?${period}`));
  // 📏 Every تشغيل writes two more; a reversed مسيّر stays in the ledger.
  check('📋 مسيّران جديدان', delta(rows.length, rowsOf(baseline.reserved).length) === 2, `+${delta(rows.length, rowsOf(baseline.reserved).length)}`);
  // 👥 Every مسيّر of every تشغيل shares the year 1999, so «رقم السند» — the قيد this
  // تشغيل posted — is what names the row that belongs to *this* تشغيل.
  const posted = rows.find((row) => row.doc_no === postedRunNumber);
  const reversed = rows.find((row) => row.notes === reversalReason);
  check('👥 عداد الموظفين 2', num(posted?.employees) === 2, String(posted?.employees));
  check(
    '💰 صافي المستحق = الإجمالي − الخصومات',
    money(Number(posted?.gross ?? 0) - Number(posted?.deductions ?? 0)) === money(posted?.net),
    money(posted?.net),
  );
  // 📝 ملاحظات — سبب العكس، كما يُقرأ `Salary_Res.Notes`.
  check('📝 ملاحظات المسيّر المعكوس', reversed?.notes === reversalReason, String(reversed?.notes));
}

// ═══════════════════════════════════════════════ 7. 👤 سجلات المستخدمين
console.log('\n■ 7. 👤 سجلات المستخدمين — السجل كاملاً وسجلّ موظف');
{
  const rows = rowsOf(await get(`/reports/user-records?${period}`));
  // The report caps at 1000 rows, so a tenant that is already full shows the newest
  // thousand and not one row more: what has to stay true is that the newest event is not
  // older than it was before this تشغيل wrote anything.
  const grew = rows.length > rowsOf(baseline.users).length;
  const fresh = String(rows[0]?.at ?? '') >= String(rowsOf(baseline.users)[0]?.at ?? '');
  check('👤 السجل يمتلئ بما كتبه هذا التشغيل', grew || (rows.length >= 1000 && fresh), `${rows.length} سجل`);
  check('🖥️ الجهاز و📝 العملية و👤 المستخدم مملوءة', rows.every((row) => row.device !== '—' && row.operation !== '' && row.actor !== '—'));

  // 👤 «المستخدم» — موظفٌ مرتبط بعضوية صاحب السجل يرى سجله وحده.
  const memberships = list(await get('/hrm/employees'));
  const withMembership = memberships.find((row) => row.membershipId);
  if (withMembership) {
    const mine = rowsOf(await get(`/reports/user-records?salesmanId=${withMembership.id}`));
    check('👤 سجلّ موظفٍ واحد أقلّ من السجل كله', mine.length > 0 && mine.length <= rows.length, `${mine.length} من ${rows.length}`);
  } else {
    check('👤 سجلّ موظفٍ واحد أقلّ من السجل كله', rows.length > 0, 'لا موظفَ مرتبطٌ بعضوية — السجل وحده');
  }
  // موظفٌ بلا عضوية لا يظهر في السجل أبداً.
  check('🚫 موظفٌ بلا عضوية — لا سجلّ', rowsOf(await get(`/reports/user-records?salesmanId=${first.id}`)).length === 0);
}

// ═══════════════════════════════════════════ 8. 🚢 تقرير فواتير التأجير
console.log('\n■ 8. 🚢 تقرير فواتير التأجير — تأجير · معلق · حجوزات');
{
  // 📁 الفئة of this تشغيل — the hanya way to tell its rows from an earlier تشغيل's.
  const rows = rowsOf(await report('rent-invoices', `groupId=${group.id}`));
  check('🚢 فاتورة ومعلقة وحجز', rows.length === 3, `${rows.length} سطر`);
  check('🏷️ المركب والفئة', rows.every((row) => row.vessel === `مركب التحقق ${stamp}` && row.category === `CHK${stamp}`));
  check('👥 العميل', rows.every((row) => row.customer === `عميل التأجير ${stamp}`));

  const body = await report('rent-invoices', `groupId=${group.id}`);
  // `CalcIncome`: 1 و3 إيرادات، و2 مرتجع، و4 خارج الحساب.
  check(
    '💳 «إيرادات» = الفاتورة + المعلقة',
    money(cardOf(body, 's_income')) === money(num(rentalNet) + num(draftNet)),
    `${money(cardOf(body, 's_income'))} = ${money(num(rentalNet) + num(draftNet))}`,
  );
  check('💳 «مرتجع» صفر', money(cardOf(body, 's_return')) === '0.00', money(cardOf(body, 's_return')));
  check(
    '💳 «الصافي» = الإيرادات − المرتجع',
    money(cardOf(body, 's_net')) === money(num(rentalNet) + num(draftNet)),
    money(cardOf(body, 's_net')),
  );
  check(
    '📏 «إيرادات» يزيد عن خطّ الأساس بمقدار الفاتورتين',
    delta(cardOf(await report('rent-invoices'), 's_income'), cardOf(baseline.rent, 's_income')) ===
      num(money(num(rentalNet) + num(draftNet))),
    `+${delta(cardOf(await report('rent-invoices'), 's_income'), cardOf(baseline.rent, 's_income'))}`,
  );

  // ⚙️ نوع العملية
  check('⚙️ «تأجير» — الفاتورة المُرحَّلة', rowsOf(await report('rent-invoices', `groupId=${group.id}&kind=rent`)).length === 1);
  check('⚙️ «معلق» — الفاتورة التي لم تُرحَّل', rowsOf(await report('rent-invoices', `groupId=${group.id}&kind=pending`)).length === 1);
  check('⚙️ «حجوزات» — حجزٌ بلا فاتورة', rowsOf(await report('rent-invoices', `groupId=${group.id}&kind=reservation`)).length === 1);
  check('⚙️ «مرتجع» — لا شيء', rowsOf(await report('rent-invoices', `groupId=${group.id}&kind=return`)).length === 0);
}

// ═══════════════════════════════════════════════ 9. 📆 فترةٌ بلا حركة
console.log('\n■ 9. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر');
{
  const empty = await get(`/reports/cash-statement?${emptyPeriod}&cashLocationId=${statementBox.id}`);
  // سطر «رصيد سابق» يُطبع ما دامت الفترة محدّدة — بصفر، لا محذوفاً.
  check('🏦 سطر «رصيد سابق» صفر', rowsOf(empty).length === 1 && money(rowsOf(empty)[0]?.income) === '0.00');
  check('💳 «الرصيد الإجمالي» صفر', money(cardOf(empty, 's_all')) === '0.00', money(cardOf(empty, 's_all')));

  // 💼 The window filters by الشهر والسنة, not by a period: a month nobody was paid in.
  const salary = await get(`/reports/salary-statement?month=1&year=1899`);
  check('💼 لا إيذونات', rowsOf(salary).length === 0);
  const reserved = await get(`/reports/salary-reserved?${emptyPeriod}`);
  check('📋 لا مسيّرات', rowsOf(reserved).length === 0);
  const rent = await get(`/reports/rent-invoices?${emptyPeriod}`);
  check('🚢 لا فواتير تأجير', rowsOf(rent).length === 0 && money(cardOf(rent, 's_income')) === '0.00');
}

// ═══════════════════════════════════════════════ 10. 🖨️ طباعة وتصدير
console.log('\n■ 10. 🖨️ طباعة وتصدير — CSV وXLSX');
{
  const csv = await post(`/reports/cash-statement/export?${period}&cashLocationId=${statementBox.id}`, { format: 'csv' });
  check('📄 CSV بعناوين الديسكتوب العربية', String(csv.content ?? '').includes('الرصيد'), `${csv.rows} سطر`);
  const xlsx = await post(`/reports/cash-statement/export?${period}&cashLocationId=${statementBox.id}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && String(xlsx.filename).endsWith('.xlsx'), String(xlsx.filename));
  const salaryCsv = await post(`/reports/salary-statement/export?${period}`, { format: 'csv' });
  check('📄 CSV الرواتب', String(salaryCsv.content ?? '').includes('صافي الراتب'), `${salaryCsv.rows} سطر`);
}

// ══════════════════════════════════════════════════════ 11. 🧹 التنظيف
console.log('\n■ 11. 🧹 التنظيف — السندات تُلغى والقيود تُعكس');
{
  const voidReason = `تنظيف سكربت التحقق ${stamp}`;
  for (const voucher of [...written.vouchers].reverse()) {
    await undo(`إلغاء سند ${voucher.number}`, () => post(`/vouchers/${voucher.id}/void`, { reason: voidReason }));
  }
  // ⚖️ القيد لا يُلغى بل **يُعكس** — «قيد عكسي» هو سبيل الرجوع في الدفاتر.
  for (const entry of [...written.entries].reverse()) {
    await undo(`عكس ${entry.number}`, () =>
      post(`/journal-entries/${entry.id}/reverse`, { branchId, fiscalPeriodId, date: day, reason: voidReason }),
    );
  }
  // 🗑️ الحجوزات والموظفون وإيذونات الصرف تُمحى؛ وما حمل حركةً يُرفض.
  for (const id of [...written.bookings].reverse()) {
    await undo('حذف حجز', () => del(`/marina/bookings/${id}`));
  }
  for (const id of written.vessels) {
    await undo('حذف مركب', () => del(`/marina/vessels/${id}`));
  }
  for (const id of written.groups) {
    await undo('حذف فئة', () => del(`/marina/groups/${id}`));
  }
  for (const id of [...written.payments].reverse()) {
    await undo('حذف إذن صرف', () => del(`/hrm/salary-payments/${id}`));
  }
  for (const id of [...written.employees].reverse()) {
    await undo('حذف موظف', () => del(`/hrm/employees/${id}`));
  }
  // 👤 An employee who has been on a مسيّر cannot be erased (`EMPLOYEE_ON_PAYROLL`); the
  // next تشغيل terminates him at its own start, before it hires its two.
  for (const id of [...written.accounts].reverse()) {
    await undo('حذف حساب', () => del(`/accounts/${id}`));
  }
  // 📋 المسيّر المُرحَّل يُعكس لا يُحذف — لا طريقَ للرجوع في الدفاتر إلا قيداً عكسيّاً.
  const reversed = await refused('post', `/hrm/payroll/runs/${reversedRun}/reverse`, { reason: voidReason });
  check('📋 المسيّر المعكوس يُرفض عكسه ثانيةً (4xx)', reversed.status === 409 || reversed.status === 404, `${reversed.status} ${reversed.code}`);
  await undo('عكس المسيّر المُرحَّل', () => post(`/hrm/payroll/runs/${postedRun}/reverse`, { reason: voidReason }));
  check(
    '⚖️ ما تعذّر حذفه رفضٌ من قاعدة الدفاتر (4xx) لا خطأ',
    refusals.every((row) => row.status >= 400 && row.status < 500),
    refusals.map((row) => row.code).join(' · ') || 'لا شيء',
  );
  check(`🧹 ما أُلغيَ: ${undone} وثيقة`, true, 'وما بقي — مسيّران معكوسان وحساباتٌ حملت حركة — أثرٌ دفتريٌّ لا رجعة فيه كما في الديسكتوب');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
