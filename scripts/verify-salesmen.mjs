#!/usr/bin/env node
/**
 * Live verification of Phase 09 part one — 🧑‍💼 المندوبون والعمولات — against a running
 * stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 🧑‍💼 شاشة المندوبين — البطاقة بالعمولات الثلاث والاتصالات وربط الموظف،
 *      والرفوض الثلاثة، والتحديث الجزئي، والحذف (`frmSalesMen`)
 *   2. 📋 طباعة فواتير مندوب وعمولاتهم — فاتورة محصَّلة وآجلة ومرتجع وإشعار مدين
 *      وسند قبض، والعمولات الثلاث و«🏆 الإجمالي»، و«🌐 الكل» و«📅 الفترة الزمنية»
 *      والفرع (`frmInvBySalesMen`)
 *   3. التنظيف — ما أُنشئ في هذا التشغيل يُلغى، وما لا يمكن إلغاؤه يُعاد استخدامه
 *
 * The script is re-runnable. Documents that cannot be undone — a فاتورة سُدّدت (لا
 * يُلغى سندٌ له تحصيل) وإشعار مدين مُرحَّل — are created **once** and reused on later
 * runs, exactly like the مندوب والصنف والموظف that belong to them; everything else is
 * voided at the end. It leaves no trace behind and it never deletes another tenant's row
 * (there is only one tenant here, but every query is tenant-scoped by the API).
 *
 * Usage: node scripts/verify-salesmen.mjs
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

const round = (value) => Math.round(Number(value) * 100) / 100;

// ---------------------------------------------------------------------------
console.log('1. 🧑‍💼 شاشة المندوبين — البطاقة والعمولات الثلاث');

const cardOne = await post('/sales/salesmen', {
  name: `مندوب أول ${stamp}`,
  commissionRate: '10',
  collectionCommissionRate: '5',
  profitCommissionRate: '20',
  tel: '014567890',
  mobile: '0551234567',
  email: `one${stamp}@example.test`,
  notes: 'مندوب المنطقة الشمالية',
});
check(
  '🧑‍💼 اسم المندوب · عمولة المبيعات · عمولة التحصيل · عمولة الربح',
  cardOne.commissionRate === '10.0000' &&
    cardOne.collectionCommissionRate === '5.0000' &&
    cardOne.profitCommissionRate === '20.0000',
  `${cardOne.name} · ${money(cardOne.commissionRate)} · ${money(cardOne.collectionCommissionRate)} · ${money(cardOne.profitCommissionRate)}`,
);
check(
  '📞 الهاتف · 📱 الجوال · 📧 البريد الإلكتروني · ملاحظات',
  cardOne.tel === '014567890' &&
    cardOne.mobile === '0551234567' &&
    cardOne.email === `one${stamp}@example.test` &&
    cardOne.notes === 'مندوب المنطقة الشمالية',
  `${cardOne.tel} · ${cardOne.mobile} · ${cardOne.email}`,
);

const tooHigh = await refused('post', '/sales/salesmen', { name: `مندوب جشع ${stamp}`, commissionRate: '250' });
check(
  'نسبة العمولة يجب أن تكون بين 0 و100',
  tooHigh.status === 422 && tooHigh.code === 'SALESMAN_RATE_RANGE' && tooHigh.detail === 'نسبة العمولة يجب أن تكون بين 0 و100',
  `${tooHigh.status} ${tooHigh.code}`,
);
const notANumber = await refused('post', '/sales/salesmen', {
  name: `مندوب نص ${stamp}`,
  collectionCommissionRate: 'عشرة',
});
check(
  'نسبة العمولة يجب أن تكون رقماً',
  notANumber.status === 422 && notANumber.code === 'SALESMAN_RATE_INVALID',
  `${notANumber.status} ${notANumber.code}`,
);

const partial = await patch(`/sales/salesmen/${cardOne.id}`, { commissionRate: '12.5' });
check(
  'تحديثٌ جزئي — ما أُرسل وحده يتغيّر',
  partial.commissionRate === '12.5000' &&
    partial.collectionCommissionRate === '5.0000' &&
    partial.profitCommissionRate === '20.0000' &&
    partial.mobile === '0551234567',
  `${money(partial.commissionRate)} · ${money(partial.collectionCommissionRate)} · ${money(partial.profitCommissionRate)}`,
);

const unknownEmployee = await refused('post', '/sales/salesmen', {
  name: `مندوب بلا موظف ${stamp}`,
  employeeId: '00000000-0000-4000-8000-000000000000',
});
check(
  'الموظف غير موجود',
  unknownEmployee.status === 422 && unknownEmployee.code === 'SALESMAN_EMPLOYEE_NOT_FOUND',
  `${unknownEmployee.status} ${unknownEmployee.code}`,
);

// ---------------------------------------------------------------------------
console.log('\n2. 📋 طباعة فواتير مندوب وعمولاتهم — الفواتير والإشعار والسند');

const branchId = (await get('/branches'))[0]?.id;
const warehouseId = (await get('/warehouses'))[0]?.id;
const cashLocationId = (await get('/cash-locations'))[0]?.id;
// 🏢 فرع بلا حركات — the desktop narrows the invoices by `MainClass.BranchNo`, so the
// filter needs a second branch to be worth testing.
const otherBranchId =
  (await get('/branches')).find((row) => row.code === 'VRB2')?.id ??
  (await post('/branches', { code: 'VRB2', nameAr: 'فرع بلا حركات' })).id;

/**
 * 👤 مندوب التحقق — a مندوب whose فاتورة has been settled cannot be undone, and neither
 * can his إشعار مدين, so this script keeps one card, one employee and one item of its
 * own and reuses them on the next run instead of leaving a new row behind every time.
 */
const salesEmployee =
  (await get('/hrm/employees')).find((row) => String(row.employeeNo) === 'VSM-1') ??
  (await post('/hrm/employees', { employeeNo: 'VSM-1', name: 'مندوب التحقق', branchId }));

const existingCards = await get('/sales/salesmen');
const salesman =
  existingCards.find((row) => row.name === 'مندوب التحقق') ??
  (await post('/sales/salesmen', {
    name: 'مندوب التحقق',
    employeeId: salesEmployee.id,
    commissionRate: '10',
    collectionCommissionRate: '5',
    profitCommissionRate: '20',
  }));
// A card left from an earlier version of this script would carry no rates.
await patch(`/sales/salesmen/${salesman.id}`, {
  employeeId: salesEmployee.id,
  commissionRate: '10',
  collectionCommissionRate: '5',
  profitCommissionRate: '20',
  active: true,
});

const categories = await get('/organization/catalog/categories');
const category =
  categories.find((row) => row.code === 'VSC-1') ??
  (await post('/organization/catalog/categories', { code: 'VSC-1', nameAr: 'تصنيف المندوب' }));
const units = await get('/organization/catalog/units');
const unit =
  units.find((row) => row.code === 'VSU-1') ??
  (await post('/organization/catalog/units', { code: 'VSU-1', nameAr: 'وحدة المندوب' }));
const itemId =
  (await get('/organization/catalog/items')).find((row) => row.sku === 'VSI-1')?.id ??
  (await post('/organization/catalog/items', {
    sku: 'VSI-1',
    nameAr: 'صنف المندوب',
    categoryId: category.id,
    baseUnitId: unit.id,
    salePrice: '100',
  })).id;

// بضاعة أول المدة — a فاتورة cannot be posted out of a warehouse that has none, and the
// 40 a unit is the cost «عمولة الربح» is measured against.
await post('/inventory/ledger/record', {
  lines: [
    { itemId, warehouseId, qty: '1000', unitCost: '40', direction: 'in', docType: 'opening', docId: '00000000-0000-0000-0000-000000000001' },
  ],
});

const reportPath = (query) => `/sales/salesmen/commissions?${query}`;
const report = (query) => get(reportPath(query));
const rowsOf = async (query) => (await report(query)).rows;

const empty = await report('');
check(
  'قبل أي حركة — «🌐 الكل» و«كل الفترة» مفعّلان، والتاريخان اليوم',
  empty.allSalesmen === true &&
    empty.allPeriod === true &&
    empty.from === new Date().toISOString().slice(0, 10) &&
    empty.to === new Date().toISOString().slice(0, 10),
  `${empty.from} → ${empty.to}`,
);

const invoice = async (body) => {
  const created = await post('/sales/invoices', { cashCustomerName: 'عميل نقدي', ...body });
  const posted = await post(`/sales/invoices/${created.id}/post`, {});
  // نقدي — `pay_type` is set by collecting, and «عمولة التحصيل» follows it.
  if (body.settlement) {
    await post(`/sales/invoices/${posted.id}/payments`, {
      method: 'cash',
      amount: posted.total,
      idempotencyKey: `verify-${posted.id}`,
      cashLocationId,
    });
  }
  return posted;
};

/**
 * فاتورة محصَّلة — created once and never voided: «لا يمكن إلغاء فاتورة لها تحصيل».
 * It is the only document in this report that earns «عمولة التحصيل» on a فاتورة.
 */
let settled = (await rowsOf('')).find(
  (row) => row.movementType === 'فاتورة بيع' && Number(row.collectionCommission) > 0,
);
if (!settled) {
  const posted = await invoice({
    branchId,
    warehouseId,
    salesmanId: salesman.id,
    settlement: true,
    lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '0' }],
  });
  settled = { documentId: posted.id, number: posted.number, created: true };
}
const settledRow = (await rowsOf('')).find((row) => row.documentId === settled.documentId);
check(
  'فاتورة محصَّلة — «عمولة التحصيل» لأن الفاتورة سُدّدت',
  settledRow &&
    Number(settledRow.value) === 200 &&
    Number(settledRow.salesCommission) === 20 &&
    round(settledRow.collectionCommission) === round(Number(settledRow.value) * 0.05) &&
    Number(settledRow.profitCommission) === 24,
  `${settledRow?.number ?? settled.number} · قيمة ${money(settledRow?.value ?? 0)} · مبيعات ${money(settledRow?.salesCommission ?? 0)} · تحصيل ${money(settledRow?.collectionCommission ?? 0)} · ربح ${money(settledRow?.profitCommission ?? 0)}`,
);

// فاتورة آجلة — no collection yet, so no «عمولة التحصيل».
const credit = await invoice({
  branchId,
  warehouseId,
  salesmanId: salesman.id,
  lines: [{ itemId, quantity: '3', unitPrice: '100', taxRate: '0' }],
});
const creditRow = (await rowsOf('')).find((row) => row.documentId === credit.id);
check(
  'فاتورة آجلة — لا عمولة تحصيل بلا تحصيل',
  creditRow &&
    Number(creditRow.value) === 300 &&
    Number(creditRow.salesCommission) === 30 &&
    Number(creditRow.collectionCommission) === 0 &&
    Number(creditRow.profitCommission) === 36,
  `${credit.number} · قيمة ${money(creditRow?.value ?? 0)} · تحصيل ${money(creditRow?.collectionCommission ?? 0)}`,
);

const returnDraft = await post(`/sales/invoices/${credit.id}/return`, {
  branchId,
  warehouseId,
  salesmanId: salesman.id,
  cashCustomerName: 'عميل نقدي',
  lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '0' }],
});
const returned = await post(`/sales/invoices/${returnDraft.id}/post`, {});
const returnRow = (await rowsOf('')).find((row) => row.documentId === returned.id);
check(
  'فاتورة مرتجع بيع — علامةٌ سالبة',
  returnRow &&
    returnRow.movementType === 'فاتورة مرتجع بيع' &&
    returnRow.isPlus === -1 &&
    Number(returnRow.value) === 100 &&
    Number(returnRow.salesCommission) === 10 &&
    Number(returnRow.profitCommission) === 12,
  `${returned.number} · قيمة ${money(returnRow?.value ?? 0)} · isPlus ${returnRow?.isPlus}`,
);

/**
 * إشعار مدين — a posted note cannot be undone either, so it too is created once. Its
 * commission is taken back, never a profit one.
 */
let note = (await rowsOf('')).find((row) => row.movementType === 'إشعار مدين');
if (!note) {
  const created = await post(`/sales/invoices/${settled.documentId}/adjustment-notes`, {
    branchId,
    kind: 'debit',
    reason: 'فرق سعر',
    amount: '50',
  });
  await post(`/sales/adjustment-notes/${created.id}/post`, {});
  note = (await rowsOf('')).find((row) => row.movementType === 'إشعار مدين');
}
check(
  'إشعار مدين — يستردّ عمولة المبيعات والتحصيل فقط',
  note &&
    note.isPlus === -1 &&
    Number(note.value) === 50 &&
    Number(note.salesCommission) === 5 &&
    Number(note.collectionCommission) === 2.5 &&
    Number(note.profitCommission) === 0,
  `${note?.number ?? '—'} · قيمة ${money(note?.value ?? 0)} · مبيعات ${money(note?.salesCommission ?? 0)} · تحصيل ${money(note?.collectionCommission ?? 0)}`,
);

const voucherDraft = await post('/vouchers', {
  branchId,
  kind: 'receipt',
  subtype: 'customer',
  date: new Date().toISOString().slice(0, 10),
  cashLocationId,
  method: 'cash',
  amount: '1150',
  vatAmount: '150',
  netAmount: '1000',
  salesmanId: salesEmployee.id,
});
const voucher = await post(`/vouchers/${voucherDraft.id}/post`, {});
const voucherRow = (await rowsOf('')).find((row) => row.documentId === voucher.id);
check(
  'سند قبض عميل — القيمة بلا ضريبة، والعمولة على ما قُبض',
  voucherRow &&
    voucherRow.movementType === 'سند قبض عميل' &&
    Number(voucherRow.value) === 1000 &&
    Number(voucherRow.collectionCommission) === 57.5 &&
    Number(voucherRow.salesCommission) === 0,
  `${voucher.number} · قيمة ${money(voucherRow?.value ?? 0)} · تحصيل ${money(voucherRow?.collectionCommission ?? 0)}`,
);

const all = await report('');
const signed = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key]) * row.isPlus, 0);
check(
  '🏆 الإجمالي — القيمة والعمولات بإشارتها',
  round(all.summary.totalValue) === round(signed(all.rows, 'value')) &&
    round(all.summary.salesCommission) === round(signed(all.rows, 'salesCommission')) &&
    round(all.summary.collectionCommission) === round(signed(all.rows, 'collectionCommission')) &&
    round(all.summary.profitCommission) === round(signed(all.rows, 'profitCommission')) &&
    all.summary.rows === all.rows.length,
  `💰 ${money(all.summary.totalValue)} · 📈 ${money(all.summary.salesCommission)} · 💳 ${money(all.summary.collectionCommission)} · 📊 ${money(all.summary.profitCommission)}`,
);

const mine = await report(`salesman_id=${salesman.id}`);
check(
  '👤 المندوب — صفوفه وحدها',
  mine.salesmanName === 'مندوب التحقق' &&
    mine.rows.every((row) => row.salesmanId === salesman.id) &&
    mine.rows.length > 0,
  `${mine.rows.length} صف · ${mine.salesmanName}`,
);
const nonePicked = await report('all_salesmen=0');
check(
  '🌐 الكل — بلا مندوب مختار يبقى كل المندوبين',
  nonePicked.rows.length === all.rows.length,
  `${nonePicked.rows.length} صف`,
);

const outside = await report('all_period=0&from=2000-01-01&to=2000-01-31');
check(
  '📅 الفترة الزمنية — لا فاتورة ولا سند خارج التاريخين',
  outside.summary.invoices === 0 && outside.summary.receipts === 0 && outside.summary.rows === 0,
  `${outside.summary.rows} صف`,
);

const otherBranch = await report(`branch_id=${otherBranchId}`);
check(
  '🏢 الفرع — الفواتير تُقيَّد بالفرع، والسندات لا (كما في النافذة)',
  otherBranch.summary.invoices === 0 &&
    otherBranch.rows.every((row) => row.movementType === 'سند قبض عميل'),
  `${otherBranch.summary.invoices} فاتورة · ${otherBranch.rows.length} صف`,
);

// ---------------------------------------------------------------------------
console.log('\n3. التنظيف — ما أُنشئ في هذا التشغيل يُلغى');

const voidCredit = await refused('post', `/sales/invoices/${credit.id}/void`, { reason: 'تحقق' });
const voidReturn = await refused('post', `/sales/invoices/${returned.id}/void`, { reason: 'تحقق' });
const voidVoucher = await refused('post', `/vouchers/${voucher.id}/void`, { reason: 'تحقق' });
check(
  'أُلغيت الوثائق التي يمكن إلغاؤها',
  // `refused()` answers 200 when nothing was refused — the void simply went through.
  voidCredit.status === 200 && voidReturn.status === 200 && voidVoucher.status === 200,
  `${credit.number} · ${returned.number} · ${voucher.number}`,
);

const after = await rowsOf('');
check(
  'لا أثر للوثائق المُلغاة',
  !after.some((row) => [credit.id, returned.id, voucher.id].includes(row.documentId)),
  `${after.length} صف باقٍ (الفاتورة المحصَّلة وإشعار المدين لا يُلغيان)`,
);

const removed = await refused('delete', `/sales/salesmen/${cardOne.id}`);
check('حُذفت بطاقة التحقق المؤقتة', removed.status === 200, `${removed.status}`);

const leftover = await get('/sales/salesmen');
check(
  'لا بطاقة مؤقتة باقية — ويبقى مندوب التحقق ما بقيت فواتيره',
  !leftover.some((row) => String(row.name).includes(stamp)) &&
    leftover.some((row) => row.name === 'مندوب التحقق'),
  `${leftover.length} بطاقة`,
);

console.log(
  `\n${failures === 0 ? '✔' : '✘'} 🧑‍💼 المندوبون والعمولات — ${failures} فشل · ${money(all.summary.totalValue)} إجمالي القيمة · ${money(all.summary.salesCommission)} ع. المبيعات · ${money(all.summary.collectionCommission)} ع. التحصيل · ${money(all.summary.profitCommission)} ع. الربح`,
);
process.exit(failures === 0 ? 0 : 1);
