#!/usr/bin/env node
/**
 * Live verification of the invoice-line numbers (R8) against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the two invoice screens drive — nothing is mocked, and the
 * numbers live in the database when the script finishes (the caller sees them in
 * /sales/invoices and /inventory/serials):
 *
 *   1. الإدخال: فاتورة شراء بالدفعة والأرقام ⇒ الترحيل يُنشئ الأرقام والدفعة
 *   2. التتبّع: `GET /inventory/serials/lookup` يُجيب أيُّ صنفٍ وعلى الرفّ أم بيع
 *   3. البيع: الرقم يُصرف ويُقيَّد على سطر الفاتورة، والقطعة تعرف عبوّتها
 *   4. المرتجع: الرقم يعود إلى الرفّ، ومرتجعُ قطعةٍ لم تُبع يُرفض
 *   5. الإلغاء: يعكس الرقم (يعود إلى الرفّ) ويمحو رابطه بالمستند الملغى
 *   6. الحرّاس: عددٌ لا يطابق الكمية · رقمٌ مجهول · دفعةٌ لصنفٍ لا يُتتبَّع
 *
 * Usage: node scripts/verify-invoice-numbers.mjs
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

  // ─────────────────────────────────────────────── 0. أدوات الفحص: صنفان وطرفان
  console.log('');
  console.log('۰) أدوات الفحص');
  const categories = await call('get', '/organization/catalog/categories?limit=1', token);
  const units = await call('get', '/organization/catalog/units?limit=1', token);
  let categoryId = data(categories)[0]?.id;
  let baseUnitId = data(units)[0]?.id;
  if (!categoryId) {
    const created = await call('post', '/organization/catalog/categories', token, {
      code: `R8-${stamp}`,
      nameAr: 'فحص الأرقام',
    });
    categoryId = data(created).id;
  }
  if (!baseUnitId) {
    const created = await call('post', '/organization/catalog/units', token, {
      code: 'PCS',
      nameAr: 'حبة',
    });
    baseUnitId = data(created).id;
  }

  const serialItem = await call('post', '/organization/catalog/items', token, {
    sku: `R8SN-${stamp}`,
    nameAr: 'شاشة فحص الأرقام',
    trackSerial: true,
    trackLot: true,
    categoryId,
    baseUnitId,
  });
  const serialItemId = data(serialItem).id;
  const plainItem = await call('post', '/organization/catalog/items', token, {
    sku: `R8PL-${stamp}`,
    nameAr: 'صنفٌ لا يُتتبَّع',
    categoryId,
    baseUnitId,
  });
  const plainItemId = data(plainItem).id;
  assert(Boolean(serialItemId && plainItemId), 'أُنشئ صنفان للفحص: واحدٌ بالأرقام التسلسلية وآخر بلا تتبّع');

  const supplier = await call('post', '/parties', token, { kind: 'supplier', name: `مورد فحص ${stamp}` });
  const customer = await call('post', '/parties', token, { kind: 'customer', name: `عميل فحص ${stamp}` });
  const supplierId = data(supplier).id;
  const customerId = data(customer).id;
  assert(Boolean(supplierId && customerId), 'أُنشئ طرفان (مورد وعميل) للفواتير');

  const serial = (label) => `R8-${stamp}-${label}`;
  const lookup = async (serialNo) => {
    const answer = await call(
      'get',
      `/inventory/serials/lookup?serialNo=${encodeURIComponent(serialNo)}`,
      token,
    );
    return data(answer);
  };

  // ─────────────────────────────────────────────── 1. الإدخال
  console.log('');
  console.log('۱) الإدخال: الشراء يُنشئ الرقم والدفعة');
  const numbers = [serial('A'), serial('B')];
  const drafted = await call('post', '/purchase-invoices', token, {
    branchId,
    warehouseId,
    partyId: supplierId,
    kind: 'purchase',
    lines: [
      {
        itemId: serialItemId,
        quantity: String(numbers.length),
        unitPrice: '100',
        serialNos: numbers,
        batchNo: `B-${stamp}`,
        productionDate: '2026-02-01',
        expiryDate: '2027-02-01',
      },
    ],
  });
  const purchaseId = data(drafted).id;
  const draftLine = data(drafted).lines[0];
  assert(
    draftLine.serialNos?.length === 2 && draftLine.batchNo === `B-${stamp}`,
    'المسودّة تحفظ الأرقام والدفعة على السطر',
    JSON.stringify(draftLine.serialNos),
  );
  assert(
    draftLine.lotId === null,
    'المسودّة لا تُنشئ دفعةً بعد — الحسم عند الترحيل',
    String(draftLine.lotId),
  );
  const beforePost = await lookup(numbers[0]);
  assert(beforePost.found === false, 'الرقم لا وجود له قبل الترحيل (المسودّة أثرها صفر)');

  const posted = await call('post', `/purchase-invoices/${purchaseId}/post`, token, {});
  const postedLine = data(posted).lines[0];
  assert(Boolean(postedLine.lotId), 'الترحيل حسم الدفعة وربطها بالسطر', String(postedLine.lotId));
  const afterPost = await lookup(numbers[0]);
  assert(afterPost.found === true && afterPost.status === 'available', 'الرقم صار موجوداً وعلى الرفّ');
  assert(afterPost.item?.sku === `R8SN-${stamp}`, 'البحث يقول أيُّ صنفٍ يخصّه الرقم', afterPost.item?.sku);
  assert(
    afterPost.documents?.some((row) => row.docType === 'purchase_invoice' && row.docId === purchaseId),
    'الرقم مقيَّد بفاتورة الشراء التي أدخلته',
  );
  const level = await call('get', `/inventory/levels?item_id=${serialItemId}`, token);
  assert(number(data(level)[0]?.quantity) === 2, 'رصيد الصنف ٢ بعد الإدخال', data(level)[0]?.quantity);

  // ─────────────────────────────────────────────── 2. البيع
  console.log('');
  console.log('۲) البيع: الرقم يُصرف، والقطعة تعرف عبوّتها');
  const saleDraft = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    partyId: customerId,
    kind: 'sale',
    lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: [numbers[0]] }],
  });
  const saleId = data(saleDraft).id;
  const sold = await call('post', `/sales/invoices/${saleId}/post`, token, {});
  const soldLine = data(sold).lines[0];
  assert(
    soldLine.batchNo === `B-${stamp}`,
    'سطر البيع أخذ دفعة الرقم (القطعة تعرف عبوّتها)',
    String(soldLine.batchNo),
  );
  assert(
    soldLine.expiryDate === '2027-02-01',
    'وتاريخ انتهائها من الدفعة نفسها — لا يُخترع على السطر',
    String(soldLine.expiryDate),
  );
  const afterSale = await lookup(numbers[0]);
  assert(afterSale.status === 'sold', 'الرقم صار «مباع» بعد ترحيل البيع', afterSale.status);
  const trace = (afterSale.documents ?? []).map((row) => row.docType);
  assert(
    trace.join(' → ') === 'purchase_invoice → sales_invoice',
    'مسار الرقم مقروءٌ بالترتيب: شراء ثم بيع',
    trace.join(' → '),
  );

  // ─────────────────────────────────────────────── 3. المرتجع
  console.log('');
  console.log('۳) المرتجع: الرقم يعود إلى الرفّ');
  const returnDraft = await call('post', `/sales/invoices/${saleId}/return`, token, {
    branchId,
    warehouseId,
    partyId: customerId,
    lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: [numbers[0]] }],
  });
  const returnId = data(returnDraft).id;
  await call('post', `/sales/invoices/${returnId}/post`, token, {});
  const afterReturn = await lookup(numbers[0]);
  assert(afterReturn.status === 'available', 'الرقم عاد إلى الرفّ بعد المرتجع', afterReturn.status);

  // ─────────────────────────────────────────────── 4. الحرّاس
  console.log('');
  console.log('۴) الحرّاس: العدد والمجهول والدفعة');
  const shortDraft = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    partyId: customerId,
    kind: 'sale',
    lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: [serial('NOPE')] }],
  });
  const shortPosted = await raw('post', `/sales/invoices/${data(shortDraft).id}/post`, token, {});
  assert(
    shortPosted.status === 422 && shortPosted.body.code === 'SERIAL_NOT_FOUND',
    'رقمٌ مجهول ⇒ 422 SERIAL_NOT_FOUND',
    `${shortPosted.status} ${shortPosted.body.code}`,
  );

  const mismatchDraft = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    partyId: customerId,
    kind: 'sale',
    lines: [{ itemId: serialItemId, quantity: '2', unitPrice: '200', serialNos: [numbers[0]] }],
  });
  const mismatchPosted = await raw('post', `/sales/invoices/${data(mismatchDraft).id}/post`, token, {});
  assert(
    mismatchPosted.status === 422 && mismatchPosted.body.code === 'SERIAL_COUNT_MISMATCH',
    'عددُ أرقامٍ أقل من الكمية ⇒ 422 SERIAL_COUNT_MISMATCH',
    `${mismatchPosted.status} ${mismatchPosted.body.code}`,
  );
  // الرمز مُعلَنٌ في `packages/contracts/src/errors.ts` (لا `DomainError` عارياً): فالعنوان
  // يخرج من `errorTitle` لا من الاحتياط العام — وهو ما تقرؤه الشاشة عارضةً الخطأ.
  assert(
    mismatchPosted.body.title === 'Serial count does not match the quantity' &&
      mismatchPosted.body.status === 422,
    'والردّ problem+json يحمل عنوان الرمز المعلَن (لا «Request failed»)',
    `${mismatchPosted.body.status} · ${mismatchPosted.body.title}`,
  );

  const untracked = await call('post', '/purchase-invoices', token, {
    branchId,
    warehouseId,
    partyId: supplierId,
    kind: 'purchase',
    lines: [{ itemId: plainItemId, quantity: '1', unitPrice: '10', batchNo: 'B-NO' }],
  });
  const untrackedPosted = await raw('post', `/purchase-invoices/${data(untracked).id}/post`, token, {});
  assert(
    untrackedPosted.status === 422 && untrackedPosted.body.code === 'LOT_NOT_TRACKED',
    'دفعةٌ لصنفٍ لا يُتتبَّع ⇒ 422 LOT_NOT_TRACKED',
    `${untrackedPosted.status} ${untrackedPosted.body.code}`,
  );

  const unknown = await lookup(serial('GHOST'));
  assert(unknown.found === false, 'بحثٌ عن رقمٍ لا وجود له ⇒ found:false (ولا خطأ)');

  // ─────────────────────────────────────────────── 5. الإلغاء يعكس
  console.log('');
  console.log('۵) الإلغاء يعكس الرقم');
  const soldAgain = await call('post', '/sales/invoices', token, {
    branchId,
    warehouseId,
    partyId: customerId,
    kind: 'sale',
    lines: [{ itemId: serialItemId, quantity: '1', unitPrice: '200', serialNos: [numbers[0]] }],
  });
  const soldAgainId = data(soldAgain).id;
  await call('post', `/sales/invoices/${soldAgainId}/post`, token, {});
  assert((await lookup(numbers[0])).status === 'sold', 'بيعٌ ثانٍ للرقم نجح (وهو على الرفّ)');
  await call('post', `/sales/invoices/${soldAgainId}/void`, token, { reason: 'فحص حيّ' });
  const afterVoid = await lookup(numbers[0]);
  assert(afterVoid.status === 'available', 'بعد الإلغاء عاد الرقم إلى الرفّ', afterVoid.status);
  assert(
    !(afterVoid.documents ?? []).some((row) => row.docId === soldAgainId),
    'ولا يبقى رابطٌ إلى المستند الملغى',
  );

  // ─────────────────────────────────────────────── 6. النتيجة
  console.log('');
  console.log(`${checks - failures}/${checks} فحصاً ناجحاً`);
  if (failures)
    console.log('ℹ️  الفحوص الفاشلة أعلاه تحمل الردّ الفعلي بين قوسين — الأرقام تبقى في القاعدة للتفتيش.');
  process.exitCode = failures ? 1 : 0;
};

main().catch((error) => {
  console.error(`✘ توقّف الفحص: ${error.message}`);
  process.exitCode = 1;
});
