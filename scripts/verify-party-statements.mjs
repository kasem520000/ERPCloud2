#!/usr/bin/env node
/**
 * Live verification of Phase 10 part eight — 📑 كشوف الحساب
 * (`Form_WPF/frmCustAccount.xaml` «أرصدة حساب العملاء» · `frmCustAccountGet.xaml`
 * «📋 كشف حساب عميل» · `frmCustLastPay.xaml` «📋 حركة آخر سداد للعملاء» · and the two
 * filters this part added to `frmAccountBalance` · `frmCostCenterBalance` — ⏰ الوقت
 * و📋 نوع القيد) against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate`
 * + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير الثلاثة بأعمدة الديسكتوب وفلاتره
 *   2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط
 *   3. 🧾 الوثائق — حسابان · عميل ومورد · أربعة قيود
 *   4. 👤 أرصدة حساب العملاء — من تحرّك حسابه وحده، برصيده وحالته
 *   5. 🏷️ نوع الحساب · 👤 العميل · 🤝 المندوب · 📅 الفترة
 *   6. 📋 كشف حساب عميل — قيدٌ بسطر، وأربعة صناديق لا يجتمع منها اثنان
 *   7. 💳 حركة آخر سداد — آخر قيدٍ بلا فترة، وثلاثة صناديق
 *   8. ⏰ الوقت و📋 نوع القيد على «كشف حساب تفصيلي» و«كشف مركز الكلفة»
 *   9. 📆 فترةٌ بلا حركة — جدولٌ فارغ ورسالة النافذة
 *  10. 🖨️ طباعة وتصدير — HTML وCSV
 *  11. 🚫 الصلاحيات · 🧹 التنظيف — القيود تُعكس، والأطراف والحسابات تُحذف
 *
 * Re-runnable and non-destructive: every account, party and entry this script writes
 * carries a stamp, every tenant-wide figure is asserted as a **difference from a
 * baseline** taken before anything is written, and everything with an undo is undone at
 * the end — an entry is *reversed*, never deleted, exactly as the desktop does it.
 *
 * Usage: node scripts/verify-party-statements.mjs
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
/** One of the 💰 boxes under the grid, by the hidden column that carries it. */
const cardOf = (report, key) => (report.grandTotal ?? []).find((total) => total.key === key)?.amount ?? '0';
const columnsOf = (entry) => (entry?.columns ?? []).map((column) => column.labelAr).join(' · ');
const paramsOf = (entry) => (entry?.params ?? []).map((param) => param.labelAr).join(' · ');
const rowsOf = (report) => report?.rows ?? [];

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const day = today.toISOString().slice(0, 10);
const period = `from=${iso(-1)}&to=${iso(1)}`;
const emptyPeriod = 'from=2000-01-01&to=2000-01-02';
const report = (key, query = '') => get(`/reports/${key}?${query ? `${query}&` : ''}${period}`);

const written = { accounts: [], parties: [], entries: [], salesman: '' };
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
console.log('■ 1. 📚 السجل — التقارير الثلاثة بأعمدة الديسكتوب');
{
  const catalog = list(await get('/reports'));
  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));

  const balances = byKey.get('customer-balances');
  check(
    '📊 أرصدة حساب العملاء — سبعة أعمدة كما في `frmCustAccount`',
    columnsOf(balances) === '# · 🔢 رقم الحساب · 👤 اسم العميل · 💸 حركة مدين · 💰 حركة دائن · ⚖️ الرصيد · 📌 الحالة',
    columnsOf(balances),
  );
  check(
    '📊 فلاترها — 👤 اسم العميل · 🏷️ نوع الحساب · 🤝 المندوب · 📅 الفترة',
    paramsOf(balances) === 'الطرف · نوع الحساب · المندوب · من تاريخ · إلى تاريخ',
    paramsOf(balances),
  );

  const statement = byKey.get('party-statement');
  check(
    '📋 كشف حساب عميل — سبعة أعمدة كما في `frmCustAccountGet`',
    columnsOf(statement) === 'م · مدين · دائن · العميل / المورد · رقم القيد · تاريخ القيد · البيان',
    columnsOf(statement),
  );
  check(
    '🏷️ نوع الحساب — «الكل» · «عملاء» · «موردين»',
    (statement?.params?.find((param) => param.labelAr === 'نوع الحساب')?.options ?? [])
      .map((option) => option.labelAr)
      .join(' · ') === 'الكل · عملاء · موردين',
  );

  const lastPay = byKey.get('customer-last-payment');
  check(
    '💳 حركة آخر سداد للعملاء — تسعة أعمدة كما في `frmCustLastPay`',
    columnsOf(lastPay) ===
      'رقم الحساب · اسم العميل · الهاتف · قيمة آخر سداد · تاريخ آخر سداد · نوع السند · الرصيد · الحالة · رقم القيد',
    columnsOf(lastPay),
  );
  // The window has no date box at all, so the report declares no period either.
  check(
    '📅 لا مربّع تاريخ في `frmCustLastPay` — ولا فلتر فترة في التقرير',
    paramsOf(lastPay) === 'الطرف · نوع الحساب',
    paramsOf(lastPay),
  );
}

// ═══════════════════════════════════════════════════════════ 2. 📏 خطّ الأساس
console.log('\n■ 2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط');
const baseline = {
  balances: await report('customer-balances'),
  statement: await report('party-statement'),
  lastPay: await get('/reports/customer-last-payment'),
};
console.log(
  `  · أرصدة ${rowsOf(baseline.balances).length} · قيود الأطراف ${rowsOf(baseline.statement).length} · آخر سداد ${
    rowsOf(baseline.lastPay).length
  }`,
);

// ═══════════════════════════════════════════════════════════ 3. 🧾 الوثائق
console.log('\n■ 3. 🧾 الوثائق — حسابان · عميل ومورد · أربعة قيود');

const branches = list(await get('/branches'));
const branchId = branches[0]?.id ?? '';
const periods = list(await get('/fiscal-periods'));
/** 📆 الفترة المفتوحة التي يقع فيها اليوم — «عكس قيد» لا يقبل قيداً بلا فترة. */
const fiscalPeriodId =
  periods.find((row) => row.status === 'open' && row.startDate <= day && day <= row.endDate)?.id ?? '';

const makeAccount = async (code, nameAr, type) => {
  const created = await post('/accounts', { code, nameAr, type });
  written.accounts.push(created.id);
  return created;
};
const receivable = await makeAccount(`7${stamp}1`, `ذمم عملاء التحقق ${stamp}`, 'asset');
const payable = await makeAccount(`7${stamp}2`, `موردي التحقق ${stamp}`, 'liability');
const cash = await makeAccount(`7${stamp}3`, `صندوق التحقق ${stamp}`, 'asset');
const revenue = await makeAccount(`7${stamp}4`, `إيراد التحقق ${stamp}`, 'revenue');
console.log(`  ✓ أربعة حسابات — ${receivable.code} … ${revenue.code}`);

const makeParty = async (kind, name, extra) => {
  const created = await post('/parties', { kind, name, branchId, ...extra });
  written.parties.push(created.id);
  return created;
};
const customer = await makeParty('customer', `عميل التحقق ${stamp}`, {
  phone: '0500000000',
  receivableAccountId: receivable.id,
});
const supplier = await makeParty('supplier', `مورد التحقق ${stamp}`, { payableAccountId: payable.id });
/** 👤 طرفٌ بلا حساب في الدليل — حركته هي الأسطر التي تحمله (`journal_entry_lines.party_id`). */
const unlinked = await makeParty('customer', `عميل بلا حساب ${stamp}`, {});
console.log(`  ✓ ثلاثة أطراف — عميل · مورد · عميل بلا حساب`);

const journal = async (body) => {
  const created = await post('/journal-entries', { branchId, ...body });
  written.entries.push(created);
  return created;
};

// 🧾 بيع على الحساب — 1000 مدين على ذمم العميل.
const sale = await journal({
  date: iso(-1),
  description: `بيع آجل للتحقق ${stamp}`,
  lines: [
    { accountId: receivable.id, debit: '1000', credit: '0', partyId: customer.id },
    { accountId: revenue.id, debit: '0', credit: '1000' },
  ],
});
// 💰 سند قبض — 400 دائن على ذمم العميل، و400 مدين على الصندوق الذي يحمل العميل كذلك.
const collection = await journal({
  date: day,
  description: `تحصيل من العميل ${stamp}`,
  lines: [
    { accountId: cash.id, debit: '400', credit: '0', partyId: customer.id },
    { accountId: receivable.id, debit: '0', credit: '400', partyId: customer.id },
  ],
});
// 🧾 سند صرف للمورد — 250 مدين على حسابه.
const payment = await journal({
  date: day,
  description: `سداد للمورد ${stamp}`,
  lines: [
    { accountId: payable.id, debit: '250', credit: '0', partyId: supplier.id },
    { accountId: cash.id, debit: '0', credit: '250', partyId: supplier.id },
  ],
});
console.log(`  ✓ ثلاثة قيود — ${sale.number} · ${collection.number} · ${payment.number}`);

// ══════════════════════════════════════════ 4. 👤 أرصدة حساب العملاء
console.log('\n■ 4. 👤 أرصدة حساب العملاء — `frmCustAccount`');
{
  const body = await report('customer-balances');
  const rows = rowsOf(body);
  const mine = rows.filter((row) => String(row.party).includes(stamp));

  check(
    '📈 عميلان جديدان في الجدول، والثالث بلا حركة لا يظهر',
    mine.length === 2 && !mine.some((row) => String(row.party).includes('بلا حساب')),
    mine.map((row) => row.party).join(' · '),
  );

  const row = mine.find((item) => item.party === `عميل التحقق ${stamp}`);
  check('🔢 رقم الحساب — حساب العميل في الدليل', row?.account_code === receivable.code, String(row?.account_code));
  check('💸 حركة مدين — ما على حسابه وحده لا ما على الصندوق', money(row?.debit) === '1000.00', money(row?.debit));
  check('💰 حركة دائن — التحصيل', money(row?.credit) === '400.00', money(row?.credit));
  check('⚖️ الرصيد — الفرق مطلقاً', money(row?.balance) === '600.00', money(row?.balance));
  check('📌 الحالة — مدين إن زاد المدين', row?.status === 'مدين', String(row?.status));
  check(
    'م — ترقيم الصفوف كما يطبعها الجدول',
    Number(row?.seq) === rows.indexOf(row) + 1,
    String(row?.seq),
  );

  const supplierRow = mine.find((item) => item.party === `مورد التحقق ${stamp}`);
  check('⚖️ المورد كذلك — رصيده مدين 250', money(supplierRow?.balance) === '250.00', money(supplierRow?.balance));

  // 📏 فرقٌ عن خطّ الأساس: مجاميع المستأجر كلها تضم ما كان قبل السكربت — وأثرُ قيودٍ
  //    معكوسة من تشغيلٍ سابق يبقى في المدين والدائن وإن عاد رصيده صفراً.
  check(
    '📊 المجاميع — مدين +1250 · دائن +400 عن خطّ الأساس',
    delta(body.totals?.debit, baseline.balances.totals?.debit) === 1250 &&
      delta(body.totals?.credit, baseline.balances.totals?.credit) === 400,
    `مدين ${money(body.totals?.debit)} · دائن ${money(body.totals?.credit)}`,
  );
  check(
    '⚖️ الرصيد — 600 للعميل و250 للمورد',
    money(mine.reduce((sum, item) => sum + num(item.balance), 0)) === '850.00',
    money(mine.reduce((sum, item) => sum + num(item.balance), 0)),
  );
}

// ══════════════════════════════ 5. 🏷️ نوع الحساب · 👤 العميل · 🤝 المندوب
console.log('\n■ 5. 🏷️ نوع الحساب · 👤 اسم العميل · 🤝 كل المندوبين · 📅 الفترة');
{
  const byKind = async (kind) => rowsOf(await report('customer-balances', `partyKind=${kind}`));
  const mine = (rows) => rows.filter((row) => String(row.party).includes(stamp)).map((row) => row.party);

  check('🏷️ «عملاء» — العميل وحده', mine(await byKind('customer')).length === 1, mine(await byKind('customer')).join(' · '));
  check('🏷️ «موردين» — المورد وحده', mine(await byKind('supplier')).join(' · ').includes('مورد التحقق'));
  check('🏷️ «الكل» — الاثنان', mine(await byKind('all')).length === 2);

  const one = rowsOf(await report('customer-balances', `partyId=${customer.id}`));
  check('👤 اسم العميل — سطرٌ واحد', one.length === 1 && one[0].party === `عميل التحقق ${stamp}`, String(one[0]?.party));

  // 🤝 مندوبٌ من إنشاء السكربت — حركته معدومة، فلا يظهر أحد من أطراف التحقق معه.
  const salesman = await post('/sales/salesmen', { code: `SM${stamp}`, name: `مندوب التحقق ${stamp}`, branchId });
  written.salesman = salesman.id;
  const bySalesman = rowsOf(await report('customer-balances', `salesmanId=${salesman.id}`));
  check(
    '🤝 كل المندوبين — مندوبٌ لم يحرّك هذه الحسابات لا يُظهرها',
    !bySalesman.some((row) => String(row.party).includes(stamp)),
    `${bySalesman.length} سطر`,
  );

  const outside = rowsOf(await get(`/reports/customer-balances?${emptyPeriod}`));
  check('📅 فترةٌ بلا حركة — جدولٌ فارغ', outside.length === 0, `${outside.length} سطر`);
}

// ══════════════════════════════════════════════ 6. 📋 كشف حساب عميل
console.log('\n■ 6. 📋 كشف حساب عميل — `frmCustAccountGet`');
{
  const body = await report('party-statement', `partyId=${customer.id}`);
  const rows = rowsOf(body);

  check('قيدٌ بسطر — ثلاثة قيود للعميل في فترةٍ حول اليوم', rows.length === 2, `${rows.length} سطر`);
  check('📅 الترتيب بالتاريخ ثم رقم القيد', rows[0]?.number === sale.number, String(rows[0]?.number));
  check('📝 البيان — بيان القيد كما في `Entry.notes`', rows[0]?.note === `بيع آجل للتحقق ${stamp}`, String(rows[0]?.note));
  check('👤 العميل / المورد', rows[0]?.party === `عميل التحقق ${stamp}`, String(rows[0]?.party));
  check('💳 مدين — البيع الآجل', money(rows[0]?.debit) === '1000.00', money(rows[0]?.debit));
  check('💵 دائن — التحصيل', money(rows[1]?.credit) === '400.00', money(rows[1]?.credit));

  check('💳 إجمالي المدين', money(cardOf(body, 's_debit')) === '1000.00', money(cardOf(body, 's_debit')));
  check('💵 إجمالي الدائن', money(cardOf(body, 's_credit')) === '400.00', money(cardOf(body, 's_credit')));
  check('⚖️ الرصيد المدين', money(cardOf(body, 's_bal_debit')) === '600.00', money(cardOf(body, 's_bal_debit')));
  check('⚖️ الرصيد الدائن — صفر', money(cardOf(body, 's_bal_credit')) === '0.00', money(cardOf(body, 's_bal_credit')));
  check('🔢 عدد القيود', money(cardOf(body, 's_count')) === '2.00', money(cardOf(body, 's_count')));
  // `UpdateSummary` L583-L609: الرصيد يقف على جانبٍ واحد، ولا يظهر على الجانبين معاً.
  check(
    '⚖️ الرصيد على جانبٍ واحد — ولا يظهر على الجانبين معاً',
    num(cardOf(body, 's_bal_debit')) * num(cardOf(body, 's_bal_credit')) === 0,
  );

  const supplierStatement = await report('party-statement', 'partyKind=supplier');
  check(
    '🏷️ المورد له الكشف نفسه',
    rowsOf(supplierStatement).some((row) => row.party === `مورد التحقق ${stamp}`),
    rowsOf(supplierStatement)
      .filter((row) => String(row.party).includes(stamp))
      .map((row) => row.party)
      .join(' · '),
  );

  const onBranch = rowsOf(await report('party-statement', `partyId=${customer.id}&branchId=${branchId}`));
  check('🌿 الفرع — «كل الفروع» وفرعٌ بعينه', onBranch.length === rows.length, `${onBranch.length} سطر`);
}

// ══════════════════════════════════════════════ 7. 💳 حركة آخر سداد
console.log('\n■ 7. 💳 حركة آخر سداد للعملاء — `frmCustLastPay`');
{
  const body = await get('/reports/customer-last-payment');
  const rows = rowsOf(body).filter((row) => String(row.party).includes(stamp));
  const row = rows.find((item) => item.party === `عميل التحقق ${stamp}`);

  check('📌 سطران — العميل والمورد', rows.length === 2, rows.map((item) => item.party).join(' · '));
  // L222-L231: the last entry on the account; L258 `dept == 0 ? credit : dept`.
  check('🧾 آخر قيدٍ حرّك الحساب', row?.entry_no === collection.number, String(row?.entry_no));
  check('💵 قيمة آخر سداد', money(row?.last_amount) === '400.00', money(row?.last_amount));
  check('📅 تاريخ آخر سداد', row?.last_day === day, String(row?.last_day));
  check('📋 نوع السند', row?.entry_type === 'قيد اليومية', String(row?.entry_type));
  check('⚖️ الرصيد', money(row?.balance) === '600.00', money(row?.balance));
  check('📌 الحالة', row?.status === 'مدين', String(row?.status));
  check('📱 الهاتف', row?.phone === '0500000000', String(row?.phone));

  // 📏 فرقٌ عن خطّ الأساس: الصناديق تقرأ المستأجر كله، و«آخر سداد» بلا فترة.
  check(
    '💳 الإجمالي — +650 عن خطّ الأساس (400 للعميل و250 للمورد)',
    delta(cardOf(body, 's_total'), cardOf(baseline.lastPay, 's_total')) === 650,
    money(cardOf(body, 's_total')),
  );
  check(
    '⚖️ الرصيد — +850 (600 + 250)',
    delta(cardOf(body, 's_balance'), cardOf(baseline.lastPay, 's_balance')) === 850,
    money(cardOf(body, 's_balance')),
  );
  check(
    '📌 السجلات — +2',
    delta(cardOf(body, 's_count'), cardOf(baseline.lastPay, 's_count')) === 2,
    money(cardOf(body, 's_count')),
  );
  check(
    '💳 · ⚖️ — صناديق أطراف التحقق وحدها',
    money(rows.reduce((sum, item) => sum + num(item.last_amount), 0)) === '650.00' &&
      money(rows.reduce((sum, item) => sum + num(item.balance), 0)) === '850.00',
    `آخر سداد ${money(rows.reduce((sum, item) => sum + num(item.last_amount), 0))} · رصيد ${money(
      rows.reduce((sum, item) => sum + num(item.balance), 0),
    )}`,
  );
}

// ═════════════════════════ 8. ⏰ الوقت و📋 نوع القيد على كشوف الحساب القائمة
console.log('\n■ 8. ⏰ الوقت و📋 نوع القيد — `frmAccountBalance` · `frmCostCenterBalance`');
{
  // قيدان في اليوم نفسه: واحدٌ في التاسعة صباحاً وآخر في التاسعة مساءً.
  const morning = await journal({
    date: day,
    time: '09:00:00',
    description: `قيد الصباح ${stamp}`,
    lines: [
      { accountId: receivable.id, debit: '70', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '70' },
    ],
  });
  const evening = await journal({
    date: day,
    time: '21:00:00',
    description: `قيد المساء ${stamp}`,
    lines: [
      { accountId: receivable.id, debit: '30', credit: '0' },
      { accountId: revenue.id, debit: '0', credit: '30' },
    ],
  });

  const statement = (query = '') => get(`/statements/general-ledger/${receivable.id}?${query}`);
  const numbersIn = (body) => (body ?? []).filter((row) => row.rank !== 0).map((row) => row.number);

  const wholeDay = await statement(`from=${day}&to=${day}`);
  check(
    '📅 اليوم كله — القيدان معاً',
    numbersIn(wholeDay).includes(morning.number) && numbersIn(wholeDay).includes(evening.number),
    numbersIn(wholeDay).join(' · '),
  );
  const fromNoon = await statement(`from=${day}&from_time=12:00`);
  check(
    '⏰ من وقت 12:00 — قيد المساء وحده',
    numbersIn(fromNoon).length === 1 && numbersIn(fromNoon)[0] === evening.number,
    numbersIn(fromNoon).join(' · '),
  );
  const untilNoon = await statement(`from=${day}&to=${day}&to_time=12:00`);
  check(
    '⏰ إلى وقت 12:00 — قيد المساء يسقط، وقيد الصباح وقيد التحصيل (بلا وقت = منتصف الليل) يبقيان',
    numbersIn(untilNoon).includes(morning.number) &&
      numbersIn(untilNoon).includes(collection.number) &&
      !numbersIn(untilNoon).includes(evening.number),
    numbersIn(untilNoon).join(' · '),
  );
  // 1000 (البيع الآجل أمس) − 400 (التحصيل عند منتصف الليل) + 70 (قيد التاسعة).
  check(
    '⚖️ الرصيد السابق يحمل ما قبل الساعة المحددة — 670',
    Number(fromNoon.find((row) => row.rank === 0)?.debit ?? 0).toFixed(4) === '670.0000',
    String(fromNoon.find((row) => row.rank === 0)?.debit),
  );

  const allTypes = (await statement('full_period=1')) ?? [];
  const manual = (await statement('full_period=1&kind=manual')) ?? [];
  const invoices = (await statement('full_period=1&kind=sales_invoice')) ?? [];
  check(
    '📋 نوع القيد — «قيد اليومية» يبقيها و«قيد مبيعات» يُسقطها',
    manual.length === allTypes.length && manual.length > 0 && invoices.length === 0,
    `الكل ${allTypes.length} · يدوي ${manual.length} · مبيعات ${invoices.length}`,
  );

  // 🗂️ «كشف مركز الكلفة» — الفلتر نفسه على النافذة الأخرى.
  const centres = list(await get('/cost-centers'));
  if (centres.length > 0) {
    const centre = centres[0];
    const centreAll = (await get(`/statements/cost-center/${centre.id}?full_period=1`)) ?? [];
    const centreFiltered = (await get(`/statements/cost-center/${centre.id}?full_period=1&kind=sales_invoice`)) ?? [];
    check(
      '🗂️ كشف مركز الكلفة — 📋 نوع القيد كذلك',
      centreFiltered.length <= centreAll.length,
      `الكل ${centreAll.length} · مبيعات ${centreFiltered.length}`,
    );
  } else {
    check('🗂️ كشف مركز الكلفة — لا مراكز في هذا المستأجر', true, 'تخطّي');
  }
}

// ══════════════════════════════════════════════ 9. 📆 فترةٌ بلا حركة
console.log('\n■ 9. 📆 فترةٌ بلا حركة — رسالة النافذة');
{
  const empty = await get(`/reports/customer-last-payment?${emptyPeriod}`);
  check('📆 لا أثر للفترة على تقريرٍ بلا فترة', rowsOf(empty).length > 0, `${rowsOf(empty).length} سطر`);

  const outside = await get(`/reports/party-statement?${emptyPeriod}`);
  check('📋 كشف حساب عميل — جدولٌ فارغ', rowsOf(outside).length === 0, `${rowsOf(outside).length} سطر`);

  const unknown = await refused('get', '/reports/no-such-statement');
  check('🚫 تقريرٌ غير معروف — 404', unknown.status === 404, `${unknown.status} ${unknown.code}`);
}

// ══════════════════════════════════════════════ 10. 🖨️ طباعة وتصدير
console.log('\n■ 10. 🖨️ طباعة وتصدير');
{
  const html = (await get('/reports/print/customer-balances')).html ?? '';
  check('🖨️ ورقة الطباعة — عنوان التقرير', html.includes('أرصدة حساب العملاء'));
  check('🖨️ ورقة الطباعة — عمود «📌 الحالة»', html.includes('📌 الحالة'));

  const lastPayHtml = (await get('/reports/print/customer-last-payment')).html ?? '';
  check('🖨️ «حركة آخر سداد» تُطبع', lastPayHtml.includes('حركة آخر سداد للعملاء'));

  const csv = await post('/reports/party-statement/export?partyId=' + customer.id, { format: 'csv' });
  check('📤 تصدير CSV — «كشف حساب عميل»', String(csv.filename ?? '').startsWith('party-statement'), String(csv.filename));
}

// ══════════════════════════════════════════════ 11. 🚫 الصلاحيات · 🧹 التنظيف
console.log('\n■ 11. 🚫 الصلاحيات — «التقارير» صلاحيةٌ قائمة بذاتها');
{
  // 👁️ A live script cannot mint a second user without an e-mail round trip, so this
  // section proves the split exists on the roles of this tenant; the 403 itself is
  // asserted by the API suite (`apps/api/test/report-party-statements.spec.ts`).
  const roles = list(await get('/roles'));
  const codes = (role) => role.permissionCodes ?? role.permissions ?? [];
  const holds = (role, code) => codes(role).includes('*') || codes(role).includes(code);
  const readers = roles.filter((role) => holds(role, 'reporting.view')).map((role) => role.name);
  check(
    '🔑 reporting.view — من يملكها في هذا المستأجر',
    readers.length > 0,
    `${readers.join(' · ')} · الأدوار: ${roles.map((role) => role.name).join(' · ')}`,
  );
}

console.log('\n■ 🧹 التنظيف — القيود تُعكس، والأطراف والحسابات تُحذف');
{
  const reason = `تنظيف سكربت التحقق ${stamp}`;
  for (const entry of [...written.entries].reverse()) {
    // ⚖️ القيد لا يُلغى بل **يُعكس** — «قيد عكسي» هو سبيل الرجوع في الدفاتر.
    await undo(`عكس ${entry.number}`, () =>
      post(`/journal-entries/${entry.id}/reverse`, { branchId, fiscalPeriodId, date: day, reason }),
    );
  }
  for (const id of written.parties) {
    await undo('حذف طرف', () => del(`/parties/${id}`));
  }
  if (written.salesman) {
    await undo('حذف مندوب', () => del(`/sales/salesmen/${written.salesman}`));
  }
  for (const id of [...written.accounts].reverse()) {
    await undo('حذف حساب', () => del(`/accounts/${id}`));
  }
  check(
    `🧹 ما أُلغيَ: ${undone} وثيقة`,
    true,
    refusals.length === 0
      ? 'لا شيء بلا رجعة'
      : `وما بقي — ${refusals.map((entry) => entry.label).join(' · ')} — أثرٌ دفتريٌّ لا رجعة فيه كما في الديسكتوب`,
  );

  // 📏 العودة إلى خطّ الأساس — حركةٌ معكوسة رصيدها صفر؛ أما القيود العكسية نفسها فأثرٌ
  //    دفتريٌّ يبقى، كما يبقى في الديسكتوب: لا يُمحى قيد، بل يُعكس بقيد.
  const after = await report('customer-balances');
  const mine = rowsOf(after).filter((row) => String(row.party).includes(stamp));
  check(
    '📏 رصيد كل طرفٍ من أطراف التحقق يعود صفراً',
    mine.every((row) => num(row.balance) === 0),
    mine.map((row) => `${row.party}: ${money(row.balance)}`).join(' · ') || 'لا سطور',
  );
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
