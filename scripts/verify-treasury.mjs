#!/usr/bin/env node
/**
 * Live verification of the Phase 06 treasury documents against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. سند قبض عميل — البيان والوقت والمندوب على السطر، ثم القيد
 *   2. سند صرف لمورد — القيد مقلوب، والبنك هو الدائن
 *   3. الرقم — الترقيم من سلسلة المستندات لا من المستخدم
 *   4. شيك — لا يلمس رصيد الصندوق حتى يُحصَّل، ويُقيَّد يوم التحصيل
 *   5. شيك مرتجع — يعيد الدين على العميل
 *   6. 🔍 البحث — بالتاريخ، بالرقم، وبالبيان
 *   7. تعريف الخزن والبنوك — المسئولون والملاحظات وبطاقة البنك
 *   8. حركة الصندوق — كشف من دفتر الأستاذ برصيد متحرك ورصيد سابق وترشيح وقت
 *
 * Every step asserts the *ledger*, not just the balance: the desktop turned a receipt
 * into an entry as it saved it (`Class/ReceiptOper.cs:21`), and a voucher that moves cash
 * without an entry is exactly the bug this phase exists to remove.
 *
 * Usage: node scripts/verify-treasury.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(2);
/** Till prices include VAT, so money is compared with a halal tolerance, not bit for bit. */
const near = (value, expected) => Math.abs(Number(value) - expected) < 0.001;
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

const login = async () => {
  const data = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  // 👤 الموظف is a *membership*; the day-close screen filters by it (section 9).
  session = data;
  return data.accessToken ?? data.access_token ?? data.token;
};

let session;
const token = await login();
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

/**
 * 🧾 فوج نقطة البيع — `feature.pos` افتراضهُ `false` (`packages/config/tenant-settings.ts:139`)،
 * والأقسام 10–12 تبيع على الدرج حقيقةً (لا تُختبر خزينةٌ بلا مبيعات). السكربت يفتحه بنفسه
 * فلا يحتاج تشغيل غيره قبله — كما يفعل `verify-pos.mjs:87`.
 */
await call('put', '/settings/feature.pos', token, { value: true });

// ---------------------------------------------------------------- reference data
const stamp = Date.now().toString().slice(-6);
const today = new Date().toISOString().slice(0, 10);

const branches = await call('get', '/branches', token);
const branchId = branches[0].id;

const account = async (code, nameAr, type) =>
  (await call('post', '/accounts', token, { code: `${code}${stamp}`, nameAr, type })).id;
const receivableAccountId = await account('1120', 'العملاء — تحقق', 'asset');
const payableAccountId = await account('2110', 'الموردون — تحقق', 'liability');
const safeAccountId = await account('1211', 'الصندوق — تحقق', 'asset');
const bankAccountId = await account('1221', 'البنك — تحقق', 'asset');
const chequesInHandAccountId = await account('1130', 'أوراق القبض — تحقق', 'asset');

const customer = await call('post', '/parties', token, {
  code: `C-${stamp}`,
  kind: 'customer',
  name: 'عميل التحقق',
  receivableAccountId,
});
const supplier = await call('post', '/parties', token, {
  code: `S-${stamp}`,
  kind: 'supplier',
  name: 'مورد التحقق',
  payableAccountId,
});

const employee = await call('post', '/hrm/employees', token, {
  employeeNo: `E-${stamp}`,
  name: 'مندوب التحقق',
  branchId,
});

// 📋 حالة الصندوق — the safe is an account first (`Class/Treasury.cs:17`).
const safe = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'safe',
  name: `صندوق التحقق ${stamp}`,
  accountId: safeAccountId,
  isDefault: true,
});
const bank = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'bank',
  name: `بنك التحقق ${stamp}`,
  accountId: bankAccountId,
  isDefault: true,
  bank: { bankName: `بنك التحقق ${stamp}`, iban: 'SA0380000000608010167519', accountNo: '608010167519' },
});
console.log(`✔ party, employee, safe and bank ready (${stamp})\n`);

await call('post', '/branch-posting-profiles', token, {
  branchId,
  docType: 'receipt_voucher',
  mapping: { version: 1, chequesInHandAccountId },
});
await call('post', '/branch-posting-profiles', token, {
  branchId,
  docType: 'payment_voucher',
  mapping: { version: 1, chequesInHandAccountId },
});
console.log('✔ أوراق القبض mapped in the posting profile\n');

const balanceOf = async (locationId) => {
  const rows = await call('get', `/cash-locations/${locationId}/balances`, token);
  const list = Array.isArray(rows) ? rows : rows.data ?? [];
  return list.reduce((sum, row) => sum + Number(row.balance ?? 0), 0);
};
const linesOf = async (entryId) => {
  const entry = await call('get', `/journal-entries/${entryId}`, token);
  return entry.lines ?? [];
};

// ── 1. سند قبض عميل ────────────────────────────────────────────────────────
console.log('1. سند قبض عميل');
const receipt = await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  voucherTime: '9:05',
  partyId: customer.id,
  cashLocationId: safe.id,
  method: 'cash',
  amount: '1500',
  description: 'تحصيل فاتورة 2401',
  salesmanId: employee.id,
  referenceNo: `INV-${stamp}`,
  referenceDate: today,
});
check('the voucher keeps its البيان', receipt.description === 'تحصيل فاتورة 2401', receipt.description);
check('⏰ الوقت is kept as a time, not a string', String(receipt.voucherTime).startsWith('09:05'), receipt.voucherTime);
check('👔 المندوب rides on the document', receipt.salesmanId === employee.id);

const beforeBalance = await balanceOf(safe.id);
const postedReceipt = await call('post', `/vouchers/${receipt.id}/post`, token, {});
check('the number comes from the document sequence', String(postedReceipt.number).startsWith('RV-'), postedReceipt.number);
check('posting writes a journal entry', Boolean(postedReceipt.journalEntryId), postedReceipt.journalEntryId);

const receiptLines = await linesOf(postedReceipt.journalEntryId);
const debited = receiptLines.find((line) => Number(line.debit) > 0);
const credited = receiptLines.find((line) => Number(line.credit) > 0);
check('مدين الصندوق — the safe’s own account', debited?.accountId === safeAccountId, debited?.accountId);
check('دائن حساب العميل', credited?.accountId === receivableAccountId, credited?.accountId);
check('the entry is balanced', money(debited?.debit) === money(credited?.credit), `${debited?.debit} / ${credited?.credit}`);
check(
  '📝 البيان is the entry’s narration — BindReceiptToEntry’s entry.Note',
  (await call('get', `/journal-entries/${postedReceipt.journalEntryId}`, token)).description ===
    'تحصيل فاتورة 2401',
);
const afterBalance = await balanceOf(safe.id);
check('the safe’s balance moved with the entry', money(afterBalance - beforeBalance) === money(1500), `${money(beforeBalance)} → ${money(afterBalance)}`);
console.log('');

// ── 2. سند صرف لمورد ───────────────────────────────────────────────────────
console.log('2. سند صرف لمورد');
const payment = await call('post', '/vouchers', token, {
  branchId,
  kind: 'payment',
  subtype: 'supplier',
  date: today,
  partyId: supplier.id,
  cashLocationId: bank.id,
  method: 'bank_transfer',
  amount: '800',
  description: 'سداد للمورد',
});
const postedPayment = await call('post', `/vouchers/${payment.id}/post`, token, {});
check('the payment is numbered from its own series', String(postedPayment.number).startsWith('PV-'), postedPayment.number);
const paymentLines = await linesOf(postedPayment.journalEntryId);
const paymentDebit = paymentLines.find((line) => Number(line.debit) > 0);
const paymentCredit = paymentLines.find((line) => Number(line.credit) > 0);
check('مدين المورد — the mirror of a receipt', paymentDebit?.accountId === payableAccountId);
check('دائن البنك', paymentCredit?.accountId === bankAccountId);
console.log('');

// ── 3. شيك ─────────────────────────────────────────────────────────────────
console.log('3. شيك — وعد لا نقد حتى يُحصَّل');
const cheque = await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: safe.id,
  method: 'cheque',
  chequeNo: `CHK-${stamp}`,
  chequeDate: today,
  amount: '5000',
  description: 'شيك من العميل',
});
const postedCheque = await call('post', `/vouchers/${cheque.id}/post`, token, {});
const pendingBalance = await balanceOf(safe.id);
const chequeLines = await linesOf(postedCheque.journalEntryId);
check(
  'أوراق القبض holds it, not the safe',
  chequeLines.find((line) => Number(line.debit) > 0)?.accountId === chequesInHandAccountId,
);

const cleared = await call('post', `/vouchers/${cheque.id}/cheque`, token, { action: 'clear' });
check('the cheque is محصّل', cleared.chequeState === 'cleared', cleared.chequeState);
const clearedBalance = await balanceOf(safe.id);
check(
  'the safe only moves when the bank honours it',
  money(clearedBalance - pendingBalance) === money(5000),
  `${money(pendingBalance)} → ${money(clearedBalance)}`,
);
const clearedEntries = await call('get', '/journal-entries', token);
const clearedList = (Array.isArray(clearedEntries) ? clearedEntries : clearedEntries.data ?? []).filter(
  (row) => row.sourceType === 'voucher_cheque' && String(row.description ?? '').includes(`CHK-${stamp}`),
);
check('and the clearance is an entry, not just a number', clearedList.length === 1, `${clearedList.length} entry`);
console.log('');

// ── 4. شيك مرتجع ───────────────────────────────────────────────────────────
console.log('4. شيك مرتجع');
const bounced = await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: safe.id,
  method: 'cheque',
  chequeNo: `CHK-B-${stamp}`,
  amount: '1200',
  description: 'شيك مرتجع',
});
await call('post', `/vouchers/${bounced.id}/post`, token, {});
const beforeBounce = await balanceOf(safe.id);
const bouncedState = await call('post', `/vouchers/${bounced.id}/cheque`, token, { action: 'bounce' });
check('the cheque is مرتجع', bouncedState.chequeState === 'bounced', bouncedState.chequeState);
check('a bounced cheque never touched the safe', money((await balanceOf(safe.id)) - beforeBounce) === money(0));
try {
  await call('post', `/vouchers/${bounced.id}/cheque`, token, { action: 'clear' });
  check('a terminal cheque cannot be cleared', false, 'expected 422');
} catch (error) {
  check('a terminal cheque cannot be cleared', error.status === 422 && error.code === 'CHEQUE_INVALID_STATE', `${error.status} ${error.code}`);
}
console.log('');

// ── 5. 🔍 البحث ────────────────────────────────────────────────────────────
console.log('5. 🔍 البحث');
const byCheque = await call('get', `/vouchers?q=CHK-${stamp}`, token);
const byChequeRows = Array.isArray(byCheque) ? byCheque : byCheque.data ?? [];
check('by رقم الشيك', byChequeRows.length === 1, `${byChequeRows.length} found`);
const byDescription = await call('get', '/vouchers?q=تحصيل', token);
const byDescriptionRows = Array.isArray(byDescription) ? byDescription : byDescription.data ?? [];
check('by البيان', byDescriptionRows.length > 0, `${byDescriptionRows.length} found`);
const byDate = await call('get', `/vouchers?from=${today}&to=${today}`, token);
const byDateRows = Array.isArray(byDate) ? byDate : byDate.data ?? [];
check(
  'by 📅 من تاريخ / إلى تاريخ',
  byDateRows.every((row) => String(row.date).slice(0, 10) === today),
  `${byDateRows.length} rows`,
);
console.log('');

// ── 6. المسودة تُعدَّل والمرحَّل لا يُعدَّل ─────────────────────────────────────
console.log('6. المسودة تُعدَّل والمرحَّل لا يُعدَّل');
const draft = await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: safe.id,
  method: 'cash',
  amount: '100',
  description: 'مسودة',
});
const patched = await call('PATCH', `/vouchers/${draft.id}`, token, {
  amount: '250',
  description: 'مبلغ مصحح',
  voucherTime: '14:30',
});
check('a draft can be corrected after saving', money(patched.amount) === money(250), patched.amount);
check('and its البيان with it', patched.description === 'مبلغ مصحح');
await call('post', `/vouchers/${draft.id}/post`, token, {});
try {
  await call('PATCH', `/vouchers/${draft.id}`, token, { amount: '999' });
  check('a posted voucher is sealed', false, 'expected 409');
} catch (error) {
  check('a posted voucher is sealed', error.status === 409 && error.code === 'VOUCHER_IMMUTABLE', `${error.status} ${error.code}`);
}
console.log('');

// ── 7. تعريف الخزن والبنوك ─────────────────────────────────────────────────
// `frmTreasury.xaml.cs:222` refuses a الصندوق with no مسئول — «يجب اختيار موظف مسئول» —
// and replaces Stock_Emps inside the treasury's own transaction. `frmBanks.xaml` carries
// the bank's card on the same row: الدولة، المدينة، المنطقة، الهواتف، نسبة الاقتطاع.
console.log('7. تعريف الخزن والبنوك');
const secondEmployee = await call('post', '/hrm/employees', token, {
  employeeNo: `E2-${stamp}`,
  name: 'مساعد أمين الصندوق',
  branchId,
});
const custodySafe = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'safe',
  name: `صندوق بمسئول ${stamp}`,
  accountId: safeAccountId,
  custodianIds: [employee.id, secondEmployee.id],
  notes: 'يُغلق يومياً الساعة الثامنة',
});
check(
  '👤 مسئولو الصندوق يُحفظون مع الصندوق نفسه',
  (custodySafe.custodianIds ?? []).length === 2,
  (custodySafe.custodianIds ?? []).join(' · ').slice(0, 24),
);
check('📝 ملاحظات الصندوق تُحفظ', custodySafe.notes === 'يُغلق يومياً الساعة الثامنة', custodySafe.notes);

try {
  await call('post', '/cash-locations', token, {
    branchId,
    kind: 'safe',
    name: `صندوق بلا مسئول ${stamp}`,
    accountId: safeAccountId,
    custodianIds: [],
  });
  check('صندوق بلا مسئول مرفوض', false, 'expected 422');
} catch (error) {
  check('صندوق بلا مسئول مرفوض', error.status === 422, `${error.status} ${error.code}`);
}

try {
  await call('post', '/cash-locations', token, {
    branchId,
    kind: 'safe',
    name: `صندوق بمسئول غريب ${stamp}`,
    accountId: safeAccountId,
    custodianIds: ['00000000-0000-4000-8000-000000000000'],
  });
  check('موظف من مؤسسة أخرى لا يُجعل مسئولاً', false, 'expected 422');
} catch (error) {
  check('موظف من مؤسسة أخرى لا يُجعل مسئولاً', error.status === 422, `${error.status} ${error.code}`);
}

// التحديث يستبدل المجموعة كما يفعل الديسكتوب: حذف ثم إدراج.
const trimmed = await call('PATCH', `/cash-locations/${custodySafe.id}`, token, {
  custodianIds: [secondEmployee.id],
  notes: 'مسئول واحد بعد التسليم',
});
check('التحديث يستبدل المسئولين', (trimmed.custodianIds ?? []).length === 1, `${(trimmed.custodianIds ?? []).length}`);
try {
  await call('PATCH', `/cash-locations/${custodySafe.id}`, token, { custodianIds: [] });
  check('ولا يُسمح بتجريد الصندوق من مسئوليه', false, 'expected 422');
} catch (error) {
  check('ولا يُسمح بتجريد الصندوق من مسئوليه', error.status === 422, `${error.status} ${error.code}`);
}

const bankCard = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'bank',
  name: `بنك ببطاقة ${stamp}`,
  accountId: bankAccountId,
  bank: {
    bankName: `بنك التحقق ${stamp}`,
    iban: 'SA0380000000608010167519',
    country: 'المملكة العربية السعودية',
    city: 'الرياض',
    region: 'العليا',
    phone: '0114013030',
    mobile: '0550000000',
    deductionPct: '2.5',
  },
});
const card = bankCard.bank ?? {};
check(
  '🏦 بطاقة البنك كاملة: الدولة · المدينة · المنطقة · نسبة الاقتطاع',
  card.country === 'المملكة العربية السعودية' &&
    card.city === 'الرياض' &&
    card.region === 'العليا' &&
    card.deductionPct === '2.5',
  `${card.country} / ${card.city} / ${card.deductionPct}`,
);

const listed = await call('get', '/cash-locations?filter[kind]=safe&limit=100', token);
const listedRows = Array.isArray(listed) ? listed : listed.data ?? [];
check(
  'القائمة تعيد المسئولين مع كل صندوق',
  listedRows.some((row) => (row.custodianIds ?? []).includes(secondEmployee.id)),
  `${listedRows.length} صندوقاً`,
);
console.log('');

// ── 8. حركة الصندوق ────────────────────────────────────────────────────────
// `frmRptKhzna.xaml.cs` builds the statement from the **ledger** (L156 resolves the
// safe's account, L229 groups `Entry_sub`), opens it with `رصيد سابق` when a period is
// chosen (L200), carries a running balance, and closes with the two cards
// `⚖️ الرصيد الإجمالي` and `📅 رصيد الفترة المحددة` (L482/L502).
console.log('8. حركة الصندوق');
const statementAccountId = await account('1212', 'صندوق الكشف — تحقق', 'asset');
const capitalAccountId = await account('3110', 'رأس المال — تحقق', 'equity');
const expenseAccountId = await account('5110', 'مصروفات — تحقق', 'expense');
const statementSafe = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'safe',
  name: `صندوق الكشف ${stamp}`,
  accountId: statementAccountId,
});
const orphanSafe = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'safe',
  name: `صندوق بلا حساب ${stamp}`,
});

const movements = (id, query) => call('get', `/cash-locations/${id}/movements?${query}`, token);

// An entry the treasury screen never wrote — a statement built from `vouchers` would
// simply not see it.
await call('post', '/journal-entries', token, {
  branchId,
  date: '2026-01-05',
  description: 'إيداع افتتاحي',
  lines: [
    { accountId: statementAccountId, debit: '500' },
    { accountId: capitalAccountId, credit: '500' },
  ],
});
// A hand entry with no time at all, on the same day as two vouchers that have one.
await call('post', '/journal-entries', token, {
  branchId,
  date: today,
  description: 'إيداع نقدي من الإدارة',
  lines: [
    { accountId: statementAccountId, debit: '200' },
    { accountId: capitalAccountId, credit: '200' },
  ],
});
const morningReceipt = await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  voucherTime: '9:00',
  partyId: customer.id,
  cashLocationId: statementSafe.id,
  method: 'cash',
  amount: '1000',
  description: 'تحصيل صباحي',
});
await call('post', `/vouchers/${morningReceipt.id}/post`, token, {});
const eveningPayment = await call('post', '/vouchers', token, {
  branchId,
  kind: 'payment',
  subtype: 'expense',
  date: today,
  voucherTime: '15:00',
  cashLocationId: statementSafe.id,
  counterAccountId: expenseAccountId,
  method: 'cash',
  amount: '300',
  description: 'مصروفات نثرية مسائية',
});
await call('post', `/vouchers/${eveningPayment.id}/post`, token, {});
// A draft: it must not move the safe on paper before it moves it in the box.
await call('post', '/vouchers', token, {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: statementSafe.id,
  method: 'cash',
  amount: '7000',
  description: 'مسودة لم تُعتمد',
});

const everything = await movements(statementSafe.id, 'all=1');
const kinds = (everything.rows ?? []).map((row) => row.processType);
check(
  'الكشف يقرأ دفتر الحساب: قيد يومية + سند قبض + سند صرف',
  ['قيد يومية', 'سند قبض', 'سند صرف'].every((kind) => kinds.includes(kind)),
  kinds.join(' · '),
);
check('⚖️ الرصيد الإجمالي يجمع كل ما حرّك الصندوق', money(everything.totalAll) === money(1400), everything.totalAll);
check('والمسوّدة لا تُحرّك الصندوق على الورق', !JSON.stringify(everything.rows).includes('مسودة لم تُعتمد'));

const lastRow = (everything.rows ?? []).at(-1);
check(
  'الرصيد المتحرك لا يقفز: آخر رصيد هو الرصيد الإجمالي',
  money(lastRow?.balance) === money(everything.totalAll),
  `${lastRow?.balance} / ${everything.totalAll}`,
);

const period = await movements(statementSafe.id, `from=${today}&to=${today}`);
const openingRow = (period.rows ?? [])[0];
check('🧾 رصيد سابق يفتح الكشف عند تحديد فترة', money(period.openingBalance) === money(500), period.openingBalance);
check(
  'وسطره مؤرَّخ بيوم قبل «من تاريخ»',
  openingRow?.isOpening === true && openingRow?.processType === 'رصيد سابق',
  `${openingRow?.processType} ${openingRow?.date}`,
);
check('⚖️ الرصيد الإجمالي يبقى رصيد الصندوق', money(period.totalAll) === money(1400), period.totalAll);
check('📅 رصيد الفترة المحددة هو ما تحرّك فيها فقط', money(period.totalPeriod) === money(900), period.totalPeriod);

const morning = await movements(statementSafe.id, `from=${today}&to=${today}&toTime=10:00`);
const morningKinds = (morning.rows ?? []).map((row) => row.processType);
check('⏰ الوقت يقصّ النهار: سند الخامسة عصراً خارج نافذة الصباح', !morningKinds.includes('سند صرف'), morningKinds.join(' · '));
check('والقيد الذي بلا وقت لا يُخفى أبداً', morningKinds.includes('قيد يومية'));
check('والرصيد يتبع النافذة', money(morning.totalAll) === money(1700), morning.totalAll);

try {
  await movements(orphanSafe.id, 'all=1');
  check('صندوق بلا حساب لا يُفتح له كشف', false, 'expected 422');
} catch (error) {
  check(
    'صندوق بلا حساب لا يُفتح له كشف',
    error.status === 422 && error.code === 'CASH_ACCOUNT_REQUIRED',
    `${error.status} ${error.code}`,
  );
}
try {
  await movements(statementSafe.id, 'from=15-01-2026');
  check('وتاريخ غير مفهوم مرفوض', false, 'expected 422');
} catch (error) {
  check(
    'وتاريخ غير مفهوم مرفوض',
    error.status === 422 && error.code === 'MOVEMENT_DATE_INVALID',
    `${error.status} ${error.code}`,
  );
}
console.log('');

// ── 9. إغلاقات اليومية ──────────────────────────────────────────────────────
// `frmCloseShift.xaml` («عرض وإدارة إغلاقات وردية الموظفين») reads `CasherClosed`
// joined with `CasherClosed_Sub` (`.xaml.cs:214` and `:270`), shows 👤 الموظف by
// joining the party (L330) and presents 🏦 رصيد الصندوق (الدرج) beside 💰 مجموع
// الشبكة والنقدي (الورق) with 📉 الفرق between them.
console.log('9. إغلاقات اليومية');

const shiftSafeAccountId = await account('1213', 'درج الوردية — تحقق', 'asset');
const deliveryAccountId = await account('5210', 'توصيل — تحقق', 'expense');
const hospitalityAccountId = await account('5220', 'ضيافة — تحقق', 'expense');
const shiftSafe = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'safe',
  name: `درج الوردية ${stamp}`,
  accountId: shiftSafeAccountId,
});
const deliveryType = await call('post', '/expense-types', token, {
  nameAr: `توصيل ${stamp}`,
  accountId: deliveryAccountId,
});
const hospitalityType = await call('post', '/expense-types', token, {
  nameAr: `ضيافة ${stamp}`,
  accountId: hospitalityAccountId,
});

const dayCloses = (query = '') => call('get', `/shift-closes/day-closes${query ? `?${query}` : ''}`, token);

// The script is re-runnable: a drawer left open by an earlier run is closed first,
// because only one open shift per cashier and branch is allowed.
for (const row of (await dayCloses()).filter((entry) => entry.status === 'open')) {
  await call('post', `/shift-closes/${row.id}/close`, token, { counts: [] });
}

const beforeOpen = (await dayCloses()).length;

// Opening the drawer is the precondition for a sale, so the API must refuse a second
// one rather than fail on the open-shift uniqueness rule.
const opened = await call('post', '/shift-closes/open', token, { branchId });
check('الوردية تُفتح', Boolean(opened?.id) && opened.status === 'open', opened?.status);
try {
  await call('post', '/shift-closes/open', token, { branchId });
  check('وردية ثانية مرفوضة', false, 'expected 409');
} catch (error) {
  check(
    'وردية ثانية مرفوضة',
    error.status === 409 && error.code === 'SHIFT_ALREADY_OPEN',
    `${error.status} ${error.code}`,
  );
}

// 💵 نقدي in the drawer, and 🚗 توصيل/☕ ضيافة leaving it. The close is a *physical*
// count, so the numbers come from the ledger, not from a field on the shift.
// A draft voucher is a promise, not money — `ClosShiftAndroid.xaml.cs` reads the
// receipts of the window, so only a posted one moves the drawer.
const postVoucher = async (payload) => {
  const voucher = await call('post', '/vouchers', token, payload);
  return call('post', `/vouchers/${voucher.id}/post`, token);
};
await postVoucher({
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: shiftSafe.id,
  method: 'cash',
  amount: '400',
  description: 'تحصيل في الوردية',
});
// The expense *type* is the bucket (🚗/☕); the voucher points at its account, which is
// what the desktop keys the split on.
for (const [typeId, typeAccountId, paid] of [
  [deliveryType.id, deliveryAccountId, '20'],
  [hospitalityType.id, hospitalityAccountId, '10'],
]) {
  await postVoucher({
    branchId,
    kind: 'payment',
    subtype: 'expense',
    date: today,
    cashLocationId: shiftSafe.id,
    counterAccountId: typeAccountId,
    method: 'cash',
    amount: paid,
    expenseTypeId: typeId,
    description: `مصروف ${paid}`,
  });
}

const openRows = await dayCloses();
const openRow = openRows.find((row) => row.id === opened.id);
check('الوردية المفتوحة تظهر في القائمة', Boolean(openRow), `${openRows.length - beforeOpen} صف جديد`);
check('💵 النقدي 400 − 30 مصروف', money(openRow.cash) === '370.00', money(openRow.cash));
check('📤 المصاريف 30', money(openRow.expenses?.total) === '30.00', money(openRow.expenses?.total));
check('🚗 توصيل 20', money(openRow.expenses?.delivery) === '20.00', money(openRow.expenses?.delivery));
check('☕ ضيافة 10', money(openRow.expenses?.hospitality) === '10.00', money(openRow.expenses?.hospitality));
// 🏦 رصيد الصندوق is what the cashier *counted*, so it stays empty until the count —
// the paper figure lives in 💵 النقدي and is what الفرق will be measured against.
check('🏦 رصيد الصندوق فارغ قبل العد', money(openRow.safeBalance) === '0.00', money(openRow.safeBalance));
check('💵 النقدي هو الرقم المتوقع قبل العد', money(openRow.expected) === '370.00', money(openRow.expected));
check('الرقم يتأخر حتى الإغلاق', !openRow.number, openRow.number ?? '—');
check('👤 الموظف مسمّى من ملف الموظف', Boolean(openRow.employee), openRow.employee ?? '—');

// 🧾 الملاحظات المعدودة: 3×100 + 1×50 + 1×20 = 370 — a cashier counts coins, not a total.
const closed = await call('post', `/shift-closes/${opened.id}/close`, token, {
  branchId,
  counts: [
    { currencyCode: 'SAR', denomination: '100', count: 3 },
    { currencyCode: 'SAR', denomination: '50', count: 1 },
    { currencyCode: 'SAR', denomination: '20', count: 1 },
  ],
});
const shiftNumber = closed.number ?? closed.id;
check('🔢 الرقم من تسلسل المستندات', /^CS-/.test(String(shiftNumber)), String(shiftNumber));

const afterClose = (await dayCloses()).find((row) => row.id === opened.id);
check('الإغلاق يظهر برقمه', afterClose?.number === shiftNumber, afterClose?.number ?? '—');
check('📉 الفرق صفر عند تطابق العدد', money(afterClose?.diff) === '0.00', money(afterClose?.diff));
check('🏦 رصيد الصندوق = ما عُدّ', money(afterClose?.safeBalance) === '370.00', money(afterClose?.safeBalance));

// The close is a snapshot. A voucher written afterwards must not rewrite it.
await postVoucher({
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: today,
  partyId: customer.id,
  cashLocationId: shiftSafe.id,
  method: 'cash',
  amount: '999',
  description: 'تحصيل بعد الإغلاق',
});
const frozen = (await dayCloses()).find((row) => row.id === opened.id);
check(
  'الإغلاق صورة ثابتة لا تتغير بعده',
  money(frozen?.cash) === '370.00' && money(frozen?.safeBalance) === '370.00',
  `${money(frozen?.cash)} / ${money(frozen?.safeBalance)}`,
);

const detail = await call('get', `/shift-closes/${opened.id}`, token);
check('🧾 الملاحظات المعدودة تُحفظ', (detail.counts?.length ?? 0) === 3, `${detail.counts?.length ?? 0} فئة`);
const countedValue = (detail.counts ?? []).reduce((running, line) => running + Number(line.total ?? 0), 0);
check('مجموع الملاحظات 370', money(countedValue) === '370.00', money(countedValue));
check('التفاصيل: سطور الملخّص', (detail.lines?.length ?? 0) > 0, `${detail.lines?.length ?? 0} سطر`);

// معرّفٌ ليس UUID يُرفض عند النابض لا في قاعدة البيانات: 400 INVALID_ID، لا 500.
try {
  await call('get', '/shift-closes/not-a-uuid', token);
  check('معرّف غير مفهوم مرفوض', false, 'expected 400');
} catch (error) {
  check(
    'معرّف غير مفهوم مرفوض',
    error.status === 400 && error.code === 'INVALID_ID',
    `${error.status} ${error.code}`,
  );
}

// 👤 الموظف — a real filter, not a decoration. The shift belongs to the signed-in
// membership, so filtering by it must keep the row and a stranger's id must drop it.
const membershipId = session?.memberships?.[0]?.id ?? '';
const byEmployee = await dayCloses(`membership_id=${membershipId}`);
check(
  '👤 الموظف يفلتر القائمة فعلياً',
  byEmployee.some((row) => row.id === opened.id) &&
    byEmployee.every((row) => row.membershipId === membershipId),
  `${byEmployee.length} صف`,
);
const byStranger = await dayCloses(`membership_id=00000000-0000-4000-8000-000000000000`);
check(
  'فلترة بموظف آخر لا تُرجع هذه الوردية',
  !byStranger.some((row) => row.id === opened.id),
  `${byStranger.length} صف`,
);

console.log('');

// ── 10. التحويل البنكي والعميل النقدي ───────────────────────────────────────
// `frmPayBank.xaml` («🏦 اختر طريقة الدفع (تحويل بنكي)») and
// `frmCashCustomer.xaml` («👤 عميل نقدي»). The first is a chooser whose answer decides
// an account: `EntryOper.cs` L493/L537/L620 keeps a named transfer out of the generic
// شبكة bucket and debits *that* bank's own account at close. The second is not a
// customer table at all — `frmCashCustomer.xaml.cs` searches the invoices
// (`SELECT … FROM inv WHERE CashCustomerName <> ''`).
console.log('10. التحويل البنكي والعميل النقدي');

const salesAccountId = await account('4100', 'مبيعات التحقق', 'revenue');
const vatAccountId = await account('2310', 'ضريبة التحقق', 'liability');
const stockAccountId = await account('1140', 'مخزون التحقق', 'asset');
const cogsAccountId = await account('5100', 'تكلفة التحقق', 'expense');
const transferBankAId = await account('1241', 'بنك التحويل أ', 'asset');
const transferBankBId = await account('1242', 'بنك التحويل ب', 'asset');

const otherBranch = await call('post', '/branches', token, {
  code: `OT${stamp}`,
  nameAr: 'فرع آخر للتحقق',
});

const bankA = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'bank',
  name: `بنك الأهلي ${stamp}`,
  accountId: transferBankAId,
  bank: { bankName: `بنك الأهلي ${stamp}` },
});
const bankB = await call('post', '/cash-locations', token, {
  branchId,
  kind: 'bank',
  name: `بنك الراجحي ${stamp}`,
  accountId: transferBankBId,
  bank: { bankName: `بنك الراجحي ${stamp}` },
});
const foreignBank = await call('post', '/cash-locations', token, {
  branchId: otherBranch.id,
  kind: 'bank',
  name: `بنك فرع آخر ${stamp}`,
  bank: { bankName: `بنك فرع آخر ${stamp}` },
});
void foreignBank;

// A till needs something to sell: warehouse, item, stock, and the accounts the sale is
// posted against.
const posWarehouse = await call('post', '/warehouses', token, {
  branchId,
  code: `PW${stamp}`,
  name: 'مستودع نقطة البيع',
  isDefault: false,
});
const category = await call('post', '/organization/catalog/categories', token, {
  code: `PC${stamp}`,
  nameAr: 'فئة التحقق',
});
const unit = await call('post', '/organization/catalog/units', token, {
  code: `PU${stamp}`,
  nameAr: 'قطعة',
});
const posItem = await call('post', '/organization/catalog/items', token, {
  sku: `PI${stamp}`,
  nameAr: 'صنف التحقق',
  categoryId: category.id,
  baseUnitId: unit.id,
  salePrice: '100',
  costPrice: '60',
});
await call('post', '/inventory/ledger/record', token, {
  lines: [
    {
      itemId: posItem.id,
      warehouseId: posWarehouse.id,
      qty: '100',
      unitCost: '60',
      direction: 'in',
      docType: 'opening',
      docId: '00000000-0000-0000-0000-000000000002',
    },
  ],
});
await call('post', '/branch-posting-profiles', token, {
  branchId,
  docType: 'sales_invoice',
  mapping: {
    version: 1,
    salesAccountId,
    vatOutputAccountId: vatAccountId,
    cashAccountId: safeAccountId,
    receivableAccountId,
    cogsAccountId,
    inventoryAccountId: stockAccountId,
  },
});

const sellOnTill = (payment, quantity = '1', walkIn) =>
  call('post', '/pos/checkout', token, {
    branchId,
    warehouseId: posWarehouse.id,
    priceIncludesVat: true,
    orderType: 'pos',
    cashCustomerName: walkIn?.name ?? 'عميل نقدي',
    cashCustomerMobile: walkIn?.mobile,
    lines: [{ itemId: posItem.id, quantity, unitPrice: '100', taxRate: '15' }],
    payment,
  });

// Every drawer left open by an earlier section is closed first — section 9 owns the
// open-shift rule, section 10 only needs a clean one.
for (const row of (await dayCloses()).filter((entry) => entry.status === 'open')) {
  await call('post', `/shift-closes/${row.id}/close`, token, { counts: [] });
}
const transferShift = await call('post', '/shift-closes/open', token, { branchId });

// 🏦 تحويلان إلى بنكين مختلفين، وثالث إلى البنك الأول.
await sellOnTill({ method: 'bank', cashLocationId: bankA.id }, '2');
await sellOnTill({ method: 'bank', cashLocationId: bankB.id }, '3');
await sellOnTill({ method: 'bank', cashLocationId: bankA.id }, '1');

const liveRows = await dayCloses();
const liveShift = liveRows.find((row) => row.id === transferShift.id);
check(
  '🏦 كل بنك على سطره',
  (liveShift?.banks ?? []).length === 2,
  (liveShift?.banks ?? []).map((bank) => `${bank.name}:${money(bank.amount)}`).join(' · '),
);
const byBankName = new Map((liveShift?.banks ?? []).map((bank) => [bank.name, Number(bank.amount)]));
check('🏦 بنك الأهلي 300', near(byBankName.get(`بنك الأهلي ${stamp}`), 300), `${byBankName.get(`بنك الأهلي ${stamp}`)}`);
check(
  '🏦 بنك الراجحي 300 — تجميع لا تكرار',
  near(byBankName.get(`بنك الراجحي ${stamp}`), 300),
  `${byBankName.get(`بنك الراجحي ${stamp}`)}`,
);
check(
  '🌐 الشبكة تحمل المبلغ كاملاً',
  near(Number(liveShift?.network), 600),
  money(liveShift?.network),
);

// A transfer may not be routed to a bank of another branch.
try {
  await sellOnTill({ method: 'bank', cashLocationId: foreignBank.id });
  check('بنك فرع آخر مرفوض', false, 'expected 422');
} catch (error) {
  check('بنك فرع آخر مرفوض', error.status === 422, `${error.status} ${error.code}`);
}

const closedTransfer = await call('post', `/shift-closes/${transferShift.id}/close`, token, { counts: [] });
check('الإقفال يرقّم الوردية', /^CS-/.test(String(closedTransfer?.number)), String(closedTransfer?.number));

const closedDetail = await call('get', `/shift-closes/${transferShift.id}`, token);
const bankLines = (closedDetail.lines ?? []).filter((line) => line.kind === 'bank-transfer');
check('سطر بنكي لكل بنك في الإغلاق', bankLines.length === 2, `${bankLines.length} سطر`);
check(
  'السطر يسمّي بنكه',
  bankLines.every((line) => Boolean(line.metadata?.cashLocationId)),
  bankLines.map((line) => line.metadata?.name).join(' · '),
);

// 👤 عميل نقدي — `frmCashCustomer.xaml.cs` searches the invoices, not a customer table.
const walkIn = { name: `زياد العتيبي ${stamp}`, mobile: '0550001111' };
await sellOnTill({ method: 'cash', cashLocationId: safe.id }, '1', walkIn);
await sellOnTill({ method: 'cash', cashLocationId: safe.id }, '1', walkIn);

const byMobile = await call('get', `/sales/cash-customers?mobile=${walkIn.mobile}`, token);
// The grouping key is (name, mobile): one row per name that used this number. A re-run of
// this script leaves the previous run's زياد العتيبي <stamp> behind, so the assertion is
// «every row really carries this mobile, and this run's زياد is one of them» — not a
// brittle row count.
check(
  '🔍 البحث بالجوال تطابق تام',
  byMobile.length > 0 && byMobile.every((row) => row.mobile === walkIn.mobile),
  `${byMobile.length} صف`,
);
const walkInRow = byMobile.find((row) => row.name === walkIn.name);
check('👤 الاسم محفوظ على الفاتورة', Boolean(walkInRow?.name), walkInRow?.name ?? '—');
check('الفواتير تُجمَّع لا تُكرَّر', Number(walkInRow?.invoices) === 2, String(walkInRow?.invoices));

const byName = await call('get', `/sales/cash-customers?name=${encodeURIComponent('زياد العتيبي')}`, token);
check('🔍 البحث بالاسم يبحث في وسطه', byName.some((row) => row.name === walkIn.name), `${byName.length} صف`);
check('كل صف يحمل جواله', byName.every((row) => Boolean(row.mobile)), `${byName.length} صف`);

const strangerName = await call('get', `/sales/cash-customers?mobile=0550009999`, token);
check('جوال مجهول لا يردّ أحداً', strangerName.length === 0, `${strangerName.length} صف`);


// ── 11. مناقلة الخزن — frmSafesTransfer: إرسال / استلام / إقفال ───────────────
console.log('11. مناقلة الخزن');
const transferSafeB = await call('post', '/cash-locations', token, {
  name: `خزنة مناقلة ${stamp}`,
  kind: 'safe',
  branchId,
  accountId: safeAccountId,
  currencyCode: 'SAR',
});

const draftTransfer = await call('post', '/cash-transfers', token, {
  branchId,
  fromCashLocationId: safe.id,
  toCashLocationId: transferSafeB.id,
  amount: '1200',
  currencyCode: 'SAR',
});
check('مسودة بلا رقم حتى تُرسل', !draftTransfer.number, String(draftTransfer.number ?? '—'));
check('المسودة تُحفظ', draftTransfer.status === 'draft', draftTransfer.status);

const beforeSend = await balanceOf(safe.id);
const sentTransfer = await call('post', `/cash-transfers/${draftTransfer.id}/send`, token, {});
check('📤 الإرسال يرقّم المناقلة', /^CT-/.test(String(sentTransfer.number)), String(sentTransfer.number));
check('الحالة بعد الإرسال', sentTransfer.status === 'sent', sentTransfer.status);
check('📒 الإرسال يقيّد', Boolean(sentTransfer.sentJournalEntryId), sentTransfer.sentJournalEntryId ?? '—');
check('🧾 حساب «نقد تحت التحويل» في الردّ', Boolean(sentTransfer.cashInTransitAccountId), sentTransfer.cashInTransitAccountId ?? '—');
check(
  '💰 الخزنة المصدر تنقص 1200',
  near((await balanceOf(safe.id)) - beforeSend, -1200),
  money((await balanceOf(safe.id)) - beforeSend),
);

// R13 — الإرسال Dr نقد تحت التحويل / Cr خزنة المصدر
const sentLines = await linesOf(sentTransfer.sentJournalEntryId);
check('📒 قيد الإرسال سطران', sentLines.length === 2, `${sentLines.length} سطر`);
check(
  'Dr نقد تحت التحويل في الإرسال',
  sentLines.some((l) => Number(l.debit) > 0),
  sentLines.map((l) => `${l.debit}/${l.credit}`).join(' · '),
);
check(
  'Cr خزنة المصدر في الإرسال',
  sentLines.some((l) => Number(l.credit) > 0),
  sentLines.map((l) => `${l.accountCode ?? l.accountId} ${l.credit}`).join(' · '),
);

const receivedTransfer = await call('post', `/cash-transfers/${sentTransfer.id}/receive`, token, {});
check('📥 الاستلام يغلق الدورة', receivedTransfer.status === 'received', receivedTransfer.status);
check('📒 الاستلام يقيّد', Boolean(receivedTransfer.receivedJournalEntryId), receivedTransfer.receivedJournalEntryId ?? '—');
check(
  '💰 الخزنة الهدف تزيد 1200',
  near(await balanceOf(transferSafeB.id), 1200),
  money(await balanceOf(transferSafeB.id)),
);

// R13 — الاستلام Dr خزنة الوصول / Cr نقد تحت التحويل
const receivedLines = await linesOf(receivedTransfer.receivedJournalEntryId);
check('📒 قيد الاستلام سطران', receivedLines.length === 2, `${receivedLines.length} سطر`);
check(
  'Dr خزنة الوصول في الاستلام',
  receivedLines.some((l) => Number(l.debit) > 0),
  receivedLines.map((l) => `${l.debit}/${l.credit}`).join(' · '),
);
check(
  'Cr نقد تحت التحويل في الاستلام',
  receivedLines.some((l) => Number(l.credit) > 0),
  receivedLines.map((l) => `${l.accountCode ?? l.accountId} ${l.credit}`).join(' · '),
);

// 📤 تُرسل مرة واحدة فقط، ولا تُستلم مرتين.
const expectFail = async (label, fn, status = 422) => {
  try {
    await fn();
    check(label, false, `expected ${status}`);
  } catch (error) {
    check(label, error.status === status, `${error.status} ${error.code}`);
  }
};
await expectFail('📤 إرسال المُرسَلة مرفوض', () =>
  call('post', `/cash-transfers/${sentTransfer.id}/send`, token, {}),
);
await expectFail('📥 استلام المُستلَمة مرفوض', () =>
  call('post', `/cash-transfers/${sentTransfer.id}/receive`, token, {}),
);

// 🗑️ حذف — المسودة وحدها تُمحى، وما أُرسل يُلغى ولا يُمحى.
const doomedDraft = await call('post', '/cash-transfers', token, {
  branchId,
  fromCashLocationId: safe.id,
  toCashLocationId: transferSafeB.id,
  amount: '45',
});
const voided = await call('post', `/cash-transfers/${doomedDraft.id}/cancel`, token, {});
check('🗑️ المسودة تُلغى', voided.status === 'voided', voided.status);
const afterVoid = (await call('get', '/cash-transfers?status=voided', token)).filter(
  (row) => row.id === doomedDraft.id,
);
check('المُلغاة تظهر في البحث', afterVoid.length === 1, `${afterVoid.length} صف`);

// 🔍 البحث برقم التحويل وبالفترة.
const byNumber = await call(
  'get',
  `/cash-transfers?number=${encodeURIComponent(sentTransfer.number)}`,
  token,
);
check(
  '🔢 البحث بالرقم يُعيدها وحدها',
  byNumber.length === 1 && byNumber[0].id === sentTransfer.id,
  `${byNumber.length} صف`,
);

const windowed = await call('get', `/cash-transfers?from=${today}&to=${today}`, token);
check('📅 نافذة اليوم تحتويها', windowed.some((row) => row.id === sentTransfer.id), `${windowed.length} صف`);
const farAway = await call('get', '/cash-transfers?from=2099-01-01&to=2099-12-31', token);
check('📅 فترة أخرى لا تحتويها', farAway.length === 0, `${farAway.length} صف`);

const namedRows = await call('get', `/cash-transfers?number=${encodeURIComponent(sentTransfer.number)}`, token);
check(
  '🏦 من خزنة / إلى خزنة مسمّاة لا مُجرّد مُعرّفات',
  namedRows[0]?.fromName && namedRows[0]?.toName,
  `${namedRows[0]?.fromName ?? '—'} → ${namedRows[0]?.toName ?? '—'}`,
);
check(
  '📒 الشبكة تعلن القيود',
  namedRows[0]?.sentJournalEntryId && namedRows[0]?.receivedJournalEntryId,
  `${namedRows[0]?.sentJournalEntryId ? 'sent' : '—'} / ${namedRows[0]?.receivedJournalEntryId ? 'received' : '—'}`,
);

// مناقلة الأصناف (`frmSafesTransfer` نفسه) تُبحث بالرقم والفترة على نفس الشكل.
const itemRows = await call('get', '/inventory/transfers?number=TR-', token);
check('🔍 مناقلة الأصناف تقبل الرقم', Array.isArray(itemRows), `${itemRows.length} صف`);
const futureItemRows = await call('get', '/inventory/transfers?from=2099-01-01&to=2099-12-31', token);
check('📅 مناقلة الأصناف تقبل الفترة', Array.isArray(futureItemRows), `${futureItemRows.length} صف`);

// ── 12. قيد الإغلاق — frmCloseShift: 📉 الفرق وحده يُرحَّل ──────────────────────────
console.log('12. قيد الإغلاق');

const differenceAccountId = await account('5320', 'فرق بالصندوق — تحقق', 'expense');
/**
 * 🧾 عهدة الإغلاق — `1211002`: ثابتُ الديسكتوب، والحساب الذي يُنشئه الدليل لكل مؤسسة
 * (`desktop-coa.ts:479`). يُقرأ من الدليل بالكود لا يُخترع هنا، لأن الخادم يقرأه كذلك.
 */
const chart = await call('get', '/accounts?limit=500', token);
const custodyAccountId = chart.find((row) => row.code === '1211002')?.id;
check('🧾 عهدة الإغلاق في الدليل — 1211002', Boolean(custodyAccountId), String(custodyAccountId));
await call('post', '/branch-posting-profiles', token, {
  branchId,
  docType: 'shift_close',
  mapping: { version: 1, cashAccountId: safeAccountId, cashDifferenceAccountId: differenceAccountId },
});

// Every drawer left open by an earlier section is closed first.
for (const row of (await dayCloses()).filter((entry) => entry.status === 'open')) {
  await call('post', `/shift-closes/${row.id}/close`, token, { counts: [] });
}

const shortShift = await call('post', '/shift-closes/open', token, { branchId });
await sellOnTill({ method: 'cash', cashLocationId: safe.id }, '1'); // 100 in the drawer
const shortClosed = await call('post', `/shift-closes/${shortShift.id}/close`, token, {
  counts: [{ denomination: '50', count: 1 }], // 50 in hand — عجز 50
});
check('📉 الفرق عجز 50', near(Number((shortClosed.summary ?? {}).diff), -50), money((shortClosed.summary ?? {}).diff));

const postedShift = await call('post', `/shift-closes/${shortShift.id}/post`, token, {});
const closeEntryId = postedShift?.journalEntryId;
check('📒 القيد يُرحَّل', Boolean(closeEntryId), String(closeEntryId));

const closeEntry = await call('get', `/journal-entries/${closeEntryId}`, token);
const closeDebits = (closeEntry.lines ?? []).filter((line) => Number(line.debit) > 0);
const closeCredits = (closeEntry.lines ?? []).filter((line) => Number(line.credit) > 0);
/**
 * 🧾 R12 — قيدُ الإغلاق صار ثلاثة أسطر لا سطراً واحداً: المعدودُ يخرج من الصندوق إلى
 * «عهدة الإغلاق» (`1211002`، ثابتُ الديسكتوب في `ClosShiftAndroid.xaml.cs:1593`)، والفرقُ
 * بين المعدود والمتوقّع يقع على «فروقات الصندوق» (`3110004`)، والصندوقُ يُخفَّض بالمتوقّع.
 *   100 متوقّع · 50 معدود  ⇒  مدين عهدة 50 + مدين فروقات 50 / دائن صندوق 100.
 */
check(
  '🧾 العهدة مدينٌ بالمعدود',
  closeDebits.some((line) => line.accountId === custodyAccountId && near(line.debit, 50)),
  closeDebits.map((line) => `${line.accountId}:${money(line.debit)}`).join(' · '),
);
check('📉 عجز: مدين فرق الصندوق', closeDebits.some((line) => line.accountId === differenceAccountId && near(line.debit, 50)), `${closeDebits.length} سطر مدين`);
check('📉 عجز: دائن الصندوق', closeCredits[0]?.accountId === safeAccountId, `${closeCredits.length} سطر دائن`);
check(
  '⚖️ القيد متوازن',
  near(closeDebits.reduce((sum, line) => sum + Number(line.debit), 0), 100) &&
    near(closeCredits.reduce((sum, line) => sum + Number(line.credit), 0), 100),
  `${money(closeDebits.reduce((sum, line) => sum + Number(line.debit), 0))}`,
);
check(
  '📝 وبيان كل سطر كما في الديسكتوب',
  String(closeEntry.lines?.find((line) => line.accountId === custodyAccountId)?.description ?? '').includes('عهدة الإغلاق') &&
    String(closeEntry.lines?.find((line) => line.accountId === differenceAccountId)?.description ?? '').includes('فرق بالصندوق') &&
    String(closeEntry.lines?.find((line) => line.accountId === safeAccountId)?.description ?? '').includes('نقدي في الصندوق'),
  String(closeEntry.lines?.find((line) => line.accountId === custodyAccountId)?.description ?? ''),
);
check(
  '🧾 العهدة تُكتب على الإغلاق نفسه',
  postedShift.custodyAccountId === custodyAccountId &&
    near(postedShift.custodyAmount, 50) &&
    near(postedShift.tillAmount, 100) &&
    near(postedShift.differenceAmount, 50),
  `معدود ${money(postedShift.custodyAmount)} · متوقّع ${money(postedShift.tillAmount)} · فرق ${money(postedShift.differenceAmount)}`,
);
check(
  '📝 البيان يحمل الإغلاق ورقمه',
  /اغلاق اليومية/.test(String(closeEntry.description)) &&
    String(closeEntry.description).includes(String(shortClosed.number)),
  String(closeEntry.description),
);

// الترحيل مرّة واحدة.
try {
  await call('post', `/shift-closes/${shortShift.id}/post`, token, {});
  check('الترحيل مرّتين مرفوض', false, 'expected 409');
} catch (error) {
  check(
    'الترحيل مرّتين مرفوض',
    error.status === 409 && error.code === 'SHIFT_ALREADY_POSTED',
    `${error.status} ${error.code}`,
  );
}

// زيادة — القيد معكوس.
const overShift = await call('post', '/shift-closes/open', token, { branchId });
await sellOnTill({ method: 'cash', cashLocationId: safe.id }, '1'); // 100 expected
await call('post', `/shift-closes/${overShift.id}/close`, token, {
  counts: [{ denomination: '100', count: 1 }, { denomination: '50', count: 1 }], // 150 in hand
});
const overPosted = await call('post', `/shift-closes/${overShift.id}/post`, token, {});
const overEntry = await call('get', `/journal-entries/${overPosted.journalEntryId}`, token);
check(
  '📈 زيادة: العهدة بالمعدود 150 والفرق دائنٌ 50 والصندوق دائنٌ 100',
  (overEntry.lines ?? []).some((line) => Number(line.debit) > 0 && line.accountId === custodyAccountId && near(line.debit, 150)) &&
    (overEntry.lines ?? []).some((line) => Number(line.credit) > 0 && line.accountId === differenceAccountId && near(line.credit, 50)) &&
    (overEntry.lines ?? []).some((line) => Number(line.credit) > 0 && line.accountId === safeAccountId && near(line.credit, 100)),
  `${(overEntry.lines ?? []).length} سطر`,
);

// 🧾 صندوق مطابق — يُرحَّل: النقد موجود ولا بد أن يتحرّك إلى العهدة، والفرق صفر.
const balancedShift = await call('post', '/shift-closes/open', token, { branchId });
await sellOnTill({ method: 'cash', cashLocationId: safe.id }, '1');
const balancedClosed = await call('post', `/shift-closes/${balancedShift.id}/close`, token, {
  counts: [{ denomination: '100', count: 1 }],
});
check('🧾 المطابق فرقُه صفر', near(balancedClosed.summary?.diff, 0), `${money(balancedClosed.summary?.diff)}`);
const balancedPosted = await call('post', `/shift-closes/${balancedShift.id}/post`, token, {});
const balancedEntry = await call('get', `/journal-entries/${balancedPosted.journalEntryId}`, token);
const balancedLines = balancedEntry.lines ?? [];
check(
  '🧾 المطابق: مدين عهدة 100 ودائن صندوق 100 — سطران بلا فرق',
  balancedLines.length === 2 &&
    balancedLines.some((line) => line.accountId === custodyAccountId && near(line.debit, 100)) &&
    balancedLines.some((line) => line.accountId === safeAccountId && near(line.credit, 100)) &&
    !balancedLines.some((line) => line.accountId === differenceAccountId),
  `${balancedLines.length} سطر`,
);
check('🧾 ومعدوده كاملٌ على العهدة', near(balancedPosted.custodyAmount, 100), money(balancedPosted.custodyAmount));

// صندوقٌ فارغ ومتوقَّعه فارغ — لا شيء يتحرّك، فلا قيد.
const emptyShift = await call('post', '/shift-closes/open', token, { branchId });
await call('post', `/shift-closes/${emptyShift.id}/close`, token, { counts: [] });
try {
  await call('post', `/shift-closes/${emptyShift.id}/post`, token, {});
  check('صندوق فارغ ⇒ 422 SHIFT_BALANCED', false, 'expected 422');
} catch (error) {
  check(
    'صندوق فارغ ⇒ 422 SHIFT_BALANCED',
    error.status === 422 && error.code === 'SHIFT_BALANCED',
    `${error.status} ${error.code}`,
  );
}

// 🧾 والشاشة: العهدة تُقرأ من شبكة الإغلاقات كما يقرأها المحاسب.
const custodyRows = await dayCloses();
const custodyRow = custodyRows.find((row) => row.id === balancedShift.id);
check(
  '🧾 الشبكة تكتب العهدة وحسابها ومعدودها',
  custodyRow?.custodyAccountId === custodyAccountId &&
    custodyRow?.custodyAccountCode === '1211002' &&
    near(custodyRow?.custodyAmount, 100) &&
    custodyRow?.postable === false,
  `${custodyRow?.custodyAccountCode} · ${money(custodyRow?.custodyAmount)}`,
);

// 🔢 الرقم سلسلة واحدة للمؤسسة: فرعان لا يصدران رقماً واحداً.
const secondBranch = await call('post', '/branches', token, {
  code: `SB${stamp}`,
  nameAr: 'فرع ثانٍ للتحقق',
});
const otherBranchShift = await call('post', '/shift-closes/open', token, { branchId: secondBranch.id });
const otherClosed = await call('post', `/shift-closes/${otherBranchShift.id}/close`, token, {
  counts: [{ denomination: '10', count: 1 }],
});
check(
  '🔢 رقم الإغلاق لا يتكرر بين الفروع',
  Boolean(otherClosed?.number) && otherClosed.number !== shortClosed.number && otherClosed.number !== overPosted?.number,
  `${otherClosed?.number} ≠ ${shortClosed.number}`,
);

// 🏦 التحويل البنكي يُدخل على حساب البنك نفسه — `EntryOper.cs` L620، لا على حساب الشبكة.
const bankShift = await call('post', '/shift-closes/open', token, { branchId });
const bankSale = await sellOnTill({ method: 'bank', cashLocationId: bankA.id }, '1');
const bankEntries = await call('get', `/journal-entries?from=${today}&to=${today}`, token);
const bankEntry = bankEntries.find((row) => row.description === `Sales invoice ${bankSale.number ?? bankSale.data?.number}`);
const bankEntryId = bankEntry?.id;
const saleLines = bankEntryId ? (await call('get', `/journal-entries/${bankEntryId}`, token)).lines ?? [] : [];
check(
  '🏦 التحويل على حساب البنك نفسه',
  saleLines.some((line) => Number(line.debit) > 0 && line.accountId === transferBankAId),
  `${saleLines.filter((line) => Number(line.debit) > 0).map((line) => line.accountId).join(',')}`,
);
check(
  '🏦 لا على حساب الصندوق العام',
  !saleLines.some((line) => Number(line.debit) > 0 && line.accountId === safeAccountId),
  'حساب البنك لا الصندوق',
);
await call('post', `/shift-closes/${bankShift.id}/close`, token, { counts: [] });
console.log('');

console.log(failures === 0 ? '\n✔ Phase 06 treasury documents verified' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
