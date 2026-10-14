#!/usr/bin/env node
/**
 * Live verification of 📊 cost centres on sales and purchase invoices (R9) against a
 * running stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the invoice screens drive — nothing is mocked, and the
 * centres, invoices and journal legs stay in the database when the script finishes (the
 * caller sees them in /accounting/cost-centers and /accounting/cost-center-statement):
 *
 *   1. الحفظ: مركزٌ على الرأس وآخر على السطر ⇒ يُعادان في الردّ (كانت الواجهة تُسقطهما)
 *   2. القيد: رجل الإيراد تُقسم على المراكز بنصيب كل سطر، وسطرٌ بلا مركز يأخذ مركز الرأس
 *   3. الشراء: رجل المخزون تُوسم بمركز السطر كذلك
 *   4. الكشف: `GET /statements/cost-center/:id` يقرأ المبيعات والمشتريات (كان صفراً)
 *   5. العكس: الإلغاء يوسم رجل المرآة بالمركز نفسه فلا يبقى مالٌ في التقرير
 *   6. الحرّاس: مركزٌ مجهول أو من مستأجرٍ آخر ⇒ 404 COST_CENTER_NOT_FOUND
 *   7. المحايد: فاتورةٌ بلا أي مركز لا تزيد كشفَ أي مركز
 *
 * Usage: node scripts/verify-invoice-cost-centers.mjs
 *   API_BASE       (default http://127.0.0.1:3000/api/v1)
 *   VERIFY_TENANT  (default demo)
 *   VERIFY_EMAIL   (default owner@demo.test)
 *   DEMO_OWNER_PASSWORD (يُقرأ من `.env` عبر `loadEnvFiles`)
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let checks = 0;
let failures = 0;

function ok(message) {
  checks += 1;
  console.log(`✔ ${message}`);
}
function bad(message) {
  checks += 1;
  failures += 1;
  console.log(`✘ ${message}`);
}
function assert(condition, message, detail) {
  if (condition) ok(message);
  else bad(`${message}${detail === undefined ? '' : ` — ${detail}`}`);
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
    error.code = parsed.code ?? '';
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function raw(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const data = (payload) => payload?.data ?? payload;
const number = (value) => Number(value ?? '0');
const stamp = Date.now().toString().slice(-6);

const main = async () => {
  const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  const token = data(login).accessToken;
  console.log(`✔ signed in as ${email} @ ${tenantCode}`);

  const branches = await call('get', '/branches?limit=1', token);
  const branchId = (Array.isArray(branches) ? branches : data(branches))[0]?.id;
  const warehouses = await call('get', '/warehouses?limit=1', token);
  const warehouseId = data(warehouses)[0]?.id;
  if (!branchId || !warehouseId) throw new Error('لا فرع ولا مستودع في هذه المنشأة — شغّل البذرة');
  console.log(`  الفرع ${branchId.slice(0, 8)}… والمستودع ${warehouseId.slice(0, 8)}…`);

  // ─────────────────────────────────────────────── 0. مراكز الفحص: مركزان وطرفٌ وصنف
  console.log('');
  console.log('۰) أدوات الفحص');
  const centre = async (code, nameAr) => {
    const created = await call('post', '/cost-centers', token, { code: `${code}-${stamp}`, nameAr });
    return data(created).id;
  };
  const centreA = await centre('R9A', 'مركز فحص أ');
  const centreB = await centre('R9B', 'مركز فحص ب');
  assert(Boolean(centreA && centreB), 'أُنشئ مركزا تكلفة', `${centreA?.slice(0, 8)} · ${centreB?.slice(0, 8)}`);

  const categories = await call('get', '/organization/catalog/categories?limit=1', token);
  const units = await call('get', '/organization/catalog/units?limit=1', token);
  let categoryId = data(categories)[0]?.id;
  let baseUnitId = data(units)[0]?.id;
  if (!categoryId) {
    categoryId = data(
      await call('post', '/organization/catalog/categories', token, {
        code: `R9C-${stamp}`,
        nameAr: 'فحص مراكز التكلفة',
      }),
    ).id;
  }
  if (!baseUnitId) {
    baseUnitId = data(
      await call('post', '/organization/catalog/units', token, { code: 'PCS', nameAr: 'حبة' }),
    ).id;
  }
  const itemId = data(
    await call('post', '/organization/catalog/items', token, {
      categoryId,
      baseUnitId,
      sku: `R9-${stamp}`,
      nameAr: 'صنف فحص مراكز التكلفة',
    }),
  ).id;
  const supplierId = data(
    await call('post', '/parties', token, { kind: 'supplier', name: `مورد فحص ${stamp}` }),
  ).id;
  const customerId = data(
    await call('post', '/parties', token, { kind: 'customer', name: `عميل فحص ${stamp}` }),
  ).id;
  console.log(`  صنف ${itemId.slice(0, 8)}… ومورد وعميل`);

  /** صافي كشف المركز: (مدين, دائن) كما يقرؤهما التقرير. */
  const totals = async (centerId) => {
    const statement = await call('get', `/statements/cost-center/${centerId}`, token);
    return statement.totals ?? {};
  };

  // ─────────────────────────────────────────────── 1. الحفظ على الرأس والسطر
  console.log('');
  console.log('۱) مركزٌ على الرأس والسطر — يُحفظ ويُعاد');
  const sale = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    partyId: customerId,
    kind: 'sale',
    costCenterId: centreA,
    lines: [
      { description: 'بند على مركز أ', quantity: '1', unitPrice: '100', costCenterId: centreA },
      { description: 'بند على مركز ب', quantity: '1', unitPrice: '300', costCenterId: centreB },
    ],
  });
  const saleId = data(sale).id;
  assert(data(sale).costCenterId === centreA, 'رأس الفاتورة يحمل المركز في الردّ');
  assert(
    (data(sale).lines ?? []).every((line) => line.costCenterId === centreA || line.costCenterId === centreB),
    'السطران يحملان مركزيهما',
    (data(sale).lines ?? []).map((line) => (line.costCenterId ?? 'null').slice(0, 8)).join(' · '),
  );
  const beforeA = await totals(centreA);
  assert(number(beforeA.credit) === 0, 'المسودّة لم تُرحَّل ⇒ كشف المركز صفر', beforeA.credit);

  // ─────────────────────────────────────────────── 2. القيد يُقسَّم
  console.log('');
  console.log('۲) الترحيل: رجل الإيراد تُقسم على المراكز');
  await call('post', `/sales/invoices/${saleId}/post`, token, {});
  const afterA = await totals(centreA);
  const afterB = await totals(centreB);
  assert(number(afterA.credit) === 100, 'مركز أ أقرض/دائن 100 بنصيب سطره', afterA.credit);
  assert(number(afterB.credit) === 300, 'مركز ب دائن 300 بنصيب سطره', afterB.credit);

  // سطرٌ لا يذكر مركزاً يأخذ مركز الرأس (L2461)
  const inherited = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    cashCustomerName: `نقدي ${stamp}`,
    kind: 'sale',
    costCenterId: centreB,
    lines: [{ description: 'بلا مركز على السطر', quantity: '1', unitPrice: '250' }],
  });
  const inheritedId = data(inherited).id;
  const inheritedLineCentre = (data(inherited).lines ?? [])[0]?.costCenterId ?? null;
  assert(inheritedLineCentre === null, 'السطر الصامت يُخزَّن بلا مركز (لا يُخترع له مركز)', inheritedLineCentre);
  await call('post', `/sales/invoices/${inheritedId}/post`, token, {});
  const afterB2 = await totals(centreB);
  assert(
    number(afterB2.credit) === 550,
    'مركز الرأس أخذ نصيب السطر الصامت (300 + 250)',
    afterB2.credit,
  );

  // ─────────────────────────────────────────────── 3. الشراء
  console.log('');
  console.log('۳) الشراء: رجل المخزون تُوسم بمركز السطر');
  const purchase = await call('post', '/purchase-invoices', token, {
    branchId,
    warehouseId,
    partyId: supplierId,
    kind: 'purchase',
    costCenterId: centreA,
    lines: [
      { itemId, quantity: '4', unitPrice: '40', costCenterId: centreB },
      { itemId, quantity: '2', unitPrice: '40' },
    ],
  });
  const purchaseId = data(purchase).id;
  assert(data(purchase).costCenterId === centreA, 'رأس فاتورة الشراء يحمل المركز');
  await call('post', `/purchase-invoices/${purchaseId}/post`, token, {});
  const purchA = await totals(centreA);
  const purchB = await totals(centreB);
  assert(number(purchA.debit) >= 80, 'مركز أ مدين بنصيب السطر الذي ورث الرأس (2×40)', purchA.debit);
  assert(number(purchB.debit) >= 160, 'مركز ب مدين بنصيب سطره (4×40)', purchB.debit);
  assert(
    number(purchA.debit) + number(purchB.debit) >= 240,
    'مجموع ما وُسم بالمخزون يغطّي قيمة الفاتورة',
    `${purchA.debit} + ${purchB.debit}`,
  );

  // ─────────────────────────────────────────────── 4. الكشف يعرض الصفوف
  console.log('');
  console.log('۴) كشف المركز يعرض الحركات (كان صفراً)');
  const statement = await call('get', `/statements/cost-center/${centreB}`, token);
  assert((statement.data ?? []).length > 0, 'كشف مركز ب فيه صفوف', `${(statement.data ?? []).length}`);
  assert(
    statement.costCenter?.id === centreB,
    'الكشف يذكر المركز نفسه في الرأس',
    statement.costCenter?.code ?? '',
  );

  // ─────────────────────────────────────────────── 5. العكس
  console.log('');
  console.log('۵) الإلغاء يعكس بالمركز نفسه');
  const beforeVoid = await totals(centreA);
  await call('post', `/sales/invoices/${saleId}/void`, token, { reason: 'فحص حيّ (R9)' });
  const afterVoid = await totals(centreA);
  assert(
    number(afterVoid.debit) > number(beforeVoid.debit),
    'رجل المرآة حملت مركز الرأس (مدين مركز أ زاد)',
    `${beforeVoid.debit} ⇒ ${afterVoid.debit}`,
  );
  assert(
    number(afterVoid.credit) - number(afterVoid.debit) < number(beforeVoid.credit) - number(beforeVoid.debit),
    'صافي المركز انخفض بعد الإلغاء ⇒ المال الملغى لم يبق في التقرير',
  );

  // ─────────────────────────────────────────────── 6. الحرّاس
  console.log('');
  console.log('۶) الحرّاس: مركزٌ مجهول لا يمرّ');
  const unknownId = '01a0c600-0000-7000-8000-000000000999';
  const headerUnknown = await raw('post', '/sales/invoices', token, {
    branchId,
    kind: 'sale',
    cashCustomerName: `مجهول ${stamp}`,
    costCenterId: unknownId,
    lines: [{ description: 'ب', quantity: '1', unitPrice: '1' }],
  });
  assert(headerUnknown.status === 404, 'مركز رأس مجهول ⇒ 404', headerUnknown.status);
  assert(headerUnknown.body.code === 'COST_CENTER_NOT_FOUND', 'ورده الرمز COST_CENTER_NOT_FOUND', headerUnknown.body.code);
  const lineUnknown = await raw('post', '/sales/invoices', token, {
    branchId,
    kind: 'sale',
    cashCustomerName: `مجهول ${stamp}`,
    lines: [{ description: 'ب', quantity: '1', unitPrice: '1', costCenterId: unknownId }],
  });
  assert(lineUnknown.status === 404, 'مركز سطر مجهول ⇒ 404', lineUnknown.status);
  const purchaseUnknown = await raw('post', '/purchase-invoices', token, {
    branchId,
    warehouseId,
    partyId: supplierId,
    kind: 'purchase',
    lines: [{ itemId, quantity: '1', unitPrice: '1', costCenterId: unknownId }],
  });
  assert(purchaseUnknown.status === 404, 'مركز سطر مجهول في الشراء ⇒ 404', purchaseUnknown.status);

  // ─────────────────────────────────────────────── 7. المحايد
  console.log('');
  console.log('۷) فاتورةٌ بلا أي مركز لا تلمس أي كشف');
  const plainBeforeA = await totals(centreA);
  const plainBeforeB = await totals(centreB);
  const plain = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    cashCustomerName: `بلا مراكز ${stamp}`,
    kind: 'sale',
    lines: [{ description: 'بلا مركز', quantity: '1', unitPrice: '777' }],
  });
  assert(data(plain).costCenterId === null, 'الرأس بلا مركز', String(data(plain).costCenterId));
  await call('post', `/sales/invoices/${data(plain).id}/post`, token, {});
  assert(
    JSON.stringify(await totals(centreA)) === JSON.stringify(plainBeforeA) &&
      JSON.stringify(await totals(centreB)) === JSON.stringify(plainBeforeB),
    'كشفا المركزين لم يتغيّرا (لا رجلَ موسومة بلا سبب)',
  );

  // ─────────────────────────────────────────────── 8. النتيجة
  console.log('');
  console.log(`${checks - failures}/${checks} فحصاً ناجحاً`);
  if (failures)
    console.log('ℹ️  الفحوص الفاشلة أعلاه تحمل الردّ الفعلي بين قوسين — الفواتير تبقى في القاعدة للتفتيش.');
  process.exitCode = failures ? 1 : 0;
};

main().catch((error) => {
  console.error(`✘ توقّف الفحص: ${error.message}`);
  process.exitCode = 1;
});
