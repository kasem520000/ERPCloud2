#!/usr/bin/env node
/**
 * Live verification of P-C1 «الأساس والقشرة، وترميم الصلاحيات» and P-C2 «العملاء في العمق»
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the console drives — nothing is mocked:
 *
 *   1. 🔐 الجلسة والصلاحيات — ما يقوله `/me` لمشغّل المنصة ولغيره
 *   2. 🗺️ المسارات — كل مسار `/platform/*` يعمل للمالك
 *   3. 🚫 الأبواب المغلقة — جلسة مستأجر لا تصل إلى اللوحة
 *   4. 👥 الأدوار والرموز — الأدوار الخمسة، والرموز الثلاثة والعشرون (آخرها رمزا المحتوى P-M5)
 *   5. ⚙️ إعدادات المنصة — قراءة، كتابة، تدقيق، رفض، واستعادة
 *   6. 📜 التدقيق العابر للمستأجرين — بلا حدود منشأةٍ واحدة
 *   7. 🔎 البحث الشامل — Ctrl+K على الرمز والاسم العربي
 *   8. 👤 دور محدود — العمليات تقرأ ولا توقف منشأة
 *   9. 📋 المهام — صندوق الأحداث عبر كل العملاء
 *  10. 🪪 بطاقة العميل — كل سؤال عن عميل واحد في مكان واحد (P-C2)
 *  11. 📊 الاستخدام — مقابل الحدّ، ومصدر الحدّ، وتجاوز العميل
 *  12. 🚦 الحالة والملكية — بلا سبب لا يقع الفعل، والسبب في التدقيق
 *  13. 🚩 الرايات والهوية — حزمة تُفتح، ولون يُكتب، وشعار خبيث يُرفض
 *  14. 🗒️ الملاحظات — تُضاف، ولا تُحذف من بطاقة عميل آخر
 *  15. 🔐 أبواب بطاقة العميل — جلسة المستأجر لا تدخل
 *  16. 🪪 الهوية والوصول — الدليل والبطاقة والجلسات والمصفوفة ودعوة مشغّل (P-C3)
 *  17. 📣 الإعلانات — شاشة المنصة تقرأ ما كتبته شاشة الإعلانات (P-C7)
 *  18. 🎧 مكتب الدعم — الصندوق وسجلّ الدخول المؤقّت (P-C8)
 *  19. 🛠️ العمليات — الطابور والصحة والملفات (P-C9)
 *  20. 💾 البيانات والاسترجاع — النسخ والاحتفاظ وطلبات البيانات (P-C10)
 *  21. 🔑 بوّابة المطوّر — مفتاحٌ يعمل، وعنوانٌ يستقبل بتوقيعٍ يُتحقَّق منه (P-C11)
 *  22. 🧹 التنظيف — الحالة تعود كما كانت
 *
 * Re-runnable and non-destructive: the settings are snapshotted before anything is written
 * and restored at the end, and the temporary platform role granted in §8 is revoked in §10.
 * Nothing is emailed and no message is sent — the console's writes are its own settings and
 * one role grant on a seeded demo user.
 *
 * One deliberate **normalisation** is possible on a freshly seeded database, and §16 says so
 * rather than hiding it: `pnpm db:seed` writes the four feature flags as rows holding the
 * catalogue default (`false`). The card's write path treats "value equals the registry
 * default" as "no row" (that is what keeps `isDefault` truthful), so returning a flag to
 * `false` removes a row that merely repeated the default.
 *
 * P-C3 adds §16 and one more honest note: it invites a real operator
 * (`VERIFY_INVITE_EMAIL`, default `verify-pc3@erpverify.test`) because «دعوة مشغّل» is only
 * proven by a person who can actually sign in. The roles that invitation grants are revoked
 * in §17; the account row stays, and a second run re-uses it rather than creating another. The **effective** value the
 * customer sees is identical (the feature stays off), and a second run changes nothing —
 * which is what "no residue" means here, and what the before/after snapshot in the report
 * asserts.
 *
 *
 * ملاحظة P-C5: هذا السكربت **لا يكتب `limits.*`** — منذ P-C5 صار كتابةُ حدٍّ عام في
 * `platform_settings` تُشغِّل التطبيق على كل عميل، ولا مسار يحذف صفّ إعدادٍ عام؛ فالسكربت
 * الذي يكتب حدّاً ويعيد «قيمته السابقة» يترك خلفه حدّاً مطبَّقاً. القسم ٥ يكتب `billing.tax_rate`.
 * Usage: node scripts/verify-platform-console.mjs
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const demo = {
  tenantCode: process.env.VERIFY_TENANT ?? 'demo',
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
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

async function request(method, path, body, token) {
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
    throw error;
  }
  return parsed.data ?? parsed;
}

/** A call that is *expected* to be refused: its status and code are the answer. */
async function refused(method, path, body, token) {
  try {
    await request(method, path, body, token);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

async function signIn(tenantCode, credentials) {
  // The platform throttles /auth/login per address and this run signs in three times; a 429
  // is not a failed check, so wait the window out before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return { token, user: login.user };
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const ownerSession = await signIn(platformTenant, operator);
const ownerToken = ownerSession.token;
console.log(`✔ logged in to ${platformTenant} as ${operator.email}\n`);

const get = (path, token = ownerToken) => request('get', path, undefined, token);
const put = (path, body, token = ownerToken) => request('put', path, body, token);

// ═══════════════════════════════════════════════ 1. 🔐 الجلسة والصلاحيات
console.log('■ 1. 🔐 الجلسة والصلاحيات — ما يقوله /me');
const ownerMe = await get('/me');
const ownerCodes = ownerMe.platformPermissions ?? [];
check(
  'جلسة المنصة تُعلن أدوار المنصة',
  Array.isArray(ownerMe.user.platformRoles) && ownerMe.user.platformRoles.includes('platform_owner'),
  ownerMe.user.platformRoles.join(', '),
);
check('وترمز صلاحيات اللوحة على حدة', ownerCodes.length >= 15, `${ownerCodes.length} رمزاً`);
check('والمفتاح الجديد معلَن وممنوح للمالك', ownerCodes.includes('console.settings.manage'));
check(
  'ولا رمز console بين صلاحيات المستأجر',
  (ownerMe.permissions ?? []).every((code) => !code.startsWith('console.')),
);
check(
  'والمفتاح 🧪 محاكاة لا يظهر كرمز مستأجر',
  !(ownerMe.permissions ?? []).includes('console.settings.manage'),
);

const demoSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const demoToken = demoSession.token;
const demoMe = await get('/me', demoToken);
check('ومالك المستأجر لا يحمل أي رمز لوحة', (demoMe.platformPermissions ?? []).length === 0);
check('ولا يُعلَن مشغّل منصة', demoMe.user.isPlatformAdmin === false);

// ═══════════════════════════════════════════════════════ 2. 🗺️ المسارات
console.log('\n■ 2. 🗺️ المسارات — كل مسار /platform/* يعمل للمالك');
const GET_ROUTES = [
  '/platform/overview',
  '/platform/tenants',
  '/platform/plans',
  '/platform/subscriptions',
  '/platform/activation-requests',
  '/platform/users',
  '/platform/roles',
  '/platform/permissions',
  '/platform/audit',
  '/platform/settings',
  '/platform/tenants/search?q=demo',
  '/platform/jobs/outbox?limit=5',
  // P-M5 — شاشة المحتوى: الصفحات والقوائم واللافتات والتصنيفات المشتقّة.
  '/platform/content/pages',
  '/platform/content/menus',
  '/platform/content/banners',
  '/platform/content/categories',
];
for (const path of GET_ROUTES) {
  const result = await refused('get', path, undefined, ownerToken);
  check(
    `GET ${path}`,
    result.status === 200,
    result.status === 200 ? '' : `${result.status} ${result.detail}`,
  );
}

// ═════════════════════════════════════════════════ 3. 🚫 الأبواب المغلقة
console.log('\n■ 3. 🚫 الأبواب المغلقة — جلسة المستأجر لا تصل إلى اللوحة');
for (const path of [
  '/platform/overview',
  '/platform/tenants',
  '/platform/audit',
  '/platform/settings',
  '/platform/users',
]) {
  const result = await refused('get', path, undefined, demoToken);
  check(`${path} ترفض المستأجر`, result.status === 403, `${result.status} ${result.code}`);
}
const anonymous = await refused('get', '/platform/audit', undefined, '');
check('وترفض بلا جلسة', anonymous.status === 401, String(anonymous.status));

// ════════════════════════════════════════════ 4. 👥 الأدوار والرموز
console.log('\n■ 4. 👥 الأدوار والرموز');
const roles = await get('/platform/roles');
const roleCodes = roles.map((role) => role.code);
check(
  'الأدوار الخمسة كلها موجودة',
  ['platform_owner', 'platform_operations', 'platform_billing', 'platform_support', 'platform_auditor'].every(
    (code) => roleCodes.includes(code),
  ),
  roleCodes.join(', '),
);
const ownerRole = roles.find((role) => role.code === 'platform_owner');
const operationsRole = roles.find((role) => role.code === 'platform_operations');
// P-C12: الرمز الواحد والعشرون (`console.analytics.view`) — قراءةٌ خالصة تُمنح لكل من يقرأ
// أرقام المنصة: المالك والتشغيل والفوترة والمدقّق. والعدّ هنا مقصود: رمزٌ يُضاف إلى الفهرس
// بلا أن يظهر على الدور يعني أن أحداً لن يستطيع استخدام الشاشة، وهو ما يجب أن يسقط هنا لا في
// يد المشغّل.
check(
  // ٢٣ منذ P-M5 (رمزا المحتوى)، و٢٥ منذ P-M6 (رمزا العملاء المتوقّعين)، و**٢٦ منذ P-M7**:
  // `console.campaigns.manage` — رمزٌ واحد لا رمزان: من يقرأ لوحة الحملات يقرأ قائمةَ
  // أشخاصٍ حقيقيين بعناوينهم وتقارير فتحهم، ولا معنى لقراءةٍ بلا قرار إرسال.
  'مالك المنصة يحمل الرموز الستة والعشرين',
  ownerRole.permissions.length === 26,
  `${ownerRole.permissions.length}`,
);
check('والعمليات لا تملك إيقاف منشأة', !operationsRole.permissions.includes('console.tenants.manage'));
check('ولا تملك كتابة الإعدادات', !operationsRole.permissions.includes('console.settings.manage'));

const registry = await get('/platform/permissions');
check('سجل رموز اللوحة يعرضها كلها', registry.length === 26, `${registry.length} رمزاً`);
check(
  'ورموز المحتوى بينها (ترحيل 0078)',
  registry.some((entry) => entry.code === 'console.content.view') &&
    registry.some((entry) => entry.code === 'console.content.manage'),
);
check(
  'والمفتاح الجديد فيه',
  registry.some((entry) => entry.code === 'console.settings.manage'),
);
check(
  'ورمز الإعلانات (P-C7) في السجل أيضاً',
  registry.some((entry) => entry.code === 'console.notifications.manage'),
);
check(
  'ورمز النسخ (P-C10) في السجل أيضاً',
  registry.some((entry) => entry.code === 'console.backups.manage'),
);
check(
  'ورمزا المطوّر (P-C11) في السجل، وعند المالك والتشغيل وحدهما',
  registry.some((entry) => entry.code === 'console.apikeys.manage') &&
    registry.some((entry) => entry.code === 'console.webhooks.manage') &&
    ownerRole.permissions.includes('console.apikeys.manage') &&
    operationsRole.permissions.includes('console.webhooks.manage') &&
    !(roles.find((role) => role.code === 'platform_support')?.permissions ?? []).includes(
      'console.apikeys.manage',
    ),
  'الاعتماد لا يُنشئه الدعم',
);

// ════════════════════════════════════════════════ 5. ⚙️ إعدادات المنصة
console.log('\n■ 5. ⚙️ إعدادات المنصة');
const settingsSnapshot = await get('/platform/settings');
const snapshotValues = Object.fromEntries(
  settingsSnapshot.settings.map((setting) => [setting.key, setting.value]),
);
check(
  'البيئة مُعلَنة بوسمٍ عربي',
  typeof settingsSnapshot.environment.name === 'string' && settingsSnapshot.environment.labelAr.length > 0,
  `${settingsSnapshot.environment.name} / ${settingsSnapshot.environment.labelAr}`,
);
check(
  // P-M5: صار 27 — أُضيفت ثمانية مفاتيح بهوية الموقع التسويقي (`site.*`)؛ وP-C12 (التقرير
  // الأسبوعي): أربعة (`report.weekly_*`)؛ وP-M4: `billing.trial_days` (فترة التجربة التي
  // يعلنها معالج الاشتراك) — كلها تُدار من هذه الشاشة نفسها، فلا شاشةَ ثانية.
  'اثنان وثلاثون إعداداً معرَّفاً (+ أربعة للتقرير الأسبوعي)',
  settingsSnapshot.settings.length === 32,
  `${settingsSnapshot.settings.length}`,
);
check(
  'ومفاتيح التقرير الأسبوعي الأربعة بينها',
  [
    'report.weekly_enabled',
    'report.weekly_recipients',
    'report.weekly_day',
    'report.weekly_hour',
  ].every((key) => settingsSnapshot.settings.some((setting) => setting.key === key)),
  settingsSnapshot.settings.filter((setting) => setting.key.startsWith('report.')).length + ' مفتاحاً',
);
check(
  'ومفاتيح الموقع الثمانية بينها',
  ['site.brand_name', 'site.tagline_ar', 'site.default_locale', 'site.url', 'site.maintenance'].every(
    (key) => settingsSnapshot.settings.some((setting) => setting.key === key),
  ),
  settingsSnapshot.settings.filter((setting) => setting.key.startsWith('site.')).length + ' مفتاحاً',
);
check(
  'ومفاتيح الحدود الخمسة الجديدة بينها',
  [
    'limits.max_items',
    'limits.max_storage_mb',
    'limits.max_api_calls_per_day',
    'limits.max_whatsapp_per_month',
    'limits.max_emails_per_month',
  ].every((key) => settingsSnapshot.settings.some((setting) => setting.key === key)),
);
check(
  'ومفاتيح الفاتورة الضريبية بينها',
  [
    'billing.seller_name',
    'billing.seller_tax_number',
    'billing.seller_address',
    'billing.tax_rate',
    'billing.payment_terms_days',
    'billing.dunning_days',
  ].every((key) => settingsSnapshot.settings.some((setting) => setting.key === key)),
);
check(
  'وكل إعداد له تسمية عربية وشرح',
  settingsSnapshot.settings.every((setting) => setting.labelAr.length > 0 && setting.helpAr.length > 0),
);
check(
  'والحدود الافتراضية الثلاثة معروضة',
  ['limits.max_users', 'limits.max_branches', 'limits.max_invoices_per_month'].every((key) =>
    settingsSnapshot.settings.some((setting) => setting.key === key),
  ),
);

try {
  const written = await put('/platform/settings', {
    values: {
      'support.email': 'support.verify@demo.test',
      'support.phone': '920000000',
      'platform.domains': ['verify.example.test'],
      // لا نكتب `limits.*` هنا منذ P-C5: كتابة حدٍّ عام تُشغِّل التطبيق على كل عميل،
      // والسكربت لا يملك ما يمحو الصفّ (لا مسار حذف لإعداد منصّة). البديل عددٌ ليس حدّاً.
      'billing.tax_rate': 16,
      'platform.maintenance': true,
      'platform.maintenance_message': 'نافذة صيانة تجريبية',
    },
  });
  const byKey = Object.fromEntries(written.settings.map((setting) => [setting.key, setting]));
  check('الكتابة تُقرأ فوراً', byKey['support.email'].value === 'support.verify@demo.test');
  check(
    'والأعداد تُخزَّن أعداداً',
    byKey['billing.tax_rate'].value === 16,
    typeof byKey['billing.tax_rate'].value,
  );
  check(
    'والقوائم تُخزَّن قوائم',
    Array.isArray(byKey['platform.domains'].value) &&
      byKey['platform.domains'].value[0] === 'verify.example.test',
  );
  check('ومفتاح الصيانة صار مفتوحاً', byKey['platform.maintenance'].value === true);
  check('ولم يبقَ إعدادٌ على قيمته الافتراضية', byKey['support.email'].isDefault === false);

  const persisted = await get('/platform/settings');
  check(
    'والقيمة تبقى بعد قراءةٍ جديدة',
    persisted.settings.find((setting) => setting.key === 'support.phone').value === '920000000',
  );

  const auditRows = await get(
    '/platform/audit?filter[entity]=platform_settings&filter[entityId]=platform.maintenance&limit=5',
  );
  check('وكل كتابة تُسجَّل في التدقيق', auditRows.items.length >= 1, `${auditRows.items.length} سطراً`);
  const auditRow = auditRows.items[0] ?? {};
  check('بصاحب الفعل', auditRow.actorUserId === ownerMe.user.id);
  check('وبقيمة قبل وبعد', auditRow.before?.value === false && auditRow.after?.value === true);

  const badKey = await refused(
    'put',
    '/platform/settings',
    { values: { 'platform.colour': 'teal' } },
    ownerToken,
  );
  check('والرفض 422 لمفتاح مجهول', badKey.status === 422, `${badKey.status} ${badKey.detail}`);
  const badEmail = await refused(
    'put',
    '/platform/settings',
    { values: { 'support.email': 'not-an-email' } },
    ownerToken,
  );
  check('ولبريدٍ تالف', badEmail.status === 422, `${badEmail.status}`);
  const badRange = await refused(
    'put',
    '/platform/settings',
    { values: { 'limits.max_branches': -5 } },
    ownerToken,
  );
  check('ولعددٍ خارج المدى', badRange.status === 422, `${badRange.status}`);
} finally {
  // إعادة القيم التي كتبها هذا القسم وحده. الكتابة الشاملة لكل اللقطة كانت تُنشئ صفوفاً
  // لمفاتيح لم يكتبها السكربت (ومنها `limits.*`) — ومع P-C5 يصير صفُّ الحدّ تطبيقاً فعلياً.
  await put('/platform/settings', {
    values: {
      'support.email': snapshotValues['support.email'],
      'support.phone': snapshotValues['support.phone'],
      'platform.domains': snapshotValues['platform.domains'],
      'billing.tax_rate': snapshotValues['billing.tax_rate'],
      'platform.maintenance': snapshotValues['platform.maintenance'],
      'platform.maintenance_message': snapshotValues['platform.maintenance_message'],
    },
  });
}

// ═══════════════════════════════════ 6. 📜 التدقيق العابر للمستأجرين
console.log('\n■ 6. 📜 التدقيق العابر للمستأجرين');
const auditAll = await get('/platform/audit?limit=200');
check(
  'السجل يعود بصفحة وعددٍ كلي',
  typeof auditAll.total === 'number' && Array.isArray(auditAll.items),
  `total=${auditAll.total}`,
);
check(
  'القراءة تعبر المستأجرين',
  new Set(auditAll.items.map((row) => row.tenantId)).size > 1,
  `${new Set(auditAll.items.map((row) => row.tenantId)).size} منشأة`,
);
const withCustomer = auditAll.items.find((row) => row.tenantId !== null && row.tenantCode);
check('وكل سطر يحمل اسم عميله ورمزه', Boolean(withCustomer?.tenantName), withCustomer?.tenantCode ?? '—');
const byTenant = await get(`/platform/audit?filter[tenantId]=${withCustomer.tenantId}&limit=50`);
check(
  'والمرشّح بالمستأجر يحصر النتائج',
  byTenant.items.length > 0 && byTenant.items.every((row) => row.tenantId === withCustomer.tenantId),
  `${byTenant.items.length} سطراً`,
);
const byAction = await get('/platform/audit?filter[action]=auth.login&limit=5');
check(
  'ومرشّح الإجراء يعمل',
  byAction.items.length > 0 && byAction.items.every((row) => row.action === 'auth.login'),
  `${byAction.items.length} سطراً`,
);
const badFilter = await refused('get', '/platform/audit?filter[colour]=red', undefined, ownerToken);
check(
  'والمرشّح المجهول يُرفض 400',
  badFilter.status === 400 && badFilter.code === 'FILTER_NOT_ALLOWED',
  badFilter.code,
);
const tenantAudit = await get('/audit-log?limit=5', demoToken);
check('وسجل المستأجر يبقى خاصاً به', Array.isArray(tenantAudit.data) || Array.isArray(tenantAudit));

// ═══════════════════════════════════════════════════ 7. 🔎 البحث الشامل
console.log('\n■ 7. 🔎 البحث الشامل');
const byCode = await get('/platform/tenants/search?q=demo');
check(
  'البحث بالرمز يجد العميل',
  byCode.some((hit) => hit.code === demo.tenantCode),
  byCode.map((hit) => hit.code).join(', '),
);
const allTenants = await get('/platform/tenants');
const arabic = allTenants.find((tenant) => /[\u0600-\u06FF]/.test(tenant.name));
if (arabic) {
  const byName = await get(`/platform/tenants/search?q=${encodeURIComponent(arabic.name.slice(0, 6))}`);
  check(
    'والبحث بالاسم العربي يعمل',
    byName.some((hit) => hit.id === arabic.id),
    arabic.name,
  );
} else {
  check('والبحث بالاسم يعمل', true, 'لا اسم عربي في قاعدة البيانات — تُخطّى');
}
const emptySearch = await refused('get', '/platform/tenants/search?q=', undefined, ownerToken);
check('والاستعلام الفارغ يُرفض 400', emptySearch.status === 400, String(emptySearch.status));

// ════════════════════════════════════════════════════ 8. 👤 دور محدود
console.log('\n■ 8. 👤 دور محدود — العمليات تقرأ ولا توقف منشأة');
const demoRow = (await get(`/platform/users?search=${encodeURIComponent(demo.email)}`)).find(
  (row) => row.email === demo.email,
);
check('وجدنا حساب التجربة في دليل المستخدمين', Boolean(demoRow), demoRow?.id ?? '—');
await request('post', `/platform/users/${demoRow.id}/roles`, { roleCode: 'platform_operations' }, ownerToken);
const limitedSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const limitedToken = limitedSession.token;
const limitedMe = await get('/me', limitedToken);
check(
  'صار يحمل رموز العمليات',
  (limitedMe.platformPermissions ?? []).includes('console.tenants.view') &&
    !(limitedMe.platformPermissions ?? []).includes('console.tenants.manage'),
  (limitedMe.platformPermissions ?? []).join(', '),
);
const limitedAudit = await refused('get', '/platform/audit?limit=1', undefined, limitedToken);
check('ويقرأ التدقيق', limitedAudit.status === 200, String(limitedAudit.status));
const limitedSettings = await refused('get', '/platform/settings', undefined, limitedToken);
check('ويقرأ الإعدادات', limitedSettings.status === 200, String(limitedSettings.status));
const limitedWrite = await refused(
  'put',
  '/platform/settings',
  { values: { 'platform.maintenance': false } },
  limitedToken,
);
check(
  'ولا يكتبها (console.settings.manage)',
  limitedWrite.status === 403 &&
    limitedWrite.detail === 'platform permission console.settings.manage required',
  `${limitedWrite.status} ${limitedWrite.detail}`,
);
const limitedSuspend = await refused(
  'post',
  `/platform/tenants/${demoMe.membership.tenantId}/status`,
  { status: 'suspended', reason: 'محاولة من دور العمليات' },
  limitedToken,
);
check(
  'ولا يوقف منشأة (console.tenants.manage)',
  limitedSuspend.status === 403 &&
    limitedSuspend.detail === 'platform permission console.tenants.manage required',
  `${limitedSuspend.status} ${limitedSuspend.detail}`,
);

// ═════════════════════════════════════════════════════════════ 9. 📋 المهام
console.log('\n■ 9. 📋 المهام — صندوق الأحداث عبر كل العملاء');
const outbox = await get('/platform/jobs/outbox?limit=20');
check(
  'الصندوق يعود بصفحةٍ وعدد',
  Array.isArray(outbox.items) && typeof outbox.total === 'number',
  `total=${outbox.total}`,
);
check(
  'وكل مهمة تحمل عميلها',
  outbox.items.every((job) => job.tenantId && 'tenantCode' in job && 'status' in job),
  `${outbox.items.length} مهمة`,
);
const filteredOutbox = await get('/platform/jobs/outbox?status=dead&limit=5');
check(
  'والمرشّح بالحالة يعمل',
  filteredOutbox.items.every((job) => job.status === 'dead'),
);
const outboxDenied = await refused('get', '/platform/jobs/outbox', undefined, demoToken);
check('والمستأجر لا يراه', outboxDenied.status === 403, String(outboxDenied.status));

// ═══════════════════════════════════════════ 10. 🪪 بطاقة العميل
console.log('\n■ 10. 🪪 بطاقة العميل — كل سؤال عن عميل واحد');
const demoId = demoMe.membership.tenantId;
const cardSnapshot = await get(`/platform/tenants/${demoId}`);
const cardTenant = cardSnapshot.tenant;
check(
  'البطاقة تعود باسم العميل ورمزه',
  cardTenant.code === demo.tenantCode && cardTenant.name.length > 0,
  `${cardTenant.code} / ${cardTenant.name}`,
);
check(
  'وبحالته وعملته',
  ['active', 'suspended', 'archived'].includes(cardTenant.status),
  `${cardTenant.status} · ${cardTenant.baseCurrency}`,
);
check(
  'وأعداد المستخدمين والفروع',
  typeof cardTenant.userCount === 'number' && cardTenant.branchCount >= 1,
  `${cardTenant.userCount} مستخدماً · ${cardTenant.branchCount} فرعاً`,
);
check(
  'وعدّاد فواتير آخر ثلاثين يوماً',
  typeof cardTenant.invoicesLast30Days === 'number',
  String(cardTenant.invoicesLast30Days),
);
check(
  'وآخر نشاط من التدقيق لا من سجل المتصفح',
  cardTenant.lastActivityAt === null || !Number.isNaN(Date.parse(cardTenant.lastActivityAt)),
  String(cardTenant.lastActivityAt),
);
check('ومالك المنشأة مُسمّى', Boolean(cardTenant.owner?.email), cardTenant.owner?.email ?? '—');
check(
  'وسطور المستخدمين تحمل أدوارهم',
  cardSnapshot.members.every(
    (member) => typeof member.roleCount === 'number' && typeof member.isOwner === 'boolean',
  ),
  `${cardSnapshot.members.length} عضواً`,
);
const missingCard = await refused(
  'get',
  '/platform/tenants/00000000-0000-0000-0000-000000000001',
  undefined,
  ownerToken,
);
check('وعميل غير موجود يردّ 404', missingCard.status === 404, `${missingCard.status} ${missingCard.code}`);
const badCard = await refused('get', '/platform/tenants/not-a-uuid', undefined, ownerToken);
check('ومعرّف تالف 400', badCard.status === 400, String(badCard.status));

// ═══════════════════════════════════════════ 11. 📊 الاستخدام
console.log('\n■ 11. 📊 الاستخدام — مقابل الحدّ، ومصدر الحدّ');
const usage = await get(`/platform/tenants/${demoId}/usage`);
const metricKeys = usage.metrics.map((metric) => metric.key);
check(
  // P-C5: البطاقة لم تعد ثلاثة عدّادات — صارت فهرس المقاييس الثمانية نفسه، تقرؤه من المحرّك.
  'البطاقة تقيس المقاييس الثمانية بترتيبها',
  JSON.stringify(metricKeys) ===
    JSON.stringify([
      'users',
      'branches',
      'items',
      'invoices_per_month',
      'storage_mb',
      'api_calls_per_day',
      'whatsapp_per_month',
      'email_sends_per_month',
    ]),
  metricKeys.join(', '),
);
check(
  'وكل مقياس يقول حالته وهل يُطبَّق',
  usage.metrics.every(
    (metric) =>
      ['ok', 'soft', 'hard', 'unlimited'].includes(metric.state) && typeof metric.enforced === 'boolean',
  ),
  usage.metrics
    .map((metric) => `${metric.key}:${metric.state}${metric.enforced ? '' : '(report)'}`)
    .join(' '),
);
check(
  'وكل بند يقول مصدر حدّه',
  usage.metrics.every((metric) => ['tenant', 'platform', 'default'].includes(metric.limitSource)),
  usage.metrics.map((metric) => `${metric.key}:${metric.limitSource}`).join(' '),
);
check(
  'وسلسلة ثلاثين يوماً كاملة',
  usage.invoicesPerDay.length === 30,
  `${usage.invoicesPerDay.length} يوماً`,
);
const usersMetric = usage.metrics.find((metric) => metric.key === 'users');
check('وعدد المستخدمين يطابق البطاقة', usersMetric.used === cardTenant.userCount, `${usersMetric.used}`);

const tenantSettingBefore = await get(`/platform/tenants/${demoId}/settings`);
check(
  'وإعدادات العميل تعرض القسم المسموح للمستأجر فقط',
  tenantSettingBefore.settings.every(
    (setting) => !setting.key.startsWith('platform.') && !setting.key.startsWith('support.'),
  ),
  `${tenantSettingBefore.settings.length} مفتاحاً`,
);
try {
  const override = await put(`/platform/tenants/${demoId}/settings/limits.max_users`, { value: 7 });
  const afterOverride = override.settings.find((setting) => setting.key === 'limits.max_users');
  check(
    'كتابة تجاوزٍ خاص بالعميل',
    afterOverride.value === 7 && afterOverride.source === 'tenant',
    `${afterOverride.value} من ${afterOverride.source}`,
  );
  const usageAfter = await get(`/platform/tenants/${demoId}/usage`);
  check(
    'والاستخدام يقرأ التجاوز لا الافتراضي',
    usageAfter.metrics.find((metric) => metric.key === 'users').limit === 7 &&
      usageAfter.metrics.find((metric) => metric.key === 'users').limitSource === 'tenant',
  );
  const platformOnly = await refused(
    'put',
    `/platform/tenants/${demoId}/settings/platform.maintenance`,
    { value: true },
    ownerToken,
  );
  check(
    'ومفتاح المنصة يُرفض هنا 422',
    platformOnly.status === 422,
    `${platformOnly.status} ${platformOnly.detail}`,
  );
  const badValue = await refused(
    'put',
    `/platform/tenants/${demoId}/settings/branding.primary_color`,
    { value: 'teal' },
    ownerToken,
  );
  check('ولون بصيغة خاطئة 422', badValue.status === 422, `${badValue.status}`);
} finally {
  await put(`/platform/tenants/${demoId}/settings/limits.max_users`, { value: null });
  const cleared = await get(`/platform/tenants/${demoId}/settings`);
  check(
    'وإزالة التجاوز تُرجع العميل إلى قيمة المنصة',
    cleared.settings.find((setting) => setting.key === 'limits.max_users').source !== 'tenant',
  );
}

// ═══════════════════════════════════════ 12. 🚦 الحالة والملكية
console.log('\n■ 12. 🚦 الحالة والملكية — بلا سبب لا يقع الفعل');
const noReason = await refused(
  'post',
  `/platform/tenants/${demoId}/status`,
  { status: 'suspended' },
  ownerToken,
);
check('الإيقاف بلا سبب يُرفض 400', noReason.status === 400, String(noReason.status));
const suspended = await request(
  'post',
  `/platform/tenants/${demoId}/status`,
  { status: 'suspended', reason: 'تحقّق حيّ P-C2' },
  ownerToken,
);
check('وبالسبب يقع الإيقاف', suspended.status === 'suspended', suspended.status);
const alreadySuspended = await refused(
  'post',
  `/platform/tenants/${demoId}/status`,
  { status: 'suspended', reason: 'تحقّق حيّ P-C2' },
  ownerToken,
);
check(
  'وتكرار نفس الحالة يُرفض 409',
  alreadySuspended.status === 409 && alreadySuspended.code === 'TENANT_STATUS_UNCHANGED',
  `${alreadySuspended.status} ${alreadySuspended.code}`,
);
const suspendedHealth = await get(`/platform/tenants/${demoId}/health`);
check(
  'والصحة تُعلن الإيقاف',
  suspendedHealth.findings.some((finding) => finding.text.includes('موقوف')),
  suspendedHealth.status,
);
const reactivated = await request(
  'post',
  `/platform/tenants/${demoId}/status`,
  { status: 'active', reason: 'انتهى التحقّق الحيّ' },
  ownerToken,
);
check('وإعادة التنشيط تعود بالحالة', reactivated.status === 'active');
const statusAudit = await get(`/platform/audit?filter[tenantId]=${demoId}&filter[entity]=tenant&limit=50`);
const statusRow = statusAudit.items.find(
  (row) => row.action === 'tenant.status' && row.after?.status === 'suspended',
);
check(
  'وسبب الإيقاف محفوظ في تدقيق العميل نفسه',
  Boolean(statusRow) && statusRow.meta?.reason === 'تحقّق حيّ P-C2',
  statusRow?.meta?.reason ?? '—',
);

const members = cardSnapshot.members;
const otherMember = members.find((member) => !member.isOwner && member.status === 'active');
if (otherMember) {
  const badTransfer = await refused(
    'post',
    `/platform/tenants/${demoId}/owner/transfer`,
    { membershipId: '00000000-0000-0000-0000-000000000002', reason: 'عضو غير موجود' },
    ownerToken,
  );
  check('نقل الملكية لعضو غير موجود 404', badTransfer.status === 404, String(badTransfer.status));
  const transferred = await request(
    'post',
    `/platform/tenants/${demoId}/owner/transfer`,
    { membershipId: otherMember.membershipId, reason: 'تحقّق حيّ P-C2' },
    ownerToken,
  );
  check('والنقل لعضو قائم يقع', transferred.owner.email === otherMember.email, transferred.owner.email);
  const back = await request(
    'post',
    `/platform/tenants/${demoId}/owner/transfer`,
    { membershipId: cardTenant.owner.membershipId, reason: 'إعادة المالك في التحقّق' },
    ownerToken,
  );
  check('ويُعاد المالك الأصلي', back.owner.email === cardTenant.owner.email, back.owner.email);
} else {
  check('لا عضو ثانٍ نشط لنقل الملكية — تُخطّى', true, 'منشأة التجربة بمستخدم واحد');
}

// ═══════════════════════════ 13. 🚩 الرايات والهوية
console.log('\n■ 13. 🚩 الرايات والهوية');
const flagsBefore = await get(`/platform/tenants/${demoId}/flags`);
check('الرايات أربع', flagsBefore.flags.length === 4, flagsBefore.flags.map((flag) => flag.key).join(', '));
check(
  'وكل راية تقول أهي افتراضية أم مضبوطة',
  flagsBefore.flags.every((flag) => typeof flag.isDefault === 'boolean' && typeof flag.enabled === 'boolean'),
);
const previousFlags = Object.fromEntries(flagsBefore.flags.map((flag) => [flag.key, flag.enabled]));
// `isDefault === false` means the customer had an explicit row; §16 reports when the write
// path turned such a redundant row (one that merely repeated the catalogue default) into none.
const previousFlagRows = Object.fromEntries(flagsBefore.flags.map((flag) => [flag.key, flag.isDefault]));
const openedFlag = await put(`/platform/tenants/${demoId}/flags`, { values: { 'feature.pos': true } });
check('فتح حزمة نقطة البيع', openedFlag.flags.find((flag) => flag.key === 'feature.pos').enabled === true);
const demoFlagView = await get('/settings', demoToken);
check('ويراها العميل في إعداداته (نفس المخزن)', demoFlagView.settings['feature.pos'] === true);
const unknownFlag = await refused(
  'put',
  `/platform/tenants/${demoId}/flags`,
  { values: { 'feature.nope': true } },
  ownerToken,
);
check('وراية مجهولة 422', unknownFlag.status === 422, `${unknownFlag.status} ${unknownFlag.detail}`);
await put(`/platform/tenants/${demoId}/flags`, { values: previousFlags });

const brandingBefore = await get(`/platform/tenants/${demoId}/branding`);
try {
  const branding = await put(`/platform/tenants/${demoId}/branding`, {
    primaryColor: '#123ABC',
    senderName: 'شركة تجريبية',
    logoUrl: 'https://example.test/logo.png',
  });
  check(
    'كتابة الهوية (لون · شعار · اسم المُرسِل)',
    branding.primaryColor === '#123abc' && branding.senderName === 'شركة تجريبية',
    branding.primaryColor,
  );
  const brandingAgain = await get(`/platform/tenants/${demoId}/branding`);
  check('والقراءة تُرجعها كما كُتبت', brandingAgain.logoUrl === 'https://example.test/logo.png');
  const badLogo = await refused(
    'put',
    `/platform/tenants/${demoId}/branding`,
    { logoUrl: 'javascript:alert(1)' },
    ownerToken,
  );
  check('ورشعار بخواص خطرة 422', badLogo.status === 422, `${badLogo.status} ${badLogo.detail}`);
} finally {
  // `updatedAt === null` means the customer had **no** branding override: writing the
  // defaults back would leave three rows saying what the catalogue already says.
  const hadOverride = brandingBefore.updatedAt !== null;
  if (hadOverride) {
    await put(`/platform/tenants/${demoId}/branding`, {
      primaryColor: brandingBefore.primaryColor,
      senderName: brandingBefore.senderName,
      logoUrl: brandingBefore.logoUrl,
    });
  } else {
    for (const key of ['branding.primary_color', 'branding.logo_url', 'branding.sender_name']) {
      await put(`/platform/tenants/${demoId}/settings/${key}`, { value: null });
    }
  }
  const brandingAfter = await get(`/platform/tenants/${demoId}/branding`);
  const sameBranding =
    brandingAfter.primaryColor === brandingBefore.primaryColor &&
    brandingAfter.senderName === brandingBefore.senderName &&
    brandingAfter.logoUrl === brandingBefore.logoUrl &&
    (brandingAfter.updatedAt === null) === (brandingBefore.updatedAt === null);
  check('واستُعيدت الهوية إلى ما كانت عليه', sameBranding, hadOverride ? 'كما كانت' : 'بلا تجاوز');
}

// ═══════════════════════════════════════════ 14. 🗒️ الملاحظات
console.log('\n■ 14. 🗒️ الملاحظات — ما لا تحتمله الحقول');
const beforeNotes = await get(`/platform/tenants/${demoId}/notes`);
const note = await request(
  'post',
  `/platform/tenants/${demoId}/notes`,
  { body: 'ملاحظة تحقّق حيّ P-C2' },
  ownerToken,
);
check('إضافة ملاحظة تُرجع كاتبها', note.authorLabel.length > 0, note.authorLabel);
const listedNotes = await get(`/platform/tenants/${demoId}/notes`);
check('وتبدو في القائمة', listedNotes.total === (beforeNotes.total ?? 0) + 1, `${listedNotes.total} ملاحظة`);
const foreignNote = await refused(
  'delete',
  `/platform/tenants/${withCustomer.tenantId}/notes/${note.id}`,
  undefined,
  ownerToken,
);
check('ولا تُحذف من بطاقة عميل آخر (404)', foreignNote.status === 404, String(foreignNote.status));
const deletedNote = await request(
  'delete',
  `/platform/tenants/${demoId}/notes/${note.id}`,
  undefined,
  ownerToken,
);
check('وتُحذف من بطاقة صاحبها', deletedNote.deleted === true);
const noteAudit = await get(`/platform/audit?filter[tenantId]=${demoId}&filter[entity]=tenant_note&limit=20`);
check(
  'ونصّها باقٍ في التدقيق بعد الحذف',
  noteAudit.items.some((row) => row.before?.body === 'ملاحظة تحقّق حيّ P-C2'),
  `${noteAudit.items.length} سطراً`,
);

// ═════════════════════════════ 15. 🔐 أبواب بطاقة العميل
console.log('\n■ 15. 🔐 أبواب بطاقة العميل');
for (const path of [
  `/platform/tenants/${demoId}`,
  `/platform/tenants/${demoId}/usage`,
  `/platform/tenants/${demoId}/settings`,
  `/platform/tenants/${demoId}/flags`,
  `/platform/tenants/${demoId}/branding`,
  `/platform/tenants/${demoId}/health`,
  `/platform/tenants/${demoId}/notes`,
]) {
  const result = await refused('get', path, undefined, demoToken);
  check(
    `GET ${path.replace(demoId, ':id')} ترفض جلسة المستأجر`,
    result.status === 403,
    `${result.status} ${result.code}`,
  );
}
const anonCard = await refused('get', `/platform/tenants/${demoId}`, undefined, '');
check('وترفض بلا جلسة 401', anonCard.status === 401, String(anonCard.status));

// ══════════════════════════════════ 16. 🪪 الهوية والوصول — مَن يدير المنصة نفسها (P-C3)
console.log('\n■ 16. 🪪 الهوية والوصول — الدليل والبطاقة والجلسات والمصفوفة والدعوة');

// --- الدليل: صفٌّ لكل إنسان، ومنشآته، ودوره، وحالة 2FA
const directory = await get('/platform/users');
check(
  'دليل المستخدمين يقرأ عبر المنشآت',
  Array.isArray(directory) && directory.length > 0,
  `${directory.length} حساباً`,
);
const selfRow = (await get(`/platform/users?search=${encodeURIComponent(operator.email)}`)).find(
  (row) => row.email === operator.email,
);
check('والبحث يجد مشغّل المنصة نفسه', Boolean(selfRow), selfRow?.id ?? '—');
const demoRow2 = directory.find((row) => row.email === demo.email);
check(
  'والصف يحمل المنشأة والدور وحالة 2FA وآخر دخول',
  Boolean(demoRow2) &&
    Array.isArray(demoRow2.tenants) &&
    demoRow2.tenants.some((tenant) => tenant.code === demo.tenantCode) &&
    typeof demoRow2.mfaEnabled === 'boolean' &&
    typeof demoRow2.activeSessionCount === 'number' &&
    'lastLoginAt' in demoRow2,
  demoRow2
    ? `${demoRow2.tenants.map((tenant) => tenant.code).join(',')} · ${demoRow2.activeSessionCount} جلسة`
    : '—',
);
const unknownUser = await refused(
  'get',
  `/platform/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
  undefined,
  ownerToken,
);
check('ومعرّف لا وجود له 404', unknownUser.status === 404, String(unknownUser.status));
const malformedId = await refused('get', '/platform/users/not-a-uuid', undefined, ownerToken);
check('ومعرّف مشوّه 400', malformedId.status === 400, String(malformedId.status));

// --- البطاقة: هو + أدواره + عضوياته + جلساته
const selfCard = await get(`/platform/users/${selfRow.id}`);
check(
  'بطاقة المستخدم تجمع العضويات والأدوار والجلسات',
  Array.isArray(selfCard.memberships) &&
    Array.isArray(selfCard.sessions) &&
    Array.isArray(selfCard.platformRoles) &&
    selfCard.platformRoles.includes('platform_owner'),
  `${selfCard.memberships.length} عضوية · ${selfCard.sessions.length} جلسة`,
);
const ownerLiveSession = selfCard.sessions.find((session) => !session.revoked);
check('وجلسته الحالية معروفة بمعرّف عائلة', Boolean(ownerLiveSession?.id), ownerLiveSession?.ip ?? '—');
check(
  'ولا كلمة مرور ولا بصمة تشفير في البطاقة',
  !JSON.stringify(selfCard).includes('argon2') && !JSON.stringify(selfCard).includes('password_hash'),
);

// --- الجلسات: القراءة، والسبب الإلزامي، وما لا وجود له
const missingReason = await refused(
  'delete',
  `/platform/sessions/${ownerLiveSession.id}`,
  undefined,
  ownerToken,
);
check(
  'إبطال جلسة بلا سبب يُرفض (400)',
  missingReason.status === 400,
  `${missingReason.status} ${missingReason.code}`,
);
const ghostSession = await refused(
  'delete',
  `/platform/sessions/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}?reason=${encodeURIComponent('جلسة وهمية')}`,
  undefined,
  ownerToken,
);
check('وجلسة لا وجود لها 404', ghostSession.status === 404, String(ghostSession.status));
const sessionRead = await refused('get', `/platform/sessions/${ownerLiveSession.id}`, undefined, ownerToken);
check('والبطاقة تقرأ الجلسة بمفردها', sessionRead.status === 200, String(sessionRead.status));

// --- إعادة تعيين 2FA: الباب قائم، والسبب شرط، ولا نمسّ 2FA حقيقيًّا في تشغيل التحقّق
const mfaNoReason = await refused(
  'post',
  `/platform/users/${selfRow.id}/mfa/reset`,
  { reason: '' },
  ownerToken,
);
check(
  'إعادة تعيين 2FA بلا سبب تُرفض (400)',
  mfaNoReason.status === 400,
  `${mfaNoReason.status} ${mfaNoReason.code}`,
);
const mfaGhost = await refused(
  'post',
  `/platform/users/${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}/mfa/reset`,
  { reason: 'حساب وهمي' },
  ownerToken,
);
check('وحساب لا وجود له 404', mfaGhost.status === 404, String(mfaGhost.status));

// --- المصفوفة: الفهرس، والفعل، والتجاوز، والإرجاع
const matrix = await get('/platform/roles');
check(
  'المصفوفة تعرض الأدوار الخمسة بأسمائها العربية',
  matrix.length === 5 && matrix.every((role) => role.nameAr),
  matrix.map((role) => role.nameAr).join(' · '),
);
check(
  'وكل دور يفرّق بين الفهرس والفعل ويعدّ حامليه',
  matrix.every(
    (role) =>
      Array.isArray(role.catalogPermissions) &&
      Array.isArray(role.permissions) &&
      typeof role.holderCount === 'number',
  ),
);
const supportCatalog = [
  ...(matrix.find((role) => role.code === 'platform_support')?.catalogPermissions ?? []),
];
const auditorCatalog = [
  ...(matrix.find((role) => role.code === 'platform_auditor')?.catalogPermissions ?? []),
];
check(
  // P-C12: صار ستّةً (`console.analytics.view`)؛ و**سبعةً في P-M6** بإضافة `console.leads.view`
  // — وهي `.view` كذلك: الرقابة تقرأ بيانات من وصل من الموقع ولا تُبدّلها.
  'والمدقّق يحمل رموز القراءة وحدها',
  auditorCatalog.length === 7 && auditorCatalog.every((code) => code.endsWith('.view')),
  auditorCatalog.join(' · '),
);
const ownerRoleRow = matrix.find((role) => role.code === 'platform_owner');
check(
  'ومالك المنصة على الفهرس بلا تجاوز',
  ownerRoleRow.overridden === false &&
    ownerRoleRow.permissions.length === ownerRoleRow.catalogPermissions.length,
  `${ownerRoleRow.permissions.length} رمزاً`,
);
const overridden = await put('/platform/roles/platform_support/permissions', {
  permissions: [...supportCatalog, 'console.users.view'],
  reason: 'تحقّق حيّ: توسيع مؤقّت لدعم المنصة',
});
check(
  'كتابة تجاوز بسبب تُقبل وتُعلَن',
  overridden.overridden === true && overridden.permissions.includes('console.users.view'),
  `${overridden.permissions.length} رمزاً`,
);
const matrixAfterWrite = await get('/platform/roles');
const supportAfter = matrixAfterWrite.find((role) => role.code === 'platform_support');
check(
  'والمصفوفة تعرض التجاوز موسوماً',
  supportAfter.overridden === true && supportAfter.permissions.includes('console.users.view'),
);
const restoredSupport = await put('/platform/roles/platform_support/permissions', {
  permissions: supportCatalog,
  reason: 'إرجاع الفهرس بعد التحقّق',
});
check(
  'وإرجاع الفهرس يمحو صفّ التجاوز',
  restoredSupport.overridden === false && restoredSupport.permissions.length === supportCatalog.length,
);
const unknownPermission = await refused(
  'put',
  '/platform/roles/platform_support/permissions',
  { permissions: ['console.not.a.code'], reason: 'رمز مجهول' },
  ownerToken,
);
check(
  'ورموز خارج السجل تُرفض 400',
  unknownPermission.status === 400,
  `${unknownPermission.status} ${unknownPermission.code}`,
);
const unknownRoleCode = await refused(
  'put',
  '/platform/roles/platform_nope/permissions',
  { permissions: ['console.audit.view'], reason: 'دور مجهول' },
  ownerToken,
);
check('ودور مجهول 404', unknownRoleCode.status === 404, String(unknownRoleCode.status));

// --- الدعوة: ينشأ الحساب ويحمل الدور ويدخل فعلاً
const inviteEmail = process.env.VERIFY_INVITE_EMAIL ?? 'verify-pc3@erpverify.test';
const invited = await request(
  'post',
  '/platform/operators/invite',
  {
    email: inviteEmail,
    fullName: 'مشغّل التحقّق',
    roleCode: 'platform_support',
    temporaryPassword: 'Kx#9Tq2Mv7Lp4Ze',
    reason: 'تحقّق حيّ من دعوة مشغّل',
  },
  ownerToken,
);
check(
  'الدعوة تُنشئ حساباً نشطاً يحمل الدور',
  invited.status === 'active' && invited.platformRoles.includes('platform_support'),
  invited.id,
);
check('ويُطالَب بتغيير كلمة المرور المؤقّتة', invited.mustChangePassword === true);
const invitedSession = await signIn(platformTenant, { email: inviteEmail, password: 'Kx#9Tq2Mv7Lp4Ze' });
const invitedMe = await get('/me', invitedSession.token);
check(
  'والمدعوّ يدخل ويحمل رموز الدعم',
  (invitedMe.platformPermissions ?? []).includes('console.tenants.view') &&
    !(invitedMe.platformPermissions ?? []).includes('console.users.manage'),
  (invitedMe.platformPermissions ?? []).length + ' رمزاً',
);
const reInvited = await request(
  'post',
  '/platform/operators/invite',
  { email: inviteEmail, fullName: 'مشغّل التحقّق', roleCode: 'platform_auditor' },
  ownerToken,
);
check(
  'والدعوة الثانية تعيد استخدام الحساب نفسه وتضيف الدور',
  reInvited.id === invited.id && reInvited.platformRoles.includes('platform_auditor'),
  reInvited.id,
);
const invitedCard = await get(`/platform/users/${invited.id}`);
check(
  'وبطاقة الحساب تسرد الدورين وحالته',
  invitedCard.platformRoles.includes('platform_support') &&
    invitedCard.platformRoles.includes('platform_auditor'),
  invitedCard.platformRoles.join(' · '),
);
check(
  'والمدعوّ عضو في منشأة المشغّلين (منشأ الرمز)',
  invitedCard.memberships.some((membership) => membership.tenantCode === platformTenant),
  invitedCard.memberships.map((membership) => membership.tenantCode).join(',') || '—',
);

// --- الأبواب: جلسة المستأجر لا تلمس الهوية، ولا جلسة مجهولة
for (const [method, path, body] of [
  ['get', '/platform/users', undefined],
  ['get', `/platform/users/${selfRow.id}`, undefined],
  ['get', '/platform/roles', undefined],
  ['get', '/platform/permissions', undefined],
  [
    'post',
    '/platform/operators/invite',
    { email: 'nope@erpverify.test', fullName: 'مرفوض', roleCode: 'platform_support' },
  ],
  [
    'put',
    '/platform/roles/platform_support/permissions',
    { permissions: ['console.audit.view'], reason: 'محاولة' },
  ],
  ['post', `/platform/users/${selfRow.id}/mfa/reset`, { reason: 'محاولة' }],
  ['delete', `/platform/sessions/${ownerLiveSession.id}?reason=${encodeURIComponent('محاولة')}`, undefined],
]) {
  const result = await refused(method, path, body, demoToken);
  check(
    `${method.toUpperCase()} ${path.replace(selfRow.id, ':id').replace(ownerLiveSession.id, ':session')} يرفض المستأجر`,
    result.status === 403,
    `${result.status} ${result.code}`,
  );
}
const anonymousIdentity = await refused('get', '/platform/users', undefined, '');
check('وترفض بلا جلسة 401', anonymousIdentity.status === 401, String(anonymousIdentity.status));

// ═════════════════════════════════════════════════════════════ 17. 🧹 التنظيف
// ════════════════════════════════════════════════ 17. 📣 الإعلانات
console.log('\n■ 17. 📣 الإعلانات — شاشة المنصة تقرأ ما كتبته شاشة الإعلانات (P-C7)');
// القسم العميق لهذا الجزء في `scripts/verify-platform-announcements.mjs`؛ وهنا ما يخصّ شاشة
// اللوحة وحدها: أن المسار يعمل للمالك، وأن مرشّحاته من الفهرس المسموح، وأن حارسه رمزُ
// الإعلانات وحده — لا الدعم ولا المدقّق.
const announcementRows = await get('/platform/announcements?limit=50');
check('قائمة الإعلانات تُقرأ للمالك', Array.isArray(announcementRows), `${announcementRows.length} صفاً`);
const publishedRows = announcementRows.filter((row) => row.status === 'published');
check(
  'وكل منشورٍ يُوسَم بمن كتبه',
  publishedRows.every((row) => typeof row.createdByLabel === 'string' && row.createdByLabel.length > 0),
  `${publishedRows.length} منشوراً`,
);
check(
  'وكل صفٍّ بحصيلة توزيعٍ معلَنة',
  announcementRows.every(
    (row) =>
      typeof row.stats?.tenants === 'number' &&
      typeof row.stats?.inApp === 'number' &&
      typeof row.stats?.emails === 'number' &&
      typeof row.stats?.reads === 'number',
  ),
);
const filtered = await get('/platform/announcements?filter[status]=published&limit=10');
check(
  'ومرشّح الحالة يعمل',
  Array.isArray(filtered) && filtered.every((row) => row.status === 'published'),
  `${filtered.length} صفاً`,
);
const announcementBadFilter = await refused(
  'get',
  '/platform/announcements?filter[nope]=1',
  undefined,
  ownerToken,
);
check(
  'ومرشّحٌ غير مسموح يُرفض 400',
  announcementBadFilter.status === 400,
  `HTTP ${announcementBadFilter.status}`,
);
check(
  'ورمز الإعلانات عند المالك والتشغيل وحدهما',
  ownerRole.permissions.includes('console.notifications.manage') &&
    (roles.find((role) => role.code === 'platform_operations')?.permissions ?? []).includes(
      'console.notifications.manage',
    ) &&
    !(roles.find((role) => role.code === 'platform_support')?.permissions ?? []).includes(
      'console.notifications.manage',
    ) &&
    !(roles.find((role) => role.code === 'platform_auditor')?.permissions ?? []).includes(
      'console.notifications.manage',
    ),
);

// ════════════════════════════════════════════════ 18. 🎧 مكتب الدعم
console.log('\n■ 18. 🎧 مكتب الدعم — الصندوق وسجلّ الدخول المؤقّت (P-C8)');
// القسم العميق لهذا الجزء في `scripts/verify-platform-support.mjs`؛ وهنا ما يخصّ شاشة
// اللوحة وحدها: أن المسار يعمل بصلاحية الدعم، وأن المدقّق لا يراه، وأن الحادّة في الواجهة
// (المهلة من الخادم) موجودة في الصفّ نفسه.
const ticketRows = await get('/platform/tickets?limit=50');
check('صندوق التذاكر يُقرأ', Array.isArray(ticketRows), `${ticketRows.length} تذكرة`);
check(
  'وكل صفٍّ يحمل مهلته وحالة أول ردّ',
  ticketRows.every(
    (row) =>
      typeof row.status === 'string' &&
      typeof row.priority === 'string' &&
      'slaDueAt' in row &&
      'firstResponseAt' in row &&
      typeof row.messageCount === 'number',
  ),
);
const openTickets = await get('/platform/tickets?filter[status]=open&limit=50');
check(
  'ومرشّح الحالة يحصر النتائج',
  openTickets.every((row) => row.status === 'open'),
  `${openTickets.length} مفتوحة`,
);
const ticketBadFilter = await refused(
  'get',
  '/platform/tickets?filter[severity]=high',
  undefined,
  ownerToken,
);
check('ومرشّحٌ غير مسموح يُرفض 400', ticketBadFilter.status === 400, `HTTP ${ticketBadFilter.status}`);

const sessionRows = await get('/platform/impersonate/sessions');
check('وسجلّ الدخول المؤقّت يُقرأ', Array.isArray(sessionRows), `${sessionRows.length} جلسة`);
check(
  'وكل جلسةٍ بحالةٍ محسوبة وسببٍ وطوابع',
  sessionRows.every(
    (row) =>
      ['active', 'ended', 'expired'].includes(row.status) &&
      typeof row.reason === 'string' &&
      Boolean(row.startedAt) &&
      Boolean(row.expiresAt),
  ),
);
check(
  'ورمز الدعم عند دور الدعم وحده',
  (roles.find((role) => role.code === 'platform_support')?.permissions ?? []).includes(
    'console.support.manage',
  ) &&
    !(roles.find((role) => role.code === 'platform_auditor')?.permissions ?? []).includes(
      'console.support.manage',
    ) &&
    !(roles.find((role) => role.code === 'platform_billing')?.permissions ?? []).includes(
      'console.support.manage',
    ),
);

// ════════════════════════════════════════════════ 19. 🛠️ العمليات
console.log('\n■ 19. 🛠️ العمليات — الطابور والصحة والملفات (P-C9)');
// القسم العميق لهذا الجزء في `scripts/verify-platform-operations.mjs` — بما فيه دورة حياة
// مهمّةٍ حقيقية (إلغاء ثم إعادة) وفحص ملفٍ رفعه العميل وحجره. وهنا ما يخصّ اللوحة وحدها:
// أن المسارات الثلاثة تعمل، وأن رمز `console.jobs.manage` هو ما يفصل الفعل عن القراءة،
// وأن المدقّق يقرأ الطابور ولا يستطيع أن يشغّله.
const jobRows = await get('/platform/jobs?limit=50');
check('الطابور يُقرأ عبر كل العملاء', Array.isArray(jobRows), `${jobRows.length} مهمّة`);
check(
  'وكل صفٍّ بحالته ومحاولاته واستحقاقه — وبلا حمولة',
  jobRows.every(
    (row) =>
      ['pending', 'published', 'dead'].includes(row.status) &&
      Number.isInteger(row.attempts) &&
      'runAt' in row &&
      Array.isArray(row.payloadKeys) &&
      !('payload' in row),
  ),
);
const pendingJobs = await get('/platform/jobs?filter[status]=pending&limit=50');
check(
  'ومرشّح الحالة يحصر النتائج',
  pendingJobs.every((row) => row.status === 'pending'),
  `${pendingJobs.length} معلَّقة`,
);
const jobBadFilter = await refused('get', '/platform/jobs?filter[state]=pending', undefined, ownerToken);
check('ومرشّحٌ غير مسموح يُرفض 400', jobBadFilter.status === 400, `HTTP ${jobBadFilter.status}`);

const heartbeat = await get('/platform/jobs/heartbeat');
check(
  'ونبض العامل يُقرأ',
  typeof heartbeat.running === 'boolean' && typeof heartbeat.enabled === 'boolean',
  `running=${heartbeat.running} · enabled=${heartbeat.enabled}`,
);

const detailedHealth = await get('/platform/health/detailed');
const probeNames = (detailedHealth.probes ?? [])
  .map((probe) => probe.name)
  .sort()
  .join(' ');
check(
  'وصحة الخدمة ستّة مجسّات لا جملة',
  probeNames === 'database email queue redis storage worker',
  probeNames,
);
check(
  'ومعها عدّادات الطلبات ودلاء الاستجابة',
  typeof detailedHealth.requests?.p95Ms === 'number' &&
    typeof detailedHealth.requests?.errorRate === 'number',
  `p95 ${detailedHealth.requests?.p95Ms}ms`,
);
const detailedAsClient = await refused('get', '/platform/health/detailed', undefined, demoToken);
check(
  'ورمز العميل لا يقرأ المجسّات (403)',
  detailedAsClient.status === 403,
  `HTTP ${detailedAsClient.status}`,
);

const fileRows = await get('/platform/files?limit=50');
check('ومدير الملفات يُقرأ عبر المستأجرين', Array.isArray(fileRows), `${fileRows.length} ملفاً`);
check(
  'وكل صفٍّ يحمل عميله وحالته وحكم فحصه',
  fileRows.every(
    (row) =>
      typeof row.tenantId === 'string' &&
      ['pending', 'ready', 'deleted'].includes(row.status) &&
      (row.scan === null || typeof row.scan.verdict === 'string'),
  ),
);
check(
  'ورموز العمليات عند المالك وحده: الفعل مميّز عن القراءة',
  (roles.find((role) => role.code === 'platform_owner')?.permissions ?? []).includes('console.jobs.manage') &&
    !(roles.find((role) => role.code === 'platform_auditor')?.permissions ?? []).includes(
      'console.jobs.manage',
    ) &&
    !(roles.find((role) => role.code === 'platform_support')?.permissions ?? []).includes(
      'console.jobs.manage',
    ) &&
    !(roles.find((role) => role.code === 'platform_billing')?.permissions ?? []).includes(
      'console.jobs.manage',
    ),
);

// ═════════════════════════════════════ 20. 💾 البيانات والاسترجاع (P-C10)
console.log('\n■ 20. 💾 البيانات والاسترجاع — النسخ والاحتفاظ وطلبات البيانات (P-C10)');
// القسم العميق لهذا الجزء في `scripts/verify-platform-backups.mjs` — نسخةٌ حقيقية تُكتب
// وتُقاس من القرص وتُعبث ببايتٍ منها، وسياسةٌ تُنفَّذ، ومحوٌ يُقاس على مستخدمٍ حقيقي.
// وهنا ما يخصّ اللوحة وحدها: أن المسارات تعمل، وأن **القراءة هنا لا تكتب شيئاً** — فسياسة
// الاحتفاظ تُقرأ ولا تُعدَّل، لأن شاشة التنظيف في §21 تقارن إعدادات المنصّة بما كانت عليه.
const backupRows = await get('/platform/backups?limit=20');
check('النسخ تُقرأ عبر كل العملاء', Array.isArray(backupRows), `${backupRows.length} نسخة`);
check(
  'وكل صفٍّ يقول حجمه وبصمته ومخزنه وعدّاداته',
  backupRows.every(
    (row) =>
      ['platform', 'tenant'].includes(row.scope) &&
      ['running', 'succeeded', 'failed'].includes(row.status) &&
      ['object-storage', 'filesystem'].includes(row.store) &&
      Number.isInteger(row.tables) &&
      Number.isInteger(row.rows) &&
      (row.checksum === null || /^[0-9a-f]{64}$/.test(row.checksum)),
  ),
);
const backupBadFilter = await refused(
  'get',
  '/platform/backups?filter[state]=succeeded',
  undefined,
  ownerToken,
);
check('ومرشّحٌ غير مسموح يُرفض 400', backupBadFilter.status === 400, `HTTP ${backupBadFilter.status}`);

const retention = await get('/platform/retention');
check(
  'وسياسة الاحتفاظ تُقرأ بنوافذها الخمس وافتراضاتها',
  [
    'auditArchiveDays',
    'artifactRetentionDays',
    'idempotencyPurgeDays',
    'outboxPurgeDays',
    'fileOrphanPurgeDays',
  ].every((key) => Number.isInteger(retention.policy?.[key]) && Number.isInteger(retention.defaults?.[key])),
  Object.entries(retention.policy ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' '),
);
check(
  'ومعها عدّادات ما سيطاله التنفيذ',
  ['idempotencyExpired', 'outboxPurgeable', 'fileOrphans', 'artifactsExpired', 'auditArchivable'].every(
    (key) => Number.isInteger(retention.purges?.[key]),
  ),
);
check('والمحو النهائي للتدقيق ممنوعٌ ومُعلَن', retention.auditHardDeleteAllowed === false);

const dataRequests = await get('/platform/data-requests?limit=20');
check('وطلبات البيانات تُقرأ', Array.isArray(dataRequests), `${dataRequests.length} طلباً`);
check(
  'وكل طلبٍ بنوعه وحالته وصاحبه',
  dataRequests.every(
    (row) =>
      ['export', 'erase'].includes(row.kind) &&
      ['pending', 'approved', 'rejected', 'completed', 'cancelled'].includes(row.status) &&
      typeof row.subjectEmail === 'string',
  ),
);

// رمز العميل لا يفتح سطح النسخ، والمشغّل يمرّ — والفصل هنا على النهايات لا على الأزرار.
const backupsAsClient = await refused('get', '/platform/backups', undefined, demoToken);
check('ورمز العميل لا يرى النسخ (403)', backupsAsClient.status === 403, `HTTP ${backupsAsClient.status}`);
const retentionAsClient = await refused('get', '/platform/retention', undefined, demoToken);
check('ولا سياسة الاحتفاظ (403)', retentionAsClient.status === 403, `HTTP ${retentionAsClient.status}`);
const requestsAsClient = await refused('get', '/platform/data-requests', undefined, demoToken);
check('ولا طلبات البيانات (403)', requestsAsClient.status === 403, `HTTP ${requestsAsClient.status}`);
check(
  'ورموز النسخ عند المالك والعمليات وحدهما',
  (roles.find((role) => role.code === 'platform_owner')?.permissions ?? []).includes(
    'console.backups.manage',
  ) &&
    (roles.find((role) => role.code === 'platform_operations')?.permissions ?? []).includes(
      'console.backups.manage',
    ) &&
    ['platform_auditor', 'platform_support', 'platform_billing'].every(
      (code) =>
        !(roles.find((role) => role.code === code)?.permissions ?? []).includes('console.backups.manage'),
    ),
);

// ═════════════════════════════════════ 21. 🔑 بوابة المطوّر (P-C11)
console.log('\n■ 21. 🔑 بوّابة المطوّر — مفتاحٌ يعمل، وعنوانٌ يستقبل بتوقيعٍ يُتحقَّق منه (P-C11)');
const catalogue = await get('/platform/developer/catalogue');
check(
  'الكتالوج يعلن النطاقات والأحداث من الخادم نفسه',
  catalogue.scopes.length >= 8 && catalogue.events.length >= 9,
  `${catalogue.scopes.length} نطاقاً · ${catalogue.events.length} حدثاً`,
);
check(
  'وصيغة التوقيع ونافذة القبول',
  catalogue.signature.header === 'x-erp-signature' && catalogue.signature.toleranceSeconds === 300,
  `${catalogue.signature.header} · ${catalogue.signature.toleranceSeconds}s`,
);

const devStamp = Date.now().toString(36);
const devKey = await request(
  'post',
  `/platform/tenants/${demoId}/api-keys`,
  { name: `تكامل اللوحة ${devStamp}`, scopes: ['invoices:read'] },
  ownerToken,
);
check(
  'مفتاحٌ يُصدر لعميلٍ بعينه ونصّه يُعاد مرّة واحدة',
  typeof devKey.secret === 'string' && devKey.secret.startsWith('erp_live_'),
  `${devKey.prefix} · ${devKey.scopes.join(',')}`,
);
const keyList = await get(`/platform/tenants/${demoId}/api-keys`);
const keyRow = keyList.find((row) => row.id === devKey.id);
check('وصفُّه في القائمة يقول نطاقاته وحالته', keyRow?.status === 'active' && keyRow?.scopes.length === 1);
check(
  'والقائمة لا تحمل النصّ الصريح',
  !JSON.stringify(keyList).includes(devKey.secret),
  'المحفوظ بادئةٌ وبصمة',
);
const keyMe = await request('get', '/integration/v1/me', undefined, devKey.secret);
check(
  'والمفتاح يعرّف نفسه من سطح التكامل',
  keyMe.tenantId === demoId && keyMe.permissions.includes('sales.view'),
  `${keyMe.tenantCode} · ${keyMe.permissions.length} صلاحية`,
);
const narrowKey = await request(
  'post',
  `/platform/tenants/${demoId}/api-keys`,
  { name: `تقارير اللوحة ${devStamp}`, scopes: ['reporting:read'] },
  ownerToken,
);
const deniedByScope = await refused('get', '/integration/v1/invoices?limit=1', undefined, narrowKey.secret);
check(
  'والنطاق سقفٌ: 403 على ما خارجه',
  deniedByScope.status === 403,
  `${deniedByScope.status} ${deniedByScope.code}`,
);
const rotated = await request(
  'post',
  `/platform/tenants/${demoId}/api-keys/${narrowKey.id}/rotate`,
  { reason: 'تدوير في التحقّق الحيّ' },
  ownerToken,
);
check('والتدوير يرث الاسم والنطاقات', rotated.name === narrowKey.name && rotated.secret !== narrowKey.secret);
check(
  'والقديم يسقط فوراً',
  (await refused('get', '/integration/v1/me', undefined, narrowKey.secret)).status === 401,
);

// مستقبِل الويب هوك: يتحقّق من التوقيع بنفسه ويردّ 200.
const hookState = { secret: '', body: '', valid: false, event: '', tenant: '' };
const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const raw = String(req.headers['x-erp-signature'] ?? '');
    const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(raw);
    if (match) {
      const expected = createHmac('sha256', hookState.secret).update(`${match[1]}.${body}`).digest('hex');
      hookState.valid =
        expected.length === match[2].length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]));
    }
    hookState.body = body;
    hookState.event = String(req.headers['x-erp-event'] ?? '');
    hookState.tenant = String(req.headers['x-erp-tenant'] ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
const hookPort = hookServer.address().port;

const badHook = await refused(
  'post',
  `/platform/tenants/${demoId}/webhooks`,
  { url: 'http://example.com/hooks', events: ['invoice.posted'] },
  ownerToken,
);
check('عنوان http عامّ يُرفض', badHook.status === 400, `${badHook.status} ${badHook.code}`);
const hook = await request(
  'post',
  `/platform/tenants/${demoId}/webhooks`,
  {
    url: `http://127.0.0.1:${hookPort}/hooks/${devStamp}`,
    events: ['invoice.posted', 'invoice.paid'],
    description: 'مستقبِل اللوحة الحيّ',
  },
  ownerToken,
);
hookState.secret = hook.secret;
check(
  'وعنوانٌ محلّي يُضاف بسرّ توقيعٍ يُعرض مرّة واحدة',
  hook.secret.startsWith('whsec_') && hook.secretPrefix.length > 5,
  hook.secretPrefix,
);
const testAttempt = await request('post', `/platform/webhooks/${hook.id}/test`, {}, ownerToken);
check(
  'وحدث الاختبار يصل فعلاً وبتوقيعٍ صحيح عند المستقبِل',
  testAttempt.status === 'delivered' && testAttempt.responseCode === 200 && hookState.valid,
  `${testAttempt.responseCode} · ${testAttempt.durationMs} ms · ${hookState.event} · توقيع صحيح=${hookState.valid}`,
);
check('ويحمل منشأة العميل', hookState.tenant === demoId);
const deliveries = await get(`/platform/webhooks/${hook.id}/deliveries`);
const deliveryRow = deliveries.find((row) => row.id === testAttempt.deliveryId);
check(
  'وسجلّ التسليم يقول الرمز والمحاولات ومفاتيح الحمولة',
  deliveryRow?.responseCode === 200 && deliveryRow?.attempts === 1 && deliveryRow?.payloadKeys.length > 0,
  `${deliveryRow?.event} · ${deliveryRow?.payloadKeys.join(',')}`,
);
// §8 يمنح حساب التجربة دور «تشغيل المنصة» مؤقّتاً ويسحبه في §22، ودور التشغيل يحمل رمز
// العناوين. وهنا يظهر فرقٌ حقيقي: **الأدوار تُقرأ من الرمز لا من القاعدة** — فجلسةُ عميلٍ
// أُصدرت قبل المنح تُردّ 403 وإن كان `/me` اليوم يقول إنه يحمل الرمز، وجلسةٌ أُصدرت بعده تمرّ.
const clientConsoleCodes = (await get('/me', demoToken)).platformPermissions ?? [];
const hooksAsClient = await refused('get', `/platform/tenants/${demoId}/webhooks`, undefined, demoToken);
check(
  'وجلسة عميلٍ أُصدرت قبل منح الدور لا تفتح العناوين (403)',
  hooksAsClient.status === 403,
  `HTTP ${hooksAsClient.status} · /me يقول ${clientConsoleCodes.length} رمزاً للحساب`,
);
const hooksAsOperator = await refused('get', `/platform/tenants/${demoId}/webhooks`, undefined, limitedToken);
check(
  'وجلسةٌ أُصدرت بعد المنح تفتحها (200) لأن دورها يحمل رمزها',
  hooksAsOperator.status === 200,
  `HTTP ${hooksAsOperator.status}`,
);

// تنظيف القسم: العنوان يُحذف والمفاتيح تُبطَل — والتدقيق يبقى أثراً.
await request('delete', `/platform/tenants/${demoId}/webhooks/${hook.id}`, { reason: 'تنظيف التحقّق الحيّ' }, ownerToken);
await request('delete', `/platform/tenants/${demoId}/api-keys/${devKey.id}`, { reason: 'تنظيف التحقّق الحيّ' }, ownerToken);
await request('delete', `/platform/tenants/${demoId}/api-keys/${rotated.id}`, { reason: 'تنظيف التحقّق الحيّ' }, ownerToken);
await new Promise((resolve) => hookServer.close(resolve));
const auditAfterDeveloper = await get('/platform/audit?limit=100');
const developerActions = new Set(
  auditAfterDeveloper.items.map((row) => row.action).filter((action) => String(action).startsWith('platform.api-key.')),
);
check(
  'وأفعال المفاتيح في التدقيق بأسمائها',
  developerActions.has('platform.api-key.create') &&
    developerActions.has('platform.api-key.rotate') &&
    developerActions.has('platform.api-key.revoke'),
  [...developerActions].join(', '),
);

console.log('\n■ 22. 🧹 التنظيف');
await request('delete', `/platform/users/${demoRow.id}/roles/platform_operations`, undefined, ownerToken);
const afterRevoke = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const revokedMe = await get('/me', afterRevoke.token);
check('سُحب الدور المحدود', (revokedMe.platformPermissions ?? []).length === 0);
// §16 granted two roles to the verification account: both come back here, so a re-run starts
// from the same place. The account itself stays — it is the one deliberate residue, and
// re-inviting it reuses the row instead of adding another.
await request('delete', `/platform/users/${invited.id}/roles/platform_support`, undefined, ownerToken);
await request('delete', `/platform/users/${invited.id}/roles/platform_auditor`, undefined, ownerToken);
const cleanedInvite = await get(`/platform/users/${invited.id}`);
check(
  'وسُحبت أدوار حساب التحقّق',
  cleanedInvite.platformRoles.length === 0,
  `${cleanedInvite.revokedPlatformRoles.length} دوراً مسحوباً`,
);
const afterDenied = await refused('get', '/platform/tenants', undefined, afterRevoke.token);
check('وعاد المستأجر ممنوعاً من اللوحة', afterDenied.status === 403, String(afterDenied.status));

const restoredFlags = await get(`/platform/tenants/${demoId}/flags`);
const restoredFlagValues = Object.fromEntries(restoredFlags.flags.map((flag) => [flag.key, flag.enabled]));
check(
  'ورايات العميل بقيمها الفعلية',
  JSON.stringify(restoredFlagValues) === JSON.stringify(previousFlags),
  Object.entries(restoredFlagValues)
    .map(([key, value]) => `${key.replace('feature.', '')}=${value}`)
    .join(' '),
);
const normalised = restoredFlags.flags.filter(
  (flag) => previousFlagRows[flag.key] === false && flag.isDefault,
);
if (normalised.length > 0) {
  // Not a residue: the value is unchanged, the redundant row is gone by design.
  console.log(
    `  · ملاحظة: ${normalised.length} راية كانت صفاً يكرّر القيمة الافتراضية فصار صفّها محذوفاً (القيمة الفعلية كما هي)`,
  );
}

const restored = await get('/platform/settings');
const restoredValues = Object.fromEntries(restored.settings.map((setting) => [setting.key, setting.value]));
check(
  'والإعدادات عادت إلى ما كانت عليه',
  JSON.stringify(restoredValues) === JSON.stringify(snapshotValues),
  `${Object.keys(restoredValues).length} مفتاحاً`,
);

// ═══════════════════════════════════════════════════════════════ الخلاصة
console.log(`\n${'─'.repeat(70)}`);
console.log(` نقاط التحقّق: ${checks} · نجحت: ${checks - failures} · فشلت: ${failures}`);
console.log(`${'─'.repeat(70)}`);
process.exit(failures === 0 ? 0 : 1);
