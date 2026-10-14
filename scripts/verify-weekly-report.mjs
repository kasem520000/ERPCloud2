#!/usr/bin/env node
/**
 * تحقّقٌ حيّ من **التقرير الأسبوعي بالبريد** — التسليم الدوري المؤجَّل من P-C12
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4: «تقرير أسبوعي بالبريد … يبني على P-C6»).
 *
 * يقود الـAPI الحقيقي على حزمةٍ تعمل (`pnpm dev`):
 *
 *   1. 🔐 الرمزان — `console.analytics.view` للمعاينة و`console.email.manage` للتشغيل
 *   2. 📅 النافذة والموعد — أسبوعٌ منقضٍ (أحد ← سبت) وموعدٌ قادم، والرابط داخل البريد
 *   3. ✉️ الإرسال — رسالةٌ حقيقية في سجلّ البريد بقالب الحدث نفسه
 *   4. 🚫 الحجر — النافذة نفسها والعنوان نفسه لا يُرسلان مرّتين، و`force` يتجاوز
 *   5. ⚙️ الإعدادات — المفاتيح الأربعة معرَّفةٌ في `/platform/settings` بالأنواع الصحيحة
 *   6. 🧹 التنظيف — الإعداد يعود إلى ما كان عليه تماماً
 *
 * **يعيد التشغيل**: لقطة الإعداد الأربعة تُستعاد في النهاية، والرسائل تبقى (سجلٌّ لا أثرٌ على
 * الزوّار)، ولا يُنشأ ولا يُحجر على شيء. والعدّ **بالفرق** لا بالرقم المطلق: رسائل التشغيل
 * السابق تبقى في السجلّ — وهذا هو معنى «لا تكرار» نفسه.
 *
 * Usage: node scripts/verify-weekly-report.mjs
 */
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

/** عنوان التحقّق — ثابتٌ ليُعدّ ما أُرسل إليه بلا التباس. */
const probe = 'verify-weekly@platform.test';

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

async function call(method, path, body, token, options = {}) {
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
  if (!response.ok && !options.allowFailure) {
    const error = new Error(
      `${method.toUpperCase()} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    throw error;
  }
  return { status: response.status, body: parsed };
}

async function data(method, path, body, token) {
  const { body: parsed } = await call(method, path, body, token);
  return parsed.data ?? parsed;
}

async function refused(method, path, body, token) {
  const { status, body: parsed } = await call(method, path, body, token, { allowFailure: true });
  return { status, code: parsed.code ?? '', detail: parsed.detail ?? parsed.message ?? '' };
}

async function signIn(tenantCode, credentials) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await data('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return { token, user: login.user };
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const owner = (await signIn(platformTenant, operator)).token;
const tenantToken = (await signIn(demo.tenantCode, { email: demo.email, password: demo.password })).token;
console.log(`✔ logged in as ${operator.email} (platform) and ${demo.email} (tenant ${demo.tenantCode})\n`);

const SETTING_KEYS = [
  'report.weekly_enabled',
  'report.weekly_recipients',
  'report.weekly_day',
  'report.weekly_hour',
];

/** كم رسالةً لهذا العنوان في سجلّ البريد — العدّاد الذي يقيس «أُرسل» و«لم يُرسل». */
async function probeMessages() {
  const rows = await data('get', '/platform/email/messages?limit=200', undefined, owner);
  const list = Array.isArray(rows) ? rows : (rows.items ?? rows.messages ?? []);
  return list.filter((row) => row.event === 'report.weekly' && row.toEmail === probe);
}

// ═══════════════════════════════════════════════ 1. 🔐 الرمزان
console.log('■ 1. 🔐 الرمزان — المعاينة للقراءة والتشغيل للبريد');
const me = await data('get', '/me', undefined, owner);
const codes = me.platformPermissions ?? [];
check('مالك المنصة يحمل `console.analytics.view`', codes.includes('console.analytics.view'));
check('ويحمل `console.email.manage`', codes.includes('console.email.manage'));

const anonymous = await refused('get', '/platform/reports/weekly');
check('بلا توكن ⇒ 401', anonymous.status === 401, `${anonymous.status}`);
const tenantPreview = await refused('get', '/platform/reports/weekly', undefined, tenantToken);
check('وجلسة المستأجر لا تقرأ التقرير (403 لا 401)', tenantPreview.status === 403, `${tenantPreview.status} ${tenantPreview.code}`);
const tenantRun = await refused('post', '/platform/reports/weekly/run', { to: [probe] }, tenantToken);
check('ولا تُشغّله', tenantRun.status === 403, `${tenantRun.status} ${tenantRun.code}`);

// ═══════════════════════════════════════════════ 2. 📅 النافذة والموعد
console.log('\n■ 2. 📅 النافذة والموعد');
// لقطة الإعداد قبل أي مسّ — تُستعاد في النهاية.
const settings = await data('get', '/platform/settings', undefined, owner);
const before = Object.fromEntries(
  SETTING_KEYS.map((key) => [key, settings.settings.find((setting) => setting.key === key)?.value]),
);

const preview = await data('get', '/platform/reports/weekly', undefined, owner);
check('المعاينة تعيد نافذةً وموعداً وقائمة مستلمين', Boolean(preview.window && preview.schedule && Array.isArray(preview.recipients)));
const start = new Date(preview.window.start);
const end = new Date(preview.window.end);
check('النافذة تبدأ أحداً في منتصف الليل بتوقيت الخادم', start.getDay() === 0 && start.getHours() === 0, start.toLocaleString('ar-SA'));
check('وطولها سبعة أيام بالضبط', end.getTime() - start.getTime() === 7 * 24 * 60 * 60 * 1000);
check('وتنتهي قبل الآن (أسبوعٌ منقضٍ لا جارٍ)', end.getTime() <= Date.now());
check('والوسم نصّه تاريخا البداية والنهاية', preview.window.label === `${preview.window.start.slice(0, 10)} → ${new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10)}`, preview.window.label);
check('الموعد القادم في المستقبل', new Date(preview.schedule.nextRunAt).getTime() > Date.now(), preview.schedule.nextRunAt);
check(
  'والموعد يوم الإعداد نفسه',
  new Date(preview.schedule.nextRunAt).getDay() === preview.schedule.day && new Date(preview.schedule.nextRunAt).getHours() === preview.schedule.hour,
  `${preview.schedule.dayLabelAr} ${preview.schedule.hour}:00`,
);
check('والرابط داخل البريد ينتهي بالشاشة `/analytics`', preview.link.endsWith('/analytics'), preview.link);
check(
  'والمتغيّرات كلها نصوصٌ بلا `undefined`',
  Object.values(preview.variables).every((value) => typeof value === 'string' && value.length > 0),
  `${Object.keys(preview.variables).length} متغيّراً`,
);
check('ولا مستلم بعد (الإعداد الافتراضي: لا تقرير)', preview.recipients.length === 0, `${preview.recipients.length}`);

// ═══════════════════════════════════════════════ 3. ✉️ الإرسال
console.log('\n■ 3. ✉️ الإرسال إلى عنوان التحقّق وحده');
const baseline = (await probeMessages()).length;

// الإرسال بتجاوز صريح أولاً: التشغيل السابق ترك رسالةً لهذه النافذة، والحجر سيمنع غيره.
const sent = await data('post', '/platform/reports/weekly/run', { to: [probe], force: true }, owner);
check('التشغيل اليدوي أنشأ رسالةً واحدة', sent.sentCount === 1 && sent.failedCount === 0, JSON.stringify(sent.outcomes));
check('وبرسالةٍ ناجحة بعنوان التحقّق', sent.outcomes[0]?.to === probe && sent.outcomes[0]?.status === 'sent');
check('وقائمة المستلمين في الإعداد لم تُمسّ', (await data('get', '/platform/reports/weekly', undefined, owner)).recipients.length === 0);

const afterSend = await probeMessages();
check('والرسالة ظاهرة في سجلّ البريد', afterSend.length === baseline + 1, `${baseline} ← ${afterSend.length}`);
check(
  'بموضوعٍ يحمل وسم الأسبوع',
  typeof afterSend[0]?.subject === 'string' && afterSend[0].subject.includes(preview.window.label.slice(0, 10)),
  afterSend[0]?.subject ?? '—',
);
check('وبحدث التقرير الأسبوعي ونطاق المنصة', afterSend[0]?.event === 'report.weekly' && afterSend[0]?.tenantId === null);
// سجلّ البريد لا يحمل الجسم (قصداً: النصّ المُرسَل يُقرأ من الصفّ لا من الفهرس)، فالتحقّق هنا
// على الموضوع، والجسم يقيسه سبيك `weekly-report.spec.ts` من القاعدة مباشرةً.
check(
  'وبنصٍّ صُيِّر من القالب (لا متغيّرات خام في الموضوع)',
  !afterSend[0]?.subject.includes('{{') && !afterSend[0]?.subject.includes('}}'),
  afterSend[0]?.subject ?? '—',
);

// ═══════════════════════════════════════════════ 4. 🚫 الحجر
console.log('\n■ 4. 🚫 لا تكرار للنافذة نفسها');
const again = await data('post', '/platform/reports/weekly/run', { to: [probe] }, owner);
check('النداء الثاني بلا تجاوز يتخطّى ولا يرسل', again.sentCount === 0 && again.skippedCount === 1, JSON.stringify(again.outcomes));
check('وسبب التخطّي مكتوب', typeof again.outcomes[0]?.detail === 'string' && again.outcomes[0].detail.length > 0, again.outcomes[0]?.detail ?? '');
check('وسجلّ البريد لم يزد', (await probeMessages()).length === baseline + 1);

const invalid = await refused('post', '/platform/reports/weekly/run', { to: ['ليست-عنواناً'] }, owner);
check('وعنوانٌ غير صالح يُرفض 400 في المدقّقة', invalid.status === 400, `${invalid.status} ${invalid.code}`);

// ═══════════════════════════════════════════════ 5. ⚙️ الإعدادات
console.log('\n■ 5. ⚙️ المفاتيح الأربعة في كتالوج الإعدادات');
// واحدٌ وثلاثون بعد P-C12، و`billing.trial_days` أضافه P-M4 (فترة التجربة في التسجيل) ⇒ 32.
check('الكتالوج صار اثنين وثلاثين مفتاحاً', settings.settings.length === 32, `${settings.settings.length}`);
const own = Object.fromEntries(settings.settings.map((setting) => [setting.key, setting]));
check('والمفاتيح الأربعة كلها معرَّفة', SETTING_KEYS.every((key) => Boolean(own[key])));
check('`report.weekly_enabled` منطقيّ افتراضه الإيقاف', own['report.weekly_enabled']?.kind === 'boolean' && own['report.weekly_enabled']?.value === false);
check('و`report.weekly_recipients` نصٌّ افتراضه فارغ', own['report.weekly_recipients']?.kind === 'string' && own['report.weekly_recipients']?.value === '');
check('و`report.weekly_day` قائمةُ أيامٍ سبعة', own['report.weekly_day']?.kind === 'select' && (own['report.weekly_day']?.options ?? []).length === 7);
check('و`report.weekly_hour` عددٌ بين 0 و23', own['report.weekly_hour']?.kind === 'integer' && own['report.weekly_hour']?.min === 0 && own['report.weekly_hour']?.max === 23);

// ═══════════════════════════════════════════════ 6. 🧹 التنظيف
console.log('\n■ 6. 🧹 التنظيف — الإعداد يعود كما كان');
const restored = await data('put', '/platform/settings', { values: before }, owner);
check('أُعيد كتابة المفاتيح الأربعة', Array.isArray(restored.settings), `HTTP ok`);
const finalPreview = await data('get', '/platform/reports/weekly', undefined, owner);
check('وعدد المستلمين عاد كما كان', finalPreview.recipients.length === 0, `${finalPreview.recipients.length}`);
check('والتشغيل الدوري متوقّف كما كان', finalPreview.enabled === false);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} نقطة تحقّق ناجحة`);
process.exit(failures === 0 ? 0 : 1);
