#!/usr/bin/env node
/**
 * Live verification of P-C11 «بوابة المطوّر» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` +
 * `pnpm dev`).
 *
 * It drives the real HTTP API — nothing is mocked — and the webhook receiver is a **real HTTP
 * server this script opens on 127.0.0.1**, so the delivery is measured end to end: the API
 * signs, posts, and reads back a status code that came off a socket.
 *
 *   1. 🔐 الأبواب — مفاتيح المنشآت وعناوينها بـ`console.apikeys.manage`/`console.webhooks.manage`،
 *      ورمز العميل 403 على سطح المنصة، والمجهول 401
 *   2. 🔑 الإصدار — مفتاحٌ يُنشأ فيظهر نصّه **مرّة واحدة**، وصفُّه يقول البادئة والنطاقات
 *      وعدد الطلبات، والقائمة بعدها **لا تحمل النصّ** (فالمحفوظ بصمة)
 *   3. 🚪 سطح التكامل — `/integration/v1/me` بالبادئة والنطاقات، والمفتاح المُحرَّف 401،
 *      وبلا ترويسة 401
 *   4. 🎚️ النطاق سقفٌ — مفتاحٌ بنطاق `reporting:read` وحده يُردّ على `/v1/invoices` بـ403
 *      يحمل `field: 'scope'` (لا 401 — الهوية صحيحة والسقف هو المانع)
 *   5. ♻️ التدوير — القديم يُبطَل والجديد يعمل، وتدوير المُبطَل 409 `INVALID_STATE`
 *   6. 🚫 الإبطال — الصفّ يبقى بسببه، والمفتاح المُبطَل 401، وإبطاله مرّتين 409
 *   7. 📡 التسليم الحقيقي — عنوانٌ محلّي يستقبل: يُتحقَّق من التوقيع **في السكربت نفسه**
 *      (`HMAC-SHA256` على `<t>.<body>` بسرّ العنوان)، والتوقيع المُحرَّف يُرفض عند المستقبِل،
 *      ثم يتعطّل المستقبِل (500) فيُسجَّل الفشل برمزه، ثم يُعاد الإرسال فيصل — والسجلّ يقول ذلك
 *   8. 🧍 العزل — مفتاحُ منشأةٍ لا يقرأ منشأةً أخرى، والتسليمات مفلترةٌ على صاحبها
 *   9. 🧾 التدقيق — الأفعال الثمانية مقيَّدة بأسمائها في `audit_log`
 *
 * **ولا يُنشئ عملاء**: يعمل على `demo` (عميل القياس) و`platform` (منشأة المشغّلين). والمفاتيح
 * والعناوين التي ينشئها تُبطَل/تُحذف في نهاية التشغيل ما لم يُطلب غير ذلك، فالتشغيل قابلٌ للتكرار
 * بلا أن ينمو سجلّ `demo` في كل مرة.
 *
 * Usage: node scripts/verify-platform-developer.mjs
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};
const demo = {
  tenantCode: process.env.VERIFY_TENANT ?? 'demo',
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const keepArtifacts = process.env.VERIFY_KEEP === '1';

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

function section(title) {
  console.log(`\n${title}`);
}

async function raw(method, path, body, token, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

async function request(method, path, body, token, extraHeaders) {
  const response = await raw(method, path, body, token, extraHeaders);
  if (response.status >= 400) {
    const problem = response.body ?? {};
    const error = new Error(
      `${method} ${path} → ${response.status} ${problem.code ?? ''} ${problem.detail ?? problem.message ?? ''}`,
    );
    error.status = response.status;
    error.code = problem.code;
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

async function attempts(method, path, body, token) {
  const response = await raw(method, path, body, token);
  const data = response.body?.data ?? response.body;
  if (response.status < 400) return { status: response.status, code: 'OK', data, problem: {} };
  const problem = response.body ?? {};
  return { status: response.status, code: problem.code ?? '', data, problem };
}

async function signIn(tenantCode, credentials) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return token;
    } catch (error) {
      if (error.status === 429 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** قائمة `{items,total,limit,offset}` أو مصفوفة — الشكلان واردان في العقود. */
const itemsOf = (payload) =>
  Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];

/** مستقبِل الويب هوك: يتحقّق من التوقيع بنفسه ويردّ بالرمز الذي نطلبه في اللحظة. */
function startReceiver() {
  const state = { status: 500, received: [] };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const signature = String(req.headers['x-erp-signature'] ?? '');
      const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature);
      let signatureValid = false;
      let fresh = false;
      if (match) {
        const [, timestamp, sent] = match;
        const expected = createHmac('sha256', state.secret ?? '').update(`${timestamp}.${body}`).digest('hex');
        const left = Buffer.from(expected, 'utf8');
        const right = Buffer.from(sent, 'utf8');
        signatureValid = left.length === right.length && timingSafeEqual(left, right);
        fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      state.received.push({
        event: String(req.headers['x-erp-event'] ?? ''),
        deliveryId: String(req.headers['x-erp-delivery'] ?? ''),
        tenantId: String(req.headers['x-erp-tenant'] ?? ''),
        body,
        parsed,
        signature,
        signatureValid,
        fresh,
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: state.status < 400 }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function main() {
  const ownerToken = await signIn(platformTenant, operator);
  const demoToken = await signIn(demo.tenantCode, demo);
  const demoMe = await request('get', '/me', undefined, demoToken);
  const demoTenantId = demoMe.membership?.tenantId;
  const stamp = Date.now().toString(36);
  const created = { keys: [], endpoints: [] };

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الأبواب: من يفتح البوابة');
  const catalogue = await request('get', '/platform/developer/catalogue', undefined, ownerToken);
  check(
    'مالك المنصة يقرأ الكتالوج',
    Array.isArray(catalogue.scopes) && catalogue.scopes.length >= 8 && catalogue.events.length >= 9,
    `${catalogue.scopes?.length} نطاقاً · ${catalogue.events?.length} حدثاً`,
  );
  check(
    'وصيغة التوقيع من الخادم نفسه',
    catalogue.signature?.header === 'x-erp-signature' && catalogue.signature?.toleranceSeconds === 300,
    `${catalogue.signature?.header} · ${catalogue.signature?.toleranceSeconds}s`,
  );
  check(
    'ويقرأ مفاتيح المنشآت',
    (await raw('get', `/platform/tenants/${demoTenantId}/api-keys`, undefined, ownerToken)).status === 200,
  );
  check(
    'وعناوين الويب هوك',
    (await raw('get', `/platform/tenants/${demoTenantId}/webhooks`, undefined, ownerToken)).status === 200,
  );
  check(
    'والمجهول لا يرى شيئاً (401)',
    (await attempts('get', `/platform/tenants/${demoTenantId}/api-keys`)).status === 401,
  );
  check(
    'ورمز العميل لا يفتح سطح المنصة (403)',
    (await attempts('get', `/platform/tenants/${demoTenantId}/api-keys`, undefined, demoToken)).status === 403,
  );

  // ─────────────────────────────────────────────── 2
  section('2. 🔑 الإصدار: النصّ الصريح مرّة واحدة');
  const keyName = `تكامل القياس ${stamp}`;
  const created1 = await request(
    'post',
    `/platform/tenants/${demoTenantId}/api-keys`,
    { name: keyName, scopes: ['invoices:read', 'reporting:read'], expiresInDays: 30 },
    ownerToken,
  );
  created.keys.push(created1.id);
  check(
    'المفتاح يُنشأ ويُعاد نصّه مرّة',
    typeof created1.secret === 'string' && created1.secret.startsWith('erp_live_'),
    `البادئة ${created1.prefix} · طول السرّ ${created1.secret?.length}`,
  );
  check(
    'والسرّ أطول من البادئة المعروضة',
    created1.secret?.startsWith(created1.prefix) && created1.secret.length > created1.prefix.length + 20,
  );
  check('والنطاقات كما طُلبت', JSON.stringify(created1.scopes) === JSON.stringify(['invoices:read', 'reporting:read']));
  check('والانتهاء محسوب', typeof created1.expiresAt === 'string' && created1.expiresAt > new Date().toISOString());

  const listed = await raw('get', `/platform/tenants/${demoTenantId}/api-keys`, undefined, ownerToken);
  const keyRow = itemsOf(listed.body?.data).find((row) => row.id === created1.id);
  check('ويظهر في قائمة المنشأة', Boolean(keyRow), keyRow ? `${keyRow.prefix} · ${keyRow.status}` : 'مفقود');
  check('وصفُّه يقول البادئة وعدد الطلبات', keyRow?.prefix === created1.prefix && keyRow?.uses === 0);
  check('والقائمة لا تحمل النصّ الصريح', !listed.text.includes(created1.secret), 'المحفوظ بصمة');

  // ─────────────────────────────────────────────── 3
  section('3. 🚪 سطح التكامل: من أنا وماذا أفتح');
  const identity = await request('get', '/integration/v1/me', undefined, created1.secret);
  check(
    'المفتاح يعرّف نفسه بمنشأته',
    identity.tenantId === demoTenantId && identity.tenantCode === demo.tenantCode,
    `${identity.tenantCode} · ${identity.scopes?.join(',')}`,
  );
  check(
    'والنطاقات تُترجم إلى صلاحيات',
    Array.isArray(identity.permissions) && identity.permissions.includes('sales.view'),
    String(identity.permissions?.length),
  );
  check(
    'والمفتاح المُحرَّف 401',
    (await attempts('get', '/integration/v1/me', undefined, `${created1.secret.slice(0, -1)}${created1.secret.endsWith('a') ? 'b' : 'a'}`))
      .status === 401,
  );
  check('وبلا مفتاح 401', (await attempts('get', '/integration/v1/me')).status === 401);
  const tampered = await attempts(
    'get',
    '/integration/v1/me',
    undefined,
    `${created1.secret.slice(0, -1)}${created1.secret.endsWith('a') ? 'b' : 'a'}`,
  );
  check('ولا يفرّق الردّ بين مجهولٍ ومُبطَل', tampered.problem?.code === 'UNAUTHENTICATED', tampered.problem?.code ?? '');

  // القراءة بنطاق `invoices:read`: تُقاس بعد إصدار مفتاحٍ ثانٍ بلا هذا النطاق (القسم 4).
  const withRead = await attempts('get', '/integration/v1/invoices?limit=3', undefined, created1.secret);
  check('وقراءة الفواتير تعمل بالنطاق', withRead.status === 200 && Array.isArray(withRead.data), `${itemsOf(withRead.data).length} فاتورة`);

  const usesRow = itemsOf((await raw('get', `/platform/tenants/${demoTenantId}/api-keys`, undefined, ownerToken)).body?.data).find(
    (row) => row.id === created1.id,
  );
  check(
    'وآخر استخدامٍ يُكتب على الصفّ',
    usesRow?.uses >= 1 && typeof usesRow?.lastUsedAt === 'string',
    `${usesRow?.uses} طلباً · ${usesRow?.lastUsedAt?.slice(0, 19)}`,
  );

  // ─────────────────────────────────────────────── 4
  section('4. 🎚️ النطاق سقفٌ لا زينة');
  const narrow = await request(
    'post',
    `/platform/tenants/${demoTenantId}/api-keys`,
    { name: `قراءة تقارير ${stamp}`, scopes: ['reporting:read'] },
    ownerToken,
  );
  created.keys.push(narrow.id);
  check('مفتاحٌ بنطاق واحد يُنشأ', narrow.scopes.length === 1, narrow.scopes.join(','));
  const denied = await attempts('get', '/integration/v1/invoices?limit=1', undefined, narrow.secret);
  check(
    'ويُردّ على مسارٍ خارج سقفه بـ403 يقول أيّ نطاقٍ ينقص',
    denied.status === 403 && denied.problem?.errors?.[0]?.field === 'scope',
    `${denied.status} · ${denied.problem?.errors?.[0]?.message ?? denied.problem?.code}`,
  );
  check('لكنه يعرّف نفسه', (await attempts('get', '/integration/v1/me', undefined, narrow.secret)).status === 200);

  // ─────────────────────────────────────────────── 5
  section('5. ♻️ التدوير: القديم يُبطَل في اللحظة نفسها');
  const rotated = await request(
    'post',
    `/platform/tenants/${demoTenantId}/api-keys/${created1.id}/rotate`,
    { reason: 'تدوير التحقّق الحيّ' },
    ownerToken,
  );
  created.keys.push(rotated.id);
  check('المفتاح الجديد يرث الاسم والنطاقات', rotated.name === keyName && JSON.stringify(rotated.scopes) === JSON.stringify(created1.scopes));
  check('ونصّه مختلف', rotated.secret !== created1.secret && rotated.secret.startsWith('erp_live_'));
  check('والجديد يعمل', (await attempts('get', '/integration/v1/me', undefined, rotated.secret)).status === 200);
  check('والقديم يسقط فوراً (401)', (await attempts('get', '/integration/v1/me', undefined, created1.secret)).status === 401);
  const rotatedRows = itemsOf((await raw('get', `/platform/tenants/${demoTenantId}/api-keys`, undefined, ownerToken)).body?.data);
  const oldRow = rotatedRows.find((row) => row.id === created1.id);
  check(
    'وصفّ القديم يبقى بسببٍ مكتوب',
    oldRow?.status === 'revoked' && typeof oldRow?.revokedAt === 'string' && Boolean(oldRow?.revokedReason),
    oldRow?.revokedReason ?? '',
  );
  const rotateAgain = await attempts(
    'post',
    `/platform/tenants/${demoTenantId}/api-keys/${created1.id}/rotate`,
    { reason: 'محاولة ثانية' },
    ownerToken,
  );
  check(
    'وتدوير المُبطَل 409 INVALID_STATE',
    rotateAgain.status === 409 && rotateAgain.problem?.code === 'INVALID_STATE',
    rotateAgain.problem?.code ?? '',
  );

  // ─────────────────────────────────────────────── 6
  section('6. 🚫 الإبطال: بابٌ يُغلق بحجّة');
  const revoke = await request(
    'delete',
    `/platform/tenants/${demoTenantId}/api-keys/${narrow.id}`,
    { reason: 'انتهى تكامل التقارير' },
    ownerToken,
  );
  check('يُبطل بسببٍ ظاهر', revoke.status === 'revoked' && revoke.revokedReason === 'انتهى تكامل التقارير');
  check('ويسقط فوراً (401)', (await attempts('get', '/integration/v1/me', undefined, narrow.secret)).status === 401);
  const revokeAgain = await attempts(
    'delete',
    `/platform/tenants/${demoTenantId}/api-keys/${narrow.id}`,
    { reason: 'إبطالٌ مكرَّر' },
    ownerToken,
  );
  check(
    'وإبطاله مرّتين 409 INVALID_STATE',
    revokeAgain.status === 409 && revokeAgain.problem?.code === 'INVALID_STATE',
    revokeAgain.problem?.code ?? '',
  );

  // ─────────────────────────────────────────────── 7
  section('7. 📡 التسليم: توقيعٌ يُتحقَّق منه ورمزٌ يُقاس');
  const receiver = await startReceiver();
  const endpointUrl = receiver.url(`/hooks/${stamp}`);
  const endpoint = await request(
    'post',
    `/platform/tenants/${demoTenantId}/webhooks`,
    { url: endpointUrl, events: ['invoice.posted', 'invoice.paid'], description: 'مستقبِل التحقّق الحيّ' },
    ownerToken,
  );
  created.endpoints.push({ id: endpoint.id, tenantId: demoTenantId });
  receiver.state.secret = endpoint.secret;
  check(
    'العنوان يُضاف وسرّه يبدأ whsec_',
    typeof endpoint.secret === 'string' && endpoint.secret.startsWith('whsec_'),
    endpoint.secretPrefix,
  );
  const badUrl = await attempts(
    'post',
    `/platform/tenants/${demoTenantId}/webhooks`,
    { url: 'http://example.com/hooks', events: ['invoice.posted'] },
    ownerToken,
  );
  check('وعنوان http عامّ يُرفض (400)', badUrl.status === 400, badUrl.problem?.code ?? '');
  const noEvents = await attempts(
    'post',
    `/platform/tenants/${demoTenantId}/webhooks`,
    { url: 'https://example.com/hooks', events: [] },
    ownerToken,
  );
  check('وبلا أحداثٍ يُرفض (400)', noEvents.status === 400, noEvents.problem?.code ?? '');

  receiver.state.status = 200;
  const testAttempt = await request('post', `/platform/webhooks/${endpoint.id}/test`, {}, ownerToken);
  const received = receiver.state.received.at(-1);
  check(
    'حدث الاختبار يصل فعلاً ويُقاس',
    testAttempt.status === 'delivered' && testAttempt.responseCode === 200,
    `${testAttempt.responseCode} · ${testAttempt.durationMs} ms`,
  );
  check('ويحمل ترويسات الحدث والتسليم والمنشأة', Boolean(received?.event) && Boolean(received?.deliveryId) && received?.tenantId === demoTenantId, received?.event ?? '');
  check('وحمولته JSON بترويسةٍ صحيحة', received?.contentType.includes('application/json') && typeof received?.parsed === 'object');
  check('وتوقيعه صحيحٌ عند المستقبِل', received?.signatureValid === true, received?.signature ?? '');
  check('وطابعه داخل نافذة القبول', received?.fresh === true);
  const forged = (() => {
    const [, timestamp] = /^t=(\d+),v1=/.exec(received.signature) ?? [];
    const wrong = createHmac('sha256', 'whsec_ليس_السرّ').update(`${timestamp}.${received.body}`).digest('hex');
    const expected = createHmac('sha256', endpoint.secret).update(`${timestamp}.${received.body}`).digest('hex');
    return wrong === expected;
  })();
  check('وتوقيعٌ بسرٍّ آخر لا يطابق (التزوير يسقط)', forged === false);

  receiver.state.status = 500;
  const failedAttempt = await request('post', `/platform/webhooks/${endpoint.id}/test`, {}, ownerToken);
  check(
    'وعند تعطّل المستقبِل يُسجَّل الفشل برمزه',
    failedAttempt.status === 'failed' && failedAttempt.responseCode === 500,
    `${failedAttempt.responseCode} · ${failedAttempt.error ?? ''}`,
  );

  const deliveries = itemsOf((await raw('get', `/platform/webhooks/${endpoint.id}/deliveries?limit=20`, undefined, ownerToken)).body?.data);
  const deliveredRow = deliveries.find((row) => row.status === 'delivered');
  const failedRow = deliveries.find((row) => row.status === 'failed');
  check('والسجلّ يحمل التسليمين', Boolean(deliveredRow) && Boolean(failedRow), `${deliveries.length} تسليماً`);
  check(
    'وبمفاتيح حمولةٍ لا بقيمها',
    Array.isArray(deliveredRow?.payloadKeys) && deliveredRow.payloadKeys.length > 0 && !('payload' in (deliveredRow ?? {})),
    deliveredRow?.payloadKeys?.join(',') ?? '',
  );
  check(
    'والفشل يحمل كود الاستجابة والزمن',
    failedRow?.responseCode === 500 && typeof failedRow?.durationMs === 'number',
    `${failedRow?.responseCode} · ${failedRow?.durationMs} ms`,
  );

  receiver.state.status = 200;
  const retry = await request(
    'post',
    `/platform/webhooks/${endpoint.id}/deliveries/${failedRow.id}/retry`,
    {},
    ownerToken,
  );
  check('وإعادة الإرسال تنجح بعد أن عاد المستقبِل', retry.status === 'delivered' && retry.responseCode === 200, `${retry.responseCode}`);
  const retryAgain = await attempts(
    'post',
    `/platform/webhooks/${endpoint.id}/deliveries/${failedRow.id}/retry`,
    {},
    ownerToken,
  );
  check(
    'وإعادة تسليمٍ وصل 409 INVALID_STATE',
    retryAgain.status === 409 && retryAgain.problem?.code === 'INVALID_STATE',
    retryAgain.problem?.code ?? '',
  );

  const endpointRows = itemsOf((await raw('get', `/platform/tenants/${demoTenantId}/webhooks`, undefined, ownerToken)).body?.data);
  const endpointRow = endpointRows.find((row) => row.id === endpoint.id);
  check(
    'والبطاقة تُحصي التسليمات وتقول آخر ردّ',
    endpointRow?.stats?.delivered >= 2 && endpointRow?.stats?.lastResponseCode === 200,
    `${endpointRow?.stats?.delivered} وصل · ${endpointRow?.stats?.failed} فشل · آخر رمز ${endpointRow?.stats?.lastResponseCode}`,
  );
  check('ولا يُعرض السرّ في القائمة', !(await raw('get', `/platform/tenants/${demoTenantId}/webhooks`, undefined, ownerToken)).text.includes(endpoint.secret));

  const paused = await request(
    'patch',
    `/platform/tenants/${demoTenantId}/webhooks/${endpoint.id}`,
    { status: 'paused' },
    ownerToken,
  );
  check('والإيقاف يُكتب على العنوان', paused.status === 'paused');
  // الإيقاف يمنع **التلقائي** (لا يُنشأ للأحداث صفّ تسليم) ويُبقي **الاختبار اليدوي**، لأن
  // صاحبه قد يكون أصلح مستقبِلَه للتوّ ويريد قياسه قبل أن يُعيد التشغيل. والقياس النافي
  // (لا صفّ لحدثٍ حقيقي والعنوان موقوف) في `platform-developer.spec.ts`.
  const pausedTest = await attempts('post', `/platform/webhooks/${endpoint.id}/test`, {}, ownerToken);
  check(
    'والاختبار اليدوي يبقى متاحاً والموقوف (الإيقاف للتلقائي)',
    pausedTest.status < 300 && pausedTest.data?.status === 'delivered',
    `${pausedTest.data?.responseCode ?? pausedTest.status}`,
  );
  const resumed = await request(
    'patch',
    `/platform/tenants/${demoTenantId}/webhooks/${endpoint.id}`,
    { status: 'active' },
    ownerToken,
  );
  check('والعنوان يعود للعمل بنقرة', resumed.status === 'active');

  // ─────────────────────────────────────────────── 8
  section('8. 🧍 العزل: مفتاحٌ لا يفتح بابَ غيره');
  const platformTenantId = (await request('get', '/platform/tenants?limit=200', undefined, ownerToken)).find(
    (row) => row.code === platformTenant,
  )?.id;
  const platformKeys = itemsOf((await raw('get', `/platform/tenants/${platformTenantId}/api-keys`, undefined, ownerToken)).body?.data);
  check(
    'مفاتيح منشأة المشغّلين لا تشمل مفتاح demo',
    !platformKeys.some((row) => row.id === rotated.id || row.prefix === rotated.prefix),
    `${platformKeys.length} مفتاحاً`,
  );
  const platformEndpoints = itemsOf((await raw('get', `/platform/tenants/${platformTenantId}/webhooks`, undefined, ownerToken)).body?.data);
  check('وعناوينها لا تشمل عنوان demo', !platformEndpoints.some((row) => row.id === endpoint.id));
  const crossTenant = await attempts('get', `/platform/webhooks/${endpoint.id}/deliveries`, undefined, demoToken);
  check('ورمز عميلٍ لا يقرأ تسليمات لوحة المنصة (403)', crossTenant.status === 403);
  const crossDeliveries = itemsOf((await raw('get', `/platform/webhooks/${endpoint.id}/deliveries`, undefined, ownerToken)).body?.data);
  check(
    'وكل تسليمٍ يحمل منشأته',
    crossDeliveries.length > 0 && crossDeliveries.every((row) => row.tenantId === demoTenantId),
    `${crossDeliveries.length} تسليماً`,
  );

  // ─────────────────────────────────────────────── 9
  section('9. 🧾 التدقيق: كل فعلٍ باسمه');
  const audit = itemsOf((await raw('get', `/platform/audit?limit=200`, undefined, ownerToken)).body?.data);
  const actions = new Set(
    audit.map((row) => row.action).filter((action) => typeof action === 'string' && action.startsWith('platform.api-key.')),
  );
  const webhookActions = new Set(
    audit.map((row) => row.action).filter((action) => typeof action === 'string' && action.startsWith('platform.webhook.')),
  );
  const expectedKeyActions = ['platform.api-key.create', 'platform.api-key.rotate', 'platform.api-key.revoke'];
  const expectedWebhookActions = ['platform.webhook.create', 'platform.webhook.test', 'platform.webhook.retry', 'platform.webhook.update'];
  for (const action of expectedKeyActions) {
    check(`التدقيق يحمل ${action}`, actions.has(action));
  }
  for (const action of expectedWebhookActions) {
    check(`التدقيق يحمل ${action}`, webhookActions.has(action));
  }

  // ─────────────────────────────────────────────── الخاتمة
  section('🧹 التنظيف (أثرٌ مقصود لا يُخفى)');
  if (keepArtifacts) {
    console.log('  · VERIFY_KEEP=1: المفاتيح والعنوان تُركت كما هي للمعاينة اليدوية.');
  } else {
    for (const id of created.keys) {
      await attempts('delete', `/platform/tenants/${demoTenantId}/api-keys/${id}`, { reason: 'تنظيف التحقّق الحيّ' }, ownerToken);
    }
    for (const entry of created.endpoints) {
      await attempts('delete', `/platform/tenants/${entry.tenantId}/webhooks/${entry.id}`, {}, ownerToken);
    }
    console.log('  · أُبطلت المفاتيح وحُذف العنوان (سجلّ التدقيق يبقى — لا يُمحى).');
  }
  await receiver.close();

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} فحصاً ناجحاً`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  if (error.problem) console.error(JSON.stringify(error.problem).slice(0, 500));
  process.exit(1);
});
