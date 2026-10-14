#!/usr/bin/env node
/**
 * Live verification of P-C7 «الإعلانات والإشعارات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed`
 * + `pnpm dev`).
 *
 * It drives the real HTTP API the two surfaces drive — nothing is mocked:
 *
 *   1. 🔐 الجلسة والأبواب — رمز المنصّة، ورمز العميل، والمجهول
 *   2. ✍️ الكتابة والاستهداف — نصّان إلزاميان، واستهدافٌ متماسك (باقة/حالة/الجميع)
 *   3. 🗓️ الجدولة — ماضٍ يُرفض، ومستقبلي يصير «مجدولة» ومعه مهمّةٌ في الطابور
 *   4. 📣 النشر — توزيعٌ فعليّ على عملاء حقيقيين، ثم متابعة إشعار العميل بعينه
 *   5. 📈 القراءات — وسمُ القراءة من صندوق العميل يرفع عدّاد المشغّل
 *   6. 🧊 التجميد والإعادة — المنشور لا يُعدَّل، وإعادة النشر لا تُضاعف
 *   7. 🧹 التنظيف والرواسب — ما يُعرف أنه يبقى، ويُعلَن
 *
 * **ولا يُرسل هذا السكربت بريداً حقيقياً في هذه البيئة**: المزوّد `console`
 * (`MAIL_TRANSPORT=console`) فتطبع الرسائل في سجلّ الخادم. ولا يُنشئ عملاء: يستهدف
 * `demo` وحدها (بحالة اشتراكها)، ثم يعدّ على إعلانه هو لا على إعلانات غيره.
 *
 * Re-runnable: each run writes new `announcements` rows (there is no delete: ما قيل للناس
 * لا يُمحى) و`announcement_reads` و`notifications` — وهي رسائل واصلة بحق، و`audit_log`
 * لا يُمحى أصلاً. ولا يُعدَّل صفٌّ قديم ولا يُحذف.
 *
 * Usage: node scripts/verify-platform-announcements.mjs
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

const draft = (overrides = {}) => ({
  titleAr: `تحقّق الإعلانات ${stamp}`,
  titleEn: `Announcements verification ${stamp}`,
  bodyAr: 'رسالةُ تحقّقٍ آليّ من سكربت P-C7: تُثبت أن الإعلان يصل إلى التطبيق والبريد.',
  bodyEn: 'Automated P-C7 verification message: proves the announcement reaches app and e-mail.',
  reason: 'تحقّق P-C7 حيّ',
  ...overrides,
});

const platform = '/platform/announcements';

async function main() {
  console.log('P-C7 — الإعلانات والإشعارات: تحقّق حيّ على الـAPI الحقيقي');

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الجلسة والأبواب');
  const anonymous = await attempts('get', `${platform}?limit=5`);
  check('المجهول يُرفض 401', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const ownerToken = await signIn(platformTenant, operator);
  check('رمز المنصّة يُصدر', Boolean(ownerToken));
  const demoToken = await signIn(demo.tenantCode, demo);
  check('رمز العميل يُصدر', Boolean(demoToken));
  const tenantOnPlatform = await attempts('get', `${platform}?limit=5`, undefined, demoToken);
  check(
    'جلسة عميلٍ لا تدخل طائرة المنصة',
    tenantOnPlatform.status === 403,
    `HTTP ${tenantOnPlatform.status}`,
  );
  const list = await envelope(`${platform}?limit=50`, ownerToken);
  check('قائمة الإعلانات تُقرأ 200', list.status === 200, `HTTP ${list.status}`);
  check(
    'بعددٍ كلّي في الغلاف',
    typeof list.body?.meta?.total === 'number',
    `total=${list.body?.meta?.total}`,
  );
  const channels = await envelope('/notifications?limit=5', demoToken);
  check('وصندوق العميل يُقرأ 200', channels.status === 200, `HTTP ${channels.status}`);
  check(
    'ويعرض عدد غير المقروء في الغلاف',
    typeof channels.body?.meta?.unread === 'number',
    `unread=${channels.body?.meta?.unread}`,
  );

  // ─────────────────────────────────────────────── 2
  section('2. ✍️ الكتابة والاستهداف');
  const halfText = await attempts(
    'post',
    platform,
    { titleAr: 'عنوانٌ عربي فقط', bodyAr: 'نصٌّ عربي بلا مقابلٍ إنجليزي.', reason: 'تحقّق P-C7' },
    ownerToken,
  );
  check('نصّ بلغةٍ واحدة يُرفض 400', halfText.status === 400, `HTTP ${halfText.status} ${halfText.code}`);
  const planless = await attempts('post', platform, draft({ audience: 'plan', planCode: null }), ownerToken);
  check('استهداف الباقة بلا كود يُرفض 400', planless.status === 400, `HTTP ${planless.status}`);
  const mixed = await attempts('post', platform, draft({ audience: 'all', planCode: 'growth' }), ownerToken);
  check('«الجميع» مع باقةٍ يُرفض 400', mixed.status === 400, `HTTP ${mixed.status}`);
  const unknownPlan = await attempts(
    'post',
    platform,
    draft({ audience: 'plan', planCode: 'no-such-plan' }),
    ownerToken,
  );
  check('باقةٌ مجهولة تُرفض 422', unknownPlan.status === 422, `HTTP ${unknownPlan.status}`);
  check(
    'والخطأ يسمّي الحقل',
    unknownPlan.problem?.errors?.[0]?.field === 'planCode',
    String(unknownPlan.problem?.errors?.[0]?.field),
  );
  const created = await attempts('post', platform, draft(), ownerToken);
  check('مسودّةٌ بنصّين تُقبل 201', created.status === 201, `HTTP ${created.status}`);
  check('وحالتها «مسودّة»', created.data?.status === 'draft', String(created.data?.status));
  check('وبلا وقت نشر', created.data?.publishedAt === null);
  check(
    'وبلا توزيع بعد',
    created.data?.stats?.tenants === 0 && created.data?.stats?.inApp === 0,
    JSON.stringify(created.data?.stats),
  );
  const draftId = created.data?.id;

  // ─────────────────────────────────────────────── 3
  section('3. 🗓️ الجدولة');
  const past = await attempts(
    'post',
    platform,
    draft({ publishAt: new Date(Date.now() - 60_000).toISOString() }),
    ownerToken,
  );
  check('جدولةٌ في الماضي تُرفض 422', past.status === 422, `HTTP ${past.status}`);
  const when = new Date(Date.now() + 3_600_000);
  const scheduled = await attempts('post', platform, draft({ publishAt: when.toISOString() }), ownerToken);
  check('جدولةٌ مستقبلية تُقبل', scheduled.status === 201, `HTTP ${scheduled.status}`);
  check('وحالتها «مجدولة»', scheduled.data?.status === 'scheduled', String(scheduled.data?.status));
  // `/platform/jobs/outbox` يعيد `{ data: { items, total, … } }` — فالصفوف في `items`.
  const jobs = await envelope('/platform/jobs/outbox?limit=50', ownerToken);
  const jobRows = jobs.body?.data?.items ?? jobs.body?.items ?? [];
  // الطابور في اللوحة يعرض المهمّة بلا حمولتها (قراءةٌ إشرافية)، فيُطابق الموعد لا المعرّف:
  // مهمّةُ النشر المجدولة هي الوحيدة بموعدٍ يساوي ما طلبناه تماماً.
  const scheduledJob = jobRows.find(
    (row) => row.type === 'announcement.publish' && new Date(row.runAt).getTime() === when.getTime(),
  );
  check('ولها مهمّةٌ في `outbox_jobs`', Boolean(scheduledJob), scheduledJob?.status ?? '—');
  check(
    'بوقتها المعطى بالضبط',
    scheduledJob ? new Date(scheduledJob.runAt).getTime() === when.getTime() : false,
    scheduledJob?.runAt ?? '—',
  );
  const unscheduled = await attempts(
    'patch',
    `${platform}/${scheduled.data?.id}`,
    { publishAt: null, reason: 'إلغاء الجدولة في التحقّق' },
    ownerToken,
  );
  check(
    'وإلغاء الجدولة يعيدها 200 مسودّة',
    unscheduled.status === 200 && unscheduled.data?.status === 'draft',
    `HTTP ${unscheduled.status} ${unscheduled.data?.status}`,
  );

  // ─────────────────────────────────────────────── 4
  section('4. 📣 النشر والتوزيع');
  const inboxBefore = await envelope('/notifications?limit=50', demoToken);
  const beforeCount = (inboxBefore.body?.data ?? []).filter((row) => row.type === 'announcement').length;
  const audienceAnnouncement = await attempts(
    'post',
    platform,
    draft({ titleAr: `إلى demo وحدها ${stamp}`, audience: 'status', tenantStatus: 'active' }),
    ownerToken,
  );
  const targetId = audienceAnnouncement.data?.id;
  const published = await attempts(
    'post',
    `${platform}/${targetId}/publish`,
    { reason: 'نشرٌ من التحقّق الحيّ' },
    ownerToken,
  );
  check('النشر يُقبل 201', published.status === 201, `HTTP ${published.status}`);
  check('وحالتها «منشورة»', published.data?.status === 'published', String(published.data?.status));
  check('وبوقت نشرٍ مسجَّل', Boolean(published.data?.publishedAt));
  check(
    'ووُزّعت على عملاء فعلاً',
    (published.data?.stats?.tenants ?? 0) >= 1 && (published.data?.stats?.inApp ?? 0) >= 1,
    JSON.stringify(published.data?.stats),
  );
  const inboxAfter = await envelope('/notifications?limit=50', demoToken);
  const payloadRow = (inboxAfter.body?.data ?? []).find(
    (row) => row.type === 'announcement' && row.payload?.announcementId === targetId,
  );
  check('ووصل إشعار العميل نفسه', Boolean(payloadRow), payloadRow?.id ?? '—');
  check(
    'وعنوانه نصّ الإعلان بلغته',
    payloadRow?.payload?.titleAr?.startsWith('إلى demo وحدها'),
    String(payloadRow?.payload?.titleAr ?? '—'),
  );
  const afterCount = (inboxAfter.body?.data ?? []).filter((row) => row.type === 'announcement').length;
  check('وزاد عدد إعلانات العميل واحداً', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`);
  check(
    'وغير المقروء يزيد معه',
    (inboxAfter.body?.meta?.unread ?? 0) > (inboxBefore.body?.meta?.unread ?? 0),
    `${inboxBefore.body?.meta?.unread} → ${inboxAfter.body?.meta?.unread}`,
  );

  // ─────────────────────────────────────────────── 5
  section('5. 📈 القراءات');
  const readsBefore = await envelope(`${platform}/${targetId}/reads?limit=100`, ownerToken);
  const demoRowBefore = (readsBefore.body?.data ?? []).find((row) => row.tenantCode === demo.tenantCode);
  check('متابعة القراءات تُقرأ 200', readsBefore.status === 200, `HTTP ${readsBefore.status}`);
  check('وفيها صفّ عميل القياس', Boolean(demoRowBefore), demoRowBefore?.tenantName ?? '—');
  check('بعدد إشعاراته', (demoRowBefore?.inApp ?? 0) >= 1, `inApp=${demoRowBefore?.inApp}`);
  check('وبلا قراءةٍ بعد', demoRowBefore?.reads === 0, `reads=${demoRowBefore?.reads}`);
  const marked = await attempts('post', `/notifications/${payloadRow?.id}/read`, undefined, demoToken);
  check('وسم القراءة من صندوق العميل يُقبل', marked.status < 400, `HTTP ${marked.status}`);
  const readsAfter = await envelope(`${platform}/${targetId}/reads?limit=100`, ownerToken);
  const demoRowAfter = (readsAfter.body?.data ?? []).find((row) => row.tenantCode === demo.tenantCode);
  check('والعدّاد يرتفع إلى ١', demoRowAfter?.reads === 1, `reads=${demoRowAfter?.reads}`);
  check('وبوقت آخر قراءة', Boolean(demoRowAfter?.lastReadAt), String(demoRowAfter?.lastReadAt));
  const reread = await attempts('post', `/notifications/${payloadRow?.id}/read`, undefined, demoToken);
  const readsIdempotent = await envelope(`${platform}/${targetId}/reads?limit=100`, ownerToken);
  const demoRowFinal = (readsIdempotent.body?.data ?? []).find((row) => row.tenantCode === demo.tenantCode);
  check(
    'وإعادة الوسم لا تُضاعف العدّاد',
    reread.status < 400 && demoRowFinal?.reads === 1,
    `reads=${demoRowFinal?.reads}`,
  );

  // ─────────────────────────────────────────────── 6
  section('6. 🧊 التجميد والإعادة');
  const frozen = await attempts(
    'patch',
    `${platform}/${targetId}`,
    { titleAr: 'محاولة تعديل ما قيل', reason: 'تحقّق P-C7' },
    ownerToken,
  );
  check('المنشور لا يُعدَّل 422', frozen.status === 422, `HTTP ${frozen.status}`);
  const stats = published.data?.stats ?? {};
  const replay = await attempts(
    'post',
    `${platform}/${targetId}/publish`,
    { reason: 'إعادة نشرٍ من التحقّق' },
    ownerToken,
  );
  check('إعادة النشر تُقبل (idempotent)', replay.status === 201, `HTTP ${replay.status}`);
  check(
    'ولا تُضاعف الإشعارات',
    (replay.data?.stats?.inApp ?? 0) === (stats.inApp ?? 0),
    `${stats.inApp} → ${replay.data?.stats?.inApp}`,
  );
  const inboxReplay = await envelope('/notifications?limit=100', demoToken);
  const replayRows = (inboxReplay.body?.data ?? []).filter(
    (row) => row.type === 'announcement' && row.payload?.announcementId === targetId,
  );
  check('ولا تُنشئ إشعاراً ثانياً للعميل', replayRows.length === 1, `${replayRows.length} إشعاراً`);
  const draftPublished = await attempts(
    'post',
    `${platform}/${draftId}/publish`,
    { reason: 'نشر المسودّة الأولى من التحقّق' },
    ownerToken,
  );
  check('والمسودّة الأولى تُنشر بنداءٍ واحد', draftPublished.status === 201, `HTTP ${draftPublished.status}`);

  // ─────────────────────────────────────────────── 7
  section('7. 🧹 التنظيف والرواسب');
  const final = await envelope(`${platform}?limit=100`, ownerToken);
  const rows = final.body?.data ?? [];
  check(
    'كل إعلانات التحقّق ظاهرة في القائمة',
    rows.some((row) => row.id === targetId) && rows.some((row) => row.id === draftId),
  );
  check(
    'وكل منشورٍ منها بمصدرٍ مكتوب',
    rows.filter((row) => row.status === 'published').every((row) => (row.createdByLabel ?? '') !== null),
  );
  const noSelf = rows.find((row) => row.audience === 'status' && row.tenantStatus === 'active');
  check('واستهداف الحالة لا يشمل منشأة المشغّلين', Boolean(noSelf));

  console.log('\n──────────────────────────────────────────────');
  console.log(`النتيجة: ${checks - failures}/${checks} نقطة ناجحة (${failures} فشلاً)`);
  console.log('رواسب مقصودة: صفوف `announcements` (ما قيل للناس لا يُمحى — ولا نقطة حذف في العقد)،');
  console.log('و`announcement_reads` (دفتر التوزيع والقراءة)، و`notifications` الواصلة إلى عميل القياس،');
  console.log('و`outbox_jobs` المهمّة الملغاة، و`audit_log` الذي لا يُمحى أصلاً.');
  console.log('ولا بريد حقيقي: المزوّد `console` فطُبعت الرسائل في سجلّ الخادم.');
  console.log(`(عميل القياس: ${demo.tenantCode} · منشأة المشغّلين: ${platformTenant})`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\n✗ توقّف التحقّق:', error?.message ?? error);
  if (error?.problem) console.error(JSON.stringify(error.problem));
  process.exit(1);
});
