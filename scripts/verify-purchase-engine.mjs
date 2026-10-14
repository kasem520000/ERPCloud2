#!/usr/bin/env node
/**
 * Live verification of R3 — «مطابقة نافذة فاتورة المشتريات»
 * (`docs/roadmap/AUDIT_PHASES_01_04.md` §6، تكملة المرحلة 03) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * المصادر المكتبية التي تُقابلها كل نقطة:
 *   `Form_WPF/frmInvPurch.xaml`        — النافذة: «👤 اسم المورد» · «🏪 المستودع» · «💳 طريقة الدفع»
 *                                        ولوحة الإجماليات L1056–L1101 والأزرار L1406–L1433
 *   `Form_WPF/frmInvPurch.xaml.cs`     — معالجات الحفظ والحذف وشروطها
 *   `Class/ItemOper.cs` `AvgCost` (L162) و`ItemAdditonalCos` (L2086)
 *                                      — المتوسط المتحرّك، وتوزيع التكاليف الإضافية
 *                                        (`cost × (itemTotal / invTotal) / qty`)
 *   `Class/InvoiceOper.cs`            — مرآة الشراء في `BindToEntry` (مورّد دائن / مشتريات مدين …)
 *
 * ما يقيسه هذا السكربت (أرقام §3D التي كانت ثابتةً في الوثيقة منذ 2026-09-10):
 *
 *   1. 📖 خطّ الأساس — الفرع والمستودع وحسابات المشتريات السبعة قبل أن تُمسّ القاعدة
 *   2. 🧾 التهيئة — صنفٌ برصيدٍ افتتاحي 48 @40 ومورّد وصنف خدمة وموقع نقديّ
 *   3. 🧮 الحساب — 10×100 − 20 @15% + 100 شحن ⇒ **1227**
 *   4. 📒 الترحيل — رقم `PI-` والقيد الرباعي بالحسابات (Dr بضاعة 1100 · Dr ضريبة 147 ·
 *      Cr خصم مكتسب 20 · Cr مورد 1227) ووسم السطر بتكلفة الوصول 108
 *   5. 📦 المتوسط المتحرّك — 48@40 + 10@108 ⇒ **58 @51.7241** (`ItemOper.AvgCost`)
 *   6. ↩️ المردود — يعود بسعر المتوسط لا بسعر الفاتورة، وفرق السعر يذهب إلى COGS
 *   7. 🔗 سلسلة المستندات (R3) — لا إلغاءَ لفاتورةٍ عليها مردودٌ مُرحَّل، ولا ترحيلَ
 *      مردودٍ إلى فاتورةٍ ملغاة
 *   8. 💵 الدفعات — صفوف التخصيص تُقرأ من `GET /purchase-invoices/:id` (كانت مخفيّة)
 *   9. 🚫 الرفض — مستودعٌ لأصنافٍ مخزنية لا لخدمة، وحسابٌ لتكاليف المصروف المباشر
 *  10. 🧹 التنظيف — العدّادات بالفرق، ولا مستندَ مُرحَّلاً يشير إلى فاتورةٍ ملغاة
 *
 * Re-runnable and non-destructive: كل عدّادٍ بالفرق (لا رقم مطلق)، والأرقام التسلسلية تُقرأ
 * ولا تُفترض، والصنف والمورد يُنشآن ببادئة `-${stamp}`، وما لا يُحذف (فواتيرُ الفحص) يبقى
 * مرقّماً ولا يُفسد تشغيلاً لاحقاً.
 *
 * Usage: node scripts/verify-purchase-engine.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const owner = {
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
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
    error.detail = parsed.detail ?? parsed.message;
    error.errors = parsed.errors ?? [];
    throw error;
  }
  return parsed.data ?? parsed;
}

/** نداءٌ **يُتوقَّع** رفضه: حالته ورمزه هما الجواب. */
async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '', detail: '', errors: [] };
  } catch (error) {
    return {
      status: error.status ?? 0,
      code: error.code ?? '',
      detail: error.detail ?? '',
      errors: error.errors ?? [],
    };
  }
}

async function signIn(credentials) {
  // المنصّة تخنق `/auth/login` لكل عنوان، والتشغيل يسجّل دخولاً واحداً؛ والـ429 ليس فشلاً.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const next = login.accessToken ?? login.access_token ?? login.token;
      if (!next) throw new Error(`login failed for ${credentials.email}`);
      return next;
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const get = (path) => request('get', path);
const post = (path, body) => request('post', path, body);
const list = (path) => get(path).then((view) => view.data ?? view);

token = await signIn(owner);
console.log(`✔ logged in to ${tenantCode} as ${owner.email}\n`);

// ══════════════════════════════════════════════════════ 1. 📖 خطّ الأساس
console.log('■ 1. 📖 خطّ الأساس — القاعدة كما هي قبل أن تُمسّ');
const branches = await list('/branches');
const warehouses = await list('/warehouses');
const branchId = branches[0]?.id;
const warehouseId = warehouses[0]?.id;
const accounts = await list('/accounts?limit=200');
const accountByCode = new Map(accounts.map((row) => [row.code, row]));
const baselineInvoices = (await list('/purchase-invoices')).length;
const baselineEntries = (await list('/journal-entries?limit=200')).length;
check('فرعٌ ومستودع في مستأجر العرض', Boolean(branchId && warehouseId), `${branches[0]?.code} · ${warehouses[0]?.name}`);
const NEEDED = {
  3200001: 'المشتريات',
  3200002: 'مردودات المشتريات',
  3200003: 'خصم مكتسب',
  2222001: 'ضريبة القيمة المضافة (مدخلات)',
  1270001: 'حساب بضاعة آخر المدة',
  22111001: 'مورد عام',
  3200004: 'تكلفة المبيعات',
};
const missing = Object.keys(NEEDED).filter((code) => !accountByCode.get(code)?.isPostable);
check(
  'حسابات المشتريات السبعة موجودةٌ وقابلةٌ للترحيل',
  missing.length === 0,
  missing.length ? `ناقص: ${missing.join('، ')}` : Object.keys(NEEDED).join('، '),
);
check(
  'العدّادان يُقرآن — وكل فحصٍ لاحقٍ بالفرق لا بالرقم المطلق',
  Number.isInteger(baselineInvoices) && Number.isInteger(baselineEntries),
  `${baselineInvoices} فاتورة مشتريات · ${baselineEntries} قيد`,
);

// ══════════════════════════════════════════════════════ 2. 🧾 التهيئة
console.log('\n■ 2. 🧾 التهيئة — صنفٌ برصيد 48 @40 ومورّد');
const stamp = Date.now().toString(36).toUpperCase();
const unitId = (await post('/organization/catalog/units', { code: `PU-${stamp}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `PC-${stamp}`, nameAr: 'عام' })).id;
const item = await post('/organization/catalog/items', {
  sku: `PVAR-${stamp}`,
  nameAr: 'صنف تحقّق محرّك الشراء',
  categoryId,
  baseUnitId: unitId,
  kind: 'stock',
  purchasePrice: '100',
});
// الرصيد الافتتاحي 48 @40 — خطُّ الأساس المُعلَن في §3D.
await post('/inventory/ledger/record', {
  lines: [
    {
      itemId: item.id,
      warehouseId,
      qty: '48',
      unitCost: '40',
      direction: 'in',
      docType: 'opening',
      docId: '00000000-0000-4000-8000-0000000000c3',
    },
  ],
});
const supplier = await post('/parties', { kind: 'supplier', name: 'مورد تحقّق محرّك الشراء' });
const serviceItem = await post('/organization/catalog/items', {
  sku: `PSVC-${stamp}`,
  nameAr: 'خدمة تحقّق محرّك الشراء',
  categoryId,
  baseUnitId: unitId,
  kind: 'service',
  purchasePrice: '50',
});
const cashLocations = await list('/cash-locations');
const cashLocation = cashLocations.find((row) => row.kind === 'cash') ?? cashLocations[0];

/** صفّ الرصيد: الكمية والمتوسط والقيمة معاً (‏`stock_balances`). */
const balanceOf = async () => {
  const rows = await list(`/inventory/levels?warehouse_id=${warehouseId}&item_id=${item.id}`);
  return {
    quantity: String(rows[0]?.quantity ?? '0'),
    averageCost: String(rows[0]?.averageCost ?? '0'),
    value: String(rows[0]?.value ?? '0'),
  };
};
const before = await balanceOf();
check('الصنف أُنشئ بسعر شراء 100', item.purchasePrice === '100.0000', `${item.sku} · ${item.purchasePrice}`);
check(
  'الرصيد الافتتاحي 48 @40',
  before.quantity === '48.0000' && before.averageCost === '40.0000',
  `${before.quantity} @${before.averageCost} = ${before.value}`,
);
check('مورّدٌ وموقعٌ نقديّ للتحصيل', Boolean(supplier.id && cashLocation?.id), `${supplier.name} · ${cashLocation?.name ?? '—'} (${cashLocation?.kind ?? '—'})`);

/** فاتورة شراءٍ 10×100 بخصم رأس 20 — الحالة المرجعية في §3D. */
const purchaseDraft = (extra = {}) =>
  post('/purchase-invoices', {
    branchId,
    warehouseId,
    partyId: supplier.id,
    invoiceDiscount: '20',
    lines: [{ itemId: item.id, quantity: '10', unitPrice: '100', taxRate: '15' }],
    ...extra,
  });

// ══════════════════════════════════════════════════════ 3. 🧮 الحساب
console.log('\n■ 3. 🧮 الحساب — خصمُ الرأس يُخفّض وعاء الضريبة (بديل `ItemAdditonalCos`)');
const draft = await purchaseDraft();
check(
  '10×100 − 20 @15% ⇒ 980 / 147 / 1127',
  draft.subtotal === '980.0000' && draft.taxTotal === '147.0000' && draft.total === '1127.0000',
  `${draft.subtotal} · ${draft.taxTotal} · ${draft.total}`,
);
check('والمسودّة بلا رقمٍ رسميّ بعد', draft.status === 'draft' && draft.number === null, `${draft.status} · ${draft.number}`);

const freight = await post(`/purchase-invoices/${draft.id}/costs`, {
  costName: 'شحن',
  amount: '100',
  allocationTarget: 'inventory',
});
check('تكلفةُ شحنٍ 100 تُخصَّص على المخزون', freight.amount === '100.0000', `${freight.costName} · ${freight.allocationTarget}`);
const preview = await get(`/purchase-invoices/${draft.id}/landed-cost`);
check(
  'والتوزيع بالنسبة (‏`ItemAdditonalCos`: 100 × 1000/1000 ÷ 10 = 10 للوحدة) ⇒ تكلفة الوحدة النهائية 108',
  Number(preview.lines[0]?.allocatedCost) === 100 && Number(preview.lines[0]?.effectiveUnitCost) === 108,
  `نصيب السطر ${preview.lines[0]?.allocatedCost} · تكلفة الوحدة ${preview.lines[0]?.effectiveUnitCost} · صافي السطر ${preview.lines[0]?.net}`,
);

// ══════════════════════════════════════════════════════ 4. 📒 الترحيل
console.log('\n■ 4. 📒 الترحيل — `SaveInvoice` + `BindToEntry` في معاملةٍ واحدة');
const posted = await post(`/purchase-invoices/${draft.id}/post`, {});
check(
  'الفاتورة صارت `posted` برقم PI- ومجموعها 1227',
  posted.status === 'posted' && /^PI-\d{6}$/.test(posted.number ?? '') && posted.total === '1227.0000',
  `${posted.status} · ${posted.number} · ${posted.total} (تكاليف إضافية ${posted.additionalCostTotal})`,
);
check(
  'والسطر موسومٌ بتكلفة الوصول 108',
  posted.lines[0]?.unitCostAtPost === '108.0000' && posted.lines[0]?.landedTotal === '1080.0000',
  `وحدة ${posted.lines[0]?.unitCostAtPost} · إجمالي السطر ${posted.lines[0]?.landedTotal}`,
);

const entries = await list('/journal-entries?limit=200');
const entry = entries.find((row) => row.description === `Purchase invoice ${posted.number}` && row.kind !== 'reversal');
check('قيد الفاتورة كُتب تلقائياً', Boolean(entry), entry?.kind ?? '—');
const entryDetail = entry ? await get(`/journal-entries/${entry.id}`) : { lines: [] };
const legs = (entryDetail.lines ?? [])
  .map((row) => {
    const code = [...accountByCode.entries()].find(([, account]) => account.id === row.accountId)?.[0] ?? row.accountId;
    return `${Number(row.debit) > 0 ? 'Dr' : 'Cr'} ${code} ${Number(row.debit) > 0 ? row.debit : row.credit}`;
  })
  .sort();
const expectedLegs = [
  'Cr 22111001 1227.0000',
  'Cr 3200003 20.0000',
  'Dr 1270001 1100.0000',
  'Dr 2222001 147.0000',
].sort();
check(
  'القيد الرباعي بحساباته هو هو (§3D)',
  JSON.stringify(legs) === JSON.stringify(expectedLegs),
  legs.join(' · '),
);
const debitSum = (entryDetail.lines ?? []).reduce((sum, row) => sum + Number(row.debit), 0);
const creditSum = (entryDetail.lines ?? []).reduce((sum, row) => sum + Number(row.credit), 0);
check(
  'والمدين يساوي الدائن (لا قيدَ غير متوازن)',
  debitSum.toFixed(4) === creditSum.toFixed(4),
  `${debitSum.toFixed(4)} = ${creditSum.toFixed(4)}`,
);

// ══════════════════════════════════════════════════════ 5. 📦 المتوسط المتحرّك
console.log('\n■ 5. 📦 المتوسط المتحرّك — `ItemOper.AvgCost` (L162)');
const afterReceipt = await balanceOf();
check(
  '48@40 + 10@108 ⇒ 58 وحدة وقيمة 3000',
  afterReceipt.quantity === '58.0000' && afterReceipt.value === '3000.0000',
  `${afterReceipt.quantity} · ${afterReceipt.value}`,
);
check(
  'والمتوسط 51.7241 (3000 ÷ 58) — لا 40 ولا 108',
  afterReceipt.averageCost === '51.7241',
  afterReceipt.averageCost,
);

// ══════════════════════════════════════════════════════ 6. ↩️ المردود
console.log('\n■ 6. ↩️ المردود — يصرف بسعر المتوسط وفرق السعر يذهب إلى COGS');
const returnDraft = await post('/purchase-invoices', {
  branchId,
  warehouseId,
  partyId: supplier.id,
  kind: 'purchase_return',
  referenceInvoiceId: draft.id,
  lines: [{ itemId: item.id, quantity: '2', unitPrice: '100', taxRate: '15' }],
});
const returned = await post(`/purchase-invoices/${returnDraft.id}/post`, {});
check(
  'المردود مُرحَّلٌ برقم PR- ويشير إلى فاتورته',
  returned.status === 'posted' && /^PR-\d{6}$/.test(returned.number ?? '') && returned.referenceInvoiceId === draft.id,
  `${returned.status} · ${returned.number}`,
);
const afterReturn = await balanceOf();
check(
  'والمخزون 58 ⇒ 56 بسعر المتوسط نفسه',
  afterReturn.quantity === '56.0000' && afterReturn.averageCost === '51.7241',
  `${afterReturn.quantity} @${afterReturn.averageCost} = ${afterReturn.value}`,
);
const returnLegs = (await get(`/journal-entries/${(await list('/journal-entries?limit=200')).find((row) => row.description === `Purchase return ${returned.number}`).id}`)).lines
  .map((row) => {
    const code = [...accountByCode.entries()].find(([, account]) => account.id === row.accountId)?.[0] ?? row.accountId;
    return `${Number(row.debit) > 0 ? 'Dr' : 'Cr'} ${code} ${Number(row.debit) > 0 ? row.debit : row.credit}`;
  })
  .sort();
check(
  'وقيدُ المردود: مدينٌ للمورّد 230 وضريبةٌ مدينة 30 ودائنٌ للبضاعة 103.4483',
  returnLegs.includes('Dr 22111001 230.0000') && returnLegs.includes('Cr 2222001 30.0000') && returnLegs.includes('Cr 1270001 103.4483'),
  returnLegs.join(' · '),
);
// القيد يقفل بفرق المتوسط دائناً لـCOGS: البضاعة عادت بقيمتها الدفترية (103.4483) والمورّد
// أعاد 196 صافياً، فالفرق 96.5517 تخفيضٌ لتكلفة المبيعات لا زيادةٌ في قيمة البضاعة.
check(
  'وفرق المتوسط (96.5517) يُغلق القيد في COGS لا في البضاعة',
  returnLegs.includes('Cr 3200004 96.5517'),
  returnLegs.find((leg) => leg.includes('3200004')) ?? '—',
);

// ══════════════════════════════════════════════════════ 7. 🔗 سلسلة المستندات
console.log('\n■ 7. 🔗 سلسلة المستندات — لا مرجعٌ معلّق إلى فاتورةٍ ملغاة');
const blockedVoid = await refused('post', `/purchase-invoices/${draft.id}/void`, { reason: 'إلغاءٌ والمردود قائم' });
check(
  'إلغاء فاتورةٍ عليها مردودٌ مُرحَّل يُرفض 409',
  blockedVoid.status === 409 && blockedVoid.code === 'PURCHASE_VOID_HAS_RETURNS',
  `${blockedVoid.status} ${blockedVoid.code}`,
);
check(
  'والرفض يسمّي المستند الذي يحجب',
  blockedVoid.errors?.[0]?.count === 1 && blockedVoid.errors?.[0]?.references?.[0]?.id === returned.id,
  `${blockedVoid.errors?.[0]?.count} مستند · ${blockedVoid.errors?.[0]?.references?.[0]?.number ?? '—'}`,
);
const untouched = await get(`/purchase-invoices/${draft.id}`);
check('والفاتورة لم تُمسّ — الرفض قبل أي كتابة', untouched.status === 'posted', untouched.status);

// الوجه الآخر: مردودٌ **مسودّة** أثرُه صفر فلا يحجب، لكن ترحيله بعد الإلغاء ممنوع.
const lateInvoice = await (async () => {
  const created = await purchaseDraft({ invoiceDiscount: undefined });
  return post(`/purchase-invoices/${created.id}/post`, {});
})();
const lateReturn = await post('/purchase-invoices', {
  branchId,
  warehouseId,
  partyId: supplier.id,
  kind: 'purchase_return',
  referenceInvoiceId: lateInvoice.id,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '100', taxRate: '15' }],
});
const levelBeforeLateVoid = await balanceOf();
const lateVoid = await post(`/purchase-invoices/${lateInvoice.id}/void`, { reason: 'إلغاءٌ والمردود مسودّة' });
check(
  'وإلغاء الفاتورة يمرّ ما دام المردود مسودّة (لا أثر لها)',
  lateVoid.status === 'voided',
  `${lateVoid.status} · الرصيد ${levelBeforeLateVoid.quantity} ⇒ ${(await balanceOf()).quantity}`,
);
const latePost = await refused('post', `/purchase-invoices/${lateReturn.id}/post`, {});
check(
  'لكن ترحيل المردود بعد إلغاء الفاتورة يُرفض 409',
  latePost.status === 409 && latePost.code === 'PURCHASE_REFERENCE_VOIDED',
  `${latePost.status} ${latePost.code}`,
);
const lateReturnAfter = await get(`/purchase-invoices/${lateReturn.id}`);
check('والمسودّة بقيت مسودة (لا قيد ولا مخزون)', lateReturnAfter.status === 'draft', lateReturnAfter.status);

// وإلغاء المردود يفتح باب إلغاء الفاتورة — لا حبسَ مقصوداً في الحاجز.
const voidedReturn = await post(`/purchase-invoices/${returned.id}/void`, { reason: 'إلغاء المردود أولاً' });
check('إلغاء المردود يمرّ', voidedReturn.status === 'voided', voidedReturn.status);
const voidedInvoice = await post(`/purchase-invoices/${draft.id}/void`, { reason: 'لم يبقَ مردودٌ مُرحَّل' });
check('وإلغاء الفاتورة يمرّ بعده', voidedInvoice.status === 'voided', voidedInvoice.status);
const afterVoids = await balanceOf();
// 56 + 2 (عكس المردود) − 10 (عكس فاتورة §7 التي أُلغي إدخالها) = 48، والقيمة تعود إلى
// 1920 بالضبط (48 × 40) — وهو ما كان يفشل قبل إصلاح `outAtOriginalCost` (R3.4).
check(
  'والمخزون عاد 48 وقيمتُه 1920 (لم يعلق فرقٌ في المخزون)',
  afterVoids.quantity === '48.0000' && afterVoids.averageCost === '40.0000' && Math.abs(Number(afterVoids.value) - 1920) < 0.001,
  `${afterVoids.quantity} @${afterVoids.averageCost} = ${afterVoids.value} (فارق التدوير ${(Number(afterVoids.value) - 1920).toFixed(4)})`,
);

// ══════════════════════════════════════════════════════ 8. 💵 الدفعات
console.log('\n■ 8. 💵 الدفعات — صفوف التخصيص تُقرأ من الفاتورة (متابعة §3D المغلقة)');
const cashDraft = await purchaseDraft({ invoiceDiscount: undefined });
const cashPosted = await post(`/purchase-invoices/${cashDraft.id}/post`, {
  settlement: cashLocation.kind === 'cash' ? 'cash' : 'bank',
  settlementAccountId: cashLocation.accountId,
  settlementCashLocationId: cashLocation.id,
});
check(
  'فاتورةٌ نقدية 10×100 @15% ⇒ 1150 مدفوعةٌ كاملة',
  cashPosted.total === '1150.0000' && cashPosted.paidTotal === '1150.0000' && cashPosted.paymentStatus === 'paid',
  `${cashPosted.total} · ${cashPosted.paidTotal} · ${cashPosted.paymentStatus}`,
);
const cashDetail = await get(`/purchase-invoices/${cashPosted.id}`);
check(
  'و`payments` تُعيد صفَّ الدفعة (كان `paidTotal` وحده)',
  Array.isArray(cashDetail.payments) && cashDetail.payments.length === 1 && cashDetail.payments[0]?.amount === '1150.0000',
  `${(cashDetail.payments ?? []).length} دفعة · ${cashDetail.payments?.[0]?.amount ?? '—'}`,
);
const creditDraft = await purchaseDraft({ invoiceDiscount: undefined });
const creditPosted = await post(`/purchase-invoices/${creditDraft.id}/post`, {});
await post(`/purchase-invoices/${creditPosted.id}/payments`, { amount: '50' });
const creditDetail = await get(`/purchase-invoices/${creditPosted.id}`);
check(
  'ودفعةٌ جزئية لاحقة تظهر هي الأخرى بحالتها',
  creditDetail.payments?.length === 1 && creditDetail.payments[0]?.amount === '50.0000' && creditDetail.paymentStatus === 'partial',
  `${creditDetail.payments?.[0]?.amount ?? '—'} · ${creditDetail.paymentStatus} · المدفوع ${creditDetail.paidTotal}`,
);

// ══════════════════════════════════════════════════════ 9. 🚫 الرفض
console.log('\n■ 9. 🚫 الرفض — أبوابٌ مغلقة بعبارات الديسكتوب');
// بلا مستودعٍ في المسودّة نفسها: القيد يقع عند الترحيل لا عند الإنشاء.
const warehouseLess = await post('/purchase-invoices', {
  branchId,
  partyId: supplier.id,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '100', taxRate: '15' }],
});
const missingWarehouse = await refused('post', `/purchase-invoices/${warehouseLess.id}/post`, {});
check(
  'فاتورةُ أصنافٍ مخزنية بلا مستودع تُرفض',
  missingWarehouse.status === 422 && missingWarehouse.code === 'PURCHASE_WAREHOUSE_REQUIRED',
  `${missingWarehouse.status} ${missingWarehouse.code}`,
);
const serviceDraft = await post('/purchase-invoices', {
  branchId,
  partyId: supplier.id,
  lines: [{ itemId: serviceItem.id, quantity: '2', unitPrice: '50', taxRate: '15' }],
});
const servicePosted = await post(`/purchase-invoices/${serviceDraft.id}/post`, {});
check('وفاتورة خدمةٍ بلا مستودع تُرحَّل', servicePosted.status === 'posted' && servicePosted.total === '115.0000', `${servicePosted.number} · ${servicePosted.total}`);

const noAccount = await purchaseDraft({ invoiceDiscount: undefined });
await post(`/purchase-invoices/${noAccount.id}/costs`, { costName: 'نقل', amount: '30', allocationTarget: 'expense' });
const expenseRefused = await refused('post', `/purchase-invoices/${noAccount.id}/post`, {});
check(
  'وتكلفةٌ إضافية مباشرة بلا حساب تُرفض بالاسم',
  expenseRefused.status === 422 && expenseRefused.code === 'PURCHASE_COST_ACCOUNT_REQUIRED',
  `${expenseRefused.status} ${expenseRefused.code}`,
);

const paidVoid = await refused('post', `/purchase-invoices/${cashPosted.id}/void`, { reason: 'فاتورةٌ مدفوعة' });
check(
  'وفاتورةٌ مدفوعة لا تُلغى — تُردّ الدفعة أولاً',
  paidVoid.status === 409 && paidVoid.code === 'PURCHASE_VOID_HAS_PAYMENTS',
  `${paidVoid.status} ${paidVoid.code}`,
);

const entriesBeforeTwice = (await list('/journal-entries?limit=200')).length;
const twice = await post(`/purchase-invoices/${cashPosted.id}/post`, {});
const entriesAfterTwice = (await list('/journal-entries?limit=200')).length;
check(
  'وفاتورةٌ مرّحّلة لا تُرحَّل مرّتين — نفس الرقم ولا قيدَ ثانٍ',
  twice.number === cashPosted.number && entriesAfterTwice === entriesBeforeTwice,
  `${twice.number ?? twice.code} · القيود ${entriesBeforeTwice} ⇒ ${entriesAfterTwice}`,
);

// ══════════════════════════════════════════════════════ 10. 🧹 التنظيف
console.log('\n■ 10. 🧹 التنظيف — العدّادات والمراجع إلى خطّ أساسها');
const finalInvoices = (await list('/purchase-invoices')).length;
const finalEntries = (await list('/journal-entries?limit=200')).length;
check('الفواتير التي أُنشئت للفحص بقيت مرقّمةً (لا حذف)', finalInvoices > baselineInvoices, `${finalInvoices} بعد ${baselineInvoices} قبل`);
check('والقيود زادت بمقدار ما رُحّل', finalEntries > baselineEntries, `${finalEntries} بعد ${baselineEntries} قبل`);
const all = await list('/purchase-invoices');
const byId = new Map(all.map((row) => [row.id, row]));
const dangling = all.filter((row) => {
  if (!row.referenceInvoiceId || row.status !== 'posted') return false;
  return byId.get(row.referenceInvoiceId)?.status === 'voided';
});
check(
  'ولا مستندَ مُرحَّلاً يشير إلى فاتورةٍ ملغاة',
  dangling.length === 0,
  dangling.map((row) => row.number).join('، ') || `فُحص ${all.length} مستنداً`,
);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
