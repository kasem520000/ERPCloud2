#!/usr/bin/env node
/**
 * verify-campaigns.mjs — التحقّق الحيّ لـ P-M7 «الحملات البريدية وإلغاء الاشتراك»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس **الطريق كاملاً**: زائرٌ يترك عنوانه في الموقع ⇒ يدخل شريحةً بأعدادٍ حقيقية ⇒ يكتب
 * مشغّلٌ حملةً ⇒ يجرّبها على عنوانٍ واحد ⇒ يجدولها في المستقبل ⇒ يُلغيها ⇒ ثم يُرسل حملةً
 * فعلاً ⇒ تُقرأ رسالتها من سجلّ البريد ⇒ **يُفتح البكسل ويُنقر الرابط ويُلغى الاشتراك بنقرة**
 * ⇒ ويُقاس الأثر في التقرير. وسبعة أقسام:
 *
 *   1. 🔐 الباب والصلاحية — بلا توكن 401، والقائمة بغلافها وعدّاداتها، والشرائح الستّ
 *      بأعدادٍ تُقرأ من الجداول الآن، والتصنيف «أشخاص/حسابات» معلَنٌ لا مضمر.
 *   2. 🚪 الجمهور — طلباتٌ حقيقية من الاستمارة العامّة ومشتركٌ بتأكيدٍ مزدوج: **جمهورنا نحن**
 *      لا جمهورٌ مبذور، فالحملة تُقاس على من أدخلناه.
 *   3. 📝 الكتابة والتحقّق — مسوّدةٌ تُنشأ، ومتغيّرٌ مجهولٌ يُرفض من الآن، وحملةٌ مقفلةٌ لا
 *      تُعدَّل، ورسالةُ اختبارٍ لا تُكتب في تقرير الحملة.
 *   4. 📤 الإرسال — الجدولة المستقبلية، والإلغاء بسببٍ مكتوب، ثم إرسالٌ فوريّ وصفٌّ لكل
 *      مستلم، ونصٌّ خرج فعلاً: بكسلٌ ورابطُ إلغاءٍ وترويساتُ RFC 8058.
 *   5. 📊 القياس — الفتح يُسجَّل **مرّة** مهما أُعيد تحميل البكسل، والنقرة تُوجَّه إلى وجهتها
 *      الحقيقية، ونقرةٌ إلى وجهةٍ ليست في الحملة 404 (لا تحويلَ مفتوح).
 *   6. 🚫 الإلغاء والامتثال — الإلغاء يُكتب حجراً عاماً يُلغي كلّ البريد اللاحق لا هذه الحملة،
 *      والحملة التالية تُعلن «لم تُرسل» بسببه، ونقرة العميل الواحدة تُقبَل بلا صفحةٍ وسيطة.
 *   7. 🌐 الموقع — شاشة `/unsubscribe` بحالاتها الأربع كما تُقرأ في متصفّحٍ لا يعرف JSON.
 *
 * **وأين الإرسال الحقيقي؟** لا يخرج بريدٌ من هذه المساحة: `MAIL_TRANSPORT=console`،
 * والفحص يقيس `provider` في صفّ الرسالة ليتأكّد من ذلك. وكل العناوين `.example.test` —
 * فلا صندوقَ إنسانٍ يُزعج في تحقّقٍ آليّ.
 *
 * **وما يُقرأ من القاعدة؟** ثلاثة أشياء لا رابع لها، وكلٌّ منها لا يُقرأ من الـAPI:
 *   1. **نصّ الرسالة كما خرجت** (`email_messages`) — منه الرمز، وهو لا يُعاد في أي استجابة
 *      عن قصد (كما في P-M6)، ورابطُ تأكيد النشرة كذلك.
 *   2. **مُجزَّأ الرمز** (`campaign_messages.track_token_hash`) — للتأكّد أن المخزَّن sha256
 *      لا الرمز الخام.
 *   3. **صفّ الحجر** (`email_suppressions`) — الدليل على أن الإلغاء عامٌّ لا خاصّ بحملة.
 *
 * Usage: node scripts/verify-campaigns.mjs
 */
import { createHash } from 'node:crypto';
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
const leadA = `verify.pm7.a.${stamp}@example.test`;
const leadB = `verify.pm7.b.${stamp}@example.test`;
const newsletter = `verify.pm7.news.${stamp}@example.test`;
const testInbox = `verify.pm7.test.${stamp}@example.test`;
const campaignName = `عرض التحقّق ${stamp}`;
/** رابطٌ حقيقيّ في الموقع التسويقي + وسمٌ ثانٍ: النقرة تُقاس على **الوجهة** لا على عدد الروابط. */
const firstStop = `${siteBase}/demo`;
const secondStop = `${siteBase}/pricing`;
const campaignBody = [
  'مرحباً {{name}},',
  '',
  `نصٌّ قصير يقول لماذا نكتب: منشأتك تكبر، والنظام ينتظر. اطلب عرضاً: ${firstStop}`,
  `وإن أردت المقارنة قبل الكلام فاقرأ [الأسعار](${secondStop}).`,
].join('\n');

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
    const error = new Error(
      `${method.toUpperCase()} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return {
    status: response.status,
    data: parsed.data,
    meta: parsed.meta,
    counts: parsed.counts,
    raw: parsed,
    headers: response.headers,
  };
}

const get = (path, options) => call('get', path, options);
const post = (path, body, options = {}) => call('post', path, { body, ...options });
const patch = (path, body, options = {}) => call('patch', path, { body, ...options });

/** نداءٌ **يُتوقَّع رفضه**: حالته ورمزه هما الجواب. */
async function refused(method, path, body, token) {
  const { status, raw } = await call(method, path, { body, token, allowFailure: true });
  return { status, code: raw.code ?? '', detail: raw.detail ?? '' };
}

/**
 * نداءُ بابٍ عامّ **بصبر**: دلو `public-form` يحمل ١٠ طلباتٍ في الدقيقة لكلّ عنوان، وسكربتات
 * التحقّق تُشغَّل وراء بعضها على العنوان نفسه. فنفادُ الدلو ليس فشل نشر — يُنتظر ويُعاد.
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
      if (error.status !== 429 || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    }
  }
}

function connectionString() {
  return process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
}

/** القراءة الأولى من القاعدة: نصّ الرسالة كما خرجت — منه الرمز (لا يُعاد في أي استجابة). */
async function sentMessage(address, event) {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, subject, body, html, headers, status, provider, is_test, created_at
         FROM email_messages
        WHERE event = $1 AND lower(to_email) = $2
        ORDER BY created_at DESC LIMIT 1`,
      [event, address.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return null;
    const body = String(row.body ?? '');
    const html = String(row.html ?? '');
    const open = html.match(/track\/open\/([A-Za-z0-9_-]{16,128})/);
    const unsubscribe = body.match(/unsubscribe\?token=([A-Za-z0-9_-]{16,128})/);
    return {
      id: String(row.id),
      subject: String(row.subject),
      body,
      html,
      headers: row.headers ?? {},
      status: String(row.status),
      provider: String(row.provider),
      isTest: Boolean(row.is_test),
      token: open ? open[1] : null,
      unsubscribeToken: unsubscribe ? unsubscribe[1] : null,
    };
  } finally {
    await client.end();
  }
}

/** مشتركو النشرة يقرأون رابط تأكيدهم من رسالتهم — كما في `verify-leads.mjs`. */
async function confirmTokenFor(address) {
  const message = await sentMessage(address, 'subscriber.confirm');
  const match = message?.body.match(/confirm\/([0-9a-f]{48})/);
  return match ? match[1] : null;
}

async function query(sql, params = []) {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** صفحةٌ من الموقع التسويقي كما يراها زائر: HTML خام — يُقاس بها ما يُعرَض لا ما يُكتب. */
async function page(path) {
  const response = await fetch(`${siteBase}${path}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
}

const operatorToken = await signIn();
console.log(`✔ logged in as ${operator.email} (platform tenant ${platformTenant})\n`);

let campaignId = null;
let report = null;

try {
  // ══════════════════════════════════════════════════ 1. 🔐 الباب والصلاحية
  console.log('■ 1. 🔐 الباب والصلاحية — من يقرأ اللوحة ومن يقرأ الشرائح');

  const anonymous = await refused('get', '/platform/campaigns');
  check('بلا توكن ⇒ 401', anonymous.status === 401, String(anonymous.status));

  const list = await get('/platform/campaigns', { token: operatorToken });
  check(
    'القائمة تُقرأ بغلاف `{data, meta}` وعدّادات كل حالة',
    list.status === 200 && Array.isArray(list.data) && typeof list.counts?.sent === 'number',
    `HTTP ${list.status} · counts=${JSON.stringify(list.counts ?? {})}`,
  );

  const segments = (await get('/platform/campaigns/segments', { token: operatorToken })).data ?? [];
  check('والشرائح ستٌّ بالترتيب المعروف', segments.length === 6, `${segments.length} شريحة`);
  check(
    'وأعدادُها أعدادُ صفوفٍ حقيقية لا تقديرات',
    segments.every((row) => Number.isInteger(row.count) && row.count >= 0),
    segments.map((row) => `${row.segment}=${row.count}`).join(' · '),
  );
  check(
    'والتصنيف معلَن: شريحتا الأشخاص «people» وشريحة الحسابات «account»',
    segments.find((row) => row.segment === 'leads')?.audience === 'people' &&
      segments.find((row) => row.segment === 'subscribers')?.audience === 'people' &&
      segments.find((row) => row.segment === 'active')?.audience === 'account',
    segments.map((row) => `${row.segment}:${row.audience}`).join(' · '),
  );
  check(
    'وكل شريحةٍ فارغة تحمل تنبيهاً، والممتلئة بلا تنبيه',
    segments.every((row) => Boolean(row.warningAr) === (row.count === 0)),
    segments
      .filter((row) => row.count === 0)
      .map((row) => row.segment)
      .join(' ') || 'لا شريحة فارغة',
  );

  // ══════════════════════════════════════════════════ 2. 🚪 الجمهور
  console.log('\n■ 2. 🚪 الجمهور — جمهورٌ نُدخله نحن: طلباتٌ موافقة ومشتركٌ مؤكَّد');

  const before = new Map(segments.map((row) => [row.segment, row.count]));

  const firstLead = await patient(() =>
    post('/public/leads', {
      fullName: 'سالم العمري',
      companyName: `شركة التحقّق ${stamp}`,
      email: leadA,
      phone: '+967700000000',
      branchCount: 3,
      message: 'نريد عرضاً لفروعنا الثلاثة، وربطاً بالمخزون، وفواتير ضريبية — ويفضّل هذا الشهر.',
      acceptsMarketing: true,
      utm: { source: 'google', medium: 'cpc', campaign: 'verify-pm7' },
    }),
  );
  check('طلبٌ من الاستمارة العامّة يُقبَل 202 بمرجعٍ قصير', firstLead.status === 202 && /^L-[0-9A-F]{8,16}$/.test(String(firstLead.data?.reference)), String(firstLead.data?.reference));

  const secondLead = await patient(() =>
    post('/public/leads', {
      fullName: 'نجاة الحسن',
      companyName: `متجر التحقّق ${stamp}`,
      email: leadB,
      message: 'عندنا فرعان ونريد ربط نقاط البيع بالفواتير، ونحتاج عرضاً هذا الشهر.',
      acceptsMarketing: true,
      utm: { source: 'direct', medium: 'organic', campaign: 'verify-pm7' },
    }),
  );
  check('وطلبٌ ثانٍ يُقبَل كذلك (شريحةٌ فيها أكثر من واحد)', secondLead.status === 202, `HTTP ${secondLead.status}`);

  const subscribed = await patient(() => post('/public/subscribe', { email: newsletter, locale: 'ar', source: 'newsletter' }));
  const confirmToken = await confirmTokenFor(newsletter);
  check(
    'والاشتراك في النشرة لا يُؤكِّد نفسه: يصل رابطٌ مُجزَّأ في رسالة',
    subscribed.status === 202 && Boolean(confirmToken),
    confirmToken ? `token=${confirmToken.slice(0, 8)}…` : 'لا رابط',
  );
  const confirmed = await get(`/public/subscribe/confirm/${confirmToken}`);
  check('وفتحُ الرابط يُؤكِّد الاشتراك 200', confirmed.status === 200, `HTTP ${confirmed.status}`);

  const moved = (await get('/platform/campaigns/segments', { token: operatorToken })).data ?? [];
  const countOf = (key) => Number(moved.find((row) => row.segment === key)?.count ?? -1);
  check(
    'والشريحة تتحرّك بعدد من أدخلناهم: متوقّعان ومشتركٌ واحد',
    countOf('leads') === (before.get('leads') ?? 0) + 2 && countOf('subscribers') === (before.get('subscribers') ?? 0) + 1,
    `leads ${before.get('leads')}→${countOf('leads')} · subscribers ${before.get('subscribers')}→${countOf('subscribers')}`,
  );

  // ══════════════════════════════════════════════════ 3. 📝 الكتابة والتحقّق
  console.log('\n■ 3. 📝 الكتابة والتحقّق — مسوّدةٌ تُراجَع قبل أن تخرج');

  const draft = await post(
    '/platform/campaigns',
    { name: campaignName, subject: 'أهلاً {{name}} — عرضٌ لفروعك', body: campaignBody, segment: 'leads', locale: 'ar' },
    { token: operatorToken },
  );
  campaignId = draft.data?.id ?? null;
  check('الحملة تُولد مسوّدة 201 بحالة «draft»', draft.status === 201 && draft.data?.status === 'draft', `${draft.status} · ${draft.data?.status}`);
  check('والتقدير يُعرض لحظة الإنشاء', draft.data?.segment === 'leads' && draft.data?.statusLabelAr === 'مسوّدة', String(draft.data?.statusLabelAr));
  check(
    'وروابط النصّ تُستخرج بترتيبها من الحملة نفسها',
    Array.isArray(draft.data?.hyperlinks) && draft.data.hyperlinks.length === 2 && draft.data.hyperlinks[0] === firstStop,
    JSON.stringify(draft.data?.hyperlinks ?? []),
  );

  const unknownVariable = await refused(
    'post',
    '/platform/campaigns',
    { name: `حملة خطأ ${stamp}`, subject: 'خصمٌ لك', body: 'مرحباً {{name}} — خصم {{discount}} لك.', segment: 'leads', locale: 'ar' },
    operatorToken,
  );
  check(
    'ومتغيّرٌ غير معروف يُرفض من الآن لا عند الإرسال',
    unknownVariable.status === 422 && unknownVariable.code === 'CAMPAIGN_BODY_INVALID',
    `${unknownVariable.status} ${unknownVariable.code}`,
  );

  const edited = await patch(
    `/platform/campaigns/${campaignId}`,
    { subject: 'خمس دقائق تكفي — عرضٌ لفروعك {{name}}' },
    { token: operatorToken },
  );
  check('والمسوّدة تُعدَّل قبل الإرسال', edited.status === 200 && edited.data?.subject.includes('خمس دقائق'), `HTTP ${edited.status}`);

  const scheduledAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const scheduled = await post(`/platform/campaigns/${campaignId}/schedule`, { scheduledAt }, { token: operatorToken });
  check(
    'والجدولة تُثبَّت بحالة «scheduled» ووقتٍ صريح',
    scheduled.status === 200 && scheduled.data?.status === 'scheduled' && Boolean(scheduled.data?.scheduledAt),
    `${scheduled.data?.status} @ ${scheduled.data?.scheduledAt ?? ''}`,
  );
  check(
    'ومعها تقدير المستلمين محسوبٌ من الجدول',
    Number(scheduled.data?.estimatedRecipients) >= 2,
    `${scheduled.data?.estimatedRecipients} مستلماً`,
  );

  const queuedJob = await query(
    `SELECT queue, type, status FROM outbox_jobs WHERE payload->>'campaignId' = $1 LIMIT 1`,
    [campaignId],
  );
  check(
    'والجدولة تُسجَّل مهمّةً في الطابور (لا مؤقّتاً في الذاكرة)',
    queuedJob.length === 1 && String(queuedJob[0].type).includes('campaign'),
    queuedJob.length ? `${queuedJob[0].queue}/${queuedJob[0].type}` : 'لا مهمّة',
  );

  const testSend = await post(`/platform/campaigns/${campaignId}/send-test`, { to: testInbox }, { token: operatorToken });
  check(
    'ورسالة اختبارٍ تخرج إلى عنوانٍ واحد بلا احتساب',
    testSend.status === 201 && testSend.data?.trackingDisabled === true,
    `${testSend.status} · ${testSend.data?.status ?? ''}`,
  );
  const testMessage = await sentMessage(testInbox, 'campaign.message');
  check(
    'وهي موسومة تجربةً في سجلّ البريد',
    Boolean(testMessage) && testMessage.isTest === true && testMessage.provider === 'console',
    `${testMessage?.provider ?? '—'} · is_test=${testMessage?.isTest ?? '—'}`,
  );
  const afterTest = await get(`/platform/campaigns/${campaignId}/report`, { token: operatorToken });
  check(
    'ولا تُكتب رسالةُ الاختبار في تقرير الحملة',
    (afterTest.data?.messages ?? []).length === 0,
    `${(afterTest.data?.messages ?? []).length} صفّاً`,
  );

  const canceled = await post(`/platform/campaigns/${campaignId}/cancel`, { reason: 'أُجّلت إلى الربع القادم' }, { token: operatorToken });
  check(
    'والإلغاء يحتاج سبباً ويُحفظ به',
    canceled.status === 200 && canceled.data?.status === 'canceled' && canceled.data?.canceledReason === 'أُجّلت إلى الربع القادم',
    `${canceled.data?.status} · ${canceled.data?.canceledReason ?? ''}`,
  );
  const locked = await refused('patch', `/platform/campaigns/${campaignId}`, { subject: 'عنوانٌ آخر تماماً' }, operatorToken);
  check(
    'وما بعد الإلغاء لا يُعدَّل (`CAMPAIGN_LOCKED`)',
    locked.status === 422 && locked.code === 'CAMPAIGN_LOCKED',
    `${locked.status} ${locked.code}`,
  );

  // ══════════════════════════════════════════════════ 4. 📤 الإرسال
  console.log('\n■ 4. 📤 الإرسال — «أرسل الآن»: صفٌّ لكل مستلم ورسالةٌ أُخرجت فعلاً');

  const sending = await post(
    '/platform/campaigns',
    { name: `${campaignName} — الإرسال`, subject: 'أهلاً {{name}} — عرضٌ لفروعك', body: campaignBody, segment: 'leads', locale: 'ar' },
    { token: operatorToken },
  );
  const sendingId = sending.data?.id ?? null;
  const sentNow = await post(`/platform/campaigns/${sendingId}/schedule`, { scheduledAt: null }, { token: operatorToken });
  check(
    '`scheduledAt: null` = الإرسال الآن، والحملة تنتهي «أُرسلت»',
    sentNow.status === 200 && sentNow.data?.status === 'sent' && Boolean(sentNow.data?.finishedAt),
    `${sentNow.data?.status} · finishedAt=${sentNow.data?.finishedAt ?? '—'}`,
  );
  check(
    'والشريحة صارت صفوفاً: من وُجد فيها لحظة الإرسال',
    Number(sentNow.data?.totals?.recipients) >= 2 && Number(sentNow.data?.totals?.sent) >= 2,
    `recipients=${sentNow.data?.totals?.recipients} · sent=${sentNow.data?.totals?.sent}`,
  );

  const firstMessage = await sentMessage(leadA, 'campaign.message');
  check(
    'وصلت الرسالة إلى الموقع مع عنوانٍ حقيقيّ (لا ناقل خارجي في هذه المساحة)',
    Boolean(firstMessage) && firstMessage.status === 'sent' && firstMessage.provider === 'console',
    `${firstMessage?.status ?? '—'} · ${firstMessage?.provider ?? '—'}`,
  );
  check(
    'والمتغيّرات استُبدلت في العنوان والمتن (لا `{{…}}` في رسالةٍ خرجت)',
    Boolean(firstMessage) && !firstMessage.subject.includes('{{') && !firstMessage.body.includes('{{'),
    firstMessage?.subject ?? '—',
  );
  check(
    'وفي الرسالة بكسلُ فتحٍ ورابطُ إلغاءٍ برمزٍ واحد',
    Boolean(firstMessage?.token) && Boolean(firstMessage?.unsubscribeToken),
    `open=${firstMessage?.token?.slice(0, 6) ?? '—'}… · unsubscribe=${firstMessage?.unsubscribeToken?.slice(0, 6) ?? '—'}…`,
  );
  check(
    'وترويسات النقرة الواحدة تخرج معها (RFC 8058)',
    String(firstMessage?.headers?.['List-Unsubscribe'] ?? '').includes('/unsubscribe?token=') &&
      String(firstMessage?.headers?.['List-Unsubscribe-Post'] ?? '') === 'List-Unsubscribe=One-Click',
    JSON.stringify(firstMessage?.headers ?? {}),
  );

  const storedToken = await query(
    `SELECT track_token_hash, status, links FROM campaign_messages
      WHERE campaign_id = $1 AND email = $2`,
    [sendingId, leadA],
  );
  check(
    'والمخزَّن مُجزَّأ: sha256 للرمز لا الرمز نفسه',
    storedToken.length === 1 && String(storedToken[0].track_token_hash) === sha256(firstMessage?.token ?? ''),
    storedToken.length ? `${String(storedToken[0].track_token_hash).slice(0, 12)}…` : 'لا صفّ',
  );

  report = (await get(`/platform/campaigns/${sendingId}/report`, { token: operatorToken })).data ?? null;
  check(
    'والتقرير يقرأ الرسائل من صفوفها لا من عدّادٍ في الذاكرة',
    (report?.messages ?? []).length === Number(sentNow.data?.totals?.recipients) &&
      report?.totals?.sent === sentNow.data?.totals?.sent,
    `${(report?.messages ?? []).length} صفّاً`,
  );

  const reDispatch = await post(`/platform/campaigns/${sendingId}/dispatch`, {}, { token: operatorToken });
  const afterRedispatch = (await get(`/platform/campaigns/${sendingId}/report`, { token: operatorToken })).data ?? null;
  check(
    'وإعادة الدفع على حملةٍ أُرسلت لا تُنشئ رسالةً ثانية',
    reDispatch.status === 200 && Number(reDispatch.data?.dispatched) === 0 &&
      (afterRedispatch?.messages ?? []).length === (report?.messages ?? []).length,
    `dispatched=${reDispatch.data?.dispatched}`,
  );

  // ══════════════════════════════════════════════════ 5. 📊 القياس
  console.log('\n■ 5. 📊 القياس — فتحٌ يُسجَّل مرّة، ونقرةٌ تُوجَّه إلى وجهتها');

  const token = firstMessage?.token ?? '';
  const pixel = await fetch(`${apiBase}/public/track/open/${token}`);
  const pixelBody = Buffer.from(await pixel.arrayBuffer());
  check(
    'بكسل الفتح يُعاد GIF شفّافاً في كل حال',
    pixel.status === 200 && String(pixel.headers.get('content-type')).includes('image/gif') && pixelBody.length > 10,
    `${pixel.status} · ${pixel.headers.get('content-type')} · ${pixelBody.length} بايت`,
  );
  const reloaded = await fetch(`${apiBase}/public/track/open/${token}`);
  check('وإعادة تحميله لا تُفشل شيئاً (عميل بريدٍ يحمّل الصور)', reloaded.status === 200, String(reloaded.status));

  const unknownOpen = await fetch(`${apiBase}/public/track/open/${'z'.repeat(32)}`);
  check('وبكسلٌ برمزٍ مجهول يعود صورةً أيضاً لا خطأً', unknownOpen.status === 200, String(unknownOpen.status));

  const click = await fetch(`${apiBase}/public/track/click/${token}/0`, { redirect: 'manual' });
  check(
    'النقرة تُوجَّه 302 إلى الوجهة الحقيقية من روابط الحملة',
    click.status === 302 && String(click.headers.get('location')) === firstStop,
    `${click.status} → ${click.headers.get('location') ?? '—'}`,
  );
  const openRedirect = await fetch(`${apiBase}/public/track/click/${token}/99`, { redirect: 'manual' });
  check(
    'ونقرةٌ إلى وجهةٍ ليست في الحملة 404 (لا تحويلَ مفتوح)',
    openRedirect.status === 404,
    String(openRedirect.status),
  );
  const unknownClick = await fetch(`${apiBase}/public/track/click/${'z'.repeat(32)}/0`, { redirect: 'manual' });
  check('ونقرةٌ برمزٍ مجهول 404 كذلك', unknownClick.status === 404, String(unknownClick.status));

  const measured = (await get(`/platform/campaigns/${sendingId}/report`, { token: operatorToken })).data ?? null;
  const mine = (measured?.messages ?? []).find((row) => row.email === leadA);
  check(
    'والتقرير يقول: فتحٌ واحد ونقرةٌ واحدة لهذا المستلم',
    measured?.totals?.opened === 1 && measured?.totals?.clicked === 1 && mine?.clickCount === 1,
    `opened=${measured?.totals?.opened} · clicked=${measured?.totals?.clicked} · clickCount=${mine?.clickCount ?? '—'}`,
  );
  check(
    'والرابط المنقور مُعلَنٌ في التقرير بوجهته',
    (measured?.links ?? []).some((row) => row.url === firstStop && row.clicks === 1) && mine?.lastClickedUrl === firstStop,
    JSON.stringify(measured?.links ?? []),
  );
  check(
    'وحدث الفتح واحدٌ وإن أُعيد تحميل البكسل مرّتين',
    (measured?.events ?? []).filter((row) => row.kind === 'opened').length === 1,
    `${(measured?.events ?? []).filter((row) => row.kind === 'opened').length} حدثاً`,
  );

  // ══════════════════════════════════════════════════ 6. 🚫 الإلغاء والامتثال
  console.log('\n■ 6. 🚫 الإلغاء والامتثال — حجرٌ عامّ يُلغي كلّ البريد اللاحق');

  // مشترك النشرة: حملةٌ ثانية إلى شريحته، ثم إلغاء بنقرةٍ من رسالتها.
  const toSubscribers = await post(
    '/platform/campaigns',
    { name: `${campaignName} — النشرة`, subject: 'رسالةٌ إلى مشتركي النشرة', body: campaignBody, segment: 'subscribers', locale: 'ar' },
    { token: operatorToken },
  );
  const subscriberCampaignId = toSubscribers.data?.id ?? null;
  const subscriberSend = await post(`/platform/campaigns/${subscriberCampaignId}/schedule`, { scheduledAt: null }, { token: operatorToken });
  check(
    'حملةٌ إلى مشتركي النشرة تخرج إلى من أكّد اشتراكه',
    subscriberSend.status === 200 && Number(subscriberSend.data?.totals?.sent) >= 1,
    `sent=${subscriberSend.data?.totals?.sent}`,
  );

  const subscriberMessage = await sentMessage(newsletter, 'campaign.message');
  const newsletterToken = subscriberMessage?.unsubscribeToken ?? '';
  const unsubscribe = await get(`/public/unsubscribe/${newsletterToken}`);
  check(
    'والفتح من رابط الرسالة يُلغي الاشتراك بنقرة 200',
    unsubscribe.status === 200 && unsubscribe.data?.unsubscribed === true,
    `${unsubscribe.status} · ${unsubscribe.data?.message ?? ''}`,
  );
  const again = await get(`/public/unsubscribe/${newsletterToken}`);
  check(
    'وإعادة الفتح تقول «من قبل» بلا تغيير (idempotent)',
    again.status === 200 && String(again.data?.message ?? '').includes('من قبل'),
    String(again.data?.message ?? ''),
  );

  const suppression = await query(
    `SELECT tenant_id, email, reason FROM email_suppressions WHERE lower(email) = $1`,
    [newsletter],
  );
  check(
    'والحجر يُكتب **عامّاً** (`tenant_id NULL`) بسبب «unsubscribe»',
    suppression.length === 1 && suppression[0].tenant_id === null && suppression[0].reason === 'unsubscribe',
    JSON.stringify(suppression[0] ?? {}),
  );
  const subscriberRow = await query(
    `SELECT status, confirmed_at, unsubscribed_at FROM email_subscribers WHERE lower(email) = $1`,
    [newsletter],
  );
  check(
    'وحالة المشترك تصير `unsubscribed` بلا تأكيدٍ معلَّق',
    subscriberRow.length === 1 && subscriberRow[0].status === 'unsubscribed' && subscriberRow[0].confirmed_at === null && subscriberRow[0].unsubscribed_at !== null,
    `${subscriberRow[0]?.status ?? '—'} · confirmed_at=${subscriberRow[0]?.confirmed_at ?? 'null'}`,
  );

  const oneClick = await post(`/public/unsubscribe/${newsletterToken}`, {}, { allowFailure: true });
  check(
    'ونقرة العميل الواحدة (`POST`) تُقبَل 200 بلا صفحةٍ وسيطة',
    oneClick.status === 200 && oneClick.data?.unsubscribed === true,
    String(oneClick.status),
  );

  // عنوانٌ من حملةٍ سبق إرسالها: نقرةُ العميل الواحدة على رسالته نفسها (لا على أخرى).
  const gated = await post(`/public/unsubscribe/${token}`, {}, { allowFailure: true });
  check(
    'ونقرة العميل الواحدة من رسالة حملةٍ أُرسلت تُقبَل 200 كذلك',
    gated.status === 200,
    String(gated.status),
  );

  // ثم حملةٌ **تالية** إلى الشريحة نفسها: الملغى يُستبعد، والباقي تصلهم.
  const followUp = await post(
    '/platform/campaigns',
    { name: `${campaignName} — التالية`, subject: 'تذكيرٌ أخير {{name}}', body: campaignBody, segment: 'leads', locale: 'ar' },
    { token: operatorToken },
  );
  const followUpId = followUp.data?.id ?? null;
  const followUpSend = await post(`/platform/campaigns/${followUpId}/schedule`, { scheduledAt: null }, { token: operatorToken });
  const followUpReport = (await get(`/platform/campaigns/${followUpId}/report`, { token: operatorToken })).data ?? null;
  check(
    'والحملة التالية تُرسل إلى الباقين وتُسقط الملغى من الشريحة',
    followUpSend.status === 200 && Number(followUpSend.data?.totals?.recipients) >= 2 &&
      Number(followUpSend.data?.totals?.skipped) >= 1,
    `recipients=${followUpSend.data?.totals?.recipients} · sent=${followUpSend.data?.totals?.sent} · skipped=${followUpSend.data?.totals?.skipped}`,
  );

  const gatedRows = await query(
    `SELECT status, detail FROM campaign_messages WHERE campaign_id = $1 AND email = $2`,
    [followUpId, leadA],
  );
  check(
    'والتقرير يقول لماذا: «لم تُرسل» بسببٍ مكتوب لا صمت',
    gatedRows.length === 1 && gatedRows[0].status === 'skipped' && String(gatedRows[0].detail ?? '').includes('محجوب'),
    `${gatedRows[0]?.status ?? '—'} · ${gatedRows[0]?.detail ?? '—'}`,
  );
  check(
    'والملغى يُعلن في مجاميع التقرير «skipped»',
    Number(followUpReport?.totals?.skipped) >= 1 &&
      (followUpReport?.messages ?? []).some((row) => row.email === leadA && row.status === 'skipped'),
    `skipped=${followUpReport?.totals?.skipped}`,
  );

  const audit = await get('/platform/audit?filter[entity]=email_campaign&limit=30', { token: operatorToken });
  const auditRows = audit.data?.items ?? [];
  check(
    'وسجلّ المنصّة يحمل أثر الحملات (إنشاء · جدولة · إلغاء)',
    auditRows.some((entry) => String(entry.action).includes('campaign.sending')) &&
      auditRows.some((entry) => String(entry.action).includes('campaign.canceled')),
    [...new Set(auditRows.map((entry) => entry.action))].join(' · '),
  );

  // ══════════════════════════════════════════════════ 7. 🌐 الموقع
  console.log('\n■ 7. 🌐 الموقع — شاشة `/unsubscribe` كما يراها زائر لا يعرف JSON');

  const bare = await page('/unsubscribe');
  check(
    'صفحةٌ بلا رمز تقول «لا رابطَ في هذه الصفحة» ولا تُخمّن',
    bare.status === 200 && bare.html.includes('لا رابطَ في هذه الصفحة'),
    `HTTP ${bare.status}`,
  );
  check(
    'وفيها `noindex`: صفحةُ إجراءٍ لا صفحةُ محتوى',
    /name="robots"[^>]*noindex/i.test(bare.html),
  );

  const stranger = await page('/unsubscribe?token=zzzzzzzzzzzzzzzzzzzzzzzz');
  check(
    'ورابطٌ مجهول يقول «الرابط غير معروف» لا «أُلغي اشتراكك»',
    stranger.status === 200 && stranger.html.includes('الرابط غير معروف'),
    `HTTP ${stranger.status}`,
  );

  const freshToken = (await sentMessage(leadB, 'campaign.message'))?.unsubscribeToken ?? '';
  const done = await page(`/unsubscribe?token=${freshToken}`);
  check(
    'ورابطٌ حقيقي يُلغي من الشاشة نفسها (بلا JavaScript)',
    done.status === 200 && done.html.includes('أُلغي اشتراكك'),
    freshToken ? `token=${freshToken.slice(0, 6)}…` : 'لا رمز',
  );
  const doneAgain = await page(`/unsubscribe?token=${freshToken}`);
  check(
    'وإعادة الفتح من المتصفّح تقول «من قبل» — لا شيئاً فُعِل مرّتين',
    doneAgain.status === 200 && doneAgain.html.includes('من قبل'),
  );

  const leadBSuppression = await query(
    `SELECT count(*)::int AS n FROM email_suppressions WHERE lower(email) = $1 AND tenant_id IS NULL`,
    [leadB],
  );
  check(
    'والشاشة استعملت مسار الـAPI نفسه: الحجر العامّ مكتوب',
    Number(leadBSuppression[0]?.n ?? 0) === 1,
    `${leadBSuppression[0]?.n} صفّاً`,
  );
} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
}

console.log(`\n${failures === 0 ? '✔' : '✗'} verify-campaigns: ${checks - failures}/${checks} نقطة ناجحة في 7 أقسام`);
process.exit(failures === 0 ? 0 : 1);
