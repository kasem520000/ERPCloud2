#!/usr/bin/env node
/**
 * Live verification for Future Enhancement 03.
 *
 * The provider is mocked by a credential beginning with MOCK-, so this script exercises the
 * real HTTP API, database, RLS transaction helpers and maintenance outbox without a Salla,
 * Zid or Shopify account. It writes only temporary stores/orders and removes the stores in
 * finally. Run with a migrated/seeded API:
 *
 *   node scripts/verify-ecommerce.mjs
 */
import { createHmac } from 'node:crypto';
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();
const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';
let token = '';
let failures = 0;
const createdStoreIds = [];

function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`,
    );
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

const data = (value) => value?.data ?? value;
const list = (value) => (Array.isArray(data(value)) ? data(value) : []);
const call = async (method, path, body, headers) => data(await request(method, path, body, headers));

async function refused(method, path, body, headers) {
  try {
    await request(method, path, body, headers);
    return { status: 200, body: {} };
  } catch (error) {
    return { status: error.status ?? 0, body: error.body ?? {} };
  }
}

const login = await call('POST', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token ?? '';
const tenantId =
  login.memberships?.find((membership) => membership.tenantCode === tenantCode)?.tenantId ??
  login.memberships?.[0]?.tenantId ??
  '';
check('تسجيل الدخول', Boolean(token), email);
check('معرّف المنشأة للويب هوك', Boolean(tenantId), tenantCode);

let branchId = '';
try {
  const branches = list(await request('GET', '/branches'));
  branchId = branches[0]?.id ?? '';
  check('فرع لاستيراد المسودات', Boolean(branchId), branches[0]?.nameAr ?? 'لا يوجد فرع');
} catch (error) {
  check('فرع لاستيراد المسودات', false, error.message);
}

try {
  console.log('\n1. قائمة المزوّدين والربط');
  const providers = list(await request('GET', '/ecommerce/providers'));
  check('ثلاثة مزودين', providers.length === 3, providers.map((provider) => provider.provider).join(', '));
  check(
    'سلة ضمن المزوّدين',
    providers.some((provider) => provider.provider === 'salla'),
  );
  check(
    'زد ضمن المزوّدين',
    providers.some((provider) => provider.provider === 'zid'),
  );
  check(
    'Shopify ضمن المزوّدين',
    providers.some((provider) => provider.provider === 'shopify'),
  );

  const store = await call('POST', '/ecommerce/stores', {
    provider: 'salla',
    apiKey: `MOCK-ECO-${Date.now()}`,
    webhookSecret: 'MOCK-WEBHOOK-SECRET',
    settings: branchId ? { branchId } : {},
  });
  createdStoreIds.push(store.id);
  check('ربط متجر سلة التجريبي', Boolean(store.id));
  check('اختبار الاتصال فعّال', store.status === 'active', store.status);
  check('لا يعيد access token', store.accessTokenMasked === '****' && !('accessTokenEnc' in store));

  console.log('\n2. مزامنة خمسة طلبات وإنشاء مسودات');
  const firstSync = await call('POST', `/ecommerce/stores/${store.id}/sync`, {});
  check('جلب خمسة طلبات', firstSync.fetched === 5, String(firstSync.fetched));
  check('إنشاء خمسة سجلات', firstSync.created === 5, String(firstSync.created));
  check('إنشاء مسودات ERP', firstSync.imported === 5 || !branchId, `${firstSync.imported}`);
  const orders = list(await request('GET', '/ecommerce/orders?store_id=' + encodeURIComponent(store.id)));
  check('الطلبات تظهر في الشاشة', orders.length === 5, String(orders.length));
  check(
    'الطلبات مربوطة بفواتير',
    !branchId || orders.every((order) => order.erpInvoiceId),
    orders.map((order) => order.status).join(', '),
  );

  console.log('\n3. idempotency والويب هوك');
  const secondSync = await call('POST', `/ecommerce/stores/${store.id}/sync`, {});
  check(
    'المزامنة الثانية لا تكرر',
    secondSync.created === 0 && secondSync.skipped === 5,
    `${secondSync.created}/${secondSync.skipped}`,
  );

  const webhookBody = {
    tenantId,
    storeId: store.id,
    id: `MOCK-WEBHOOK-${Date.now()}`,
    orderNo: 'WEBHOOK-1',
    status: 'pending',
    customer: { name: 'Webhook customer', mobile: '0501111111' },
    total: '33.0000',
    lines: [{ name: 'Webhook item', quantity: '1', unitPrice: '33.0000' }],
  };
  const raw = JSON.stringify(webhookBody);
  const signature = createHmac('sha256', 'MOCK-WEBHOOK-SECRET').update(raw).digest('hex');
  const webhook = await call('POST', '/ecommerce/webhooks/salla', webhookBody, {
    'x-tenant-id': tenantId,
    'x-salla-signature': signature,
  });
  check('webhook يقبل طلباً جديداً', webhook.accepted === true && webhook.duplicate === false);
  const duplicate = await call('POST', '/ecommerce/webhooks/salla', webhookBody, {
    'x-tenant-id': tenantId,
    'x-salla-signature': signature,
  });
  check('webhook لا يكرر remote id', duplicate.duplicate === true);
  const invalid = await refused('POST', '/ecommerce/webhooks/salla', webhookBody, {
    'x-tenant-id': tenantId,
    'x-salla-signature': 'bad-signature',
  });
  check('توقيع HMAC خاطئ مرفوض', invalid.status === 401, `${invalid.status}`);

  console.log('\n4. فشل الرمز والتنظيف');
  const bad = await call('POST', '/ecommerce/stores', {
    provider: 'zid',
    apiKey: `MOCK-FAIL-${Date.now()}`,
    webhookSecret: 'bad',
  });
  createdStoreIds.push(bad.id);
  check('فشل الرمز يضع error', bad.status === 'error', bad.lastError ?? '—');
  const badOrders = await call('GET', `/ecommerce/orders?store_id=${encodeURIComponent(bad.id)}`);
  check('متجر فشل الرمز بلا طلبات', Array.isArray(badOrders) && badOrders.length === 0);
  const logs = await call('GET', `/ecommerce/stores/${store.id}/logs`);
  check('سجل المزامنة موجود', Array.isArray(logs) && logs.length > 0, String(logs?.length ?? 0));
  check(
    'حالة الطلب المستورد واضحة',
    orders.every((order) => ['imported', 'pending', 'failed'].includes(order.status)),
  );
} finally {
  for (const id of createdStoreIds) {
    await request('DELETE', `/ecommerce/stores/${id}`).catch(() => undefined);
  }
}

console.log(
  `\n${failures === 0 ? '✅' : '❌'} verify-ecommerce: ${failures === 0 ? '15+ checks passed' : `${failures} check(s) failed`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
