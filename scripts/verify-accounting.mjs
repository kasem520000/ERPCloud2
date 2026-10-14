#!/usr/bin/env node
/**
 * Live verification of the Phase 07 accounting documents against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📂 شجرة الحسابات — الرصيد على كل عقدة (`frmAccountsDirectory.xaml` binds
 *      `trBalance` on every node, and a parent is the sum of its branch)
 *   2. الرصيد من القيود المرحَّلة فقط — وما عُكس لا يُحصى
 *   3. 🔍 البحث بالكود وبالاسم، وتضييق النوع والفرع
 *   4. 📋 تفاصيل الحسابات — الحساب الرئيسي مسمّى لا مُعرّفاً
 *   5. بطاقة الحساب — 📅 تاريخ فتح الحساب · 💰 الرصيد الافتتاحي · 📊 مركز التكلفة
 *   6. 📄 كشف الحساب — الرصيد السابق والرصيد التراكمي (`frmAccountBalance`)
 *   7. 📊 طريقة العرض · الفترة · الفرع · كشف حساب رئيسي (`frmAccountsStatement`)
 *   8. 📒 إنشاء قيد يومية — ⏰ الوقت · ✅ قيد ضريبي · 🔑 الرقم العام · المندوب
 *   9. 🌳 مراكز التكلفة — الشجرة بالأرصدة · 📊 كشف مركز الكلفة
 *  10. العكس — القيد المعكوس يصفّر الأثر ويحمل أبعاده
 *  11. 🗂️ إدارة الفترات المحاسبية — ➕ إضافة · ✏️ تعديل · ⚡ تفعيل · 🔒 إغلاق · 🗑️ حذف
 *  12. ⚖️ ميزان المراجعة — افتتاحي · خلال الفترة المحددة · ختامي · الحالة
 *  13. 📊 أرباح وخسائر حسابات رئيسية — المخزون آخر المدة · صافي أرباح العام
 *
 * Usage: node scripts/verify-accounting.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(2);
const near = (value, expected) => Math.abs(Number(value) - expected) < 0.001;
const today = () => new Date().toISOString().slice(0, 10);
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
    method,
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

/**
 * The statement answers `{ data, totals, account }`; `call` unwraps `data`, so this one
 * keeps the envelope whole.
 */
async function callEnvelope(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = JSON.parse(await response.text());
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

const token = await (
  async () => {
    const data = await call('post', '/auth/login', undefined, { tenantCode, email, password });
    return data.accessToken ?? data.access_token ?? data.token;
  }
)();
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const account = async (code, nameAr, type, extra = {}) =>
  call('post', '/accounts', token, { code, nameAr, type, ...extra });

const directory = (query = '') => call('get', `/accounts${query ? `?${query}` : ''}`, token);

console.log('1. 📂 شجرة الحسابات — الرصيد على كل عقدة');

const costCenter = await call('post', '/cost-centers', token, {
  code: `CC${stamp}`,
  nameAr: `مركز تكلفة ${stamp}`,
});

const rootId = (await account(`9${stamp}`, `أصول التحقق ${stamp}`, 'asset', {
  isPostable: false,
  openedAt: '2024-01-01',
  costCenterId: costCenter.id,
})).id;
const midId = (await account(`9${stamp}1`, `نقدية التحقق ${stamp}`, 'asset', { parentId: rootId })).id;
const leafId = (await account(`9${stamp}11`, `صندوق التحقق ${stamp}`, 'asset', { parentId: midId })).id;
const sisterId = (await account(`9${stamp}2`, `عملاء التحقق ${stamp}`, 'asset', { parentId: rootId })).id;
const contraId = (await account(`8${stamp}`, `رأس مال التحقق ${stamp}`, 'equity')).id;

const post = (lines) => call('post', '/journal-entries', token, { date: today(), description: `قيد تحقق ${stamp}`, lines });
const postOn = (date, lines, branchId) =>
  call('post', '/journal-entries', token, { date, description: `قيد تحقق ${stamp}`, lines, ...(branchId ? { branchId } : {}) });
const iso = (offsetDays) => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + offsetDays);
  return at.toISOString().slice(0, 10);
};
const statement = (id, query = '') => callEnvelope('get', `/statements/general-ledger/${id}${query ? `?${query}` : ''}`);

const balanceOf = async (id) => {
  const rows = await directory('with_balances=1');
  return rows.find((row) => row.id === id)?.balance;
};

const first = await post([
  { accountId: leafId, debit: '500' },
  { accountId: contraId, credit: '500' },
]);
await post([
  { accountId: sisterId, debit: '300' },
  { accountId: contraId, credit: '300' },
]);

const leaf = await balanceOf(leafId);
check('رصيد الورقة 500', near(Number(leaf?.balance), 500), money(leaf?.balance));
const root = await balanceOf(rootId);
check('رصيد الأب يجمع فرعه (800)', near(Number(root?.balance), 800), money(root?.balance));
check('الأب بلا حركة خاصة به', near(Number(root?.ownBalance), 0), money(root?.ownBalance));
check('عدد الأبناء في الرصيد', Number(root?.descendants) === 3, String(root?.descendants));

console.log('\n2. وما عُكس ليس مالاً');
const periods = await call('get', '/fiscal-periods', token);
const period = periods.find((row) => row.status === 'open');
const extra = await post([
  { accountId: leafId, debit: '120' },
  { accountId: contraId, credit: '120' },
]);
check('القيد الثاني يحرّك الرصيد', near(Number((await balanceOf(leafId))?.balance), 620), money((await balanceOf(leafId))?.balance));
await call('post', `/journal-entries/${extra.id}/reverse`, token, {
  branchId: (await call('get', '/branches', token))[0].id,
  fiscalPeriodId: period?.id,
  date: today(),
  reason: `عكس للتحقق ${stamp}`,
});
check('العكس يعيد الرصيد (500)', near(Number((await balanceOf(leafId))?.balance), 500), money((await balanceOf(leafId))?.balance));
void first;

console.log('\n3. 🔍 البحث بالكود وبالاسم، وتضييق النوع والفرع');
const byCode = await directory(`q=9${stamp}11`);
check('🔍 بالكود', byCode.some((row) => row.id === leafId), `${byCode.length} صف`);
const byName = await directory(`q=${encodeURIComponent('صندوق التحقق')}`);
check('🔍 بالاسم', byName.some((row) => row.id === leafId), `${byName.length} صف`);
const byType = await directory('type=equity');
check('تضييق النوع', byType.some((row) => row.id === contraId) && !byType.some((row) => row.id === leafId), `${byType.length} صف`);
const nothing = await directory('q=لا-يوجد-بهذا-الاسم');
check('بحث بلا نتيجة لا يردّ كل شيء', nothing.length === 0, `${nothing.length} صف`);

console.log('\n4. 📋 تفاصيل الحسابات — الحساب الرئيسي مسمّى');
const rows = await directory('with_balances=1');
check(
  '📋 الحساب الرئيسي',
  rows.find((row) => row.id === leafId)?.parentName === `نقدية التحقق ${stamp}`,
  String(rows.find((row) => row.id === leafId)?.parentName),
);
check('الجذر بلا أب', (rows.find((row) => row.id === rootId)?.parentName ?? null) === null, '—');

console.log('\n5. بطاقة الحساب — 📅 تاريخ فتح الحساب · 💰 الرصيد الافتتاحي · 📊 مركز التكلفة');
const openingId = (await account(`9${stamp}3`, `افتتاحي التحقق ${stamp}`, 'asset', {
  parentId: rootId,
  openingBalance: '250',
  openedAt: '2024-06-01',
})).id;
check('💰 الرصيد الافتتاحي داخل الرصيد', near(Number((await balanceOf(openingId))?.balance), 250), money((await balanceOf(openingId))?.balance));
const card = await call('get', `/accounts/${rootId}`, token);
check('📅 تاريخ فتح الحساب محفوظ', String(card.openedAt ?? '').slice(0, 10) === '2024-01-01', String(card.openedAt));
check('📊 مركز التكلفة محفوظ', card.costCenterId === costCenter.id, String(card.costCenterId));
try {
  await call('PATCH', `/accounts/${openingId}`, token, { openingBalance: '900' });
  // The opening balance is editable while nothing is posted against the account.
  check('💰 الافتتاحي قابل للتعديل قبل الترحيل', true, '250 → 900');
} catch (error) {
  check('💰 الافتتاحي قابل للتعديل قبل الترحيل', false, `${error.status} ${error.code}`);
}

// التوافق: بلا `with_balances` يبقى الردّ كما كان.
const plain = await directory();
check('النهاية القائمة بلا أرصدة كما كانت', plain.length > 0 && plain[0].balance === undefined, `${plain.length} حساب`);

console.log('\n6. 📄 كشف الحساب — الرصيد السابق والرصيد التراكمي');

const stmtId = (await account(`9${stamp}4`, `كشف التحقق ${stamp}`, 'asset')).id;
const stmtChildId = (await account(`9${stamp}41`, `فرع كشف التحقق ${stamp}`, 'asset', { parentId: stmtId })).id;

// قبل الفترة: 400 على الحساب و100 على فرعه. داخلها: 150 + (50 و70 في قيد واحد) − 60،
// و25 على الفرع نفسه حتى يظهر فرعُه في «كشف حساب رئيسي».
await postOn(iso(-8), [
  { accountId: stmtId, debit: '400' },
  { accountId: contraId, credit: '400' },
]);
await postOn(iso(-8), [
  { accountId: stmtChildId, debit: '100' },
  { accountId: contraId, credit: '100' },
]);
await postOn(iso(-4), [
  { accountId: stmtId, debit: '150' },
  { accountId: contraId, credit: '150' },
]);
await postOn(iso(-3), [
  { accountId: stmtId, debit: '50' },
  { accountId: stmtId, debit: '70' },
  { accountId: contraId, credit: '120' },
]);
await postOn(iso(-3), [
  { accountId: stmtChildId, debit: '25' },
  { accountId: contraId, credit: '25' },
]);
await postOn(iso(-2), [
  { accountId: contraId, debit: '60' },
  { accountId: stmtId, credit: '60' },
]);

const stmt = await statement(stmtId, `from=${iso(-6)}`);
const opening = stmt.data.find((row) => row.rank === 0);
check('رصيد سابق — البيان', opening?.description === 'رصيد مرحل من فترة سابقة', String(opening?.description));
check('رصيد سابق — النوع', opening?.entryType === 'رصيد سابق', String(opening?.entryType));
check('رصيد سابق — 400 مدين', near(Number(opening?.debit), 400) && near(Number(opening?.runningBalance), 400), money(opening?.debit));

const movements = stmt.data.filter((row) => row.rank !== 0);
check('التفصيلي يبقي كل سطر', movements.length === 4, `${movements.length} حركة`);
const running = stmt.data.map((row) => Number(row.runningBalance));
check(
  'الرصيد تراكمي',
  near(running[0], 400) && near(running[1], 550) && near(running[2], 600) && near(running[3], 670) && near(running.at(-1), 610),
  running.join(' → '),
);
check('الرصيد الختامي 610', near(Number(stmt.totals.closing), 610), money(stmt.totals.closing));
check('الحالة مدين', stmt.totals.closingStatus === 'مدين', String(stmt.totals.closingStatus));

console.log('\n7. 📊 طريقة العرض · الفترة · الفرع · كشف حساب رئيسي');

const summary = await statement(stmtId, `from=${iso(-6)}&summary=1`);
check(
  'تجميعي (ملخص) يجمع سطور القيد',
  summary.data.filter((row) => row.rank !== 0).length === 3 && summary.data.some((row) => near(Number(row.debit), 120)),
  `${summary.data.filter((row) => row.rank !== 0).length} حركة`,
);

const full = await statement(stmtId, 'full_period=1');
check('فترة كاملة — بلا سطر افتتاح', full.data.every((row) => row.rank !== 0), `${full.data.length} صف`);
check('فترة كاملة — نفس الرصيد', near(Number(full.totals.closing), 610), money(full.totals.closing));

const hidden = await statement(stmtId, `from=${iso(-6)}&hide_previous_balance=1`);
check(
  'عدم إظهار الرصيد السابق — يُخفي السطر ولا يُسقط المال',
  hidden.data.every((row) => row.rank !== 0) && near(Number(hidden.data[0]?.runningBalance), 550),
  money(hidden.data[0]?.runningBalance),
);

const branchList = await call('get', '/branches', token);
if (branchList.length > 1) {
  const other = branchList[1];
  await postOn(iso(-1), [
    { accountId: stmtId, debit: '90' },
    { accountId: contraId, credit: '90' },
  ], other.id);
  const one = await statement(stmtId, `from=${iso(-6)}&branch_id=${other.id}&hide_previous_balance=1`);
  check(
    'الفرع يضيّق الكشف',
    near(Number(one.totals.debit), 90) && one.data.filter((row) => row.rank !== 0).every((row) => row.branchName === (other.nameAr ?? other.name)),
    `${one.data.filter((row) => row.rank !== 0).length} حركة`,
  );
} else {
  check('الفرع يضيّق الكشف', true, 'تخطّي: مؤسسة بفرع واحد');
}

const branch = await statement(stmtId, `from=${iso(-6)}&with_descendants=1`);
check(
  'كشف حساب رئيسي — الحساب وفرعه',
  branch.data.some((row) => row.accountCode === `9${stamp}41`),
  `${branch.data.length} صف`,
);
check('كشف حساب رئيسي — بلا رصيد تراكمي', branch.data.every((row) => row.runningBalance === null), '—');
check(
  'كشف حساب رئيسي — رصيده هو رصيد الشجرة',
  near(Number(branch.totals.closing), Number((await balanceOf(stmtId))?.balance)),
  `${money(branch.totals.closing)} = ${money((await balanceOf(stmtId))?.balance)}`,
);

const contra = await statement(contraId, `from=${iso(-6)}`);
check(
  'الحالة تقف على جانب المال لا على طبيعة الحساب',
  contra.totals.closingStatus === 'دائن',
  String(contra.totals.closingStatus),
);
check(
  'إجمالي مدين ودائن ورصيد الفترة',
  near(Number(stmt.totals.debit), 270) && near(Number(stmt.totals.credit), 60) && near(Number(stmt.totals.periodDebit), 210),
  `${money(stmt.totals.debit)} / ${money(stmt.totals.credit)} / ${money(stmt.totals.periodDebit)}`,
);

const sibling = await statement(stmtId);
check(
  'التوافق — بلا معايير يردّ نفس الدفتر القديم',
  Array.isArray(sibling.data) && sibling.data.length > 0 && 'entryId' in sibling.data[0] && sibling.totals !== undefined,
  `${sibling.data.length} صف`,
);
const drilldown = await call('get', `/journal-entries/${movements[0]?.entryId}`, token);
check('👁️ تفاصيل — القيد مفتوح من الكشف', Array.isArray(drilldown.lines) && drilldown.lines.length > 0, `${drilldown.lines?.length ?? 0} سطر`);

check('النهاية القائمة بلا أرصدة كما كانت', plain.length > 0 && plain[0].balance === undefined, `${plain.length} حساب`);

console.log('\n8. 📒 إنشاء قيد يومية — ⏰ الوقت · ✅ قيد ضريبي · 🔑 الرقم العام · المندوب');

const employees = await call('get', '/hrm/employees', token).catch(() => []);
// A fresh demo has no staff; create one so المندوب is checked against a real row.
const salesman =
  employees[0]?.id ??
  (await call('post', '/hrm/employees', token, {
    employeeNo: `S${stamp}`,
    name: `مندوب التحقق ${stamp}`,
    salaryComponents: {},
  })
    .then((created) => created.id)
    .catch(() => undefined));
const cardAccounts = await directory('with_balances=1');
const bankId = cardAccounts.find((row) => row.type === 'asset' && row.isPostable)?.id;
const equityId = cardAccounts.find((row) => row.type === 'equity' && row.isPostable)?.id;

const voucherCard = await call('post', '/journal-entries', token, {
  date: today(),
  time: '10:30',
  isVat: true,
  lines: [
    { accountId: bankId, debit: '80', salesmanId: salesman },
    { accountId: equityId, credit: '80' },
  ],
});
check('⏰ الوقت محفوظ', String(voucherCard.entryTime ?? '').slice(0, 5) === '10:30', String(voucherCard.entryTime));
check('✅ قيد ضريبي محفوظ', voucherCard.isVat === true, String(voucherCard.isVat));
check('رقم القيد متسلسل', /^JE-/.test(String(voucherCard.number ?? '')), String(voucherCard.number));
check('🔑 الرقم العام = هوية القيد', /^[0-9a-f-]{36}$/.test(String(voucherCard.id ?? '')), String(voucherCard.id).slice(0, 8));

const stored = await call('get', `/journal-entries/${voucherCard.id}`, token);
check(
  '📝 الملاحظة تُملأ تلقائياً',
  stored.description === `سند قيد يومية رقم: ${voucherCard.number} بتاريخ ${today()}`,
  String(stored.description),
);
const bankLine = (stored.lines ?? []).find((line) => line.accountId === bankId);
check(
  'الشرح يُسمّى بالحساب الذي يسدّده',
  String(bankLine?.description ?? '') === `سند قيد يومية رقم: ${voucherCard.number} - سداد دفعة من حساب: ${bankLine?.accountNameAr ?? ''}`,
  String(bankLine?.description),
);
if (salesman) {
  check('المندوب على السطر', bankLine?.salesmanId === salesman, String(bankLine?.salesmanId ?? '—'));
} else {
  check('المندوب على السطر', true, 'تخطّي: لا موظفين في هذه المؤسسة');
}

const kept = await call('post', '/journal-entries', token, {
  date: today(),
  description: 'قيد بملاحظة',
  lines: [
    { accountId: bankId, debit: '5' },
    { accountId: equityId, credit: '5' },
  ],
});
check('الملاحظة التي كتبها المستخدم تُحفظ', kept.description === 'قيد بملاحظة', String(kept.description));
check('⏰ الوقت فارغ حين لا يُرسل', (kept.entryTime ?? null) === null, String(kept.entryTime));
check('✅ قيد ضريبي خطؤه الافتراضي', kept.isVat === false, String(kept.isVat));

let refused = 0;
try {
  await call('post', '/journal-entries', token, {
    date: today(),
    lines: [
      { accountId: bankId, debit: '100' },
      { accountId: equityId, credit: '99' },
    ],
  });
} catch (error) {
  refused = error.status ?? 0;
}
check('الفرق — قيد غير متوازن مرفوض', refused === 422, `${refused} JOURNAL_NOT_BALANCED`);

console.log('\n9. 🌳 مراكز التكلفة — الشجرة بالأرصدة · 📊 كشف مركز الكلفة');

const centresWithBalances = await call('get', '/cost-centers?with_balances=1', token);
const mainCentre = centresWithBalances.find((row) => !row.parentId) ?? centresWithBalances[0];
check('الشجرة تردّ الرصيد على العقدة', mainCentre?.balance !== undefined, JSON.stringify(mainCentre?.balance ?? null).slice(0, 60));
let childCentre = centresWithBalances.find((row) => row.parentId === mainCentre?.id);
if (!childCentre) {
  childCentre = await call('post', '/cost-centers', token, {
    code: `CC${stamp}S`,
    nameAr: `فرع تحقق ${stamp}`,
    parentId: mainCentre?.id,
  });
}
const kinds = await call('get', '/cost-centers?with_balances=1', token);
check(
  '🏷️ النوع — 🟢 رئيسي / 🔵 فرعي',
  kinds.find((row) => row.id === mainCentre.id)?.kind === 'main' &&
    kinds.find((row) => row.id === childCentre.id)?.kind === 'sub',
  `${kinds.find((row) => row.id === mainCentre.id)?.kind} / ${kinds.find((row) => row.id === childCentre.id)?.kind}`,
);

const ccAccounts = await directory('with_balances=1');
const ccExpense = ccAccounts.find((row) => row.type === 'expense' && row.isPostable);
const ccCash = ccAccounts.find((row) => row.type === 'asset' && row.isPostable);
const leafCentre = centresWithBalances.find((row) => row.parentId) ?? mainCentre;

const ccBefore = Number((await call('get', '/cost-centers?with_balances=1', token)).find((row) => row.id === leafCentre.id)?.balance?.balance ?? 0);
await call('post', '/journal-entries', token, {
  date: today(),
  lines: [
    { accountId: ccExpense.id, debit: '60', costCenterId: leafCentre.id },
    { accountId: ccCash.id, credit: '60' },
  ],
});
const ccAfter = Number((await call('get', '/cost-centers?with_balances=1', token)).find((row) => row.id === leafCentre.id)?.balance?.balance ?? 0);
check('الرصيد يتحرّك بحركة المركز', near(ccAfter - ccBefore, 60), `${money(ccBefore)} → ${money(ccAfter)}`);

const ccRow = (await call('get', '/cost-centers?with_balances=1', token)).find((row) => row.id === leafCentre.id);
const ccStatement = await callEnvelope('get', `/statements/cost-center/${leafCentre.id}?from=${today()}&hide_previous_balance=1`);
check(
  '📊 كشف مركز الكلفة يردّ الحركة',
  // The script posts on every run, so the report is checked against what the tree says
  // about the same centre — not against a number from the first run.
  near(Number(ccStatement.totals.debit), Number(ccRow?.balance?.debit ?? 0)),
  `${money(Number(ccStatement.totals.debit))} = ${money(Number(ccRow?.balance?.debit ?? 0))}`,
);
check(
  '📌 الحالة تسمّي الجانب',
  ccStatement.totals.closingStatus === 'مدين',
  String(ccStatement.totals.closingStatus),
);
const ccSummary = await callEnvelope('get', `/statements/cost-center/${leafCentre.id}?from=${today()}&summary=1&hide_previous_balance=1`);
check(
  '📑 نوع التقرير — تجميعي/تفصيلي',
  ccSummary.data.length <= ccStatement.data.length,
  `${ccSummary.data.length} مقابل ${ccStatement.data.length}`,
);
const ccFull = await callEnvelope('get', `/statements/cost-center/${leafCentre.id}?full_period=1`);
check('فترة كاملة — بلا سطر افتتاح', ccFull.data.every((row) => row.rank !== 0), `${ccFull.data.length} صف`);
check('الرصيد = رصيد الشجرة', near(Number(ccFull.totals.closing), ccAfter), `${money(Number(ccFull.totals.closing))} = ${money(ccAfter)}`);

console.log('\n10. العكس — القيد المعكوس يصفّر الأثر ويحمل أبعاده');

const reversalTarget = await call('post', '/journal-entries', token, {
  date: today(),
  lines: [
    { accountId: ccExpense.id, debit: '45', costCenterId: leafCentre.id },
    { accountId: ccCash.id, credit: '45' },
  ],
});
const beforeReverse = Number((await call('get', '/cost-centers?with_balances=1', token)).find((row) => row.id === leafCentre.id)?.balance?.balance ?? 0);
const reversalPeriods = await call('get', '/fiscal-periods', token);
const reversalPeriod = reversalPeriods.find((row) => row.status === 'open');
const reversal = await call('post', `/journal-entries/${reversalTarget.id}/reverse`, token, {
  branchId: (await call('get', '/branches', token))[0].id,
  fiscalPeriodId: reversalPeriod?.id,
  date: today(),
  reason: `عكس للتحقق ${stamp}`,
});
const afterReverse = Number((await call('get', '/cost-centers?with_balances=1', token)).find((row) => row.id === leafCentre.id)?.balance?.balance ?? 0);
check(
  'العكس يصفّر أثر المركز ولا يضاعفه',
  near(beforeReverse - afterReverse, 45),
  `${money(beforeReverse)} → ${money(afterReverse)}`,
);
const reversalDetail = await call('get', `/journal-entries/${reversalTarget.id}`, token);
check('القيد الأصلي يبقى مرحّلاً — المرآة هي العكس', reversalDetail.status === 'posted', String(reversalDetail.status));
const mirrorLines = (await call('get', `/journal-entries/${reversal.reversalOf ? reversal.id : reversal.id}`, token)).lines ?? [];
const mirrored = mirrorLines.find((line) => line.accountId === ccExpense.id);
check('المرآة تحمل مركز التكلفة', mirrored?.costCenterId === leafCentre.id, String(mirrored?.costCenterId ?? '—'));


console.log('\n11. 🗂️ إدارة الفترات المحاسبية — ➕ إضافة · ✏️ تعديل · ⚡ تفعيل · 🔒 إغلاق · 🗑️ حذف');

const farYear = new Date().getUTCFullYear() + 5;

/**
 * Every run adds a period in the same future year, so an earlier run's period would
 * overlap this one's — and the script has to be re-runnable. The stale ones go first.
 */
for (const stale of (await call('get', '/fiscal-periods', token)).filter((row) => String(row.name).startsWith('فترة تحقق'))) {
  if (stale.status === 'closed') {
    await call('post', `/fiscal-periods/${stale.id}/reopen`, token, { reason: `تنظيف تحقق ${stamp}` });
  }
  await fetch(`${base}/fiscal-periods/${stale.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
}

const periodsBefore = await call('get', '/fiscal-periods', token);
check(
  'القائمة تردّ الرقم واسم السنة والحالة',
  periodsBefore.length > 0 &&
    typeof periodsBefore[0]?.number === 'number' &&
    'isActive' in periodsBefore[0] &&
    'notes' in periodsBefore[0],
  `${periodsBefore.length} فترة، أولاها رقم ${periodsBefore[0]?.number}`,
);

const newPeriod = await call('post', '/fiscal-periods', token, {
  name: `فترة تحقق ${stamp}`,
  startDate: `${farYear}-01-01`,
  endDate: `${farYear}-06-30`,
  isActive: true,
  notes: `ملاحظة ${stamp}`,
});
check('➕ إضافة — الاسم والتاريخان و✔️ نشطة وملاحظات', newPeriod.isActive === true && newPeriod.notes === `ملاحظة ${stamp}`, `${newPeriod.name} رقم ${newPeriod.number}`);
check('رقم الفترة مشتقّ من ترتيبها في سنتها', Number(newPeriod.number) === 1, String(newPeriod.number));
check(
  'السنة تُفتح وحدها إن لم تكن',
  (await call('get', '/fiscal-years', token)).some((row) => row.name === String(farYear)),
  String(farYear),
);
check(
  '⚡ تفعيل — فترة نشطة واحدة لا اثنتان',
  (await call('get', '/fiscal-periods', token)).filter((row) => row.isActive === true).length === 1,
  (await call('get', '/fiscal-periods', token)).filter((row) => row.isActive).map((row) => row.name).join('، '),
);

const overlap = await fetch(`${base}/fiscal-periods`, {
  method: 'post',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name: `متداخلة ${stamp}`, startDate: `${farYear}-02-01`, endDate: `${farYear}-08-31` }),
});
const overlapBody = await overlap.json();
check(
  '«يوجد تداخل في التواريخ مع فترة محاسبية أخرى»',
  overlap.status === 409 && overlapBody.code === 'PERIOD_OVERLAP',
  `${overlap.status} ${overlapBody.code ?? ''}`,
);

await call('post', `/fiscal-periods/${newPeriod.id}/close`, token, {});
const closedRow = (await call('get', '/fiscal-periods', token)).find((row) => row.id === newPeriod.id);
check('🔒 إغلاق الفترة — أغلقت بواسطة وتاريخ الإغلاق', closedRow?.status === 'closed' && Boolean(closedRow?.closedAt), String(closedRow?.closedByName ?? closedRow?.closedBy ?? '—'));
check('المغلقة تخرج من النشطة', closedRow?.isActive === false, String(closedRow?.isActive));

const refuseActivate = await fetch(`${base}/fiscal-periods/${newPeriod.id}/activate`, {
  method: 'post',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({}),
});
check('«لا يمكن تفعيل فترة محاسبية مغلقة»', refuseActivate.status === 409, String(refuseActivate.status));

const refuseEdit = await fetch(`${base}/fiscal-periods/${newPeriod.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name: 'معدّلة' }),
});
const refuseEditBody = await refuseEdit.json();
check(
  '«لا يمكن تعديل فترة مغلقة. يرجى إعادة فتحها أولاً»',
  refuseEdit.status === 409 && String(refuseEditBody.detail ?? '').includes('لا يمكن تعديل فترة مغلقة'),
  `${refuseEdit.status} ${refuseEditBody.detail ?? ''}`,
);

await call('post', `/fiscal-periods/${newPeriod.id}/reopen`, token, { reason: `تحقق ${stamp}` });
const reopened = (await call('get', '/fiscal-periods', token)).find((row) => row.id === newPeriod.id);
check('🔓 إعادة فتح — يزيل من أغلقها ومتى', reopened?.status === 'open' && reopened?.closedAt === null, String(reopened?.status));

await fetch(`${base}/fiscal-periods/${newPeriod.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
});
check(
  '🗑️ حذف — الفترة تزول من القائمة',
  !(await call('get', '/fiscal-periods', token)).some((row) => row.id === newPeriod.id),
  `${(await call('get', '/fiscal-periods', token)).length} فترة`,
);

console.log('\n12. ⚖️ ميزان المراجعة — افتتاحي · خلال الفترة المحددة · ختامي · الحالة');

const mizan = await callEnvelope('get', '/statements/trial-balance');
const mizanRow = mizan.data.find((row) => row.accountId === leafId);
check(
  'الأعمدة العشرة واسم الحساب',
  Boolean(mizanRow?.code) &&
    Boolean(mizanRow?.name) &&
    'openingDebit' in mizanRow &&
    'balanceDebit' in mizanRow &&
    'closingDebit' in mizanRow,
  `${mizanRow?.code} ${mizanRow?.name}`,
);
check('الحركة متوازنة — مدين = دائن', mizan.totals.balanced === true, `${money(mizan.totals.debit)} = ${money(mizan.totals.credit)}`);

const mizanPeriod = await callEnvelope('get', `/statements/trial-balance?from=${today()}`);
const mizanLeaf = mizanPeriod.data.find((row) => row.accountId === leafId);
const mizanClosed =
  Number(mizanLeaf?.openingDebit ?? 0) -
  Number(mizanLeaf?.openingCredit ?? 0) +
  Number(mizanLeaf?.debit ?? 0) -
  Number(mizanLeaf?.credit ?? 0);
check(
  'الختامي = الافتتاحي + حركة الفترة — صيغة `ShowResult`',
  near(Number(mizanLeaf?.closingDebit ?? 0) - Number(mizanLeaf?.closingCredit ?? 0), mizanClosed),
  `${money(mizanLeaf?.closingDebit)} − ${money(mizanLeaf?.closingCredit)} = ${money(mizanClosed)}`,
);
check(
  'الرصيد والحالة — كما يطبعها الديسكتوب',
  typeof mizanPeriod.totals.balance === 'string' && typeof mizanPeriod.totals.status === 'string',
  `${money(mizanPeriod.totals.balance)} ${mizanPeriod.totals.status || 'متوازن'}`,
);
const mizanBranch = await callEnvelope('get', `/statements/trial-balance?parent_id=${rootId}`);
check(
  'الحساب الرئيسي — الميزان على فرعٍ واحد من الشجرة',
  mizanBranch.data.length > 0 && mizanBranch.data.every((row) => String(row.code).startsWith(String(9) + stamp)),
  `${mizanBranch.data.length} صف: ${mizanBranch.data.map((row) => row.code).join('، ')}`,
);

console.log('\n13. 📊 أرباح وخسائر حسابات رئيسية — المخزون آخر المدة · صافي أرباح العام');

const incomeRevenue = await account(`7${stamp}`, `إيرادات التحقق ${stamp}`, 'revenue');
const incomeExpense = await account(`6${stamp}`, `مصروفات التحقق ${stamp}`, 'expense');
await post([
  { accountId: incomeRevenue.id, credit: '900' },
  { accountId: leafId, debit: '900' },
]);
await post([
  { accountId: incomeExpense.id, debit: '350' },
  { accountId: leafId, credit: '350' },
]);

const income = await callEnvelope('get', `/statements/income-statement?from=${iso(-1)}&to=${iso(1)}`);
const incomeAccounts = income.data.filter((row) => row.kind === 'account');
check(
  'الإيرادات والمصروفات وحدها — حساب الميزانية لا يظهر',
  incomeAccounts.some((row) => row.code === `7${stamp}`) &&
    incomeAccounts.some((row) => row.code === `6${stamp}`) &&
    !incomeAccounts.some((row) => row.code === mizanRow?.code),
  incomeAccounts.map((row) => row.code).join(' · '),
);
check(
  'رصيد مدين / رصيد دائن — كلٌّ على جانبه',
  near(Number(incomeAccounts.find((row) => row.code === `7${stamp}`)?.balanceCredit), 900) &&
    near(Number(incomeAccounts.find((row) => row.code === `6${stamp}`)?.balanceDebit), 350),
  `إيرادات ${money(incomeAccounts.find((row) => row.code === `7${stamp}`)?.balanceCredit)} · مصروفات ${money(incomeAccounts.find((row) => row.code === `6${stamp}`)?.balanceDebit)}`,
);
const incomeSides = incomeAccounts.reduce(
  (sum, row) => ({
    debit: sum.debit + Number(row.balanceDebit),
    credit: sum.credit + Number(row.balanceCredit),
  }),
  { debit: 0, credit: 0 },
);
const incomeStock = Number(income.totals.stock);
const incomeExpected = Math.abs(incomeSides.credit + incomeStock - incomeSides.debit);
check(
  'صافي أرباح العام — ما يزيد به الدائن على المدين',
  near(Number(income.totals.profit), incomeExpected) &&
    income.totals.profitLabel === (incomeSides.credit + incomeStock >= incomeSides.debit ? 'صافي أرباح العام' : 'صافي خسائر العام'),
  `${money(income.totals.profit)} ${income.totals.profitLabel} — ${money(incomeSides.credit + incomeStock)} مقابل ${money(incomeSides.debit)}`,
);
check(
  'إيرادات التحقق ومصروفاتها على القائمة — 900 مقابل 350',
  near(Number(incomeAccounts.find((row) => row.code === `7${stamp}`)?.balanceCredit), 900) &&
    near(Number(incomeAccounts.find((row) => row.code === `6${stamp}`)?.balanceDebit), 350),
  `${money(incomeAccounts.find((row) => row.code === `7${stamp}`)?.balanceCredit)} مقابل ${money(incomeAccounts.find((row) => row.code === `6${stamp}`)?.balanceDebit)}`,
);
check(
  '«✅ الحسابات متوازنة» — العمودان يلتقيان',
  income.totals.balanced === true && near(Number(income.totals.debit), Number(income.totals.credit)),
  `${money(income.totals.debit)} = ${money(income.totals.credit)}`,
);
check(
  'قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ',
  income.data.some((row) => row.kind === 'stock' && row.name.includes('قيمة مخزون')),
  money(income.totals.stock),
);
const incomeDetail = await callEnvelope('get', `/statements/income-statement?from=${iso(-1)}&to=${iso(1)}&summary=0`);
check(
  '📑 تفصيلي — صفّ لكل حساب',
  incomeDetail.data.filter((row) => row.kind === 'account').length >= incomeAccounts.length,
  `${incomeDetail.data.filter((row) => row.kind === 'account').length} مقابل ${incomeAccounts.length}`,
);

console.log('');
console.log(
  failures === 0
    ? '\n✔ Phase 07 — دليل الحسابات · كشف الحساب · الفترات والميزان verified'
    : `\n✗ ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
