#!/usr/bin/env node
/**
 * Live verification of Phase 09 part eight — 🛒 متجر سلة — against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked except the
 * store itself: a connection whose **store id starts with `MOCK-`** is served by the
 * in-memory Salla of `salla-client.ts`, because `FrmSallah` builds its client from a token
 * written into the XAML's code-behind and the desktop's path can be exercised no other
 * way.
 *
 *   1. إعدادات ربط سلة — connect the store and map it to a فرع
 *   2. 📦 جلب المنتجات — `ProductsManager.GetProducts()` → «تم جلب {n} منتج.»
 *   3. 👥 العملاء — `CustomersManager.GetCustomers()` (read, stored nowhere)
 *   4. ➕ إضافة منتج — `ProductsManager.CreateProduct()` من صنفٍ حقيقي
 *   5. ✏️ تحديث المنتج و🗑️ حذفه — `PUT` و`DELETE products/{id}`
 *   6. 📋 جلب الطلبات — `OrdersManager.GetOrders()` → فاتورة لكل طلب، والثاني لا يكرّر
 *   7. تحديث حالة الطلب — `PUT orders/{id}/status` بـ`{ status }`
 *   8. 🗑️ حذف الطلب — المسوّدة تُمحى مع فاتورتها
 *   9. الرفوض — «المتجر غير موجود» · «يجب تحديد حالة الطلب» · «الطلب غير موجود» ·
 *      و«خطأ في الطلب: 404 …» بلسان `SallaAPI`
 *  10. سجل التصدير — كل عمليةٍ مرئية
 *  11. التنظيف — الطلبات والفاتورة والمتجر والصنف: لا أثر
 *
 * Re-runnable and non-destructive: the branch, category and unit are reused when the
 * tenant has them, and everything this script writes is deleted in a `finally`.
 *
 * Usage: node scripts/verify-salla.mjs
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
    // Node 22's undici rejects lowercase verbs: `put`/`delete` come back a 405 with an
    // empty body, and `JSON.parse('')` then throws instead of reporting the real problem.
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed;
}

async function call(method, path, body) {
  const parsed = await request(method, path, body);
  return parsed.data ?? parsed;
}

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
const put = (path, body) => call('put', path, body);
const del = (path) => call('delete', path);
// The operation endpoints answer `{ data, count, message }` — the sentence is part of the
// response, so they are read raw instead of unwrapped.
const rawGet = (path) => request('get', path);
const rawPost = (path, body) => request('post', path, body);
const rawPut = (path, body) => request('put', path, body);
const rawDel = (path) => request('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));

const written = { orders: [], connectionId: '', itemId: '', categoryId: '', unitId: '' };

try {
  // -------------------------------------------------------------------------
  console.log('1. إعدادات ربط سلة — المتجر، وربطه بفرع');

  const branches = list(await get('/branches'));
  const branchId = branches[0]?.id ?? '';
  check('🏢 الفرع', Boolean(branchId), branches[0]?.nameAr ?? 'لا فرع');

  // A `MOCK-` store is served by the in-memory Salla — no credential, no network.
  const connection = await post('/integrations/salla/connections', {
    storeId: `MOCK-VERIFY-${stamp}`,
    accessToken: 'mock-access-token',
    webhookSecret: 'mock-webhook-secret',
    scopes: ['offline_access', 'orders.read', 'products.write'],
  });
  written.connectionId = connection.id;
  check('🛒 المتجر', Boolean(connection.id), connection.storeId);
  check('🔑 لا أثر للرمز', connection.accessToken === undefined && connection.accessTokenMasked === '****', 'مقنَّع');

  const mapping = await post('/integrations/salla/branch-mappings', { connectionId: connection.id, branchId, remoteBranchId: 'MAIN' });
  check('🏬 ربط المستودعات', mapping?.id === connection.id || Boolean(mapping?.branchId ?? mapping?.id), `الفرع: ${branches[0]?.nameAr ?? ''}`);

  // -------------------------------------------------------------------------
  console.log('\n2. 📦 جلب المنتجات — «تم جلب {n} منتج.»');

  const pulled = await rawPost('/integrations/salla/products/pull', { connectionId: connection.id });
  check('«تم جلب 2 منتج.»', pulled.message === 'تم جلب 2 منتج.', pulled.message);
  check('📦 عدد المنتجات', pulled.count === 2, `${pulled.count}`);

  const catalog = list(await get(`/integrations/salla/catalog?connectionId=${connection.id}`));
  check('📋 منتجات المتجر محفوظة', catalog.length === 2, catalog.map((row) => row.name).join(' · '));
  check('💵 السعر', catalog[0]?.price === '120.0000', `${catalog[0]?.name}: ${catalog[0]?.price}`);

  // -------------------------------------------------------------------------
  console.log('\n3. 👥 العملاء — `CustomersManager`، يُقرأ ولا يُخزَّن');

  const customers = await rawGet(`/integrations/salla/customers?connectionId=${connection.id}`);
  check('👥 عدد العملاء', customers.count === 2, `${customers.count}`);
  check('📱 الجوال', customers.data?.[0]?.mobile === '0551000001', customers.data?.[0]?.name ?? '—');

  // -------------------------------------------------------------------------
  console.log('\n4. ➕ إضافة منتج — صنفٌ حقيقي بأربعة مفاتيح');

  const existing = list(await get('/organization/catalog/items'));
  let item = existing[0];
  if (!item) {
    written.categoryId = (await post('/organization/catalog/categories', { code: `SL${stamp}`, nameAr: 'سلة' })).id;
    written.unitId = (await post('/organization/catalog/units', { code: `PC${stamp}`, nameAr: 'حبة' })).id;
    item = await post('/organization/catalog/items', {
      sku: `SKU-SL-${stamp}`,
      nameAr: `صنف سلة ${stamp}`,
      categoryId: written.categoryId,
      baseUnitId: written.unitId,
      salePrice: '150.0000',
    });
    written.itemId = item.id;
  }
  check('📦 الصنف', Boolean(item?.id), item ? `${item.sku} — ${item.nameAr}` : 'لا صنف');

  const pushed = await rawPost('/integrations/salla/products/push', { connectionId: connection.id, itemId: item.id });
  check('«تم إضافة المنتج بنجاح.»', pushed.message === 'تم إضافة المنتج بنجاح.', pushed.message);
  const remoteId = pushed.data?.remoteId ?? '';
  check('🔢 رقم المنتج في المتجر', Boolean(remoteId), remoteId);

  const pulledAgain = await rawPost('/integrations/salla/products/pull', { connectionId: connection.id });
  check('📦 المنتج المُضاف يظهر في الجلب', pulledAgain.count === 3, `${pulledAgain.count} منتج`);

  // -------------------------------------------------------------------------
  console.log('\n5. ✏️ تحديث · 🗑️ حذف — `PUT` و`DELETE products/{id}`');

  const updated = await rawPut(`/integrations/salla/products/${remoteId}`, { connectionId: connection.id, itemId: item.id });
  check('«تم تحديث المنتج بنجاح.»', updated.message === 'تم تحديث المنتج بنجاح.', updated.message);

  const removed = await rawDel(`/integrations/salla/products/${remoteId}?connectionId=${connection.id}&itemId=${item.id}`);
  check('«تم حذف المنتج من المتجر.»', removed.message === 'تم حذف المنتج من المتجر.', removed.message);

  // -------------------------------------------------------------------------
  console.log('\n6. 📋 جلب الطلبات — «تم جلب {n} طلب.»، ثم لا تكرار');

  const first = await rawPost('/integrations/salla/orders/pull', { connectionId: connection.id });
  check('«تم جلب 2 طلب.»', first.message === 'تم جلب 2 طلب.', first.message);
  check('🧾 فاتورة لكل طلب', first.created === 2, `${first.created} فاتورة`);
  check('📅 الحالة عند المتجر', first.data?.[0]?.remoteStatus === 'pending', first.data?.[0]?.remoteStatus ?? '—');
  check('👤 العميل', first.data?.[0]?.customerName === 'محمد الأحمد', first.data?.[0]?.customerName ?? '—');
  check('💰 الإجمالي', first.data?.[0]?.total === '240.0000', first.data?.[0]?.total ?? '—');

  const second = await rawPost('/integrations/salla/orders/pull', { connectionId: connection.id });
  check('الجلب الثاني لا يكرّر', second.created === 0 && second.count === 2, `أُنشئ: ${second.created} · مُتجاوَز: ${second.skipped?.length ?? 0}`);
  check(
    'الأرقام البعيدة هي المفتاح',
    JSON.stringify(second.skipped ?? []) === JSON.stringify(['MOCK-O-1', 'MOCK-O-2']),
    (second.skipped ?? []).join(' · '),
  );

  const orders = list(await get('/integrations/salla/orders'));
  check('📋 إدارة الطلبات', orders.length === 2, `${orders.length} طلب`);
  check('🧾 كل طلبٍ فاتورة مسوّدة', orders.every((row) => row.status === 'draft'), orders.map((row) => row.status).join(' · '));

  // -------------------------------------------------------------------------
  console.log('\n7. تحديث حالة الطلب — `PUT orders/{id}/status` بـ`{ status }`');

  const orderId = orders.find((row) => row.remoteId === 'MOCK-O-1')?.orderId ?? '';
  check('🔗 الطلب مربوط بمرآته', Boolean(orderId), orderId || 'لا مرآة');

  const noStatus = await refused('put', `/integrations/salla/orders/${orderId}/status`, { status: '   ' });
  check('«يجب تحديد حالة الطلب»', noStatus.status === 422 && noStatus.detail === 'يجب تحديد حالة الطلب', `${noStatus.status} ${noStatus.code} ${noStatus.detail}`);

  const delivered = await rawPut(`/integrations/salla/orders/${orderId}/status`, { status: 'delivered' });
  check('الحالة عند المتجر', delivered.data?.remoteStatus === 'delivered', delivered.data?.remoteStatus ?? '—');

  // -------------------------------------------------------------------------
  console.log('\n8. 🗑️ حذف الطلب — المسوّدة تُمحى مع فاتورتها');

  const invoiceId = orders.find((row) => row.remoteId === 'MOCK-O-1')?.salesInvoiceId ?? '';
  const removedOrder = await del(`/integrations/salla/orders/${orderId}`);
  check('🗑️ حذف المرآة', removedOrder?.deleted === true, removedOrder?.id ?? '—');
  const goneInvoice = await refused('get', `/sales/invoices/${invoiceId}`);
  check('🧾 الفاتورة المسوّدة تُمحى', goneInvoice.status === 404, `${goneInvoice.status}`);
  const left = list(await get('/integrations/salla/orders'));
  check('📋 بقي طلبٌ واحد', left.length === 1, `${left.length}`);

  // -------------------------------------------------------------------------
  console.log('\n9. الرفوض — بلسان النافذة و`SallaAPI`');

  const noStore = await refused('post', '/integrations/salla/products/pull', { connectionId: '00000000-0000-0000-0000-000000000000' });
  check('«المتجر غير موجود»', noStore.status === 404 && noStore.detail === 'المتجر غير موجود', `${noStore.status} ${noStore.code} ${noStore.detail}`);

  const noOrder = await refused('put', '/integrations/salla/orders/00000000-0000-0000-0000-000000000000/status', { status: 'done' });
  check('«الطلب غير موجود»', noOrder.status === 404 && noOrder.detail === 'الطلب غير موجود', `${noOrder.status} ${noOrder.code} ${noOrder.detail}`);

  const noItem = await refused('post', '/integrations/salla/products/push', { connectionId: connection.id, itemId: '00000000-0000-0000-0000-000000000000' });
  check('«الصنف غير موجود»', noItem.status === 404 && noItem.code === 'ITEM_NOT_FOUND', `${noItem.status} ${noItem.code}`);

  // منتجٌ مَحاه المتجر: «خطأ في الطلب: 404 - …» كما يرميها `SallaAPI.GetAsync`.
  const stale = await refused('put', `/integrations/salla/products/${remoteId}`, { connectionId: connection.id, itemId: item.id });
  check('«خطأ في الطلب: 404 - …»', stale.status === 502 && String(stale.detail).startsWith('خطأ في الطلب: 404'), `${stale.status} ${stale.code} ${String(stale.detail).slice(0, 60)}`);

  // -------------------------------------------------------------------------
  console.log('\n10. سجل التصدير — كل عمليةٍ مرئية');

  const logs = list(await get('/integrations/salla/export-log'));
  const actions = logs.map((row) => row.action);
  check('📜 العمليات المسجَّلة', ['pull', 'create', 'update', 'delete', 'orders', 'status'].every((action) => actions.includes(action)), actions.slice(0, 8).join(' · '));
  check('📜 لا أخطاء', logs.every((row) => !row.error), `${logs.filter((row) => row.error).length} خطأ`);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n11. التنظيف — لا أثر لهذا التشغيل');

  for (const row of list(await get('/integrations/salla/orders'))) {
    if (row.orderId) written.orders.push(row.orderId);
    await del(`/integrations/salla/orders/${row.orderId}`).catch(() => {});
  }
  const ordersLeft = list(await get('/integrations/salla/orders'));
  check('📋 الطلبات', ordersLeft.length === 0, `${ordersLeft.length}`);

  if (written.connectionId) await del(`/integrations/salla/connections/${written.connectionId}`).catch(() => {});
  const catalogLeft = list(await get('/integrations/salla/catalog'));
  check('📦 منتجات المتجر', catalogLeft.length === 0, `${catalogLeft.length}`);

  if (written.itemId) await del(`/organization/catalog/items/${written.itemId}`).catch(() => {});
  if (written.unitId) await del(`/organization/catalog/units/${written.unitId}`).catch(() => {});
  if (written.categoryId) await del(`/organization/catalog/categories/${written.categoryId}`).catch(() => {});
  console.log(`  ✓ المتجر والصنف والوحدة والمجموعة: ${written.connectionId ? 'حُذف ما أُنشئ' : 'لا شيء أُنشئ'}`);
}

console.log(`\n${failures === 0 ? '✔ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
