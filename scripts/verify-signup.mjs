/**
 * verify-signup.mjs — التحقّق الحيّ لـ P-M4 «الاشتراك والتفعيل»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس **الطريق كاملاً لا المخرَج**: زائرٌ لا يملك حساباً يفتح `/onboarding` ⇒ يقرأ الباقات
 * (نفس ما تعرضه صفحة الأسعار) ⇒ يُنشئ منشأةً ⇒ يصل الرمز **بالبريد** (لا في الاستجابة) ⇒
 * يُؤكَّد ⇒ تُقرأ لوحة الترحيب بمهامّها ⇒ يدخل المدير من الباب الحقيقي. وخمسة أقسام:
 *
 *   1. 🔓 المسار العام — الباقات، والرفض المهنيّ، وحدّ المعدّل.
 *   2. 🏢 التسجيل — المنشأة والمدير وطلب التفعيل المعلَّق (لا رخصةٌ ذاتية).
 *   3. 🔐 الرمز — لا يُعاد أبداً، ويُخزَّن مُجزَّأً، وله مهلةٌ ومحاولاتٌ وسقفُ إرسال.
 *   4. 🧭 لوحة الترحيب — الحالة، ومهامّ الإعداد المقيسة، وتجميد القراءة بلا رمز (404).
 *   5. 🖥️ الشاشة المعروضة — خطوات المعالج الأربع في HTML `/onboarding`، والرخصة الباقية في
 *      طابور المشغّل (لا اشتراك فعّالٌ بلا اعتماد إنسان).
 *
 * **وكيف يُقرأ الرمز؟** لا يُعاد في أي استجابة **عن قصد** (JWT-monitor أنظف من ذلك): يُقرأ
 * من جدول البريد `email_messages.body` باتصال المشغّل — وهو الطرف الوحيد الذي يجوز أن يرى ما
 * وصل إلى بريد المستخدم. ونقطةٌ في القسم الثالث تقيس هذا القصد نفسه: لا رمز في أي استجابة.
 *
 * Usage: node scripts/verify-signup.mjs
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

// `pg` يُستعار من `@erp/testing` كما في `scripts/local-db.mjs` (تبعيّة تطوير هناك لا في الجذر):
// القراءة الوحيدة خارج الـAPI، وهي قراءة **سجلّ البريد** لا قراءة حالة التسجيل — الحالة
// تُقاس من الواجهات في القسم الرابع.
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
const email = `verify.pm4.${stamp}@example.test`;
const password = `Verify-PM4-${stamp}!`;

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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return { status: response.status, data: parsed.data, meta: parsed.meta, raw: parsed };
}

const get = (path, options) => call('get', path, options);
const post = (path, body, options = {}) => call('post', path, { body, ...options });

async function page(base, path) {
  const response = await fetch(`${base}${path}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
}

async function signIn() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await call('post', '/auth/login', { body: { tenantCode: platformTenant, ...operator } });
      const token = login.data?.accessToken;
      if (!token) throw new Error('login failed');
      return token;
    } catch (error) {
      // دلو الدخول ١٠/دقيقة على نفس العنوان، وسكربتات التحقّق تُشغَّل وراء بعضها — فالانتظار
      // هنا جزءٌ من القياس لا تسامحٌ مع خطأ: نفاد الدلو ليس فشل نشر.
      if (error.status !== 429 || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    }
  }
}

/** نصّ HTML مقروء: تُشطب الوسوم كي تُقاس الكلمات لا الشيفرة. */
const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** آخر رسالة تحقّقٍ وصلت لهذا العنوان — النصّ المُصيَّر كما رآه صاحبه. */
async function mailedCode(address) {
  const connectionString = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT status, subject, body FROM email_messages
        WHERE event = 'signup.verify' AND lower(to_email) = $1
        ORDER BY created_at DESC LIMIT 1`,
      [address.toLowerCase()],
    );
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

let ticket = null;
let tenantCode = null;

try {
  // ══════════════════════════════════════════════════════ 1. 🔓 المسار العام
  console.log(`■ 1. 🔓 المسار العام — ${apiBase}/signup/plans`);
  const plans = await get('/signup/plans');
  const publicPlans = await get('/public/plans');
  check('باقات التسجيل تُقرأ بلا جلسة', plans.status === 200 && Array.isArray(plans.data));
  check('وفيها باقاتٌ معلنة', plans.data.length > 0, `${plans.data.length} باقة`);
  check(
    'وهي **نفس** قائمة صفحة الأسعار حرفاً بحرف',
    JSON.stringify(plans.data) === JSON.stringify(publicPlans.data),
    `${plans.data.length} = ${publicPlans.data.length}`,
  );
  check('ومعها نسبة الضريبة في meta', typeof plans.meta?.vatRatePercent === 'number', `${plans.meta?.vatRatePercent}%`);

  const weak = await post('/signup', { companyName: 'أ', ownerFullName: 'س', ownerEmail: 'not-an-email', ownerPassword: 'short' }, { allowFailure: true });
  check('بياناتٌ ضعيفة تُرفض 400 لا 500', weak.status === 400, String(weak.status));

  const unknownPlan = await post(
    '/signup',
    {
      companyName: 'منشأة اختبار',
      ownerFullName: 'مدير اختبار',
      ownerEmail: `verify.pm4.bad.${stamp}@example.test`,
      ownerPassword: password,
      planId: '00000000-0000-4000-8000-000000000000',
    },
    { allowFailure: true },
  );
  check('باقةٌ غير معروضة تُرفض 422', unknownPlan.status === 422, String(unknownPlan.status));
  check('ورسالة الرفض تقول سببها', typeof unknownPlan.raw.detail === 'string', String(unknownPlan.raw.detail).slice(0, 60));

  // ══════════════════════════════════════════════════════ 2. 🏢 التسجيل
  console.log('\n■ 2. 🏢 التسجيل — منشأة ومدير وطلب تفعيل');
  const chosen = plans.data[0];
  const started = await post('/signup', {
    companyName: `مؤسسة التحقّق ${stamp}`,
    ownerFullName: 'مدير التحقّق',
    ownerEmail: email,
    ownerPassword: password,
    phone: '+966500000000',
    planId: chosen.id,
    countryCode: 'SA',
    baseCurrency: 'SAR',
    timezone: 'Asia/Riyadh',
    locale: 'ar',
    acceptedTerms: true,
  });
  ticket = started.data;
  tenantCode = ticket.tenantCode;
  check('التسجيل يُنشئ المنشأة 201', started.status === 201, tenantCode);
  check('والاشتراك معلَّق لا فعّال', ticket.subscriptionStatus === 'pending', ticket.subscriptionStatus);
  check('وطلب التفعيل مُنشأ', typeof ticket.activationRequestId === 'string' && ticket.activationRequestId.length > 0);
  check('والباقة المختارة تعود ببيانها', ticket.plan?.id === chosen.id && ticket.plan?.amount === chosen.amount, `${ticket.plan?.amount} ${ticket.plan?.currency}`);
  check('ومعها فترة التجربة المعلَنة من الإعدادات', Number.isInteger(ticket.trialDays) && ticket.trialDays > 0, `${ticket.trialDays} يوماً`);
  check('ورَمز المنشأة مقروء', /^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantCode));
  check('والبريد مُخفيّ في العرض', String(ticket.verification.emailMasked).includes('…'), ticket.verification.emailMasked);
  check('والتذكرة (token) أُعطيت مرّة', typeof ticket.token === 'string' && ticket.token.length >= 32, `${ticket.token.length} حرفاً`);

  const duplicate = await post(
    '/signup',
    {
      companyName: `مؤسسة أخرى ${stamp}`,
      ownerFullName: 'مدير آخر',
      ownerEmail: email,
      ownerPassword: password,
    },
    { allowFailure: true },
  );
  check('بريدٌ يملك منشأةً يُرفض 409 برمزه', duplicate.status === 409 && duplicate.raw.code === 'SIGNUP_EMAIL_TAKEN', String(duplicate.raw.code));

  // ══════════════════════════════════════════════════════ 3. 🔐 الرمز
  console.log('\n■ 3. 🔐 الرمز — بالبريد وحده، وبمهلةٍ وسقف');
  const startedJson = JSON.stringify(ticket.verification);
  check(
    'الرمز لا يُعاد في استجابة التسجيل',
    !('code' in ticket.verification) && !('code' in started) && !/\b\d{6}\b/.test(startedJson),
    'لا رمز ولا حقل `code` في كائن التحقّق',
  );

  const operatorToken = await signIn();
  const mailLog = await get(`/platform/email/messages?search=${encodeURIComponent(email)}`, { token: operatorToken });
  const logged = (mailLog.data ?? []).find((row) => row.event === 'signup.verify');
  check('الرسالة ظاهرة في سجلّ المنصة', Boolean(logged), logged ? `${logged.status} · ${logged.subject}` : 'لا رسالة');
  check('ومُرسَلة لا معلّقة في الطابور', logged?.status === 'sent', String(logged?.status));
  check('وسجلّ المنصة لا ينشر نصّ الرسالة', logged !== undefined && !('body' in logged), Object.keys(logged ?? {}).join(','));
  const message = await mailedCode(email);
  check('والرسالة نفسها في جدول البريد بحالتها', Boolean(message), message ? String(message.status) : 'لا صفّ');
  const mailBody = String(message?.body ?? '');
  const code = mailBody.match(/\b(\d{6})\b/)?.[1];
  check('وفيها رمزٌ من ستة أرقام', /^\d{6}$/.test(code ?? ''), code ? '••••••' : 'لا رمز');
  check(
    'والقالب يحمل وقت انتهاء الصلاحية نفسه الذي يعلنه الـAPI',
    mailBody.includes(String(ticket.verification.expiresAt)) ||
      mailBody.includes(new Date(ticket.verification.expiresAt).toISOString()),
    ticket.verification.expiresAt,
  );
  check('واسم المنشأة في نصّ الرسالة', mailBody.includes(stamp), 'اسم التحقّق');

  const wrongCode = await post('/signup/verify', { email, token: ticket.token, code: code === '000000' ? '111111' : '000000' }, { allowFailure: true });
  check('رمزٌ خاطئ يُرفض 422', wrongCode.status === 422 && wrongCode.raw.code === 'SIGNUP_CODE_INVALID', String(wrongCode.status));
  check('ويُنقص محاولةً في الجواب', wrongCode.raw.errors?.[0]?.attemptsRemaining === 4, JSON.stringify(wrongCode.raw.errors));

  const wrongToken = await post('/signup/verify', { email, token: '0'.repeat(48), code: '123456' }, { allowFailure: true });
  check('وتذكرةٌ خاطئة تُرجع 404 لا 422', wrongToken.status === 404 && wrongToken.raw.code === 'SIGNUP_TOKEN_INVALID', String(wrongToken.status));

  const cooldown = await post('/signup/resend', { email, token: ticket.token }, { allowFailure: true });
  check('إعادة الإرسال قبل المهلة تُرفض 429', cooldown.status === 429 && cooldown.raw.code === 'RATE_LIMITED', String(cooldown.raw.code));
  check('ومعها الثواني المتبقية', Number(cooldown.raw.errors?.[0]?.retryAfterSeconds) > 0, `${cooldown.raw.errors?.[0]?.retryAfterSeconds}ث`);

  const statusAnon = await get(`/signup/status/${encodeURIComponent(email)}`, { allowFailure: true });
  check('والحالة بلا تذكرة 404 — فلا سردَ عناوين', statusAnon.status === 404, String(statusAnon.status));
  const statusWrong = await get(`/signup/status/${encodeURIComponent(email)}?token=${'0'.repeat(48)}`, { allowFailure: true });
  check('وبتذكرةٍ خاطئة الجواب نفسه', statusWrong.status === 404 && statusWrong.raw.detail === statusAnon.raw.detail);
  const unknownEmail = await get(`/signup/status/nobody-${stamp}%40example.test?token=${ticket.token}`, { allowFailure: true });
  check('وعنوانٌ مجهول الجواب نفسه أيضاً', unknownEmail.status === 404 && unknownEmail.raw.detail === statusAnon.raw.detail);

  const verified = await post('/signup/verify', { email, token: ticket.token, code });
  check('الرمز الصحيح يُقبل 200', verified.status === 200, verified.data?.verification?.state);
  check('والحالة تصير verified', verified.data?.verification?.state === 'verified');
  const again = await post('/signup/verify', { email, token: ticket.token, code });
  check('وإعادة الرمز نفسه لا تُفشل (idempotent)', again.status === 200 && again.data?.verification?.state === 'verified');

  // ══════════════════════════════════════════════════════ 4. 🧭 لوحة الترحيب
  console.log('\n■ 4. 🧭 لوحة الترحيب — ما تبقّى فعلاً');
  const status = await get(`/signup/status/${encodeURIComponent(email)}?token=${ticket.token}`);
  check('الحالة تُقرأ بالتذكرة', status.status === 200 && status.data.tenantCode === tenantCode);
  const tasks = status.data.setup ?? [];
  check('ومعها أربع مهامّ إعداد', tasks.length === 4, tasks.map((task) => task.key).join(', '));
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  check('ملفّ المنشأة مكتمل', byKey.get('company')?.done === true);
  check('والفرع الرئيسي جاهز بالعدد', byKey.get('branch')?.done === true, `عدد الفروع: ${byKey.get('branch')?.count}`);
  check('ودليل الحسابات جاهز بالعدد', byKey.get('chart')?.done === true, `عدد الحسابات: ${byKey.get('chart')?.count}`);
  check('وأول فاتورة لم تُصدَر بعد', byKey.get('invoice')?.done === false, `عدد الفواتير: ${byKey.get('invoice')?.count}`);
  check('والتقدّم محسوبٌ من المهامّ', status.data.progress?.done === 3 && status.data.progress?.total === 4, `${status.data.progress?.done}/${status.data.progress?.total}`);
  check('ولكل مهمّة مسارٌ فعليّ في لوحة الإدارة', tasks.every((task) => typeof task.href === 'string' && task.href.startsWith('/')), tasks.map((task) => task.href).join(' '));
  check('والتجربة والباقة تظهران في اللوحة', Number.isInteger(status.data.trialDays) && status.data.plan?.id === chosen.id);

  const login = await call('post', '/auth/login', { body: { tenantCode, email, password } });
  check('والمدير يدخل فوراً من الباب الحقيقي', login.status === 200 && typeof login.data?.accessToken === 'string');
  const accounts = await get('/accounts', { token: login.data?.accessToken });
  check('ويرى دليل حسابات منشأته', accounts.status === 200 && accounts.data.length > 0, `${accounts.data?.length} حساباً`);

  // ══════════════════════════════════════════════════════ 5. 🖥️ الشاشة المعروضة
  console.log('\n■ 5. 🖥️ الشاشة المعروضة — /onboarding');
  const onboarding = await page(siteBase, '/onboarding');
  const onboardingText = textOf(onboarding.html);
  check('صفحة المعالج تُقدَّم 200', onboarding.status === 200, String(onboarding.status));
  check('وتسمّي الخطوات الأربع', ['الباقة', 'المنشأة', 'مدير الحساب', 'التحقّق'].every((label) => onboardingText.includes(label)));
  check('والصفحة عربية RTL', onboarding.html.includes('dir="rtl"') || onboarding.html.includes('lang="ar"'));
  const withTicket = await page(siteBase, `/onboarding?email=${encodeURIComponent(email)}&token=${ticket.token}`);
  check('ورابط التذكرة يفتح الشاشة نفسها (القراءة في الخادم)', withTicket.status === 200, String(withTicket.status));

  // لوحة المنصة: الطلب في الطابور ولم تُمنح رخصة.
  const requests = await get('/platform/activation-requests?status=pending', { token: operatorToken });
  const mine = (requests.data ?? []).find((row) => row.id === ticket.activationRequestId);
  check('والطلب في طابور التفعيل بلوحة المنصة', mine?.status === 'pending', mine ? String(mine.status) : 'غير موجود');
  check('والتفصيل يقول الباقة والتجربة والعنوان', typeof mine?.notes === 'string' && mine.notes.includes(email), String(mine?.notes ?? '').slice(0, 80));
  check('ولا اشتراك فعّالٌ بعد التسجيل', status.data.subscriptionStatus === 'pending', status.data.subscriptionStatus);
  check('والمدير لا يملك دور مشغّل المنصة', login.data?.user?.isPlatformAdmin === false);
} catch (error) {
  failures += 1;
  console.error(`\n✗ توقّف التحقّق: ${error.message}`);
} finally {
  // تنظيف الأنظمة: المنشأة تبقى (حذفها يمسّ بياناتٍ مُدقَّقة)، والطلب يبقى في الطابور ليعتمده
  // المشغّل — وهذا هو المقصود: التسجيل الذاتي لا يُنشئ رخصةً تُنسى في قائمة، بل طلباً يراه إنسان.
  console.log('\nℹ️ أثر التحقّق: منشأةٌ واحدة بحالة «طلب تفعيل معلَّق»' + (tenantCode ? ` — الرمز ${tenantCode}` : ''));
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} نقطة تحقّق ناجحة`);
  process.exit(failures === 0 ? 0 : 1);
}
