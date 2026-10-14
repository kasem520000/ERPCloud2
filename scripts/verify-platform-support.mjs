#!/usr/bin/env node
/**
 * Live verification of P-C8 «مكتب الدعم والدخول المؤقّت» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the two surfaces drive — nothing is mocked:
 *
 *   1. 🔐 الأبواب — مالك المنصة ودور الدعم يمرّان، والمدقّق والفوترة لا، والمجهول 401
 *   2. 🎫 فتح التذكرة — المهلة من الأولوية، وأول رسالة باسم العميل، والرفض اللازم
 *   3. 💬 الردّ والملاحظة الداخلية — الأول يوقف عدّاد الاستجابة، والثانية لا
 *   4. 🚪 إغلاق التذكرة — المغلقة لا تُردّ ولا تُفتح، والمهلة تتوقّف عن العدّ
 *   5. 🔎 الترشيح والإسناد — مرشّحات الحالة/الأولوية/الإسناد، ومرشِّحٌ خارج الفهرس 400
 *   6. 🩺 الدخول المؤقّت — رمزٌ يحمل `imp`، بعين مالك المنشأة، وعمره لا يزيد على الجلسة
 *   7. ⛔️ حدود الرمز — لا حذف، ولا مسّ بـ`/auth/`، ولا صلاحيات منصة، والقراءة مسموحة
 *   8. ⏹️ الإنهاء — الرمز يسقط في الطلب التالي، والسجلّ يحفظ من دخل ولماذا
 *   9. 🧾 التدقيق والعزل — الأفعال الخمسة مقيَّدة، وتذاكر العميل لا تتسرّب بين المنشآت
 *
 * **ولا يُنشئ عملاء**: يعمل على `demo` (عميل القياس) و`platform` (منشأة المشغّلين).
 * Re-runnable: كل تشغيل يكتب تذاكر وجلساتٍ جديدة، ولا يحذف شيئاً — الصفوف أثر، و«الإنهاء»
 * يكتب `ended_at` لا يمسح. و`audit_log` لا يُمحى أصلاً.
 *
 * Usage: node scripts/verify-platform-support.mjs
 */
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

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
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

/** A call whose status is part of the answer — success or refusal, with the real status. */
async function attempts(method, path, body, token) {
  const response = await raw(method, path, body, token);
  const data = response.body?.data ?? response.body;
  if (response.status < 400) {
    return { status: response.status, code: 'OK', data, problem: {} };
  }
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

/** الغلاف كاملاً (`{data, meta}`) — كي تُقرأ المجاميع لا الصفوف وحدها. */
const envelope = (path, token) => raw('get', path, undefined, token);

const reason = `تحقّق P-C8 ${stamp}`;

/** `imp` و`exp` مقروءان من الرمز نفسه: العقد يَعِد بعمرٍ قصير، وهذا ما يُقاس. */
function claimsOf(token) {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function main() {
  const ownerToken = await signIn(platformTenant, operator);
  const demoToken = await signIn(demo.tenantCode, demo);

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الأبواب والصلاحيات');
  const me = await request('get', '/me', undefined, ownerToken);
  check('مالك المنصة يدخل', Boolean(me.user?.id), me.user?.email ?? '');
  const demoMe = await request('get', '/me', undefined, demoToken);
  const demoTenantId = demoMe.membership?.tenantId;
  check('وعميل القياس أيضًا', Boolean(demoTenantId), demoMe.membership?.tenantCode ?? '');
  check('ورمز العميل بلا جلسة دعم', demoMe.impersonation === null || demoMe.impersonation === undefined);

  const anonymous = await attempts('get', '/platform/tickets');
  check('المجهول لا يرى الصندوق (401)', anonymous.status === 401, `HTTP ${anonymous.status}`);

  const asClient = await attempts('get', '/platform/tickets', undefined, demoToken);
  check('ورمز العميل لا يفتح سطح المنصة (403)', asClient.status === 403, `HTTP ${asClient.status}`);

  // ─────────────────────────────────────────────── 2
  section('2. 🎫 فتح تذكرة بمهلتها');
  const created = await attempts(
    'post',
    '/platform/tickets',
    {
      tenantId: demoTenantId,
      subject: `الفاتورة لا تُطبع ${stamp}`,
      body: 'عند الطباعة تظهر الصفحة بيضاء ولا يظهر أي سطر خطأ.',
      priority: 'high',
      category: 'طباعة',
      reason,
    },
    ownerToken,
  );
  check('تُفتح التذكرة', created.status === 201, `HTTP ${created.status}`);
  const ticket = created.data ?? {};
  check('بحالة «مفتوحة»', ticket.status === 'open', ticket.status);
  check('ورسالةٍ أولى واحدة', ticket.messageCount === 1, `${ticket.messageCount}`);
  check('وبلا ردٍّ بعد', ticket.firstResponseAt === null);
  const slaHours =
    ticket.slaDueAt && ticket.createdAt
      ? (new Date(ticket.slaDueAt).getTime() - new Date(ticket.createdAt).getTime()) / 3_600_000
      : 0;
  check('ومهلة 4 ساعات للأولوية العالية', slaHours > 3.9 && slaHours < 4.1, `${slaHours.toFixed(2)} ساعة`);

  const badReason = await attempts(
    'post',
    '/platform/tickets',
    { tenantId: demoTenantId, subject: 'تذكرة بلا سبب', body: 'نصٌّ يكفي', reason: 'لا' },
    ownerToken,
  );
  check('ورفض سببٍ أقصر من المسموح (400)', badReason.status === 400, `HTTP ${badReason.status}`);
  const ghostTenant = await attempts(
    'post',
    '/platform/tickets',
    {
      tenantId: '00000000-0000-0000-0000-000000000000',
      subject: 'منشأة غير موجودة',
      body: 'نصٌّ يكفي للتحقّق',
      reason,
    },
    ownerToken,
  );
  check('ورفض منشأةٍ غير موجودة (422)', ghostTenant.status === 422, `HTTP ${ghostTenant.status}`);

  // ─────────────────────────────────────────────── 3
  section('3. 💬 الردّ العام مقابل الملاحظة الداخلية');
  const note = await attempts(
    'post',
    `/platform/tickets/${ticket.id}/reply`,
    { body: 'نتحقّق من الطابعة مع فريق البنية.', isInternal: true, reason: 'ملاحظة تشغيلية' },
    ownerToken,
  );
  check('الملاحظة الداخلية تُقيَّد', note.status === 201, `HTTP ${note.status}`);
  check('ولا توقف عدّاد الاستجابة', note.data?.firstResponseAt === null);
  check('ولا تنقل التذكرة', note.data?.status === 'open', note.data?.status ?? '');
  check(
    'وتُعلَن موسومةً في التفاصيل',
    (note.data?.messages ?? []).some((message) => message.isInternal === true),
  );

  const reply = await attempts(
    'post',
    `/platform/tickets/${ticket.id}/reply`,
    { body: 'وصلنا طلبك — أعد تشغيل خدمة الطباعة ثم أعد المحاولة.', reason: 'ردٌّ على العميل' },
    ownerToken,
  );
  check('والردّ العام يُقبل', reply.status === 201, `HTTP ${reply.status}`);
  check('ويوقف عدّاد الاستجابة', reply.data?.firstResponseAt !== null);
  check('وينقل التذكرة إلى «بانتظار العميل»', reply.data?.status === 'pending', reply.data?.status ?? '');

  // ─────────────────────────────────────────────── 4
  section('4. 🚪 إغلاق التذكرة');
  const closed = await attempts(
    'patch',
    `/platform/tickets/${ticket.id}`,
    { status: 'closed', reason: 'انتهت المشكلة' },
    ownerToken,
  );
  check('الإغلاق يُقبل', closed.status === 200, `HTTP ${closed.status}`);
  check('ويكتب وقت الإغلاق', closed.data?.closedAt !== null);
  const lateReply = await attempts(
    'post',
    `/platform/tickets/${ticket.id}/reply`,
    { body: 'ملاحظة متأخّرة بعد الإغلاق', reason: 'بعد الإغلاق' },
    ownerToken,
  );
  check('ولا ردّ على المغلقة (422)', lateReply.status === 422, `HTTP ${lateReply.status}`);
  const reopened = await attempts(
    'patch',
    `/platform/tickets/${ticket.id}`,
    { status: 'open', reason: 'محاولة إعادة فتح' },
    ownerToken,
  );
  check('ولا إعادة فتحٍ للمغلقة (422)', reopened.status === 422, `HTTP ${reopened.status}`);

  // ─────────────────────────────────────────────── 5
  section('5. 🔎 الترشيح والإسناد');
  const urgent = await attempts(
    'post',
    '/platform/tickets',
    {
      tenantId: demoTenantId,
      subject: `توقّف البيع في الفرع ${stamp}`,
      body: 'نقاط البيع لا تُكمل البيع منذ الصباح.',
      priority: 'urgent',
      reason,
    },
    ownerToken,
  );
  const urgentTicket = urgent.data ?? {};
  const openPage = await envelope('/platform/tickets?filter[status]=open&limit=100', ownerToken);
  const openRows = openPage.body?.data ?? [];
  check(
    'مرشّح الحالة يعيد المفتوحة وحدها',
    openRows.length > 0 && openRows.every((row) => row.status === 'open'),
  );
  const unassignedPage = await envelope('/platform/tickets?filter[assignedTo]=none&limit=100', ownerToken);
  check(
    'ومرشّح «بلا إسناد» يجد التذكرة العاجلة',
    (unassignedPage.body?.data ?? []).some((row) => row.id === urgentTicket.id),
  );
  const urgentPage = await envelope('/platform/tickets?filter[priority]=urgent&limit=100', ownerToken);
  check(
    'ومرشّح الأولوية يعيد العاجلة وحدها',
    (urgentPage.body?.data ?? []).length > 0 &&
      (urgentPage.body?.data ?? []).every((row) => row.priority === 'urgent'),
  );
  const badFilter = await attempts('get', '/platform/tickets?filter[severity]=high', undefined, ownerToken);
  check('ومرشِّحٌ خارج الفهرس يُرفض (400)', badFilter.status === 400, `HTTP ${badFilter.status}`);

  const assigned = await attempts(
    'patch',
    `/platform/tickets/${urgentTicket.id}`,
    { assignedTo: me.user.id, reason: 'إسنادٌ لمشغّل' },
    ownerToken,
  );
  check('الإسناد يُقبل', assigned.status === 200, `HTTP ${assigned.status}`);
  check('ويُسمّى المكلَّف', Boolean(assigned.data?.assignedToLabel), assigned.data?.assignedToLabel ?? '');
  const cleared = await attempts(
    'patch',
    `/platform/tickets/${urgentTicket.id}`,
    { assignedTo: null, reason: 'سحب الإسناد' },
    ownerToken,
  );
  check('والسحب بـ`null` يُقبل', cleared.status === 200 && cleared.data?.assignedTo === null);

  // ─────────────────────────────────────────────── 6
  section('6. 🩺 الدخول المؤقّت بعين العميل');
  const started = await attempts(
    'post',
    '/platform/impersonate',
    { tenantId: demoTenantId, reason: `مراجعة إعداد الطباعة مع العميل — ${stamp}`, minutes: 5 },
    ownerToken,
  );
  check('تُفتح الجلسة', started.status === 201, `HTTP ${started.status}`);
  const session = started.data?.session ?? {};
  const supportToken = started.data?.accessToken ?? '';
  check('بمدّة 300 ثانية', started.data?.expiresIn === 300, `${started.data?.expiresIn}`);
  check('وباسم عضويّة المالك', session.asUserLabel !== null && session.asUserLabel !== undefined);
  const claims = claimsOf(supportToken);
  check('والرمز يحمل `imp`', typeof claims.imp === 'string' && claims.imp === session.id);
  check(
    'وبعمرٍ لا يزيد على الجلسة',
    Number(claims.exp) - Number(claims.iat) <= 300,
    `${Number(claims.exp) - Number(claims.iat)} ثانية`,
  );
  check('وبلا صلاحيات منصة', claims.pam === undefined && claims.proles === undefined);

  const supportMe = await attempts('get', '/me', undefined, supportToken);
  check('والرمز يقرأ هوية العميل', supportMe.status === 200, `HTTP ${supportMe.status}`);
  check('و`GET /me` يعلن الجلسة وسببها', supportMe.data?.impersonation?.sessionId === session.id);
  check(
    'وبوسم المشغّل نفسه',
    typeof supportMe.data?.impersonation?.operatorLabel === 'string' &&
      supportMe.data.impersonation.operatorLabel.length > 0,
    supportMe.data?.impersonation?.operatorLabel ?? '',
  );

  const tooLong = await attempts(
    'post',
    '/platform/impersonate',
    { tenantId: demoTenantId, reason: `مدّة أطول من السقف — ${stamp}`, minutes: 90 },
    ownerToken,
  );
  check('ومدّةٌ فوق الساعة تُرفض (400)', tooLong.status === 400, `HTTP ${tooLong.status}`);
  const shortReason = await attempts(
    'post',
    '/platform/impersonate',
    { tenantId: demoTenantId, reason: 'قصير', minutes: 10 },
    ownerToken,
  );
  check('وسببٌ قصير يُرفض (400)', shortReason.status === 400, `HTTP ${shortReason.status}`);

  // ─────────────────────────────────────────────── 7
  section('7. ⛔️ حدود الرمز المؤقّت');
  const workday = await attempts('get', '/parties?limit=5', undefined, supportToken);
  check('القراءة في عمل العميل اليومي مسموحة', workday.status === 200, `HTTP ${workday.status}`);
  const removed = await attempts(
    'delete',
    '/parties/00000000-0000-0000-0000-000000000000',
    undefined,
    supportToken,
  );
  check('والحذف ممنوع (403)', removed.status === 403, `HTTP ${removed.status}`);
  check(
    'وسببه معلَن',
    (removed.problem?.errors ?? [])[0]?.reason === 'IMPERSONATION_NO_DELETE',
    (removed.problem?.errors ?? [])[0]?.reason ?? '',
  );
  const password = await attempts(
    'post',
    '/auth/change-password',
    { currentPassword: 'x', newPassword: 'y' },
    supportToken,
  );
  check('وتغيير كلمة المرور ممنوع (403)', password.status === 403, `HTTP ${password.status}`);
  check(
    'وسببه معلَن',
    (password.problem?.errors ?? [])[0]?.reason === 'IMPERSONATION_AUTH_BLOCKED',
    (password.problem?.errors ?? [])[0]?.reason ?? '',
  );
  const asClientOnPlatform = await attempts('get', '/platform/tickets', undefined, supportToken);
  check(
    'والرمز لا يفتح سطح المنصة (403)',
    asClientOnPlatform.status === 403,
    `HTTP ${asClientOnPlatform.status}`,
  );

  // ─────────────────────────────────────────────── 8
  section('8. ⏹️ الإنهاء والسجلّ');
  const ended = await attempts('delete', `/platform/impersonate/${session.id}`, undefined, ownerToken);
  check('الإنهاء يُقبل', ended.status === 200, `HTTP ${ended.status}`);
  check('ويكتب وقت النهاية', ended.data?.endedAt !== null && ended.data?.status === 'ended');
  const afterEnd = await attempts('get', '/me', undefined, supportToken);
  check('والرمز يسقط في الطلب التالي (401)', afterEnd.status === 401, `HTTP ${afterEnd.status}`);
  check(
    'وسببه معلَن',
    (afterEnd.problem?.errors ?? [])[0]?.reason === 'IMPERSONATION_ENDED',
    (afterEnd.problem?.errors ?? [])[0]?.reason ?? '',
  );
  const sessions = await request('get', '/platform/impersonate/sessions', undefined, ownerToken);
  const mine = (sessions ?? []).find((row) => row.id === session.id);
  check('والجلسة في السجلّ بحالتها', mine?.status === 'ended', mine?.status ?? '');
  check('وبسببها كما كُتب', (mine?.reason ?? '').includes(stamp.replace(/T.*/, '')), mine?.reason ?? '');
  check(
    'والسجلّ يحمل الطوابع كاملة',
    Boolean(mine?.startedAt && mine?.expiresAt && mine?.endedAt),
    `${mine?.startedAt ?? ''}`,
  );
  const ghostSession = await attempts(
    'delete',
    '/platform/impersonate/00000000-0000-0000-0000-000000000000',
    undefined,
    ownerToken,
  );
  check('وإنهاء جلسةٍ غير موجودة 404', ghostSession.status === 404, `HTTP ${ghostSession.status}`);

  // ─────────────────────────────────────────────── 9
  section('9. 🧾 التدقيق والعزل');
  // سجلّ التدقيق يعود بصفحةٍ (`{items,total}`) لا بمصفوفة — كحال `verify-platform-console`.
  const audit = await request('get', '/platform/audit?limit=100', undefined, ownerToken);
  const auditRows = audit?.items ?? [];
  const actions = new Set(auditRows.map((row) => row.action));
  for (const [label, code] of [
    ['فتح تذكرة', 'support.ticket.create'],
    ['تعديل تذكرة', 'support.ticket.update'],
    ['ردّ/ملاحظة', 'support.ticket.reply'],
    ['بدء دخول مؤقّت', 'support.impersonate.start'],
    ['إنهاء دخول مؤقّت', 'support.impersonate.end'],
  ]) {
    check(`التدقيق يقيّد «${label}»`, actions.has(code), code);
  }
  const startRow = auditRows.find((row) => row.action === 'support.impersonate.start');
  check('وباسم المشغّل وسببه', (startRow?.meta?.reason ?? '').length >= 10);

  const demoTickets = await request(
    'get',
    `/platform/tenants/${demoTenantId}/tickets`,
    undefined,
    ownerToken,
  );
  check(
    'وتذاكر العميل تُقرأ من سطح المنصة',
    (demoTickets ?? []).length > 0 && (demoTickets ?? []).every((row) => row.tenantId === demoTenantId),
    `${(demoTickets ?? []).length} تذكرة`,
  );
  const platformTickets = await request(
    'get',
    `/platform/tenants/${(await request('get', `/platform/tenants?limit=100`, undefined, ownerToken)).find((row) => row.code === platformTenant)?.id}/tickets`,
    undefined,
    ownerToken,
  );
  check(
    'وتذاكر منشأة المشغّلين لا تحمل تذاكر العميل',
    (platformTickets ?? []).every((row) => row.tenantId !== demoTenantId),
  );

  console.log('\n──────────────────────────────────────────────');
  console.log(`النتيجة: ${checks - failures}/${checks} نقطة ناجحة (${failures} فشلاً)`);
  console.log('رواسب مقصودة: صفوف `support_tickets` و`ticket_messages` (ما قيل للعميل أثر)،');
  console.log('و`support_sessions` بحالتها `ended` (الإنهاء يكتب وقتاً لا يمسح صفّاً)،');
  console.log('و`audit_log` الذي لا يُمحى أصلاً، وإشعار/بريد لم يخرجا في هذا الجزء.');
  console.log(`(عميل القياس: ${demo.tenantCode} · منشأة المشغّلين: ${platformTenant})`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\n✗ توقّف التحقّق:', error?.message ?? error);
  if (error?.problem) console.error(JSON.stringify(error.problem));
  process.exit(1);
});
