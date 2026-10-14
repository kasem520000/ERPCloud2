#!/usr/bin/env node
/**
 * Live verification of Phase 10 part five — 📒 تقارير المحاسبة
 * (`Form_WPF/frmRptBalances` · `frmRptEntries` · `frmRptIncomeStatement` ·
 * `frmRptCostCenter` · `frmTaxRptPeriod`) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير الستة بأعمدة الديسكتوب وبطاقاته
 *   2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط
 *   3. 🧾 الوثائق — ستة حسابات · ثلاثة مراكز تكلفة · أربعة قيود · سند قبض · سند صرف
 *   4. 📊 أرصدة الحسابات — الافتتاحي والحركة والختامي على وجهين
 *   5. 📒 القيود اليومية — السجل ونوع القيد وحالته ورقم المستند
 *   6. 🧾 تفاصيل القيد — السطور وإجمالي المدين والدائن
 *   7. 📈 أرباح وخسائر حسابات رئيسية — التجميع على الأب وقيمة المخزون
 *   8. 📂 تقرير مراكز التكلفة — تجميعي وتفصيلي
 *   9. 🧾 الإقرار الضريبي — البنود الستة وصافي الضريبة و«ربع سنة» و«شهري»
 *  10. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر
 *  11. 🖨️ طباعة وتصدير — CSV وXLSX
 *  12. 🧹 التنظيف — القيود تُعكس والسندات تُلغى، وما لا رجعة فيه يُعلَن
 *
 * Re-runnable and non-destructive: every account, centre and document this script writes
 * carries a stamp, every tenant-wide total is asserted as a **difference from a baseline**
 * taken before anything is written, and everything with an undo is undone at the end.
 *
 * Usage: node scripts/verify-reports-accounting.mjs
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
const rowFor = (rows, code) => rows.find((row) => row.code === code);

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const from = iso(-1);
const to = iso(1);
const day = today.toISOString().slice(0, 10);
const period = `from=${from}&to=${to}`;
const emptyPeriod = 'from=2000-01-01&to=2000-01-02';
const year = today.getUTCFullYear();
const currentMonth = String(today.getUTCMonth() + 1);

const report = (key, query = '') => get(`/reports/${key}?${query ? `${query}&` : ''}${period}`);
const rowsOf = (report) => report.rows ?? [];

const written = {
  accounts: [],
  costCenters: [],
  entries: [],
  vouchers: [],
  employee: '',
  party: '',
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
console.log('■ 1. 📚 السجل — التقارير الستة بأعمدة الديسكتوب');
{
  const catalog = list(await get('/reports'));
  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));

  const balances = byKey.get('account-balances');
  check(
    '📊 أرصدة الحسابات — عشرة أعمدة',
    columns(balances) ===
      'الحساب · اسم الحساب · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن · رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن',
    columns(balances),
  );
  check(
    '📊 فلاتر «أرصدة الحسابات»',
    params(balances) === 'الحساب الرئيسي · الفرع · المندوب · من تاريخ · من وقت (HH:mm) · إلى تاريخ · إلى وقت (HH:mm)',
    params(balances),
  );

  const entries = byKey.get('journal-entries');
  check(
    '📒 القيود اليومية — سبعة أعمدة',
    columns(entries) === 'الرقم العام · رقم المستند · تاريخ القيد · نوع القيد · حالة القيد · البيان · رقم القيد',
    columns(entries),
  );
  check(
    '🧾 نوع القيد — ستة عشر اسماً من `EntryTypes`',
    entries?.params?.find((param) => param.labelAr === 'نوع القيد')?.options?.length === 16,
    `${entries?.params?.find((param) => param.labelAr === 'نوع القيد')?.options?.length ?? 0} خيار`,
  );

  const lines = byKey.get('journal-entry-lines');
  check(
    '🧾 تفاصيل القيد — ثمانية أعمدة',
    columns(lines) === 'رقم القيد · م · مدين · دائن · كود الحساب · اسم الحساب · مركز التكلفة · البيان',
    columns(lines),
  );

  const income = byKey.get('income-statement-accounts');
  check(
    '📈 أرباح وخسائر حسابات رئيسية — أربعة أعمدة',
    columns(income) === 'الحساب · اسم الحساب · رصيد مدين · رصيد دائن',
    columns(income),
  );

  const centres = byKey.get('cost-center-statement');
  check(
    '📂 تقرير مراكز التكلفة — أربعة عشر عموداً',
    columns(centres) ===
      'الرمز · اسم مركز التكلفة · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن · رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن · اسم الحساب · العملية · رقم العملية · التاريخ',
    columns(centres).slice(0, 60) + ' …',
  );
  check(
    '📋 نوع التقرير — تفصيلي · تجميعي',
    (centres?.params?.find((param) => param.labelAr === 'نوع التقرير')?.options ?? [])
      .map((option) => option.labelAr)
      .join(' · ') === 'تجميعي · تفصيلي',
  );

  const vat = byKey.get('vat-return-period');
  check('🧾 الإقرار الضريبي — أربعة أعمدة', columns(vat) === 'القسم · الوصف · الصافي · الضريبة', columns(vat));
  check(
    '📆 ربع سنة · شهري',
    (vat?.params?.find((param) => param.labelAr === 'ربع سنة')?.options ?? []).length === 4 &&
      (vat?.params?.find((param) => param.labelAr === 'شهري')?.options ?? []).length === 12,
  );
}

// ═══════════════════════════════════════════════════════════ 2. 📏 خطّ الأساس
console.log('\n■ 2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط');
const baseline = {
  balances: await report('account-balances'),
  entries: await report('journal-entries'),
  lines: await report('journal-entry-lines'),
  income: await report('income-statement-accounts'),
  centres: await report('cost-center-statement', 'kind=summary'),
  vat: await report('vat-return-period'),
};
console.log(
  `  · القيود ${rowsOf(baseline.entries).length} · السطور ${rowsOf(baseline.lines).length} · الحسابات ${
    rowsOf(baseline.balances).length
  }`,
);
console.log(`  · صافي الضريبة ${money(cardOf(baseline.vat, 's_net_vat'))} · صافي الربح ${money(cardOf(baseline.income, 's_profit'))}`);

// ═══════════════════════════════════════════════════════════ 3. 🧾 الوثائق
console.log('\n■ 3. 🧾 الوثائق — ستة حسابات · ثلاثة مراكز تكلفة · أربعة قيود · سندان');

const branches = list(await get('/branches'));
const branchId = branches[0]?.id ?? '';
const periods = list(await get('/fiscal-periods'));
/** 📆 الفترة المفتوحة التي يقع فيها اليوم — «عكس قيد» لا يقبل قيداً بلا فترة. */
const fiscalPeriodId =
  periods.find((row) => row.status === 'open' && row.startDate <= day && day <= row.endDate)?.id ?? '';
const taxGroups = list(await get('/organization/catalog/tax-groups'));
const vatAccountId = taxGroups.find((group) => group.vatAccountId)?.vatAccountId ?? '';
const cashLocations = list(await get('/cash-locations'));
const cashLocationId = cashLocations[0]?.id ?? '';

const makeAccount = async (code, nameAr, type, parentId) => {
  const created = await post('/accounts', { code, nameAr, type, ...(parentId ? { parentId } : {}) });
  written.accounts.push(created.id);
  return created;
};

const revenueParent = await makeAccount(`9${stamp}1`, `إيرادات التحقق ${stamp}`, 'revenue');
const revenueSales = await makeAccount(`9${stamp}2`, `إيراد مبيعات التحقق ${stamp}`, 'revenue', revenueParent.id);
await makeAccount(`9${stamp}3`, `إيراد آخر التحقق ${stamp}`, 'revenue', revenueParent.id);
const expenseParent = await makeAccount(`9${stamp}4`, `مصروفات التحقق ${stamp}`, 'expense');
const expenseSalary = await makeAccount(`9${stamp}5`, `رواتب التحقق ${stamp}`, 'expense', expenseParent.id);
const cash = await makeAccount(`9${stamp}6`, `صندوق التحقق ${stamp}`, 'asset');
console.log(`  ✓ ستة حسابات — ${revenueParent.code} … ${cash.code}`);

const makeCentre = async (code, nameAr, parentId) => {
  const created = await post('/cost-centers', { code, nameAr, ...(parentId ? { parentId } : {}) });
  written.costCenters.push(created.id);
  return created;
};
const centreParent = await makeCentre(`CC${stamp}`, `مركز التحقق ${stamp}`);
const centreSales = await makeCentre(`CC${stamp}S`, `مبيعات التحقق ${stamp}`, centreParent.id);
const centreStore = await makeCentre(`CC${stamp}W`, `مستودع التحقق ${stamp}`, centreParent.id);
console.log(`  ✓ ثلاثة مراكز تكلفة — ${centreParent.code} وأبناؤه`);

const employee = await post('/hrm/employees', {
  employeeNo: `ACC${stamp}`,
  name: `مندوب التحقق ${stamp}`,
  branchId,
});
written.employee = employee.id;

const journal = async (body) => {
  const created = await post('/journal-entries', { branchId, ...body });
  written.entries.push(created);
  return created;
};

// 🏁 قيد إفتتاحي — 1000 + 200 مدين يقابلها 1200 دائن، كلها على «مبيعات التحقق».
const opening = await journal({
  date: day,
  sourceType: 'opening',
  description: `قيد إفتتاحي للتحقق ${stamp}`,
  lines: [
    { accountId: cash.id, debit: '1000', credit: '0', costCenterId: centreSales.id },
    { accountId: expenseSalary.id, debit: '200', credit: '0', costCenterId: centreSales.id },
    { accountId: revenueSales.id, debit: '0', credit: '1200', costCenterId: centreSales.id },
  ],
});
// 📒 قيد اليومية — 300 مدين و300 دائن، بمندوب.
const movement = await journal({
  date: day,
  description: `تحصيل إيراد ${stamp}`,
  lines: [
    { accountId: cash.id, debit: '300', credit: '0', costCenterId: centreSales.id, salesmanId: employee.id },
    { accountId: revenueSales.id, debit: '0', credit: '300', costCenterId: centreSales.id, salesmanId: employee.id },
  ],
});
// 📒 قيد اليومية — 120 مصروف على «مستودع التحقق».
const expense = await journal({
  date: day,
  description: `مصروف رواتب ${stamp}`,
  lines: [
    { accountId: expenseSalary.id, debit: '120', credit: '0', costCenterId: centreStore.id },
    { accountId: cash.id, debit: '0', credit: '120', costCenterId: centreStore.id },
  ],
});
// 🧾 قيد ضريبي — 30 على حساب الضريبة و200 على المصروف، يقابلهما 230 دائن.
const vatEntry = await journal({
  date: day,
  isVat: true,
  description: `قيد ضريبي ${stamp}`,
  lines: [
    { accountId: vatAccountId, debit: '30', credit: '0' },
    { accountId: expenseSalary.id, debit: '200', credit: '0' },
    { accountId: cash.id, debit: '0', credit: '230' },
  ],
});
check(
  '🧾 أربعة قيود مُرحَّلة',
  [opening, movement, expense, vatEntry].every((entry) => entry.status === 'posted'),
  [opening.number, movement.number, expense.number, vatEntry.number].join(' · '),
);

const party = await post('/parties', { kind: 'customer', name: `عميل التحقق ${stamp}` });
written.party = party.id;
const makeVoucher = async (kind, amount, vatAmount, description) => {
  const draft = await post('/vouchers', {
    branchId,
    kind,
    subtype: 'customer',
    date: day,
    partyId: party.id,
    cashLocationId,
    method: 'cash',
    amount,
    vatAmount,
    description,
  });
  const postedVoucher = await post(`/vouchers/${draft.id}/post`, {});
  written.vouchers.push(postedVoucher);
  return postedVoucher;
};
const receipt = await makeVoucher('receipt', '1000', '150', `تحصيل التحقق ${stamp}`);
const payment = await makeVoucher('payment', '300', '45', `سداد التحقق ${stamp}`);
check('💵 سند قبض وسند صرف مُرحَّلان', receipt.status === 'posted' && payment.status === 'posted', `${receipt.number} · ${payment.number}`);

// ════════════════════════════════════════════════ 4. 📊 أرصدة الحسابات
console.log('\n■ 4. 📊 أرصدة الحسابات — الافتتاحي والحركة والختامي');
{
  const rows = rowsOf(await report('account-balances', `accountId=${revenueParent.id}`));
  check('📊 «الحساب الرئيسي» يُبقي الأبناء وحدهم', rows.length === 1, `${rows.length} سطر`);
  const sale = rowFor(rows, revenueSales.code);
  check('🏁 رصيد افتتاحي دائن 1200', money(sale?.opening_credit) === '1200.00', money(sale?.opening_credit));
  check('🔄 حركة دائن 300', money(sale?.move_credit) === '300.00', money(sale?.move_credit));
  check(
    '⚖️ رصيد ختامي دائن 1500 ومدين صفر',
    money(sale?.final_credit) === '1500.00' && money(sale?.final_debit) === '0.00',
    `${money(sale?.final_debit)} / ${money(sale?.final_credit)}`,
  );

  const report2 = await report('account-balances', `accountId=${revenueParent.id}`);
  check('💳 بطاقة «الرصيد (دائن)» 1500', money(cardOf(report2, 's_net_credit')) === '1500.00', money(cardOf(report2, 's_net_credit')));
  check('💳 بطاقة «عدد الحسابات»', num(cardOf(report2, 's_count')) === 1, cardOf(report2, 's_count'));

  // 🧑‍💼 المندوب — شريطٌ على السطور لا على القيد.
  const bySalesman = rowsOf(await report('account-balances', `salesmanId=${employee.id}`));
  check(
    '🧑‍💼 المندوب — سطران فقط',
    bySalesman.length === 2 && money(rowFor(bySalesman, revenueSales.code)?.final_credit) === '300.00',
    `${bySalesman.length} سطر · ${money(rowFor(bySalesman, revenueSales.code)?.final_credit)}`,
  );

  // 🏢 الفرع — قيدٌ على فرعٍ آخر يُسقط كل شيء.
  const otherBranch = rowsOf(await report('account-balances', `branchId=00000000-0000-4000-8000-000000000000`));
  check('🏢 فرعٌ بلا حركة — جدولٌ فارغ', otherBranch.length === 0, `${otherBranch.length} سطر`);

  // 📏 فرقٌ عن خطّ الأساس
  const all = await report('account-balances');
  // ثلاثة حساباتٍ جديدة تحمل حركة (الإيراد · المصروف · الصندوق)؛ الأبوان بلا سطور.
  check(
    '📏 ثلاثة حساباتٍ جديدةٍ على الأقل تحمل حركة',
    delta(rowsOf(all).length, rowsOf(baseline.balances).length) >= 3,
    `+${delta(rowsOf(all).length, rowsOf(baseline.balances).length)}`,
  );
}

// ═════════════════════════════════════════════════ 5. 📒 القيود اليومية
console.log('\n■ 5. 📒 القيود اليومية — السجل ونوع القيد وحالته');
{
  const rows = rowsOf(await report('journal-entries'));
  const mine = rows.find((row) => row.entry_no === opening.number);
  check('🏁 «قيد إفتتاحي» يُسمّى باسمه', mine?.entry_type === 'قيد إفتتاحي', String(mine?.entry_type));
  check('📋 حالة القيد — معتمد', mine?.state_ar === 'معتمد', String(mine?.state_ar));
  check('📄 رقم المستند — بلا مستند', mine?.doc_no === '—', String(mine?.doc_no));
  check('📅 تاريخ القيد', mine?.entry_date === day, String(mine?.entry_date));

  const vouchers = rows.filter((row) => row.entry_type === 'سند قبض' || row.entry_type === 'سند صرف');
  check('💵 قيد السندين باسمهما', vouchers.length >= 2, vouchers.map((row) => row.entry_type).join(' · '));

  const report2 = await report('journal-entries');
  check(
    '💳 بطاقة «عدد القيود»',
    delta(num(cardOf(report2, 's_count')), num(cardOf(baseline.entries, 's_count'))) >= 6,
    `+${delta(num(cardOf(report2, 's_count')), num(cardOf(baseline.entries, 's_count')))}`,
  );

  // 🔍 نوع القيد · رقم القيد · حالة القيد — صناديق «البحث».
  check(
    '🔍 «نوع القيد = قيد إفتتاحي»',
    rowsOf(await report('journal-entries', 'kind=opening')).some((row) => row.entry_no === opening.number),
  );
  check(
    '🔢 «رقم القيد»',
    rowsOf(await report('journal-entries', `entryNo=${movement.number}`)).length === 1,
    movement.number,
  );
  check(
    '🔍 «نوع القيد = سند قبض»',
    rowsOf(await report('journal-entries', 'kind=voucher_receipt')).some((row) => row.entry_type === 'سند قبض'),
  );
}

// ═══════════════════════════════════════════════════ 6. 🧾 تفاصيل القيد
console.log('\n■ 6. 🧾 تفاصيل القيد — السطور والإجماليات');
{
  const rows = rowsOf(await report('journal-entry-lines'));
  // عشرة سطور من القيود الأربعة (3 + 2 + 2 + 3) + أربعة من السندين (سطران لكل سند).
  check(
    '📏 أربعة عشر سطراً جديداً',
    delta(rows.length, rowsOf(baseline.lines).length) === 14,
    `+${delta(rows.length, rowsOf(baseline.lines).length)}`,
  );
  const cashLines = rows.filter((row) => row.code === cash.code);
  check('🧾 «م» يبدأ من واحد', cashLines[0]?.seq === '1', String(cashLines[0]?.seq));
  check('📊 مركز التكلفة على السطر', cashLines[0]?.cost_center === `مبيعات التحقق ${stamp}`, String(cashLines[0]?.cost_center));

  const report2 = await report('journal-entry-lines');
  // 1850 من القيود الأربعة + 1000 من سند القبض + 300 من سند الصرف.
  check(
    '💳 «إجمالي المدين» +3150',
    delta(cardOf(report2, 'debit'), cardOf(baseline.lines, 'debit')) === 3150,
    `+${delta(cardOf(report2, 'debit'), cardOf(baseline.lines, 'debit'))}`,
  );
  check(
    '💳 «إجمالي الدائن» +3150',
    delta(cardOf(report2, 'credit'), cardOf(baseline.lines, 'credit')) === 3150,
    `+${delta(cardOf(report2, 'credit'), cardOf(baseline.lines, 'credit'))}`,
  );
  check('⚖️ «الفرق» صفر — القيود متوازنة', money(cardOf(report2, 's_diff')) === '0.00', money(cardOf(report2, 's_diff')));

  const byCentre = rowsOf(await report('journal-entry-lines', `costCenterId=${centreStore.id}`));
  check('📂 مركز التكلفة — سطران', byCentre.length === 2, `${byCentre.length} سطر`);
}

// ═══════════════════════════════ 7. 📈 أرباح وخسائر حسابات رئيسية
console.log('\n■ 7. 📈 أرباح وخسائر حسابات رئيسية — التجميع على الأب');
{
  const rows = rowsOf(await report('income-statement-accounts'));
  const revenue = rows.find((row) => row.account === `إيرادات التحقق ${stamp}`);
  const expenseRow = rows.find((row) => row.account === `مصروفات التحقق ${stamp}`);
  // `FinalAcc = 2` ثم التجميع على الأب: 1200 + 300 دائن، و200 + 120 + 200 مدين.
  check('📈 الإيرادات مُجمَّعة على أبيها — 1500 دائن', money(revenue?.credit_balance) === '1500.00', money(revenue?.credit_balance));
  check('📉 المصروفات مُجمَّعة على أبيها — 520 مدين', money(expenseRow?.debit_balance) === '520.00', money(expenseRow?.debit_balance));
  check(
    '🏷️ سطر «قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ»',
    rows.some((row) => row.account === 'قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ'),
  );

  const report2 = await report('income-statement-accounts');
  check(
    '💳 «صافي أرباح العام» +980',
    delta(cardOf(report2, 's_profit'), cardOf(baseline.income, 's_profit')) === 980,
    `+${delta(cardOf(report2, 's_profit'), cardOf(baseline.income, 's_profit'))}`,
  );
}

// ═══════════════════════════════════ 8. 📂 تقرير مراكز التكلفة
console.log('\n■ 8. 📂 تقرير مراكز التكلفة — تجميعي وتفصيلي');
{
  const summary = rowsOf(
    await report('cost-center-statement', `costCenterId=${centreParent.id}&kind=summary`),
  );
  check('📂 تجميعي — خمسة سطور', summary.length === 5, `${summary.length} سطر`);
  const cashRow = summary.find((row) => row.cost_center === `مبيعات التحقق ${stamp}` && row.account_name === cash.nameAr);
  check('🏁 افتتاحي 1000 وحركة 300', money(cashRow?.opening_debit) === '1000.00' && money(cashRow?.move_debit) === '300.00');
  check('⚖️ ختامي مدين 1300', money(cashRow?.final_debit) === '1300.00', money(cashRow?.final_debit));
  check('📋 «تجميعي» يترك «العملية» فارغاً', summary.every((row) => row.operation === ''));

  const summaryReport = await report('cost-center-statement', `costCenterId=${centreParent.id}&kind=summary`);
  check('💳 بطاقة «عدد السجلات» 5', num(cardOf(summaryReport, 's_count')) === 5, cardOf(summaryReport, 's_count'));

  const detailed = rowsOf(
    await report('cost-center-statement', `costCenterId=${centreParent.id}&kind=detailed`),
  );
  check('📂 تفصيلي — سبعة سطور', detailed.length === 7, `${detailed.length} سطر`);
  check(
    '🧾 «العملية» و«رقم العملية» و«التاريخ» مملوءة',
    detailed.every((row) => row.operation !== '' && row.operation_no !== '' && row.entry_date === day),
  );
  const openingRow = detailed.find((row) => row.account_name === revenueSales.nameAr);
  check('🏁 الافتتاحي يُعاد على كل سطر كما في الديسكتوب', money(openingRow?.opening_credit) === '1200.00', money(openingRow?.opening_credit));

  // A leaf has no children: «تفصيلي» falls back to the centre itself («تجميعي» لا).
  const leaf = rowsOf(await report('cost-center-statement', `costCenterId=${centreStore.id}&kind=detailed`));
  check('🌿 مركزٌ بلا أبناء — يُبلّغ عن نفسه في «تفصيلي»', leaf.length === 2, `${leaf.length} سطر`);
  check('🌿 «تجميعي» على ورقةٍ لا أبناء لها — لا شيء', rowsOf(await report('cost-center-statement', `costCenterId=${centreStore.id}&kind=summary`)).length === 0);
}

// ═════════════════════════════════════════ 9. 🧾 الإقرار الضريبي
console.log('\n■ 9. 🧾 الإقرار الضريبي — البنود وصافي الضريبة');
{
  const vatReport = await report('vat-return-period');
  const rows = rowsOf(vatReport);
  check('🧾 ثلاثة عشر بنداً يُطبع الإقرار كاملاً', rows.length === 13, `${rows.length} بند`);
  const value = (line) => rows.find((row) => row.line === line);
  const base = (line) => rowsOf(baseline.vat).find((row) => row.line === line);
  /** 📏 كل رقمٍ هنا فرقٌ عن خطّ الأساس، فلا تُحصى وثائقُ تشغيلٍ سابق مرتين. */
  const grew = (line, column, expected) => delta(value(line)?.[column], base(line)?.[column]) === expected;

  check(
    '💵 «سندات القبض» +1000 صافي و+150 ضريبة',
    grew('سندات القبض', 'net', 1000) && grew('سندات القبض', 'vat', 150),
    `+${delta(value('سندات القبض')?.net, base('سندات القبض')?.net)} / +${delta(value('سندات القبض')?.vat, base('سندات القبض')?.vat)}`,
  );
  check(
    '💸 «سندات الصرف» +500 صافي و+75 ضريبة (السند 300 + القيد الضريبي 200)',
    grew('سندات الصرف', 'net', 500) && grew('سندات الصرف', 'vat', 75),
    `+${delta(value('سندات الصرف')?.net, base('سندات الصرف')?.net)} / +${delta(value('سندات الصرف')?.vat, base('سندات الصرف')?.vat)}`,
  );
  check(
    '🚫 بندا «الاستيرادات» بلا مقابل في السحابة',
    money(value('الإستيرادات الخاضعة للقيمة المضافة بالنسبة الأساسية')?.net) === '0.00' &&
      money(value('الإستيرادات الخاضعة للقيمة المضافة التي تطبق عليها آلية الاحتساب العكسي')?.net) === '0.00',
  );
  check(
    '🧮 «صافي المبيعات» +1000 و«صافي المشتريات» +500',
    grew('صافي المبيعات', 'net', 1000) && grew('صافي المشتريات', 'net', 500),
    `+${delta(value('صافي المبيعات')?.net, base('صافي المبيعات')?.net)} / +${delta(value('صافي المشتريات')?.net, base('صافي المشتريات')?.net)}`,
  );

  const net = rows[12];
  check('🧾 «صافي ضريبة القيمة المضافة» = 150 − 75', delta(net?.vat, rowsOf(baseline.vat)[12]?.vat) === 75, money(net?.vat));
  // 🟢 أحمر «(مستحق الدفع للهيئة)» وأخضر «(غير مستحق)» — بأيّ الوجهين دارت الإشارة.
  check(
    '🟢 «(مستحق الدفع للهيئة)» إن زادت الضريبة وإلا «(غير مستحق)»',
    net?.line === (Number(net?.vat) > 0 ? 'مستحق الدفع للهيئة' : 'غير مستحق'),
    String(net?.line),
  );

  check(
    '📏 «صافي ضريبة القيمة المضافة» +75 عن خطّ الأساس',
    delta(cardOf(vatReport, 's_net_vat'), cardOf(baseline.vat, 's_net_vat')) === 75,
    `+${delta(cardOf(vatReport, 's_net_vat'), cardOf(baseline.vat, 's_net_vat'))}`,
  );

  // 📆 «ربع سنة» و«شهري» يكتبان الفترة فوق صندوقي التاريخ (`SetDate`).
  const quarter = rowsOf(await get(`/reports/vat-return-period?quarter=1`));
  check(
    '📆 «ربع سنة» يكتب الفترة — الربع الأول من هذه السنة يُفرغ الإقرار',
    quarter.length === 13 && quarter.every((row) => money(row.vat) === '0.00'),
  );
  const monthReport = await get(`/reports/vat-return-period?month=${currentMonth}`);
  check(
    '📆 «شهري» يكتب الفترة — الشهر يحمل ما حملته الفترة نفسها',
    cardOf(monthReport, 's_net_vat') === cardOf(vatReport, 's_net_vat'),
    `${money(cardOf(monthReport, 's_net_vat'))} = ${money(cardOf(vatReport, 's_net_vat'))}`,
  );
}

// ═══════════════════════════════════════ 10. 📆 فترةٌ بلا حركة
console.log('\n■ 10. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر');
{
  const empty = await get(`/reports/account-balances?${emptyPeriod}`);
  check('📊 أرصدة الحسابات — لا سطر', rowsOf(empty).length === 0);
  check('💳 بطاقات صفر', money(cardOf(empty, 's_net_debit')) === '0.00' && num(cardOf(empty, 's_count')) === 0);

  const lines = await get(`/reports/journal-entry-lines?${emptyPeriod}`);
  check('🧾 تفاصيل القيد — لا سطر', rowsOf(lines).length === 0);
  check('💳 «إجمالي المدين» صفر', money(cardOf(lines, 'debit')) === '0.00');

  const income = await get(`/reports/income-statement-accounts?${emptyPeriod}`);
  check('📈 سطر المخزون يُطبع وحده', rowsOf(income).length === 1 && money(cardOf(income, 's_profit')) === '0.00');

  const vat = await get(`/reports/vat-return-period?${emptyPeriod}`);
  check('🧾 الإقرار يُطبع فارغاً', rowsOf(vat).length === 13 && money(cardOf(vat, 's_net_vat')) === '0.00');
  check('🟡 «(غير مستحق)»', rowsOf(vat)[12]?.line === 'غير مستحق', String(rowsOf(vat)[12]?.line));
}

// ══════════════════════════════════════ 11. 🖨️ طباعة وتصدير
console.log('\n■ 11. 🖨️ طباعة وتصدير — CSV وXLSX');
{
  const csv = await post(`/reports/account-balances/export?${period}&accountId=${revenueParent.id}`, { format: 'csv' });
  check(
    '📄 CSV بعناوين الديسكتوب العربية',
    String(csv.content ?? '').includes('رصيد ختامي دائن'),
    `${csv.rows} سطر`,
  );
  const xlsx = await post(`/reports/account-balances/export?${period}&accountId=${revenueParent.id}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && String(xlsx.filename).endsWith('.xlsx'), String(xlsx.filename));

  const vatCsv = await post(`/reports/vat-return-period/export?${period}`, { format: 'csv' });
  check('📄 CSV الإقرار الضريبي', String(vatCsv.content ?? '').includes('صافي ضريبة القيمة المضافة'), `${vatCsv.rows} سطر`);
}

// ══════════════════════════════════════════════════════ 12. 🧹 التنظيف
console.log('\n■ 12. 🧹 التنظيف — القيود تُعكس والسندات تُلغى');
{
  const voidReason = `تنظيف سكربت التحقق ${stamp}`;
  for (const voucher of [...written.vouchers].reverse()) {
    await undo(`إلغاء سند ${voucher.number}`, () => post(`/vouchers/${voucher.id}/void`, { reason: voidReason }));
  }
  // ⚖️ القيد لا يُلغى بل **يُعكس** — «قيد عكسي» هو سبيل الرجوع في الدفاتر، كما في الديسكتوب.
  for (const entry of [...written.entries].reverse()) {
    await undo(`عكس ${entry.number}`, () =>
      post(`/journal-entries/${entry.id}/reverse`, { branchId, fiscalPeriodId, date: day, reason: voidReason }),
    );
  }
  const afterReverse = await report('journal-entries', 'kind=reversal');
  check('🔄 أربعة قيود عكسية', rowsOf(afterReverse).length >= 4, `${rowsOf(afterReverse).length} قيد عكسي`);
  check(
    '📋 القيد المعكوس يُقرأ «لاغي»',
    rowsOf(await report('journal-entries', `entryNo=${opening.number}`))[0]?.state_ar === 'لاغي',
    String(rowsOf(await report('journal-entries', `entryNo=${opening.number}`))[0]?.state_ar),
  );

  // 🗑️ الحسابات ومراكز التكلفة التي تحمل حركة لا تُحذف — رفضُها قاعدةُ دفاتر لا عطل.
  for (const id of written.costCenters) {
    await undo('حذف مركز تكلفة', () => del(`/cost-centers/${id}`));
  }
  for (const id of [...written.accounts].reverse()) {
    await undo('حذف حساب', () => del(`/accounts/${id}`));
  }
  check(
    '⚖️ ما تعذّر حذفه رفضٌ من قاعدة الدفاتر (4xx) لا خطأ',
    refusals.every((row) => row.status >= 400 && row.status < 500),
    refusals.map((row) => row.code).join(' · ') || 'لا شيء',
  );
  check(
    `🧹 ما أُلغيَ: ${undone} وثيقة`,
    true,
    'وما بقي — حساباتٌ ومراكز تكلفةٍ حملت حركة وقيودٌ معكوسة — أثرٌ دفتريٌّ لا رجعة فيه كما في الديسكتوب',
  );
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
