#!/usr/bin/env node
/**
 * Live verification of the Phase 08 part one HRM documents against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 🏢 الإدارات والأقسام — إدارة واحدة وأقسامها، والرفضان (`frmManagement` /
 *      `frmDepartments`)
 *   2. 👤 بطاقة الموظف — كل حقول النافذة تُحفظ وتُقرأ (`frmEmployees`)
 *   3. رقم الحساب — حساب باسم الموظف تحت «موظفين الفرع الرئيسي»، ويتغيّر بتغيّر الاسم
 *   4. إجمالي الرواتب والمستحقات — مجموع البدلات السبعة
 *   5. قائمة الموظفين — البحث بالاسم وبالرقم، والتضييق بالإدارة
 *   6. الحذف — «لا يمكن حذف موظف مرتبط بمستخدم»، ثم حذف موظف بلا ارتباط
 *   7. 🎁 الحوافز والجزاءات — الأنواع الثلاثة، الرفوض الأربعة، «رقم السند»، الملاحظة
 *      التي تُكتب نفسها، وقيد السلفة والمكافأة (`frmEmpSalaryAddSub`)
 *   8. 💵 دفع الرواتب — «رقم الإذن»، الرفوض الثلاثة، «لقد تم دفع راتب الموظف سابقاً»،
 *      «لا يوجد رواتب مستحقة للموظف»، وسند الصرف الذي يُصرف به الراتب (`frmSalaryPay`)
 *   9. 📄 كشف حساب موظف — «اختر موظف»، الفترة والفرع، «الرصيد السابق»، «تجميعي/تفصيلي»
 *      والبطاقات الأربع (`frmEmpAccountGet`)
 *  10. 📈 حركات الموظف — «اختر موظف»، «🔄 نوع الحركة»، «📅 من تاريخ/إلى تاريخ»، وأعمدة
 *      «📋 بيانات الحركات» و`💰 الإجمالي` (`frmEmpInvs`)
 *  11. 📊 تقرير الرواتب — «كل الفترة» و«الشهر:/السنة:»، «💼 بيانات الرواتب» و
 *      «💰 إجمالي الرواتب:» (`frmRptSalary`)
 *
 * The two other refusals («لا يمكن حذف موظف مرتبط بفواتير» and the payroll one) are in
 * `apps/api/test/employee-card.spec.ts`: they leave an invoice and a payroll run behind.
 * This script cleans up after itself — every row it creates, it deletes, so it can be run
 * twice in a row — with one exception worth naming: the سلفة it pays out in section 7
 * becomes a real posted document, and a posted entry is not something a verification
 * script may quietly erase.
 *
 * Usage: node scripts/verify-hrm.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(2);
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    // Node 22's undici rejects lowercase verbs: `patch` comes back a 405 with an empty
    // body, and `JSON.parse('')` then throws instead of reporting the real problem.
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed.data ?? parsed;
}

const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
const token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path, token);
const post = (path, body) => call('post', path, token, body);
const patch = (path, body) => call('patch', path, token, body);
const del = (path) => call('delete', path, token);

/** A refusal is a result, not a crash — the desktop shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    // Node 22's undici rejects lowercase verbs: `patch` becomes a 405 with an empty body.
    await (method.toUpperCase() === 'DELETE'
      ? del(path)
      : method.toUpperCase() === 'PATCH'
        ? patch(path, body)
        : method.toUpperCase() === 'GET'
          ? get(path)
          : post(path, body));
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

// ---------------------------------------------------------------------------
// Cleanup — anything a previous run left behind (`employeeNo` / `code` start with VR).
// ---------------------------------------------------------------------------
const leftoverEmployees = (await get('/hrm/employees')).filter((row) => String(row.employeeNo).startsWith('VR'));
for (const row of leftoverEmployees) await refused('delete', `/hrm/employees/${row.id}`);
const leftoverDepartments = (await get('/hrm/departments')).filter((row) => String(row.code).startsWith('VR'));
for (const row of leftoverDepartments.filter((entry) => entry.kind === 'section')) await refused('delete', `/hrm/departments/${row.id}`);
for (const row of leftoverDepartments.filter((entry) => entry.kind === 'management')) await refused('delete', `/hrm/departments/${row.id}`);

console.log('1. 🏢 الإدارات والأقسام — إدارة واحدة وأقسامها');

const management = await post('/hrm/departments', { code: `VRM${stamp}`, name: `الإدارة المالية ${stamp}` });
check('➕ إضافة إدارة — بلا أب (أي: إدارة لا قسم)', !management.parentId, `${management.code} ${management.name}`);

const section = await post('/hrm/departments', { code: `VRS${stamp}`, name: `قسم الخزينة ${stamp}`, parentId: management.id });
check('➕ إضافة قسم — يتبع الإدارة', section.parentId === management.id);

const listed = await get('/hrm/departments');
const sectionRow = listed.find((row) => row.id === section.id);
check('«اسم الإدارة التابع لها» في القائمة', sectionRow?.parentName === management.name, sectionRow?.parentName);
check(
  'الإدارة في القائمة `management` وتحصي أقسامها',
  listed.find((row) => row.id === management.id)?.kind === 'management' &&
    (listed.find((row) => row.id === management.id)?.sectionCount ?? 0) === 1,
);

const nested = await refused('post', '/hrm/departments', { code: `VRS${stamp}2`, name: 'قسم تحت القسم', parentId: section.id });
check('لا قسم تحت قسم — «لا يمكن إضافة قسم تحت قسم آخر»', nested.status === 422 && nested.detail === 'لا يمكن إضافة قسم تحت قسم آخر', `${nested.status} ${nested.code}`);

const managementWithSections = await refused('delete', `/hrm/departments/${management.id}`);
check('لا يمكن حذف إدارة لها أقسام', managementWithSections.status === 409 && managementWithSections.code === 'DEPARTMENT_HAS_SECTIONS', managementWithSections.detail);

console.log('\n2. 👤 بطاقة الموظف — كل حقول النافذة');

const card = (suffix) => ({
  employeeNo: `VR${stamp}${suffix}`,
  name: `موظف التحقق ${stamp}${suffix}`,
  departmentId: section.id,
  hireDate: '2024-01-15',
  birthDate: '1990-05-02',
  insuranceNo: `INS-${stamp}${suffix}`,
  nationalId: `1099${stamp}${suffix}`,
  maritalStatus: 'متزوج',
  nationality: 'يمني',
  gender: 'male',
  phone: '01-234567',
  mobile: '771234567',
  email: `verify${stamp}${suffix}@example.com`,
  address: 'صنعاء - شارع حدة',
  notes: 'موظف تحقق',
  salaryComponents: { basic: '5000', housing: '1000', transport: '500', food: '300', medical: '200', fixedBonus: '250', other: '150' },
  bank: { iban: 'SA0380000000608010167519', bankNo: '123456', bankName: 'بنك اليمن' },
});

const employee = await post('/hrm/employees', card('1'));
const read = await get(`/hrm/employees/${employee.id}`);

check(
  'بيانات الموظف الأساسية تُقرأ كما كُتبت',
  read.name === employee.name &&
    read.employeeNo === employee.employeeNo &&
    read.hireDate === '2024-01-15' &&
    read.birthDate === '1990-05-02' &&
    read.insuranceNo === employee.insuranceNo &&
    read.maritalStatus === 'متزوج' &&
    read.nationality === 'يمني' &&
    read.gender === 'male' &&
    read.phone === '01-234567' &&
    read.mobile === '771234567' &&
    read.email === employee.email,
  read.employeeNo,
);
check('«النوع» و«الحالة» بأسمائهما العربية', read.genderLabel === 'ذكر' && read.statusLabel === 'نشط', `${read.genderLabel} · ${read.statusLabel}`);
check(
  'البيانات التكميلية — العنوان · رقم الهوية · الحساب البنكي · اسم البنك · ملاحظات',
  read.address === 'صنعاء - شارع حدة' &&
    read.nationalId === employee.nationalId &&
    read.bank?.bankNo === '123456' &&
    read.bank?.bankName === 'بنك اليمن' &&
    read.notes === 'موظف تحقق',
);
check('الآيبان يردّ مقنّعاً', read.bank?.iban === 'SA03********7519', read.bank?.iban);
check('الإدارة تُقرأ من القسم ولا تُخزَّن مرتين', read.managementId === management.id && read.managementName === management.name && read.sectionId === section.id, `${read.managementName} / ${read.sectionName}`);

console.log('\n3. رقم الحساب — حساب باسم الموظف تحت «موظفين الفرع الرئيسي»');

const root = (await get('/accounts?q=2241')).find((row) => row.code === '2241');
check('الشجرة تحمل جذر الموظفين (2241)', Boolean(root), root?.nameAr);

const account = await get(`/accounts/${employee.employeeAccountId}`);
check(
  'SaveAccounts — حساب باسم الموظف تحت الجذر، قابل للترحيل',
  account.parentId === root.id && account.nameAr === employee.name && account.code.startsWith('2241') && account.isPostable === true,
  `${account.code} ${account.nameAr}`,
);
check('رقم الحساب يظهر على البطاقة', read.accountCode === account.code, read.accountCode);

const renamed = await patch(`/hrm/employees/${employee.id}`, { name: `${employee.name} بعد التعديل` });
const renamedAccount = await get(`/accounts/${employee.employeeAccountId}`);
check('تغيير الاسم يغيّر اسم الحساب', renamedAccount.nameAr === renamed.name, renamedAccount.nameAr);

const second = await post('/hrm/employees', card('2'));
check('كل موظف يأخذ الرقم التالي', Number(second.accountCode) === Number(employee.accountCode) + 1, `${employee.accountCode} → ${second.accountCode}`);

console.log('\n4. إجمالي الرواتب والمستحقات');

check('المجموع = الراتب الأساسي + ستة بدلات', money(second.totalSalary) === '7400.00', money(second.totalSalary));
const afterRaise = await patch(`/hrm/employees/${second.id}`, { salaryComponents: { basic: '6000', housing: '1000', transport: '500', food: '300', medical: '200', fixedBonus: '250', other: '150' } });
check('يتغيّر بتغيّر البدلات', money(afterRaise.totalSalary) === '8400.00', money(afterRaise.totalSalary));

console.log('\n5. قائمة الموظفين — البحث بالاسم وبالرقم');

const byName = await get(`/hrm/employees?q=${encodeURIComponent(employee.name)}`);
check('البحث بالاسم', byName.some((row) => row.id === employee.id), `${byName.length} صف`);
const byNumber = await get(`/hrm/employees?q=${encodeURIComponent(second.employeeNo)}`);
check('البحث بالرقم', byNumber.some((row) => row.id === second.id), second.employeeNo);
const inManagement = await get(`/hrm/employees?department_id=${management.id}`);
check(
  'التضييق بالإدارة يجلب موظفي أقسامها',
  inManagement.some((row) => row.id === employee.id) && inManagement.some((row) => row.id === second.id),
  `${inManagement.length} صف`,
);

console.log('\n6. الحذف — «لا يمكن حذف موظف مرتبط بمستخدم»');

const memberships = await get('/memberships');
const membership = (memberships.data ?? memberships)[0];
const linked = await patch(`/hrm/employees/${second.id}`, { membershipId: membership.id });
check('ربط الموظف بمستخدم', linked.id === second.id, membership.displayName ?? membership.id);
const refusedDelete = await refused('delete', `/hrm/employees/${second.id}`);
check('الرفض بعبارة الديسكتوب', refusedDelete.status === 409 && refusedDelete.detail === 'لا يمكن حذف موظف مرتبط بمستخدم', `${refusedDelete.status} ${refusedDelete.code}`);

await patch(`/hrm/employees/${second.id}`, { membershipId: null });
check('فكّ الارتباط', (await get(`/hrm/employees/${second.id}`)).membershipId === null);
const deleted = await del(`/hrm/employees/${second.id}`);
check('حذف موظف بلا ارتباط', deleted.id === second.id && (await refused('get', `/hrm/employees/${second.id}`)).status === 404);

const sectionWithEmployees = await refused('delete', `/hrm/departments/${section.id}`);
check('لا يمكن حذف قسم عليه موظفون', sectionWithEmployees.status === 409 && sectionWithEmployees.code === 'DEPARTMENT_IN_USE', sectionWithEmployees.detail);

// ---------------------------------------------------------------------------
// 7. 🎁 الحوافز والجزاءات — `Form_WPF/frmEmpSalaryAddSub.xaml` «إدخال الحوافز والخصومات
// للموظفين». The window's grid prints `الموظف · النوع · المبلغ · التاريخ`, its four
// refusals are `ValidateInputs` L566, its «رقم السند» is `LoadNextNumber` L225, and its
// note writes itself when the clerk leaves it empty (L665).
// ---------------------------------------------------------------------------
console.log('\n7. 🎁 الحوافز والجزاءات — إدخال الحوافز والخصومات للموظفين');

const today = new Date().toISOString().slice(0, 10);
const madeAdjustments = [];
const removedDrafts = [];
const types = await get('/hrm/adjustment-types');
const bonusType = types.find((row) => row.code === 'bonus');
const deductionType = types.find((row) => row.code === 'deduction');
const advanceType = types.find((row) => row.code === 'advance');
check(
  'الأنواع الثلاثة — مكافأة إضافة، وخصم وسلفة خصمان',
  bonusType?.name === 'مكافأة' && bonusType?.kind === 'addition' &&
    deductionType?.name === 'خصم' && deductionType?.kind === 'deduction' &&
    advanceType?.name === 'سلفة' && advanceType?.kind === 'deduction',
  types.map((row) => `${row.name}/${row.kind}`).join(' · '),
);

const nobody = await refused('post', '/hrm/adjustments', { employeeId: '00000000-0000-0000-0000-000000000000', typeId: bonusType.id, valueText: '100', startsOn: today });
check('يجب اختيار موظف', nobody.detail === 'يجب اختيار موظف', `${nobody.status} ${nobody.code}`);
const noType = await refused('post', '/hrm/adjustments', { employeeId: employee.id, valueText: '100', startsOn: today });
check('يجب اختيار نوع الإجراء', noType.detail === 'يجب اختيار نوع الإجراء', `${noType.status} ${noType.code}`);
const noValue = await refused('post', '/hrm/adjustments', { employeeId: employee.id, typeId: bonusType.id, valueText: '0', startsOn: today, subFromSalary: true });
check('يجب إدخال مبلغ', noValue.detail === 'يجب إدخال مبلغ', `${noValue.status} ${noValue.code}`);
const noLocation = await refused('post', '/hrm/adjustments', { employeeId: employee.id, typeId: advanceType.id, valueText: '100', startsOn: today, subFromSalary: false });
check('يجب اختيار الصندوق أو البنك', noLocation.detail === 'يجب اختيار الصندوق أو البنك', `${noLocation.status} ${noLocation.code}`);

const noteA = await post('/hrm/adjustments', { employeeId: employee.id, typeId: bonusType.id, valueText: '150', startsOn: today, subFromSalary: true });
const noteB = await post('/hrm/adjustments', { employeeId: employee.id, typeId: advanceType.id, valueText: '150', startsOn: today, subFromSalary: true });
madeAdjustments.push(noteA.id, noteB.id);
check('رقم السند يتسلسل', Number(noteB.number) === Number(noteA.number) + 1, `${noteA.number} → ${noteB.number}`);
check('الملاحظة تُكتب نفسها', noteA.reason === `مكافأة للموظف ${renamed.name}` && noteB.reason === `سلفة للموظف ${renamed.name}`, noteA.reason);

const expenseAccount = (await get('/accounts?q=3122001')).find((row) => row.code === '3122001');
const till = (await get('/cash-locations')).find((row) => row.kind === 'safe' && row.accountId);
const advance = await post('/hrm/adjustments', {
  employeeId: employee.id,
  typeId: advanceType.id,
  valueText: '500',
  startsOn: today,
  subFromSalary: false,
  paymentMethod: 'cash',
  cashLocationId: till.id,
});
madeAdjustments.push(advance.id);
check('سلفة تُصرف الآن تصبح مرحَّلة', advance.status === 'approved' && Boolean(advance.journalEntryId), `${advance.status} · قيد ${advance.journalEntryId ? 'نعم' : 'لا'}`);

const advanceLines = await get(`/journal-entries/${advance.journalEntryId}`);
const advanceLinesList = advanceLines.lines ?? [];
check(
  'قيد السلفة — مدين حساب الموظف، دائن الصندوق',
  advanceLinesList.some((line) => line.accountId === employee.employeeAccountId && Number(line.debit) === 500) &&
    advanceLinesList.some((line) => line.accountId === till.accountId && Number(line.credit) === 500),
  advanceLinesList.map((line) => `${Number(line.debit) > 0 ? 'مدين' : 'دائن'} ${Number(line.debit) || Number(line.credit)}`).join(' · '),
);

if (expenseAccount) {
  const bonus = await post('/hrm/adjustments', {
    employeeId: employee.id,
    typeId: bonusType.id,
    valueText: '300',
    startsOn: today,
    subFromSalary: false,
    paymentMethod: 'cash',
    cashLocationId: till.id,
  });
  const bonusLines = (await get(`/journal-entries/${bonus.journalEntryId}`)).lines ?? [];
  check(
    'قيد المكافأة — مدين «راتب أساسي»، دائن الصندوق',
    bonusLines.some((line) => line.accountId === expenseAccount.id && Number(line.debit) === 300) &&
      bonusLines.some((line) => line.accountId === till.accountId && Number(line.credit) === 300),
    `${expenseAccount.code} ${expenseAccount.nameAr}`,
  );
  madeAdjustments.push(bonus.id);
}

const onSalary = await post('/hrm/adjustments', { employeeId: employee.id, typeId: deductionType.id, valueText: '120', startsOn: today, subFromSalary: true });
madeAdjustments.push(onSalary.id);
check('ما يخصم من الراتب مسودة بلا قيد', onSalary.status === 'draft' && onSalary.journalEntryId === null, onSalary.status);
const approvedAdjustment = await post(`/hrm/adjustments/${onSalary.id}/approve`, {});
check('الاعتماد يدخلها مسير الرواتب', approvedAdjustment.status === 'approved', approvedAdjustment.status);

const monthPreview = await post('/hrm/payroll/preview', { yearMonth: today.slice(0, 7) });
const previewLine = (monthPreview.lines ?? []).find((row) => row.employeeId === employee.id);
check('تظهر في استحقاق الشهر', Number(previewLine?.deductions ?? 0) >= 120, String(previewLine?.deductions ?? '—'));

const postedRefusal = await refused('delete', `/hrm/adjustments/${advance.id}`);
check('لا يمكن حذف حركة مرحَّلة', postedRefusal.status === 409 && postedRefusal.code === 'ADJUSTMENT_POSTED', postedRefusal.detail);
const deletedDraft = await del(`/hrm/adjustments/${onSalary.id}`);
check('حذف مسودة', deletedDraft.deleted === true && (await refused('get', `/hrm/adjustments/${onSalary.id}`)).status === 404);

const listedAdjustments = await get(`/hrm/adjustments?employee_id=${employee.id}`);
check('القائمة تحمل أسماء الموظف والنوع والصندوق', listedAdjustments.every((row) => row.employeeName && row.typeName), `${listedAdjustments.length} صف`);

const usedType = await refused('delete', `/hrm/adjustment-types/${bonusType.id}`);
check('لا يمكن حذف نوع مستخدم في حركات', usedType.status === 409 && usedType.detail === 'لا يمكن حذف نوع مستخدم في حركات', `${usedType.status} ${usedType.code}`);

// ---------------------------------------------------------------------------
// 8. 💵 دفع الرواتب — `Form_WPF/frmSalaryPay.xaml` («دفع الرواتب»). One إذن صرف per
// employee per month, carrying `رقم الإذن` · `الموظف` · `الشهر`/`السنة` ·
// `طريقة الدفع` · `الصندوق/البنك` · `الراتب الأساسي` · `بدل سكن` · `بدل مواصلات` ·
// `💰 الحوافز` · `🔴 الخصومات` · `💵 الصافي` · `ملاحظات`, and a search grid narrowed by
// «رقم الإذن», «الموظف» and `من تاريخ`/`إلى تاريخ`.
// ---------------------------------------------------------------------------
console.log('\n8. 💵 دفع الرواتب — إذن صرف راتب');

const paidIds = [];
const branchId = (await get('/branches'))[0]?.id;
const pay = (body) => post('/hrm/salary-payments', body);

const noBranch = await refused('post', '/hrm/salary-payments', { employeeId: employee.id, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: till.id });
check('يجب اختيار الفرع.', noBranch.detail === 'يجب اختيار الفرع.', `${noBranch.status} ${noBranch.code}`);
const noEmployee = await refused('post', '/hrm/salary-payments', { branchId, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: till.id });
check('يجب اختيار الموظف.', noEmployee.detail === 'يجب اختيار الموظف.', `${noEmployee.status} ${noEmployee.code}`);
const noTill = await refused('post', '/hrm/salary-payments', { employeeId: employee.id, branchId, yearMonth: today.slice(0, 7), paymentDate: today });
check('يجب اختيار الصندوق.', noTill.detail === 'يجب اختيار الصندوق.', `${noTill.status} ${noTill.code}`);

const bare = await post('/cash-locations', { branchId, kind: 'safe', name: `صندوق بلا حساب ${stamp}` });
const noAccount = await refused('post', '/hrm/salary-payments', { employeeId: employee.id, branchId, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: bare.id });
check('لم يتم العثور على الحساب المقابل للصندوق.', noAccount.detail === 'لم يتم العثور على الحساب المقابل للصندوق.', `${noAccount.status} ${noAccount.code}`);

const broke = await post('/hrm/employees', { employeeNo: `VRP${stamp}`, name: `موظف بلا راتب ${stamp}`, branchId });
const nothingDue = await refused('post', '/hrm/salary-payments', { employeeId: broke.id, branchId, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: till.id });
check('لا يوجد رواتب مستحقة للموظف.', nothingDue.detail === 'لا يوجد رواتب مستحقة للموظف.', `${nothingDue.status} ${nothingDue.code}`);

// «رقم الإذن» is `MAX(id) + 1` over every إذن on the books — a second run of this script
// continues the sequence rather than starting from one, so the check is relative.
const numbersBefore = (await get('/hrm/salary-payments')).map((row) => Number(row.number) || 0);
const highestBefore = numbersBefore.length ? Math.max(...numbersBefore) : 0;
const first = await pay({ employeeId: employee.id, branchId, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: till.id });
paidIds.push(first.id);
// A soft-deleted إذن keeps its number — `LoadNxtNo` is `MAX(id)` over every row, deleted
// ones included — so the next إذن continues past the last number ever used rather than
// reusing a gap. What we can check from outside is that it follows everything on the books.
check('رقم الإذن يتبع ما على الدفتر', Number(first.number) > highestBefore, `${highestBefore} → ${first.number}`);
check(
  'المبلغ = الراتب الأساسي + بدل سكن + بدل مواصلات + بدلات أخرى − الخصومات',
  Number(first.net) === Number(first.basic) + Number(first.housing) + Number(first.transport) + Number(first.otherAllowances) + Number(first.additions) - Number(first.deductions),
  `${first.net} = ${first.basic} + ${first.housing} + ${first.transport} + ${first.otherAllowances} + ${first.additions} − ${first.deductions}`,
);
check('الصافي يطابق مسيّر الشهر', Number(first.net) === Number((await post('/hrm/payroll/preview', { yearMonth: today.slice(0, 7) })).lines.find((line) => line.employeeId === employee.id)?.net ?? 0), first.net);

const duplicate = await refused('post', '/hrm/salary-payments', { employeeId: employee.id, branchId, yearMonth: today.slice(0, 7), paymentDate: today, cashLocationId: till.id });
check('لقد تم دفع راتب الموظف سابقاً.', duplicate.status === 409 && duplicate.detail === 'لقد تم دفع راتب الموظف سابقاً.', `${duplicate.status} ${duplicate.code}`);

const paymentLines = (await get(`/journal-entries/${first.journalEntryId}`)).lines ?? [];
check(
  'سند الصرف — مدين حساب الموظف، دائن الصندوق',
  paymentLines.some((line) => line.accountId === employee.employeeAccountId && Number(line.debit) === Number(first.net)) &&
    paymentLines.some((line) => line.accountId === till.accountId && Number(line.credit) === Number(first.net)),
  paymentLines.map((line) => `${Number(line.debit) > 0 ? 'مدين' : 'دائن'} ${Number(line.debit) || Number(line.credit)}`).join(' · '),
);

// Another month of the seeded fiscal year — an إذن cannot be paid into a month no open
// period covers, and the seeded calendar is the current year only.
const nextMonth =
  (await get('/fiscal-periods'))
    .filter((row) => row.status === 'open')
    .map((row) => String(row.startDate ?? '').slice(0, 7))
    .find((value) => value && value !== today.slice(0, 7)) ?? today.slice(0, 7);
const nextPayment = await pay({ employeeId: employee.id, branchId, yearMonth: nextMonth, paymentDate: `${nextMonth}-01`, cashLocationId: till.id, notes: 'صرف نقداً من الخزينة' });
paidIds.push(nextPayment.id);
check('رقم الإذن يتسلسل', Number(nextPayment.number) === Number(first.number) + 1, `${first.number} → ${nextPayment.number}`);
check('الشهر والسنة على الإذن', nextPayment.month === nextMonth.slice(5) && nextPayment.year === nextMonth.slice(0, 4), `${nextPayment.month}/${nextPayment.year}`);

const listedPayments = await get('/hrm/salary-payments');
check('🔍 البحث — الأسماء والملاحظات', listedPayments.every((row) => row.employeeName && row.branchName) && listedPayments.some((row) => row.notes === 'صرف نقداً من الخزينة'), `${listedPayments.length} صف`);
const payByNumber = await get(`/hrm/salary-payments?number=${nextPayment.number}`);
check('البحث برقم الإذن', payByNumber.length === 1 && payByNumber[0].id === nextPayment.id, `${payByNumber.length} صف`);
const payByEmployee = await get(`/hrm/salary-payments?employee_id=${employee.id}`);
check('البحث بالموظف', payByEmployee.length >= 2 && payByEmployee.every((row) => row.employeeId === employee.id), `${payByEmployee.length} صف`);
const payByDate = await get(`/hrm/salary-payments?from=${today}&to=${today}`);
check('البحث بالفترة', payByDate.every((row) => row.paymentDate === today), `${payByDate.length} صف`);

const postedPayment = await refused('delete', `/hrm/salary-payments/${nextPayment.id}`);
check('لا يمكن حذف إذن مرحَّل', postedPayment.status === 409 && postedPayment.code === 'SALARY_PAYMENT_POSTED', postedPayment.detail);

const draft = await pay({ employeeId: employee.id, branchId, yearMonth: '2030-11', paymentDate: '2030-11-01', cashLocationId: till.id, postVoucher: false });
check('إذنٌ بلا صرف يبقى بلا سند', draft.voucherId === null && draft.journalEntryId === null, `${draft.voucherId} / ${draft.journalEntryId}`);
removedDrafts.push(draft.id);

// ---------------------------------------------------------------------------
// 9. 📄 كشف حساب موظف — `Form_WPF/frmEmpAccountGet.xaml` («كشف حساب موظف»). The
// window's own query (`ShowAccount`, L226) over the employee's account, its four tiles
// (`UpdateSummary`, L318) and its filters `اسم الموظف` · `الفرع` · `الفترة الزمنية`.
// Everything here is a read — the movements are the سلفة of section 7 and the إذنات صرف
// of section 8, so the screen is verified against documents the script already made.
// ---------------------------------------------------------------------------
console.log('\n9. 📄 كشف حساب موظف — حركة حساب الموظف');

const statementPath = (query) => `/hrm/employee-statement?${query}`;
// Section 3 renames the employee and its account follows the name, so the statement is
// checked against the card as it stands now, not as it was created.
const currentEmployee = await get(`/hrm/employees/${employee.id}`);
const full = await get(statementPath(`employee_id=${employee.id}&full_period=1`));
const movements = (full.rows ?? []).filter((row) => row.entryId !== null);

check('👤 اسم الموظف ورقم حسابه', full.employee?.name === currentEmployee.name && Boolean(full.employee?.accountCode), `${full.employee?.employeeNo} ${full.employee?.accountCode}`);
check('📊 تفاصيل كشف الحساب — سطرٌ لكل قيد مرحَّل', movements.length >= 3 && movements.every((row) => row.entryNumber), `${movements.length} صف`);
check('كل سطر يحمل الموظف والفرع', movements.every((row) => row.employee === currentEmployee.name && row.branchName), movements[0]?.branchName ?? '—');

const debitSum = movements.reduce((sum, row) => sum + Number(row.debit), 0);
const creditSum = movements.reduce((sum, row) => sum + Number(row.credit), 0);
check('💳 إجمالي المدين = مجموع العمود', Number(full.summary.totalDebit) === debitSum, `${full.summary.totalDebit}`);
check('💵 إجمالي الدائن = مجموع العمود', Number(full.summary.totalCredit) === creditSum, `${full.summary.totalCredit}`);
// `UpdateSummary` — |مدين − دائن| على جانبٍ واحد، والآخر صفر.
const balance = Number(full.summary.balanceDebit) - Number(full.summary.balanceCredit);
check(
  '⚖️ الرصيد على جانبٍ واحد',
  (Number(full.summary.balanceDebit) === 0 || Number(full.summary.balanceCredit) === 0) &&
    Math.abs(balance) === Math.abs(debitSum - creditSum),
  `${full.summary.balanceDebit} / ${full.summary.balanceCredit}`,
);
const lastRow = movements[movements.length - 1];
check(
  'الرصيد المتحرك ينتهي عند الرصيد',
  Math.abs(Number(lastRow?.runningBalance ?? 0)) === Math.abs(balance),
  `${lastRow?.runningBalance} ${lastRow?.balanceStatus}`,
);

const noEmployeeStatement = await refused('get', statementPath('full_period=1'));
check('اختر موظف.', noEmployeeStatement.status === 422 && noEmployeeStatement.detail === 'اختر موظف', `${noEmployeeStatement.status} ${noEmployeeStatement.code}`);
const unknownEmployee = await refused('get', statementPath('employee_id=00000000-0000-0000-0000-000000000000&full_period=1'));
check('موظفٌ من مستأجر آخر — «اختر موظف»', unknownEmployee.status === 422 && unknownEmployee.code === 'EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED', unknownEmployee.detail);

const emptyPeriod = await get(statementPath(`employee_id=${employee.id}&from=2000-01-01&to=2000-01-31`));
check('📅 الفترة الزمنية — فترةٌ بلا حركات', (emptyPeriod.rows ?? []).filter((row) => row.entryId !== null).length === 0, `${(emptyPeriod.rows ?? []).length} صف`);
const todayPeriod = await get(statementPath(`employee_id=${employee.id}&from=${today}&to=${today}`));
check('اليوم الأخير داخل الفترة', (todayPeriod.rows ?? []).filter((row) => row.entryId !== null).length >= 1, `${(todayPeriod.rows ?? []).length} صف`);

// 🏢 الفرع — `chkAllBranches` off means one branch only. The seeded tenant has a single
// branch and every حركة here belongs to it, so the check brings a second branch of its
// own: the screen has to show nothing for it. Section 10 deletes it again.
const otherBranch = await post('/branches', { code: `VRB${stamp}`, nameAr: `فرع التحقق ${stamp}` });
const onOtherBranch = await get(statementPath(`employee_id=${employee.id}&branch_id=${otherBranch.id}&full_period=1`));
check('🏢 الفرع — فرعٌ بلا حركات للموظف', (onOtherBranch.rows ?? []).filter((row) => row.entryId !== null).length === 0, otherBranch.nameAr);
const onBranch = await get(statementPath(`employee_id=${employee.id}&branch_id=${branchId}&full_period=1`));
check('كل الفروع يحوي حركات الفرع', (onBranch.rows ?? []).filter((row) => row.entryId !== null).length === movements.length, `${(onBranch.rows ?? []).length} صف`);

const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
const carried = await get(statementPath(`employee_id=${employee.id}&from=${tomorrow}&to=${tomorrow}`));
check(
  'الرصيد السابق يُرحَّل عند طلب فترة تبدأ بعد أول حركة',
  (carried.rows ?? []).length === 1 && (carried.rows ?? [])[0].entryId === null && (carried.rows ?? [])[0].entryType === 'رصيد سابق',
  (carried.rows ?? [])[0]?.description ?? '—',
);
const hidden = await get(statementPath(`employee_id=${employee.id}&from=${tomorrow}&to=${tomorrow}&hide_previous_balance=1`));
check('عدم إظهار الرصيد السابق', (hidden.rows ?? []).length === 0, `${(hidden.rows ?? []).length} صف`);

const detailed = await get(statementPath(`employee_id=${employee.id}&full_period=1&detailed=1`));
const detailedRows = detailed.rows ?? [];
check('📑 تفصيلي — سطرٌ لكل سطر قيد لا لكل قيد', detailedRows.length >= movements.length, `${detailedRows.length} صف مقابل ${movements.length} تجميعي`);
check(
  'البيان في التفصيلي من سطر القيد لا من القيد',
  detailedRows.some((row) => !movements.some((movement) => movement.description === row.description)),
  detailedRows[0]?.description ?? '—',
);

// ---------------------------------------------------------------------------
// 10. 📈 حركات الموظف — `Form_WPF/frmEmpInvs.xaml` («مبيعات ومشتريات موظف خلال
// الفترة»). `ShowResult` (L226) reads `Inv ⋈ Inv_Sub` on `Inv.sales_emp` over
// `date >= @date1 AND date <= @date2` with `IS_Deleted=0`, one row per line. The cloud
// carries that link as `sales_invoices.salesman_id`, so this section sells something —
// a real posted فاتورة and a real مرتجع — and then reads them back through the screen.
// ---------------------------------------------------------------------------
console.log('\n10. 📈 حركات الموظف — مبيعات الموظف خلال الفترة');

const warehouseId = (await get('/warehouses'))[0]?.id;
/**
 * 👤 مندوب التحقق — an employee who has appeared on a فاتورة cannot be deleted
 * («لا يمكن حذف موظف مرتبط بفواتير»), so the script keeps one salesman of its own and
 * reuses it on the next run instead of leaving a new one behind every time.
 */
const salesEmployee =
  (await get('/hrm/employees')).find((row) => String(row.employeeNo).startsWith('VRM')) ??
  (await post('/hrm/employees', { employeeNo: `VRM${stamp}`, name: `مندوب التحقق ${stamp}`, branchId }));

const movementCategory = await post('/organization/catalog/categories', { code: `VRC${stamp}`, nameAr: `تصنيف التحقق ${stamp}` });
const movementUnit = await post('/organization/catalog/units', { code: `VRU${stamp}`, nameAr: `وحدة التحقق ${stamp}` });
const movementItem = await post('/organization/catalog/items', {
  sku: `VRI${stamp}`,
  nameAr: `صنف التحقق ${stamp}`,
  categoryId: movementCategory.id,
  baseUnitId: movementUnit.id,
  salePrice: '100',
});
// بضاعة أول المدة — a فاتورة cannot be posted out of a warehouse that has none, so the
// sale below is what proves the receipt landed.
await post('/inventory/ledger/record', {
  lines: [{ itemId: movementItem.id, warehouseId, qty: '1000', unitCost: '40', direction: 'in', docType: 'opening', docId: '00000000-0000-0000-0000-000000000001' }],
});

const sell = async (body) => {
  const created = await post('/sales/invoices', { cashCustomerName: 'عميل نقدي', ...body });
  return post(`/sales/invoices/${created.id}/post`, {});
};
const sold = await sell({
  branchId,
  warehouseId,
  salesmanId: salesEmployee.id,
  lines: [{ itemId: movementItem.id, quantity: '3', unitPrice: '100', taxRate: '0' }],
});
check('فاتورة بيع مرحَّلة باسم الموظف', sold.status === 'posted' && Number(sold.total) === 300, `${sold.number} ${sold.total}`);

const returnDraft = await post(`/sales/invoices/${sold.id}/return`, {
  branchId,
  warehouseId,
  salesmanId: salesEmployee.id,
  cashCustomerName: 'عميل نقدي',
  lines: [{ itemId: movementItem.id, quantity: '1', unitPrice: '100', taxRate: '0' }],
});
const soldReturn = await post(`/sales/invoices/${returnDraft.id}/post`, {});
check('مرتجع بيع مرحَّل باسم الموظف', soldReturn.status === 'posted' && Number(soldReturn.total) === 100, `${soldReturn.number} ${soldReturn.total}`);

const movementsPath = (query) => `/hrm/employee-movements?${query}`;
const movementRows = await get(movementsPath(`employee_id=${salesEmployee.id}`));
const movementLines = movementRows.rows ?? [];
check('📋 بيانات الحركات — سطرٌ لكل سطر فاتورة', movementLines.length === 2, `${movementLines.length} صف`);
check(
  'نوع الحركة — «فاتورة بيع» و«فاتورة مرتجع بيع»',
  movementLines.some((row) => row.movementType === 'فاتورة بيع') && movementLines.some((row) => row.movementType === 'فاتورة مرتجع بيع'),
  movementLines.map((row) => row.movementType).join(' · '),
);
check(
  '📦 الصنف · الكمية · 💵 السعر · 💰 الإجمالي',
  movementLines.every((row) => row.itemName === movementItem.nameAr && Number(row.unitPrice) === 100) &&
    movementLines.some((row) => row.quantity === '3.0000' && row.lineTotal === '300.0000'),
  `${movementLines[0]?.itemName} ${movementLines[0]?.quantity} × ${movementLines[0]?.unitPrice}`,
);
// `txtSum` — the desktop adds `tot_net` once per line, so a three-line invoice is counted
// three times; the cloud counts each invoice once.
check('💰 الإجمالي = المبيعات − المرتجع', Number(movementRows.summary.total) === 200 && Number(movementRows.summary.salesTotal) === 300 && Number(movementRows.summary.returnsTotal) === 100, `${movementRows.summary.total} = 300 − 100`);
check(
  'المبيعات وحدها، والمرتجع وحده',
  (await get(movementsPath(`employee_id=${salesEmployee.id}&movement_type=sales`))).rows.length === 1 &&
    (await get(movementsPath(`employee_id=${salesEmployee.id}&movement_type=returns`))).rows.length === 1,
);

const noEmployeeMovements = await refused('get', movementsPath('from=2000-01-01&to=2000-01-31'));
check('اختر موظف.', noEmployeeMovements.status === 422 && noEmployeeMovements.detail === 'اختر موظف', `${noEmployeeMovements.status} ${noEmployeeMovements.code}`);
const movementsOutside = await get(movementsPath(`employee_id=${salesEmployee.id}&from=2000-01-01&to=2000-01-31`));
check('📅 من تاريخ / إلى تاريخ — فترةٌ بلا حركات', (movementsOutside.rows ?? []).length === 0);
const movementsInside = await get(movementsPath(`employee_id=${salesEmployee.id}&from=${today}&to=${today}`));
check('اليوم الأخير داخل الفترة', (movementsInside.rows ?? []).length === 2, `${(movementsInside.rows ?? []).length} صف`);
const movementsOtherBranch = await get(movementsPath(`employee_id=${salesEmployee.id}&branch_id=${otherBranch.id}`));
check('🏢 الفرع — فرعٌ بلا حركات', (movementsOtherBranch.rows ?? []).length === 0, otherBranch.nameAr);
const everyEmployee = await get(movementsPath('all_employees=1'));
check('الكل — كل الموظفين الذين لهم حركات', (everyEmployee.rows ?? []).length >= 2, `${(everyEmployee.rows ?? []).length} صف`);

// ---------------------------------------------------------------------------
// 11. 📊 تقرير الرواتب — `Form_WPF/frmRptSalary.xaml` («💼 تقرير الرواتب»). The window
// reads `SalaryPay` with `IS_Deleted=0` — the cloud's `salary_payments`, the إذن صرف of
// section 8 — narrowed by `الشهر:`/`السنة:` unless «كل الفترة» is on.
// ---------------------------------------------------------------------------
console.log('\n11. 📊 تقرير الرواتب — كل إذن صرف عن كل شهر');

const salaryPath = (query) => `/hrm/reports/salary${query ? `?${query}` : ''}`;
const salaryReport = await get(salaryPath(''));
const salaryRows = salaryReport.rows ?? [];
check('💼 بيانات الرواتب — إذنٌ لكل صف', salaryRows.length >= 3 && salaryRows.every((row) => row.number && row.employeeName), `${salaryRows.length} صف`);
check('«كل الفترة» هي الأصل', salaryReport.allPeriod === true && salaryRows.length === (await get(salaryPath('all_period=true'))).rows.length);
check(
  '👁️ عرض — الصفّ يحمل إذن الصرف نفسه',
  salaryRows.some((row) => row.id === first.id) && salaryRows.some((row) => row.id === nextPayment.id),
  `${first.number} · ${nextPayment.number}`,
);

const monthRows = (await get(salaryPath(`all_period=false&year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`))).rows ?? [];
check('الشهر والسنة يضيّقان التقرير', monthRows.length >= 1 && monthRows.every((row) => row.yearMonth === today.slice(0, 7)), `${monthRows.length} صف`);
check('«رقم السند» و«الشهر» و«السنة»', monthRows.some((row) => row.id === first.id && row.month === today.slice(5, 7) && row.year === today.slice(0, 4)), `${first.number}`);

// `gross = tot_salary + Houses + Travel + salary_add` (L104) — plus the four allowances
// the window has no box for, so الإجمالي − الخصومات = الصافي على كل صف.
check(
  '💰 الإجمالي − الخصومات = 💵 صافي الراتب',
  salaryRows.every((row) => Number(row.gross) - Number(row.deductions) === Number(row.net)),
  salaryRows.map((row) => `${row.gross} − ${row.deductions} = ${row.net}`)[0] ?? '—',
);
const netSum = salaryRows.reduce((sum, row) => sum + Number(row.net), 0);
check('💰 إجمالي الرواتب = مجموع الصافي', Number(salaryReport.summary.total) === netSum, `${salaryReport.summary.total}`);
const draftRow = salaryRows.find((row) => row.id === draft.id);
check('إذنٌ بلا صرف يظهر بلا سند', Boolean(draftRow) && draftRow?.posted === false && draftRow?.voucherNumber === null, draftRow?.number ?? '—');

// ---------------------------------------------------------------------------
// Cleanup — what this run created, removed again.
// ---------------------------------------------------------------------------
// Only what this run created — the demo tenant's own حوافز must survive a verification.
for (const id of madeAdjustments) await refused('delete', `/hrm/adjustments/${id}`);
// The إذن that carries no سند صرف goes; the ones that paid a salary stay, and the script
// says so rather than quietly failing to clean up after itself.
for (const id of removedDrafts) await refused('delete', `/hrm/salary-payments/${id}`);
for (const row of (await get('/hrm/employees')).filter((entry) => String(entry.employeeNo) === `VRP${stamp}`)) await refused('delete', `/hrm/employees/${row.id}`);
for (const row of (await get('/hrm/employees')).filter((entry) => String(entry.employeeNo).startsWith('VR'))) await refused('delete', `/hrm/employees/${row.id}`);
for (const row of (await get('/hrm/departments')).filter((entry) => String(entry.code).startsWith('VR'))) await refused('delete', `/hrm/departments/${row.id}`);
for (const row of (await get('/branches')).filter((entry) => String(entry.code ?? '').startsWith('VRB'))) await refused('delete', `/branches/${row.id}`);
// A posted فاتورة is a document: it is voided, not deleted, and the stock follows it back.
for (const invoice of [sold, soldReturn]) await refused('post', `/sales/invoices/${invoice.id}/void`, { reason: 'تحقق المرحلة 08' });
await refused('delete', `/organization/catalog/items/${movementItem.id}`);
// The مندوب of section 10 stays: «لا يمكن حذف موظف مرتبط بفواتير». Everything else goes.
const remaining = (await get('/hrm/employees')).filter((entry) => String(entry.employeeNo).startsWith('VR') && !String(entry.employeeNo).startsWith('VRM'));
check('لا يبقى أثر بعد التشغيل', remaining.length === 0, `${remaining.length} صف`);
const keptSalesman = (await get('/hrm/employees')).filter((entry) => String(entry.employeeNo).startsWith('VRM'));
check('يبقى مندوب التحقق ما بقيت فواتيره', keptSalesman.length === 1, `${keptSalesman[0]?.employeeNo ?? '—'}`);
const remainingBranches = (await get('/branches')).filter((entry) => String(entry.code ?? '').startsWith('VRB'));
check('حُذف فرع التحقق', remainingBranches.length === 0, `${remainingBranches.length} صف`);
const voidedInvoices = await Promise.all([sold.id, soldReturn.id].map((id) => get(`/sales/invoices/${id}`)));
check('أُلغيت فواتير التحقق', voidedInvoices.every((row) => row.status === 'voided'), voidedInvoices.map((row) => `${row.number} ${row.status}`).join(' · '));
const leftoverMovements = await get(movementsPath(`employee_id=${salesEmployee.id}`));
check('لا حركة بعد الإلغاء', (leftoverMovements.rows ?? []).length === 0, `${(leftoverMovements.rows ?? []).length} صف`);
const remainingAdjustments = (await get('/hrm/adjustments')).filter((row) => madeAdjustments.includes(row.id));
check('تبقى الحركات المرحَّلة وحدها', remainingAdjustments.every((row) => row.status === 'approved' && row.journalEntryId), `${remainingAdjustments.length} صف`);
const remainingDrafts = (await get('/hrm/salary-payments')).filter((row) => removedDrafts.includes(row.id));
check('حُذف الإذن المسوَّد', remainingDrafts.length === 0, `${remainingDrafts.length} صف`);

console.log(failures === 0 ? '\n✔ Phase 08 — 👤 بطاقة الموظف · 🏢 الإدارات والأقسام · 🎁 الحوافز والجزاءات · 💵 دفع الرواتب · 📄 كشف حساب موظف · 📈 حركات الموظف · 📊 تقرير الرواتب verified' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
