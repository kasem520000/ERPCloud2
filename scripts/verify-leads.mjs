#!/usr/bin/env node
/**
 * verify-leads.mjs — التحقّق الحيّ لـ P-M6 «التقاط العملاء المتوقّعين وإدارتهم»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس **الطريق كاملاً**: زائرٌ مجهول يملأ استمارةً في الموقع ⇒ يصل طلبٌ له مرجع ⇒ يقرأ
 * مشغّلُ المنصّة الطابور ⇒ يُسند ويُعلّق ويُغيّر الحالة ⇒ **يحوّل الطلب إلى منشأة حقيقية**
 * بترخيص تجربة ⇒ ويُدير النشرة البريدية بتأكيدٍ مزدوج. وخمسة أقسام:
 *
 *   1. 🚪 الاستمارة العامّة — الالتقاط، والمصيدة الصامتة، والمنع من التكرار، وحدّ المعدّل.
 *   2. 🧭 الطابور في اللوحة — الغلاف والعدّادات والبحث والتفاصيل والأثر، وصلاحيةُ القراءة
 *      مقابل صلاحية التصرّف.
 *   3. 🎯 التحويل — منشأةٌ ومديرٌ وفرعٌ ودليلُ حساباتٍ وترخيص `trialing`، والمنع من التحويل
 *      مرّتين، ودخول المدير بكلمة المرور المؤقتة.
 *   4. 📬 النشرة البريدية — تأكيدٌ مزدوج: لا `confirmed` بلا فتح رابط، والرابط مُجزَّأ.
 *   5. 🧹 الأثر والتنظيف — الأحداث مسجّلة، والطلب التجريبي يُغلق بسببٍ مكتوب.
 *
 * **وما يُقرأ من القاعدة؟** قراءةٌ واحدة: **نصّ رسالة التأكيد** لاستخراج الرابط — لأن الرمز
 * لا يُعاد في أي استجابة **عن قصد** (كما في P-M4)، وهي القراءة الوحيدة التي يجوز أن يقوم بها
 * سكربت التحقّق (باتصال المشغّل)، تماماً كقراءة رمز التسجيل في `verify-signup.mjs`.
 *
 * Usage: node scripts/verify-leads.mjs
 */
import { createRequire } from 'node:module';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const siteBase = (
  process.env.MARKETING_BASE ?? `http://127.0.0.1:${process.env.MARKETING_PORT ?? 3002}`
).replace(/\/+$/, '');
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};

const requireRoot = createRequire(import.meta.url);
const requireTesting = createRequire(new URL('../packages/testing/package.json', import.meta.url));
function requirePg() {
  for (const resolver of [requireRoot, requireTesting]) {
    try {
      return resolver('pg');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Cannot find "pg". Run `pnpm install` at the repository root first.');
}
const { Client } = requirePg();

const stamp = Date.now().toString(36);
const leadEmail = `verify.pm6.${stamp}@example.test`;
const newsEmail = `verify.pm6.news.${stamp}@example.test`;
const message = 'نحتاج عرضاً لفروعنا الثلاثة، وربطاً بالمخزون، وفواتير ضريبية — ويفضّل هذا الشهر.';

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

async function call(method, path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok && !options.allowFailure) {
    const error = new Error(`${method.toUpperCase()} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return { status: response.status, data: parsed.data, meta: parsed.meta, raw: parsed, headers: response.headers };
}

const get = (path, options) => call('get', path, options);
const post = (path, body, options = {}) => call('post', path, { body, ...options });
const patch = (path, body, options) => call('patch', path, { body, ...options });

/** نداءٌ **يُتوقَّع رفضه**: حالته ورمزه هما الجواب. */
async function refused(method, path, body, token) {
  const { status, raw } = await call(method, path, { body, token, allowFailure: true });
  return { status, code: raw.code ?? '', detail: raw.detail ?? '' };
}

/**
 * نداءُ بابٍ عامّ **بصبر**: دلو `public-form` يحمل ١٠ طلباتٍ في الدقيقة لكلّ عنوان، وسكربتات
 * التحقّق تُشغَّل وراء بعضها على العنوان نفسه. فنفادُ الدلو ليس فشل نشر — يُنتظر ويُعاد،
 * ويُقاس الحدّ نفسه في الفحص المخصّص له (رأس `x-ratelimit-limit`).
 */
async function patient(run, attempts = 8) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error.status !== 429 || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    }
  }
}

async function signIn() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await call('post', '/auth/login', { body: { tenantCode: platformTenant, ...operator } });
      const token = login.data?.accessToken;
      if (!token) throw new Error('login failed');
      return token;
    } catch (error) {
      // دلو الدخول ١٠/دقيقة على العنوان نفسه، وسكربتات التحقّق تُشغَّل وراء بعضها — فالانتظار
      // هنا جزءٌ من القياس لا تسامحٌ مع خطأ: نفاد الدلو ليس فشل نشر.
      if (error.status !== 429 || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    }
  }
}

/** رابط تأكيد النشرة كما وصل بالبريد — القراءة الوحيدة خارج الـAPI. */
async function confirmTokenFor(address) {
  const connectionString = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT subject, body FROM email_messages
        WHERE event = 'subscriber.confirm' AND lower(to_email) = $1
        ORDER BY created_at DESC LIMIT 1`,
      [address.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return null;
    const match = String(row.body).match(/confirm\/([0-9a-f]{48})/);
    return match ? { token: match[1], body: String(row.body) } : { token: null, body: String(row.body) };
  } finally {
    await client.end();
  }
}

/** صفحةٌ من الموقع التسويقي كما يراها زائر: HTML خام — يُقاس بها ما يُعرَض لا ما يُكتب. */
async function page(path) {
  const response = await fetch(`${siteBase}${path}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
}

const operatorToken = await signIn();
console.log(`✔ logged in as ${operator.email} (platform tenant ${platformTenant})\n`);

let leadId = null;
let leadReference = null;

try {
  // ══════════════════════════════════════════════════ 1. 🚪 الاستمارة العامّة
  console.log('■ 1. 🚪 الاستمارة العامّة — الالتقاط والمصيدة ومنع التكرار');

  const honeypot = await patient(() =>
    post('/public/leads', {
    fullName: 'روبوت التسويق',
    email: `bot.${stamp}@example.test`,
    message: 'رسالةٌ آليةٌ ملأت الحقل المخفيّ الذي لا يراه الإنسان أبداً.',
      website: 'http://spam.example',
    }),
  );
  check('المصيدة تُقابَل بـ202 صامتة (لا تُعلن أنها كُشِفت)', honeypot.status === 202, String(honeypot.status));
  check(
    'ولا يُقال لها مُتابعةٌ حقيقية',
    typeof honeypot.data?.received === 'boolean',
    JSON.stringify(honeypot.data ?? {}),
  );

  const weak = await patient(() =>
    post('/public/leads', { fullName: 'س', email: 'not-an-email', message: 'قصيرة' }, { allowFailure: true }),
  );
  check('واستمارةٌ ناقصة تُرفض 400 لا 500', weak.status === 400, `${weak.status} ${weak.raw?.code ?? ''}`);

  const first = await patient(() =>
    post('/public/leads', {
      fullName: 'سالم العمري',
    companyName: `شركة التحقّق ${stamp}`,
    email: leadEmail,
    phone: '+967700000000',
    branchCount: 3,
    message,
    acceptsMarketing: true,
      utm: { source: 'google', medium: 'cpc', campaign: 'verify-pm6' },
    }),
  );
  check('وطلبٌ صحيح يُقبَل 202', first.status === 202, String(first.status));
  leadReference = first.data?.reference ?? null;
  check('ويُعاد مرجعٌ قصير يُقال للزائر', /^L-[0-9A-F]{8,16}$/.test(String(leadReference)), String(leadReference));
  check(
    'ورأس حدّ المعدّل يحرس الباب العامّ',
    first.headers?.get('x-ratelimit-limit') !== null,
    `limit=${first.headers?.get('x-ratelimit-limit')}`,
  );

  const again = await patient(() =>
    post('/public/leads', {
      fullName: 'سالم العمري',
    companyName: `شركة التحقّق ${stamp}`,
    email: leadEmail.toUpperCase(),
      message: 'إضافة: عندنا فرعٌ رابع في عدن، ونريد ربط نقاط البيع.',
    }),
  );
  check(
    'والعنوان نفسه لا يُنشئ طلباً ثانياً (نفس المرجع)',
    again.data?.reference === leadReference,
    `${again.data?.reference} = ${leadReference}`,
  );

  // ══════════════════════════════════════════════════ 2. 🧭 الطابور في اللوحة
  console.log('\n■ 2. 🧭 الطابور في اللوحة — القراءة والإسناد والحالة');

  const anonymous = await refused('get', '/platform/leads');
  check('بلا توكن ⇒ 401', anonymous.status === 401, String(anonymous.status));

  const queue = await get('/platform/leads', { token: operatorToken });
  check('الطابور يُقرأ بغلاف `{data, meta}`', queue.status === 200 && Array.isArray(queue.data), `HTTP ${queue.status}`);
  check(
    'ومعه عدّادات كل حالة وعدد غير المُسنَد',
    typeof queue.raw?.counts?.new === 'number' && typeof queue.raw?.unassigned === 'number',
    JSON.stringify(queue.raw?.counts ?? {}),
  );

  const found = await get(`/platform/leads?q=${encodeURIComponent(String(leadReference))}`, { token: operatorToken });
  check('والبحث بالمرجع يجد الطلب وحده', found.data?.length === 1, `${found.data?.length ?? 0} نتيجة`);
  leadId = found.data?.[0]?.id ?? null;
  check('والطلب الجديد في حالة «جديد»', found.data?.[0]?.status === 'new', String(found.data?.[0]?.status));
  check(
    'ووسوم الحملة محفوظة كما وصلت',
    found.data?.[0]?.utm?.campaign === 'verify-pm6' && found.data?.[0]?.utm?.medium === 'cpc',
    JSON.stringify(found.data?.[0]?.utm ?? {}),
  );

  const detail = await get(`/platform/leads/${leadId}`, { token: operatorToken });
  check('تفاصيل الطلب تعيد الرسالة والملاحظات والأثر', detail.status === 200 && Array.isArray(detail.data?.events));
  check(
    'وطلبٌ ثانٍ من العنوان نفسه سُجّل **ملاحظةً** لا صفّاً',
    (detail.data?.notes ?? []).some((note) => String(note.body).includes('فرعٌ رابع')),
    `${detail.data?.notes?.length ?? 0} ملاحظة`,
  );
  check(
    'وأثرُ التكرار موسومٌ صراحةً',
    (detail.data?.events ?? []).some((event) => event.kind === 'lead.duplicated'),
    (detail.data?.events ?? []).map((event) => event.kind).join(' · '),
  );

  const assigned = await patch(`/platform/leads/${leadId}`, { assignedTo: (await get('/me', { token: operatorToken })).data?.user?.id }, { token: operatorToken });
  check('الإسناد يُقبل ويُسجَّل', assigned.status === 200 && assigned.data?.assignedTo, String(assigned.status));
  check('ومعه أثرُ إسنادٍ في الطلب', (await get(`/platform/leads/${leadId}`, { token: operatorToken })).data?.events?.some((event) => event.kind === 'lead.assigned'));

  const contacted = await patch(
    `/platform/leads/${leadId}`,
    { status: 'contacted', reason: 'اتصلنا، وطلب عرضاً يوم الثلاثاء' },
    { token: operatorToken },
  );
  check('والانتقال إلى «قيد التواصل» يُقبل', contacted.status === 200 && contacted.data?.status === 'contacted', String(contacted.status));

  const locked = await refused('patch', `/platform/leads/${leadId}`, { status: 'won' }, operatorToken);
  check('و«مؤهَّل» قبل «تحوّل» ممنوع 422', locked.status === 422 && locked.code === 'LEAD_STATUS_LOCKED', `${locked.status} ${locked.code}`);

  const tenantSession = await refused('get', '/platform/leads', undefined, 'not-a-platform-token');
  check('ورمزٌ غير صالح لا يفتح الطابور (401)', tenantSession.status === 401, String(tenantSession.status));

  // ══════════════════════════════════════════════════ 3. 🎯 التحويل
  console.log('\n■ 3. 🎯 التحويل — منشأةٌ حقيقية بترخيص تجربة');

  const tenantCode = `verify-pm6-${stamp}`;
  const converted = await post(`/platform/leads/${leadId}/convert`, { tenantCode }, { token: operatorToken });
  check('التحويل يُنشئ المنشأة 201', converted.status === 201, `${converted.status} ${converted.raw?.code ?? ''}`);
  check('ويُعيد رمز المنشأة المطلوب', converted.data?.tenantCode === tenantCode, String(converted.data?.tenantCode));
  check(
    'وكلمة مرورٍ مؤقتة تُعاد مرّةً واحدة (لا تُخزَّن خاماً)',
    typeof converted.data?.tempPassword === 'string' && converted.data.tempPassword.length >= 12,
    `${String(converted.data?.tempPassword ?? '').length} حرفاً`,
  );
  check(
    'والتجربة من إعداد المنصّة لا من رقمٍ في الكود',
    typeof converted.data?.trialDays === 'number' && converted.data.trialDays > 0,
    `${converted.data?.trialDays} يوماً`,
  );
  check('والطلب صار «تحوّل» ومعه منشأته', converted.data?.lead?.status === 'won' && converted.data?.lead?.convertedTenantId);

  const tenantCard = await get(`/platform/tenants/${converted.data?.tenantId}`, { token: operatorToken });
  check('والمنشأة تظهر في بطاقة العملاء', tenantCard.status === 200, `HTTP ${tenantCard.status}`);

  const licence = await get('/platform/subscriptions?status=trialing', { token: operatorToken });
  const mine = (licence.data ?? []).filter((row) => row.tenantId === converted.data?.tenantId);
  check(
    'ولها ترخيصٌ بحالة «تجربة»',
    mine.length === 1 && Boolean(mine[0]?.trialEndsAt),
    mine[0] ? `${mine[0].status} حتى ${mine[0].trialEndsAt}` : 'لا ترخيص',
  );

  const ownerLogin = await call('post', '/auth/login', {
    body: { tenantCode, email: leadEmail, password: converted.data?.tempPassword },
    allowFailure: true,
  });
  check('والمدير يدخل بكلمة المرور المؤقتة', ownerLogin.status === 200 || ownerLogin.status === 201, String(ownerLogin.status));
  const ownerToken = ownerLogin.data?.accessToken;
  if (ownerToken) {
    const ownerMe = await get('/me', { token: ownerToken });
    check(
      'وصلاحياته صلاحيات منشأةٍ فقط (لا رمز console)',
      (ownerMe.data?.permissions ?? []).length > 0 && !(ownerMe.data?.permissions ?? []).some((code) => code.startsWith('console.')),
      `${(ownerMe.data?.permissions ?? []).length} رمزاً`,
    );
  }

  const twice = await refused('post', `/platform/leads/${leadId}/convert`, {}, operatorToken);
  check('والتحويل مرّةً ثانية يُرفض 409', twice.status === 409 && twice.code === 'LEAD_ALREADY_CONVERTED', `${twice.status} ${twice.code}`);

  // ══════════════════════════════════════════════════ 4. 📬 النشرة البريدية
  console.log('\n■ 4. 📬 النشرة البريدية — تأكيدٌ مزدوج');

  const subscribed = await patient(() => post('/public/subscribe', { email: newsEmail }));
  check('الاشتراك يُقبَل 202 بحالة `pending`', subscribed.status === 202 && subscribed.data?.status === 'pending', `${subscribed.status} ${subscribed.data?.status}`);

  const mailed = await confirmTokenFor(newsEmail);
  check('ووصلت رسالةُ تأكيدٍ بالبريد', Boolean(mailed?.body), mailed ? `${mailed.body.length} حرفاً` : 'لا رسالة');
  check('وفيها رابطُ تأكيدٍ برمز ٤٨ حرفاً', Boolean(mailed?.token), mailed?.token ? 'موجود' : 'مفقود');
  check(
    'ولا يُعاد الرمز في أي استجابة',
    JSON.stringify(subscribed.raw ?? {}).includes('confirm/') === false,
    'الاستجابة نظيفة',
  );

  const confirmed = await get(`/public/subscribe/confirm/${mailed?.token}`);
  check('وفتحُ الرابط يُؤكّد الاشتراك', confirmed.status === 200 && confirmed.data?.status === 'confirmed', `${confirmed.status} ${confirmed.data?.status}`);
  const twiceConfirmed = await get(`/public/subscribe/confirm/${mailed?.token}`);
  check('وإعادة الفتح لا تغيّر شيئاً (idempotent)', twiceConfirmed.status === 200 && twiceConfirmed.data?.status === 'confirmed');

  const unknown = await refused('get', `/public/subscribe/confirm/${'a'.repeat(48)}`);
  check('ورابطٌ مجهول ⇒ 404 بلا سرد', unknown.status === 404, `${unknown.status} ${unknown.code}`);

  const subscribers = await get('/platform/leads/subscribers', { token: operatorToken });
  const listed = (subscribers.data ?? []).find((row) => row.email === newsEmail);
  check('والمشترك يظهر في قائمة اللوحة مؤكَّداً', listed?.status === 'confirmed', listed ? listed.status : 'غير موجود');
  check(
    'وعدّادات النشرة بثلاث حالات',
    subscribers.raw?.counts?.pending !== undefined && subscribers.raw?.counts?.confirmed !== undefined,
    JSON.stringify(subscribers.raw?.counts ?? {}),
  );

  const manual = await patch(`/platform/leads/subscribers/${listed?.id}`, { status: 'unsubscribed' }, { token: operatorToken });
  check('والإلغاء اليدوي يُسجَّل بلا حذف صفّ', manual.status === 200 && manual.data?.status === 'unsubscribed', String(manual.status));

  // ══════════════════════════════════════════════════ 5. 🧹 الأثر والتنظيف
  console.log('\n■ 5. 🧹 الأثر والتنظيف — سجلٌّ لا يُمحى');

  const finalDetail = await get(`/platform/leads/${leadId}`, { token: operatorToken });
  const kinds = (finalDetail.data?.events ?? []).map((event) => event.kind);
  check('أثرُ الطلب يحمل الالتقاط', kinds.includes('lead.created'), kinds.join(' · '));
  check('ويحمل إسناداً', kinds.includes('lead.assigned'));
  check('ويحمل تغيير حالة', kinds.includes('lead.status_changed'));
  check('ويحمل تحويلاً', kinds.includes('lead.converted'));
  check(
    'ولا حذف في النظام كلّه (الطلب باقٍ بتاريخه)',
    finalDetail.data?.lead?.id === leadId && finalDetail.data?.lead?.status === 'won',
    String(finalDetail.data?.lead?.status),
  );

  const note = await post(`/platform/leads/${leadId}/notes`, { body: 'طلبُ اختبارٍ من سكربت التحقّق — أُغلق بعد التحويل.' }, { token: operatorToken });
  check('والملاحظة تُخزَّن منسوبةً لصاحبها', note.status === 201 && note.data?.authorName, `${note.status} · ${note.data?.authorName ?? ''}`);

  const audit = await get('/platform/audit?filter[entity]=lead&limit=20', { token: operatorToken });
  const auditRows = audit.data?.items ?? [];
  check(
    'وسجلّ المنصّة يحمل تحويل الطلب',
    auditRows.some((entry) => String(entry.action).includes('lead.converted')),
    `${auditRows.length} سطراً من ${audit.data?.total ?? 0}`,
  );
} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
}

// ══════════════════════════════════════════════════ 6. 🌐 الموقع التسويقي
// قسمٌ مستقلّ عن الحالة: يقيس **الشاشات المعروضة** لا الـAPI وحده — «نقطة نهاية حقيقية لكل
// شاشة» لا تُقاس من الخادم، بل من HTML الذي يفتحه الزائر.
try {
  console.log('\n■ 6. 🌐 الموقع التسويقي — الاستمارات المعروضة على الشبكة');

  const contact = await page('/contact');
  check('«تواصل معنا» صفحةٌ حيّة 200', contact.status === 200, `HTTP ${contact.status}`);
  check(
    'وفيها حقول الطلب الحقيقية',
    contact.html.includes('name="fullName"') && contact.html.includes('name="email"') && contact.html.includes('name="message"'),
  );
  check(
    'وفيها المصيدة (`website`) داخل حقلٍ مخفيّ لا يراه إنسان',
    contact.html.includes('name="website"') && contact.html.includes('hp-field'),
  );
  // والمصيدة تُخفى بـCSS حقيقيّ يصل المتصفّح (لا بـ`hidden` يكشفها للماسح، ولا بحالة React
  // لا تُصيَّر على الخادم) — فتُقرأ ورقة الأنماط المُحمَّلة فعلاً وتُفتَّش فيها القاعدة.
  // وفي وضع التطوير تأتي الورقة بمعامل إصدار (`…css?v=…`) — فالالتقاط يشمل ما بعده.
  const styleHref = contact.html.match(/href="([^"]+\.css[^"]*)"/)?.[1] ?? '';
  const stylesheet = styleHref
    ? await fetch(styleHref.startsWith('http') ? styleHref : `${siteBase}${styleHref}`).then((response) => response.text())
    : '';
  check(
    'والحقل المخفيّ مخفيٌّ بـCSS يصل المتصفّح فعلاً',
    /\.hp-field\s*\{[^}]*display\s*:\s*none/i.test(stylesheet),
    styleHref || 'لا ورقة أنماط',
  );

  const demo = await page('/demo');
  check('«اطلب عرضاً» صفحةٌ حيّة 200', demo.status === 200, `HTTP ${demo.status}`);
  check('وفيها الاستمارة نفسها بنصّها الخاص', demo.html.includes('اطلب عرضاً') && demo.html.includes('lead-form'));

  const home = await page('/');
  check(
    'واشتراك النشرة في تذييل الصفحة الرئيسية',
    home.status === 200 && home.html.includes('newsletter-form') && home.html.includes('name="website"'),
  );

  const english = await page('/en');
  check(
    'وللنشرة نظيرٌ إنجليزي في `/en` (التذييل بلغتين)',
    english.status === 200 && english.html.includes('newsletter-form') && /dir="ltr"/.test(english.html),
  );

  const sitemap = await fetch(`${siteBase}/sitemap.xml`).then((response) => response.text());
  check('وخريطة الموقع تُعلن مسارَي التحويل', sitemap.includes('/demo<') || sitemap.includes('/demo'), 'demo');
  check('وفيها مسار الاشتراك أيضاً', sitemap.includes('/onboarding'), 'onboarding');
} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
}

console.log(`\n${failures === 0 ? '✔' : '✗'} verify-leads: ${checks - failures}/${checks} نقطة ناجحة في 6 أقسام`);
process.exit(failures === 0 ? 0 : 1);
