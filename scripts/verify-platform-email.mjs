#!/usr/bin/env node
/**
 * Live verification of P-C6 «خدمة البريد» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §7)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed`
 * + `pnpm dev`).
 *
 * It drives the real HTTP API the two surfaces drive — nothing is mocked:
 *
 *   1. 🔐 الجلسة والأبواب — رمز المنصّة، ورمز العميل، والمجهول
 *   2. 🧩 الفهرس والبذور — ١٧ حدثاً × لغتين، كلٌّ بنصّه ووسمه
 *   3. 🧪 التصيير والاختبار — قالبٌ يُصيَّر بمتغيّراته وتُوسَم رسالته «اختبار»
 *   4. 🧱 الرفض الصريح — متغيّرٌ ناقص يمنع قبل الكتابة، ومتغيّرٌ مجهول يُرفض عند الحفظ
 *   5. 🛡️ الحجر — يمنع قبل الطابور، ويُسجَّل بسببه، ورفعُه يُعيد الإرسال
 *   6. 🧵 الطابور والسجلّ — مهمّة `email.send` في `outbox_jobs` وسجلٌّ مرشَّح
 *   7. 🎛️ الإعدادات — تُصوَّر وتُعدَّل وتُعاد، وفحص اتصال
 *   8. 🙋 سطح العميل — تجاوز النصّ، و`null` يعيد نصّ المنصة، ومنع تبديل المزوّد
 *   9. 🧹 التنظيف — الحجر والتجاوزات والإعدادات تعود، والرواسب معلَنة
 *
 * **ولا يُرسل هذا السكربت بريداً حقيقياً أبداً**: المزوّد في هذه البيئة `console`
 * (`MAIL_TRANSPORT=console`) فتطبع الرسائل في سجلّ الخادم، وكل عنوانٍ يستعمله السكربت
 * عنوانُ اختبارٍ محجوز (`*.test`). والإعدادات تُصوَّر أولاً وتُعاد في §9 — وكذلك كل حجرٍ
 * يُضاف وتجاوزٍ يُكتب.
 *
 * Re-runnable: the only rows it leaves are `email_messages` (سجلّ لا يُمحى بحكم التصميم —
 * وهو الدليل على أن الرسالة خرجت أو رُفضت) و`audit_log` (لا يُمحى أصلاً).
 *
 * Usage: node scripts/verify-platform-email.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operated = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const operator = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? '',
};
const demo = {
  tenantCode: process.env.VERIFY_TENANT ?? 'demo',
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const probe = 'verify-pc6@mail.test';
const blockedProbe = 'blocked-verify-pc6@mail.test';

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

async function raw(method, path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function request(method, path, body, token) {
  const response = await raw(method, path, body, token);
  if (response.status >= 400) {
    const problem = response.body ?? {};
    const error = new Error(
      `${method} ${path} → ${response.status} ${problem.code ?? ''} ${problem.detail ?? problem.message ?? ''}`,
    );
    error.status = response.status;
    error.code = problem.code;
    error.detail = problem.detail ?? problem.message;
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

/**
 * A call whose status is part of the answer — success or refusal. It returns the **real**
 * HTTP status (201 for a created row, 200 for an update), not a normalised one: a check
 * that says «يُقبل» must be able to say *how* it was accepted.
 */
async function attempts(method, path, body, token) {
  const response = await raw(method, path, body, token);
  const data = response.body?.data ?? response.body;
  if (response.status < 400) {
    return { status: response.status, code: 'OK', detail: '', data, problem: {} };
  }
  const problem = response.body ?? {};
  return {
    status: response.status,
    code: problem.code ?? '',
    detail: problem.detail ?? problem.message ?? '',
    data,
    problem,
  };
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

/** رسائل السجلّ كما تعيدها الـAPI: الغلاف كاملاً (كي تُقرأ المجاميع). */
const messageLog = (query, token) => raw('get', `/platform/email/messages${query}`, undefined, token);

async function main() {
  console.log('P-C6 — خدمة البريد: تحقّق حيّ على الـAPI الحقيقي (ولا بريد حقيقي)');

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الجلسة والأبواب');
  const anonymous = await attempts('get', '/platform/email/messages');
  check('المجهول يُرفض 401', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const ownerToken = await signIn(platformTenant, operator);
  check('رمز المنصّة يُصدر', Boolean(ownerToken));
  const demoToken = await signIn(demo.tenantCode, demo);
  check('رمز العميل يُصدر', Boolean(demoToken));
  const tenantOnPlatform = await attempts('get', '/platform/email/messages', undefined, demoToken);
  check(
    'جلسة عميلٍ لا تدخل طائرة المنصة',
    tenantOnPlatform.status === 403,
    `HTTP ${tenantOnPlatform.status}`,
  );
  // القوائم تُعاد بغلافها (`{data, meta}`) لا بغلافٍ مزدوج — فنُقرأ بـ`raw` كي لا يضيع الغلاف.
  const self = await raw('get', '/platform/email/templates?locale=ar', undefined, ownerToken);
  check(
    'قالب المنصّة مقروء لمالك المنصة',
    Array.isArray(self.body?.data),
    `${self.body?.data?.length ?? 0} صفاً`,
  );

  // ─────────────────────────────────────────────── 2
  section('2. 🧩 الفهرس والبذور');
  const all = await raw('get', '/platform/email/templates', undefined, ownerToken);
  check('قراءة القوالب 200', all.status === 200, `HTTP ${all.status}`);
  const rows = all.body?.data ?? [];
  check('١٧ حدثاً × لغتين = ٣٤ صفاً', rows.length === 34, `${rows.length} صفاً`);
  const events = new Set(rows.map((row) => row.event));
  check('١٧ حدثاً فريداً', events.size === 17, `${events.size} حدثاً`);
  const locales = new Set(rows.map((row) => row.locale));
  check(
    'لغتان معلنتان',
    locales.size === 2 && locales.has('ar') && locales.has('en'),
    [...locales].join(' · '),
  );
  check(
    'كل صفٍّ من قالب المنصة',
    rows.every((row) => row.source === 'platform'),
  );
  check(
    'كل صفٍّ بعنوان عربي',
    rows.every((row) => (row.labelAr ?? '').length > 0),
  );
  check(
    'كل صفٍّ بنصٍّ وموضوع',
    rows.every((row) => row.subject.length > 0 && row.body.length > 0),
  );
  check(
    'البذور تستعمل كل متغيّر معلَن (لا «متغيّرات ناقصة»)',
    rows.every((row) => row.missingVariables.length === 0),
  );
  const invite = rows.find((row) => row.event === 'user.invite' && row.locale === 'ar');
  check('حدث الدعوة موجود بعنوانه العربي', Boolean(invite), invite?.labelAr ?? '—');
  check(
    'ومتغيّراته معلَنة',
    (invite?.variables ?? []).join(',') === 'name,tenant,link',
    (invite?.variables ?? []).join(','),
  );

  // ─────────────────────────────────────────────── 3
  section('3. 🧪 التصيير والاختبار');
  const variables = { name: 'عميل التحقّق', tenant: 'منشأة التحقّق', link: 'https://verify.test/i/1' };
  const delivered = await attempts(
    'post',
    `/platform/email/templates/${invite.id}/test`,
    { to: probe, locale: 'ar', variables },
    ownerToken,
  );
  check('اختبار القالب يُقبل', delivered.status === 201, `HTTP ${delivered.status}`);
  check('والرسالة أُرسلت فعلاً', delivered.data?.status === 'sent', `الحالة ${delivered.data?.status}`);
  check('وعبر المزوّد المعلَن', delivered.data?.provider === 'console', String(delivered.data?.provider));
  check('وبوقت تسليم', Boolean(delivered.data?.deliveredAt));
  check('ولا حجر على عنوان الاختبار', delivered.data?.suppressionReason === null);
  const probeLog = await messageLog(`?search=${encodeURIComponent(probe)}&limit=50`, ownerToken);
  const probeRows = probeLog.body?.data ?? [];
  const created = probeRows.find((row) => row.id === delivered.data?.messageId);
  check('والرسالة في السجلّ', Boolean(created), created?.subject ?? '—');
  check(
    'بموضوعٍ مُصيَّر (استُبدل {{tenant}})',
    created?.subject === 'دعوة للانضمام إلى منشأة التحقّق',
    created?.subject,
  );
  check('و موسومة «اختبار»', created?.isTest === true);
  check('وموجَّهة إلى العنوان المطلوب', created?.toEmail === probe, created?.toEmail);
  check('وبمحاولةٍ واحدة ناجحة (التسليم في المسار)', created?.attempts === 1, `محاولات ${created?.attempts}`);

  // ─────────────────────────────────────────────── 4
  section('4. 🧱 الرفض الصريح');
  const beforeCount = (await messageLog('?limit=1', ownerToken)).body?.meta?.total ?? 0;
  const missing = await attempts(
    'post',
    `/platform/email/templates/${invite.id}/test`,
    { to: probe, locale: 'ar', variables: { tenant: 'منشأة التحقّق' } },
    ownerToken,
  );
  check('متغيّرٌ ناقص يُرفض 400', missing.status === 400, `HTTP ${missing.status} ${missing.code}`);
  check(
    'ورسالة الخطأ تسمّي الناقص',
    (missing.problem?.errors?.[0]?.missing ?? []).includes('link'),
    JSON.stringify(missing.problem?.errors?.[0]?.missing ?? []),
  );
  const afterCount = (await messageLog('?limit=1', ownerToken)).body?.meta?.total ?? 0;
  check('ولم تُكتب رسالةٌ في السجلّ', afterCount === beforeCount, `${beforeCount} → ${afterCount}`);

  const unknown = await attempts(
    'put',
    `/platform/email/templates/${invite.id}`,
    { subject: invite.subject, body: `${invite.body}\n{{unknown_variable}}`, reason: 'محاولة متغيّر مجهول' },
    ownerToken,
  );
  check('متغيّرٌ لا يعرفه الحدث يُرفض عند الحفظ', unknown.status === 400, `HTTP ${unknown.status}`);
  const invariant = await raw(
    'get',
    '/platform/email/templates?event=user.invite&locale=ar',
    undefined,
    ownerToken,
  );
  const invariantRow = invariant.body?.data?.[0];
  check(
    'ونسخة القالب لم تتغيّر',
    invariantRow?.version === invite.version,
    `${invite.version} → ${invariantRow?.version}`,
  );
  const noReason = await attempts(
    'put',
    `/platform/email/templates/${invite.id}`,
    { subject: invite.subject, body: invite.body },
    ownerToken,
  );
  check('وتحرير النصّ بلا سببٍ مكتوب يُرفض', noReason.status === 400, `HTTP ${noReason.status}`);

  // ─────────────────────────────────────────────── 5
  section('5. 🛡️ الحجر');
  const globalBlock = await attempts(
    'post',
    '/platform/email/suppressions',
    { email: blockedProbe, reason: 'manual', note: 'عنوان تحقّق — يُرفع في §9' },
    ownerToken,
  );
  check('حجرٌ عامّ يُضاف', globalBlock.status === 201, `HTTP ${globalBlock.status}`);
  const suppressed = await attempts(
    'post',
    `/platform/email/templates/${invite.id}/test`,
    { to: blockedProbe, locale: 'ar', variables },
    ownerToken,
  );
  check(
    'الرسالة إلى عنوانٍ محجوب لا تخرج',
    suppressed.data?.status === 'suppressed',
    String(suppressed.data?.status),
  );
  check(
    'وتُذكر السبب صراحةً',
    suppressed.data?.suppressionReason === 'manual',
    String(suppressed.data?.suppressionReason),
  );
  check('وبلا وقت تسليم', suppressed.data?.deliveredAt === null);
  const blockedLog = await messageLog(`?search=${encodeURIComponent(blockedProbe)}&limit=10`, ownerToken);
  check('وتُسجَّل «محجوبة» في السجلّ', blockedLog.body?.data?.[0]?.status === 'suppressed');
  const duplicate = await attempts(
    'post',
    '/platform/email/suppressions',
    { email: blockedProbe, reason: 'manual' },
    ownerToken,
  );
  check('وتكرار الحجر يُرفض 422', duplicate.status === 422, `HTTP ${duplicate.status}`);
  const raised = await attempts(
    'delete',
    `/platform/email/suppressions/${globalBlock.data.id}`,
    undefined,
    ownerToken,
  );
  check('ورفع الحجر يُقبل', raised.status === 200, `HTTP ${raised.status}`);
  const afterRaise = await attempts(
    'post',
    `/platform/email/templates/${invite.id}/test`,
    { to: blockedProbe, locale: 'ar', variables },
    ownerToken,
  );
  check('وبعده تخرج الرسالة', afterRaise.data?.status === 'sent', String(afterRaise.data?.status));

  // ─────────────────────────────────────────────── 6
  section('6. 🧵 الطابور والسجلّ');
  const jobs = await request('get', '/platform/jobs/outbox?limit=200', undefined, ownerToken);
  const jobRows = jobs?.items ?? [];
  const emailJobs = jobRows.filter((job) => job.type === 'email.send');
  check('مهام `email.send` موجودة في الطابور', emailJobs.length > 0, `${emailJobs.length} مهمّة`);
  check(
    'وكلها على طابور الإشعارات',
    emailJobs.every((job) => job.queue === 'notifications'),
  );
  // كان الفحص يشترط أن تكون كل مهمّة `pending` أو `published` — وهذا كان صحيحاً قبل P-C9:
  // لم يكن لأحدٍ أن يُلغي مهمّة. وبعد P-C9 صار المشغّل يملك `cancel` (وسمٌ `dead` بسببه)، فصار
  // وجود صفٍّ `dead` **حالةً مشروعة** لا خللاً. فالقياس صار: الحالات كلها معلومة، والملغاة
  // تحمل سبب من ألغاها — لا أن تُقرأ الحالات المعلومة كأنها الوحيدة الممكنة.
  check(
    'وبحالةٍ معلومة: معلَّقة أو نُفِّذت أو ملغاة من اللوحة',
    emailJobs.every((job) => ['pending', 'published', 'dead'].includes(job.status)),
    [...new Set(emailJobs.map((job) => job.status))].join(' · '),
  );
  const cancelledJobs = emailJobs.filter((job) => job.status === 'dead');
  check(
    'والملغاة تحمل سبب من ألغاها في اللوحة',
    cancelledJobs.every((job) => typeof job.lastError === 'string' && job.lastError.includes('لوحة المنصة')),
    cancelledJobs.length === 0 ? 'لا ملغاة' : `${cancelledJobs.length} ملغاة`,
  );
  check('وللرسائل الاختبارية معرّف مهمّة', Boolean(created?.id));
  const counts = probeLog.body?.counts ?? {};
  check('المرشّح بالعنوان يُعيد رسالتين', probeRows.length >= 2, `${probeRows.length} رسالة`);
  const filteredStatus = await messageLog('?status=sent&limit=5', ownerToken);
  check(
    'والترشيح بالحالة يعمل',
    (filteredStatus.body?.data ?? []).every((row) => row.status === 'sent'),
    `${filteredStatus.body?.data?.length ?? 0} رسالة`,
  );
  const eventFiltered = await messageLog('?event=user.invite&limit=5', ownerToken);
  check(
    'والترشيح بالحدث يعمل',
    (eventFiltered.body?.data ?? []).every((row) => row.event === 'user.invite'),
  );
  check(
    'والمجاميع تُطابق عدد الصفوف المرشَّحة',
    Object.values(counts).reduce((sum, value) => sum + value, 0) === probeLog.body?.meta?.total,
    `${JSON.stringify(counts)} مقابل ${probeLog.body?.meta?.total}`,
  );

  // ─────────────────────────────────────────────── 7
  section('7. 🎛️ الإعدادات');
  const settings = await request('get', '/platform/email/settings', undefined, ownerToken);
  check('الإعدادات مقروءة', settings?.provider === 'console', `المزوّد ${settings?.provider}`);
  check(
    'وباسم مُرسِلٍ وعنوان',
    (settings?.fromName ?? '').length > 0 && (settings?.fromEmail ?? '').includes('@'),
    `${settings?.fromName} <${settings?.fromEmail}>`,
  );
  check('وبلا اعتماد SMTP في هذه البيئة (لا يُخزَّن سرّ في جدول)', settings?.smtpConfigured === false);
  const snapshot = {
    provider: settings.provider,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
    replyTo: settings.replyTo,
    sendingDomain: settings.sendingDomain,
    dailyLimit: settings.dailyLimit,
    monthlyLimit: settings.monthlyLimit,
  };
  const updated = await request(
    'put',
    '/platform/email/settings',
    { fromName: 'منصة ERP — تحقّق P-C6', reason: 'تحقّق حيّ لخدمة البريد' },
    ownerToken,
  );
  check('تعديل الاسم يُقبل ويُطبَّق', updated.fromName === 'منصة ERP — تحقّق P-C6', updated.fromName);
  check('والعنوان يبقى كما هو (لا يُمسّ)', updated.fromEmail === snapshot.fromEmail, updated.fromEmail);
  const tooLong = await attempts('put', '/platform/email/settings', { monthlyLimit: 9_000_000 }, ownerToken);
  check('وسقف فوق الحدّ الأقصى يُرفض', tooLong.status === 400, `HTTP ${tooLong.status}`);
  const emptyWrite = await attempts(
    'put',
    '/platform/email/settings',
    { reason: 'لا شيء للتعديل' },
    ownerToken,
  );
  check('وكتابةٌ بلا حقلٍ قابل للتحرير تُرفض', emptyWrite.status === 400, `HTTP ${emptyWrite.status}`);
  const settingsProbe = await attempts(
    'post',
    '/platform/email/settings/test',
    { to: probe, locale: 'ar' },
    ownerToken,
  );
  check('فحص الاتصال يخرج', settingsProbe.data?.status === 'sent', String(settingsProbe.data?.status));
  const settingsLog = await messageLog(`?search=${encodeURIComponent(probe)}&limit=50`, ownerToken);
  const probeMessage = (settingsLog.body?.data ?? []).find((row) => row.id === settingsProbe.data?.messageId);
  check('ورسالته موسومة «اختبار»', probeMessage?.isTest === true);

  // ─────────────────────────────────────────────── 8
  section('8. 🙋 سطح العميل');
  const mine = await raw('get', '/email/templates?locale=ar', undefined, demoToken);
  check(
    'قوالب العميل مقروءة',
    mine.status === 200 && (mine.body?.data?.length ?? 0) > 0,
    `HTTP ${mine.status}`,
  );
  check(
    'وكلّها من نصّ المنصة في البداية',
    (mine.body?.data ?? []).every((row) => row.source === 'platform'),
  );
  // نصّ المنصة كما هو **قبل** التجاوز — وبعده يُقارَن حرفاً بحرف، لأن «نصٌّ مستقل» دعوى
  // تُقاس بالبايت لا بمجرّد كلمةٍ في السطر (قالب المنصة نفسه يذكر «وتستحق في {{due}}»).
  const platformBefore = await request(
    'get',
    '/platform/email/templates?event=invoice.created&locale=ar',
    undefined,
    ownerToken,
  );
  const platformBodyBefore = platformBefore?.[0]?.body;
  const override = await attempts(
    'put',
    '/email/templates/invoice.created?locale=ar',
    {
      body: 'فاتورة {{invoice_no}} من {{name}} بمبلغ {{amount}} — تستحق {{due}}.',
      reason: 'تحقّق P-C6: تجاوز نصّ',
    },
    demoToken,
  );
  check('تجاوز النصّ يُقبل', override.status === 200, `HTTP ${override.status}`);
  check('ويُوسَم «تجاوز العميل»', override.data?.source === 'tenant', String(override.data?.source));
  check('ويرث الموضوع من المنصة', (override.data?.subject ?? '').length > 0, override.data?.subject);
  const platformSight = await request(
    'get',
    `/platform/email/templates?event=invoice.created&locale=ar&tenantId=${override.data?.tenantId ?? ''}`,
    undefined,
    ownerToken,
  );
  check('والمنصة ترى التجاوز لصاحبٍ بعينه', platformSight?.[0]?.source === 'tenant');
  const platformAfter = await request(
    'get',
    '/platform/email/templates?event=invoice.created&locale=ar',
    undefined,
    ownerToken,
  );
  check(
    'وقالب المنصة نفسه لم يتغيّر حرفاً (تجاوزٌ مستقل)',
    platformAfter?.[0]?.body === platformBodyBefore && platformAfter?.[0]?.source === 'platform',
    `حرفه ${platformAfter?.[0]?.body?.length ?? 0} · نسخته ${platformAfter?.[0]?.version ?? '—'}`,
  );
  const reverted = await attempts(
    'put',
    '/email/templates/invoice.created?locale=ar',
    { subject: null, body: null, reason: 'العودة إلى نصّ المنصة' },
    demoToken,
  );
  check(
    'و`null` يعيد نصّ المنصة للحقلين',
    reverted.data?.source === 'platform',
    String(reverted.data?.source),
  );
  const providerChange = await attempts(
    'put',
    '/email/settings',
    { provider: 'smtp', reason: 'محاولة تبديل المزوّد' },
    demoToken,
  );
  check(
    'وتبديل المزوّد من سطح العميل مرفوض 422',
    providerChange.status === 422,
    `HTTP ${providerChange.status}`,
  );
  const tenantSettings = await request('get', '/email/settings', undefined, demoToken);
  check(
    'وهويّة المُرسِل مقروءة للعميل',
    (tenantSettings?.fromName ?? '').length > 0,
    tenantSettings?.fromName,
  );
  const tenantLog = await raw('get', '/email/messages?limit=50', undefined, demoToken);
  check('وسجلّ العميل يُقرأ', tenantLog.status === 200, `${tenantLog.body?.data?.length ?? 0} رسالة`);
  // المرجع هو **معرّف منشأة الجلسة** من `/me`، لا من أوّل صفّ قالب: مَن كتبت له إعلاناً في
  // P-C7 صارت أصفاره متغيّرة، وكان الأساس السابق يعتمد على وجود تجاوزٍ له في القوالب —
  // فقياسُ العزل يجب أن يسأل عن الهوية لا عن رصيدٍ متبقٍّ.
  const demoIdentity = await request('get', '/me', undefined, demoToken);
  const demoId = demoIdentity?.membership?.tenantId ?? null;
  const leaked = (tenantLog.body?.data ?? []).filter((row) => row.tenantId !== demoId);
  check('ولا يحمل رسالة عميلٍ آخر', leaked.length === 0, `${leaked.length} تسرّباً`);
  const unknownEvent = await attempts(
    'put',
    '/email/templates/does.not.exist',
    { body: 'نصّ', reason: 'حدث غير موجود' },
    demoToken,
  );
  check('وحدثٌ غير معروف يُرفض 404', unknownEvent.status === 404, `HTTP ${unknownEvent.status}`);

  // ─────────────────────────────────────────────── 9
  section('9. 🧹 التنظيف والحالة النهائية');
  const restored = await request(
    'put',
    '/platform/email/settings',
    {
      fromName: snapshot.fromName,
      fromEmail: snapshot.fromEmail,
      replyTo: snapshot.replyTo,
      sendingDomain: snapshot.sendingDomain,
      dailyLimit: snapshot.dailyLimit,
      monthlyLimit: snapshot.monthlyLimit,
      reason: 'إعادة الإعدادات كما كانت قبل التحقّق',
    },
    ownerToken,
  );
  check(
    'الإعدادات أُعيدت كما صُوِّرت',
    restored.fromName === snapshot.fromName && restored.fromEmail === snapshot.fromEmail,
  );
  const leftovers = await request('get', '/platform/email/suppressions', undefined, ownerToken);
  check(
    'ولا حجرَ متبقّياً من السكربت',
    !(leftovers ?? []).some((row) => row.email === probe || row.email === blockedProbe),
    `${(leftovers ?? []).length} صفاً في القائمة`,
  );
  const finalTemplates = await request('get', '/platform/email/templates', undefined, ownerToken);
  check('وقفز القوالب كما بدأ (٣٤ صفاً)', finalTemplates?.length === 34, `${finalTemplates?.length} صفاً`);
  const finalOverrides = await request(
    'get',
    `/platform/email/templates?tenantId=${override.data?.tenantId ?? ''}&locale=ar`,
    undefined,
    ownerToken,
  );
  check(
    'وبلا تجاوزٍ متبقٍّ لعميل التحقّق',
    (finalOverrides ?? []).every((row) => row.source !== 'tenant'),
  );

  console.log('\n──────────────────────────────────────────────');
  console.log(`النتيجة: ${checks - failures}/${checks} نقطة ناجحة (${failures} فشلاً)`);
  console.log('رواسب مقصودة: سجلّ الرسائل لا يُمحى (وهو دليل التسليم)، و`audit_log` لا يُمحى أصلاً، وعدّاد');
  console.log('`email_sends_per_month` لعميل التحقّق يبقى صفراً لأن رسائل السكربت كلها اختبارية.');
  console.log(`(عميل مشغّل التحقّق: ${operated} · عميل القياس: ${demo.tenantCode})`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\n✗ توقّف التحقّق:', error?.message ?? error);
  if (error?.problem) console.error(JSON.stringify(error.problem));
  process.exit(1);
});
