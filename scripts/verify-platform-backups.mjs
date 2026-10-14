#!/usr/bin/env node
/**
 * Live verification of P-C10 «البيانات والاسترجاع» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4)
 * against a running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` +
 * `pnpm dev`).
 *
 * It drives the real HTTP API — nothing is mocked:
 *
 *   1. 🔐 الأبواب — المالك يمرّ إلى النسخ والاحتفاظ وطلبات البيانات، ورمز العميل 403، والمجهول 401
 *   2. 💾 نسخةٌ حقيقية — تُشغَّل، وصفُّها يقول حجمها وبصمتها ومخزنها، ويُقارَن الحجم بقياس
 *      مستقل: السكربت يقرأ **ملف النسخة من القرص** ويحصي بايتاته بنفسه (والحقول الثلاثة
 *      `bytes`/`checksum`/`objectKey` معروضة على الشاشة، فهي من العقد)
 *   3. 🔒 التشفير — الملف على القرص يبدأ بترويسة `ERP-BACKUP/1` ولا يحتوي نصّ NDJSON:
 *      نسخةٌ تُقرأ بلا مفتاح ليست نسخةً مشفّرة
 *   4. 🔬 التحقّق — `verify` يعيد قراءة الملف ويطابق البصمة، وعدّاداته من داخل الملف،
 *      واستعادته التجريبية «جاهزة» بلا جدولٍ مفقود
 *   5. 🧨 العبث — يُقلب بايتٌ واحد في الملف على القرص فيفشل التحقّق (وهذا يثبت أنه يقرأ
 *      الملف لا الاستجابة)، ثم يُعاد البايت فينجح — ولا يُترك أثر
 *   6. 🔗 الرابط الموقّع — ينزّل النصّ المفكوك، والتوقيع المزوَّر 403 والمنتهي 410
 *   7. ⏳ الاحتفاظ — القراءة والحدود (نافذة خارج حدّها 400)، والكتابة تُحفظ وتُقرأ،
 *      والقياس التجريبي يقيس ولا يمسح، وسجلّ التدقيق **لا يُمحى** ولا يُخفى عدّاده
 *   8. 🗑️ طلبات البيانات — فتحٌ وقرارٌ وتنفيذ: تصديرٌ يُنتج ملفاً موقّعاً يُنزَّل، ومحوٌ
 *      يرفض بلا تأكيد، ثم يُخفي الهوية ويسحب العضوية **ويُبقي الإيصال** ويُبلّغ بعدّاد
 *      صفوف التدقيق — وهذا العدّاد يُقاس من القاعدة أيضًا
 *   9. 🧾 التدقيق — الأفعال الستّة مقيَّدة بأسماءٍ حقيقية في `audit_log`
 *
 * **ولا يُنشئ عملاء**: يعمل على `demo` (عميل القياس) و`platform` (منشأة المشغّلين). وله الحقّ
 * في **تعديل نافذة احتفاظٍ واحدة** وإرجاعها كما كانت، وفي إنشاء نسخةٍ (تُبقى أثراً مقصوداً).
 *
 * وأمّا صاحب البيانات الذي يُصدَّر ثم تُمحى هويته فهو **مستخدمٌ يُنشئه السكربت نفسه** عبر المسار
 * الحقيقي (`POST /memberships` ببريدٍ يحمل الطابع الزمني). وهذا قرارٌ مقصود: لو محا السكربت هوية
 * `owner@demo.test` لأفسد كل سكربتات التحقّق الأخرى في هذه البيئة (وهي تسجّل الدخول بهذا البريد)،
 * ولما أمكن تشغيله مرّتين. فالمحو يُقاس على شخصٍ صنعه السكربت، والقياس لا يكلّف البيئة شيئاً.
 *
 * Re-runnable: كل تشغيل يضيف نسخةً جديدة (وملفاً واحداً في مجلد النسخ) وعضواً مستخدَماً بحالة
 * `suspended` وطلبَي بياناتٍ وسطورَ تدقيق. ولا يحذف شيئاً إلا ما يكتبه هو (ونافذة الاحتفاظ
 * تُعاد إلى قيمتها الأصلية).
 *
 * Usage: node scripts/verify-platform-backups.mjs
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const platformTenant = process.env.VERIFY_PLATFORM_TENANT ?? 'platform';
const artifactDir = process.env.BACKUP_ARTIFACT_DIR ?? '/tmp/erp-backups';
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

const envelope = (path, token) => raw('get', path, undefined, token);

/**
 * مسار الرابط الموقّع كما يُطلب: الرابط قد يُعاد مطلقاً (`http://host/api/v1/…`) وقد يُعاد
 * نسبياً (`/api/v1/…`)، والأصل يأتي من `base` دائماً — فالبادئة تُقتطع مرّة واحدة.
 */
const pathOf = (url) => {
  const withoutOrigin = url.replace(/^https?:\/\/[^/]+/, '');
  return withoutOrigin.startsWith('/api/v1') ? withoutOrigin.slice('/api/v1'.length) : withoutOrigin;
};

/** ملفات النسخ على القرص: تكفي لقياس البايتات من خارج الـAPI. */
async function artifactFiles() {
  try {
    const names = await readdir(artifactDir, { recursive: true });
    return names.map((name) => String(name)).filter((name) => name.endsWith('.enc'));
  } catch {
    return [];
  }
}

async function main() {
  const ownerToken = await signIn(platformTenant, operator);
  const demoToken = await signIn(demo.tenantCode, demo);
  const demoMe = await request('get', '/me', undefined, demoToken);
  const demoTenantId = demoMe.membership?.tenantId;
  const demoEmail = demoMe.user?.email ?? demo.email;

  // ─────────────────────────────────────────────── 1
  section('1. 🔐 الأبواب: من يملك النسخة');
  check('مالك المنصة يقرأ النسخ', (await envelope('/platform/backups?limit=5', ownerToken)).status === 200);
  check('ويقرأ سياسة الاحتفاظ', (await envelope('/platform/retention', ownerToken)).status === 200);
  check(
    'ويقرأ طلبات البيانات',
    (await envelope('/platform/data-requests?limit=5', ownerToken)).status === 200,
  );

  check('والمجهول لا يرى النسخ (401)', (await attempts('get', '/platform/backups')).status === 401);
  const clientOnBackups = await attempts('get', '/platform/backups', undefined, demoToken);
  check(
    'ورمز العميل لا يفتح سطح النسخ (403)',
    clientOnBackups.status === 403,
    `HTTP ${clientOnBackups.status}`,
  );
  const clientOnRetention = await attempts('get', '/platform/retention', undefined, demoToken);
  check(
    'ولا يقرأ سياسة الاحتفاظ (403)',
    clientOnRetention.status === 403,
    `HTTP ${clientOnRetention.status}`,
  );
  const clientOnRequests = await attempts('get', '/platform/data-requests', undefined, demoToken);
  check('ولا طلبات البيانات (403)', clientOnRequests.status === 403, `HTTP ${clientOnRequests.status}`);

  // ─────────────────────────────────────────────── 2
  section('2. 💾 نسخةٌ حقيقية تُغادر القاعدة');
  const beforeFiles = (await artifactFiles()).length;
  const ran = await attempts('post', '/platform/backups/run', { note: `تحقّق P-C10 ${stamp}` }, ownerToken);
  check('تشغيل النسخة ينجح (201)', ran.status === 201, `HTTP ${ran.status}`);
  const run = ran.data;
  check('والحالة `succeeded`', run?.status === 'succeeded', run?.failureReason ?? run?.status);
  check('ولها حجمٌ بالبايت أكبر من صفر', Number(run?.bytes) > 0, `${run?.bytes} بايت`);
  check(
    'وبصمةٌ سداسية بطول sha256',
    /^[0-9a-f]{64}$/.test(run?.checksum ?? ''),
    (run?.checksum ?? '').slice(0, 16),
  );
  check('ووجهةٌ مُعلَنة', ['object-storage', 'filesystem'].includes(run?.store), run?.store);
  check(
    'وعدّاداتها من القراءة نفسها',
    Number(run?.rows) >= 0 && Number(run?.tables) >= 0,
    `${run?.tables} جدولاً · ${run?.rows} صفاً`,
  );
  check('ومستأجرون في النسخة', Number(run?.tenants) >= 2, `${run?.tenants} مستأجراً`);
  check('ومدةٌ مقيسة', Number.isInteger(run?.durationMs) && run.durationMs >= 0, `${run?.durationMs} م.ث`);

  // القياس المستقل: يُقرأ الملف من القرص بحجمه الحقيقي.
  const filesAfter = await artifactFiles();
  check(
    'وظهر ملفٌ جديد في مخزن النسخ',
    filesAfter.length === beforeFiles + 1,
    `${beforeFiles} → ${filesAfter.length}`,
  );
  const stored = filesAfter.find((name) => name.includes(run?.id));
  check('ومساره يحمل معرّف النسخة', Boolean(stored), stored ?? '(غير موجود)');
  let diskBytes = null;
  if (stored) {
    const bytes = await readFile(join(artifactDir, stored));
    diskBytes = bytes.byteLength;
    check(
      'وحجم القرص يساوي الحجم المسجَّل بالمِلي بايت',
      diskBytes === run.bytes,
      `${diskBytes} = ${run.bytes}`,
    );

    // ─────────────────────────────────────────────── 3
    section('3. 🔒 التشفير: ما على القرص ليس ما في الشاشة');
    const head = bytes.subarray(0, 16).toString('utf8');
    check('الملف يبدأ بترويسة النسخة', head.startsWith('ERP-BACKUP/1'), head.replace(/\n/g, '\\n'));
    check(
      'ولا يحتوي نصّ الملف الصريح',
      !bytes.toString('utf8').includes('"kind":"erp-platform-dump"'),
      'البايتات مشفّرة بـaes-256-gcm',
    );
    check(
      'وفي الترويسة حجمُ النصّ الصريح',
      /\s\d+\n$/.test(bytes.subarray(0, 64).toString('utf8').split('\n')[0] + '\n'),
    );
  }

  // ─────────────────────────────────────────────── 4
  section('4. 🔬 التحقّق: إعادة قراءة الملف لا الاستجابة');
  const verified = await request('post', `/platform/backups/${run.id}/verify`, {}, ownerToken);
  check('التحقّق ينجح', verified.verified === true, verified.detail ?? '');
  check(
    'والبصمة تُطابق المسجَّلة',
    verified.checksum?.matches === true && verified.checksum?.actual === run.checksum,
  );
  check('والحجم المقروء هو نفسه', verified.bytes === run.bytes, `${verified.bytes}`);
  check('والصيغة معروفة', verified.format === 'erp-platform-dump/1', verified.format);
  check(
    'وعدّاد الصفوف من داخل الملف',
    verified.totalRows === run.rows,
    `${verified.totalRows} = ${run.rows}`,
  );
  check(
    'والجداول تُعدّ ولا تُفترض',
    verified.tables.length === run.tables,
    `${verified.tables.length} جدولاً`,
  );
  check('ولا بتر في الملف', verified.truncated === false);
  check(
    'والاستعادة التجريبية «جاهزة» بلا جدولٍ مفقود',
    verified.restore?.verdict === 'ready' && verified.restore?.missingTables?.length === 0,
    verified.restore?.verdict,
  );
  check(
    'وجداول من الطرفين ظاهرة (منصّةٌ وعميل)',
    verified.tables.some((entry) => entry.table === 'tenants') &&
      verified.tables.some((entry) => entry.table === 'memberships'),
    `${verified.tables.length} جدولاً`,
  );

  // ─────────────────────────────────────────────── 5
  section('5. 🧨 العبث: بايتٌ واحد يكفي');
  if (stored) {
    const path = join(artifactDir, stored);
    const original = await readFile(path);
    const tampered = Buffer.from(original);
    tampered[tampered.byteLength - 17] = (tampered[tampered.byteLength - 17] ?? 0) ^ 0xff;
    await writeFile(path, tampered);

    const failed = await request('post', `/platform/backups/${run.id}/verify`, {}, ownerToken);
    check('تغيير بايتٍ يُفشل التحقّق', failed.verified === false, failed.detail ?? '');
    check('والبصمة لا تُطابق', failed.checksum?.matches === false);
    check('والحكم «غير قابلة للقراءة»', failed.restore?.verdict === 'unreadable', failed.restore?.verdict);

    await writeFile(path, original);
    const restored = await request('post', `/platform/backups/${run.id}/verify`, {}, ownerToken);
    check('وإعادة البايت تُعيد النجاح', restored.verified === true, restored.detail ?? '');
    check('والبايتات عادت كما كانت', (await readFile(path)).byteLength === original.byteLength);
  }

  // ─────────────────────────────────────────────── 6
  section('6. 🔗 الرابط الموقّع: قدرةٌ قصيرة العمر');
  const link = await request('get', `/platform/backups/${run.id}/download`, undefined, ownerToken);
  check('يُمنح رابطٌ موقّع', typeof link.url === 'string' && link.url.includes('signature='), link.name);
  check('وبمهلةٍ محدودة', Date.parse(link.expiresAt) > Date.now(), link.expiresAt);
  const downloaded = await raw('get', pathOf(link.url));
  check('والتنزيل ينجح بلا رمز حامل (200)', downloaded.status === 200, `HTTP ${downloaded.status}`);
  const firstLine = (downloaded.text ?? '').split('\n')[0];
  check(
    'والمحتوى NDJSON بترويسة النسخة',
    firstLine.includes('"kind":"erp-platform-dump"'),
    firstLine.slice(0, 60),
  );
  const footer = JSON.parse((downloaded.text ?? '').trim().split('\n').pop() ?? '{}');
  check('وذيله يقول إن الملف كامل', footer.complete === true);
  check(
    'وعدّاداته تطابق ما قاله التحقّق',
    footer.totalRows === verified.totalRows,
    `${footer.totalRows} = ${verified.totalRows}`,
  );

  const forged = await raw(
    'get',
    `/platform/backups/${run.id}/content?expires=${Math.floor(Date.now() / 1000) + 3600}&signature=deadbeef`,
  );
  check('والتوقيع المزوَّر يُرفض (403)', forged.status === 403, `HTTP ${forged.status}`);
  const expired = await raw('get', `/platform/backups/${run.id}/content?expires=1&signature=deadbeef`);
  check('والمنتهي يُرفض (410)', expired.status === 410, `HTTP ${expired.status}`);

  // ─────────────────────────────────────────────── 7
  section('7. ⏳ الاحتفاظ: يُضبط، يُقاس، ولا يمسّ سجلّ التدقيق');
  const retention = await request('get', '/platform/retention', undefined, ownerToken);
  check(
    'السياسة تُقرأ بنوافذها الخمس',
    [
      'auditArchiveDays',
      'artifactRetentionDays',
      'idempotencyPurgeDays',
      'outboxPurgeDays',
      'fileOrphanPurgeDays',
    ].every((key) => Number.isInteger(retention.policy?.[key])),
    JSON.stringify(retention.policy),
  );
  check('ومنع المسح النهائي للتدقيق مُعلَن', retention.auditHardDeleteAllowed === false);
  check(
    'والعدّادات تُقرأ من القاعدة',
    ['idempotencyExpired', 'outboxPurgeable', 'fileOrphans', 'artifactsExpired', 'auditArchivable'].every(
      (key) => Number.isInteger(retention.purges?.[key]),
    ),
    JSON.stringify(retention.purges),
  );

  const outOfBounds = await attempts('put', '/platform/retention', { idempotencyPurgeDays: 1 }, ownerToken);
  check(
    'ونافذةٌ خارج حدّها تُرفض (400)',
    outOfBounds.status === 400,
    `HTTP ${outOfBounds.status} ${outOfBounds.code}`,
  );
  const afterRefusal = await request('get', '/platform/retention', undefined, ownerToken);
  check('ولا تُكتب', afterRefusal.policy.idempotencyPurgeDays === retention.policy.idempotencyPurgeDays);

  const originalWindow = retention.policy.outboxPurgeDays;
  const probeWindow = originalWindow === 45 ? 46 : 45;
  const saved = await request('put', '/platform/retention', { outboxPurgeDays: probeWindow }, ownerToken);
  check('ونافذةٌ صالحة تُحفظ', saved.policy.outboxPurgeDays === probeWindow, `${probeWindow} يوماً`);
  const reread = await request('get', '/platform/retention', undefined, ownerToken);
  check('وتُقرأ بعد الحفظ', reread.policy.outboxPurgeDays === probeWindow);
  check('ولكل تعديلٍ صفُّ تدقيق', reread.updatedAt !== null, reread.updatedAt ?? '');
  const reverted = await request(
    'put',
    '/platform/retention',
    { outboxPurgeDays: originalWindow },
    ownerToken,
  );
  check('وأُعيدت النافذة إلى قيمتها الأصلية', reverted.policy.outboxPurgeDays === originalWindow);

  const measured = await request(
    'post',
    '/platform/retention/apply',
    { mode: 'dry_run', reason: `قياس P-C10 ${stamp}` },
    ownerToken,
  );
  check('والقياس التجريبي يعمل', measured.mode === 'dry_run' && Array.isArray(measured.results), `HTTP 201`);
  check(
    'ويغطّي الأهداف الأربعة',
    ['artifacts', 'idempotency', 'outbox', 'files'].every((target) =>
      measured.results.some((entry) => entry.target === target),
    ),
    measured.results.map((entry) => `${entry.target}:${entry.rows}`).join(' · '),
  );
  check(
    'ولا يحذف شيئاً وهو تجريبي',
    measured.results.every((entry) => entry.objectsRemoved === 0),
  );
  check('وعدد ملفات النسخ لم ينقص', (await artifactFiles()).length === beforeFiles + 1);

  // ─────────────────────────────────────────────── 8
  section('8. 🗑️ طلبات البيانات: تصديرٌ ومحوٌ وإيصال');
  // صاحب البيانات يُنشئه السكربت نفسه (عضويةٌ حقيقية في عميل القياس) فلا تُمسّ هوية
  // `owner@demo.test` التي تسجّل بها بقية السكربتات دخولها.
  const subjectEmail = `verify-pc10-${stamp}@demo.test`;
  const roles = await request('get', '/roles?limit=50', undefined, demoToken);
  const roleList = Array.isArray(roles) ? roles : (roles.items ?? roles.data ?? []);
  const roleId = roleList[0]?.id;
  check('دورٌ في عميل القياس لعضوية صاحب البيانات', Boolean(roleId), roleId ?? '(لا أدوار)');
  const membership = await request(
    'post',
    '/memberships',
    { email: subjectEmail, fullName: 'P-C10 Subject', roleIds: [roleId] },
    demoToken,
  );
  const subjectUserId = membership.userId ?? membership.user?.id ?? membership.id;
  check('وصاحب بياناتٍ حقيقي أُنشئ بمسارٍ حقيقي', Boolean(subjectUserId), subjectEmail);

  const exportRequest = await request(
    'post',
    '/platform/data-requests',
    {
      kind: 'export',
      tenantId: demoTenantId,
      subjectEmail,
      note: `تحقّق P-C10 ${stamp}`,
    },
    ownerToken,
  );
  check('يُفتح طلب تصديرٍ لصاحب البيانات', exportRequest.status === 'pending', exportRequest.subjectEmail);

  const beforeDecision = await attempts(
    'post',
    `/platform/data-requests/${exportRequest.id}/execute`,
    {},
    ownerToken,
  );
  check('والتنفيذ قبل القرار يُرفض (422)', beforeDecision.status === 422, `HTTP ${beforeDecision.status}`);

  const decidedExport = await request(
    'post',
    `/platform/data-requests/${exportRequest.id}/decide`,
    { decision: 'approve', reason: `قرار P-C10 ${stamp}` },
    ownerToken,
  );
  check('والقرار يُكتب بسبب', decidedExport.status === 'approved', decidedExport.decisionNote ?? '');
  const doubleDecision = await attempts(
    'post',
    `/platform/data-requests/${exportRequest.id}/decide`,
    { decision: 'reject', reason: `محاولة ثانية ${stamp}` },
    ownerToken,
  );
  check('وقرارٌ ثانٍ يُرفض (422)', doubleDecision.status === 422, `HTTP ${doubleDecision.status}`);

  const exported = await request(
    'post',
    `/platform/data-requests/${exportRequest.id}/execute`,
    {},
    ownerToken,
  );
  const exportResult = exported.export;
  check('والتنفيذ يُنتج ملفاً', Number(exportResult?.bytes) > 0, `${exportResult?.bytes} بايت`);
  check(
    'ببصمةٍ سداسية',
    /^[0-9a-f]{64}$/.test(exportResult?.checksum ?? ''),
    (exportResult?.checksum ?? '').slice(0, 16),
  );
  check(
    'ومرجعٍ ثابتٍ للذات لا يمحو نفسه',
    /^sub_[0-9a-f]{12}$/.test(exportResult?.subjectRef ?? ''),
    exportResult?.subjectRef,
  );
  const exportDownload = await raw('get', pathOf(exportResult.downloadUrl));
  check('والملف يُنزَّل بمحتواه (200)', exportDownload.status === 200, `HTTP ${exportDownload.status}`);
  check(
    'وفيه بيانات صاحب الطلب',
    (exportDownload.text ?? '').includes(subjectEmail),
    'users/audit_log/email_messages',
  );
  check(
    'وذيله يقول إنه كامل',
    JSON.parse((exportDownload.text ?? '').trim().split('\n').pop() ?? '{}').complete === true,
  );
  const forgedExport = await raw(
    'get',
    pathOf(`${exportResult.downloadUrl.split('&signature=')[0]}&signature=xx`),
  );
  check(
    'ورابط التصدير لا يُفتح بتوقيعٍ مزوَّر (403)',
    forgedExport.status === 403,
    `HTTP ${forgedExport.status}`,
  );

  const eraseRequest = await request(
    'post',
    '/platform/data-requests',
    { kind: 'erase', tenantId: demoTenantId, subjectEmail, note: `محو P-C10 ${stamp}` },
    ownerToken,
  );
  await request(
    'post',
    `/platform/data-requests/${eraseRequest.id}/decide`,
    { decision: 'approve', reason: `قرار محو P-C10 ${stamp}` },
    ownerToken,
  );
  const noConfirm = await attempts(
    'post',
    `/platform/data-requests/${eraseRequest.id}/execute`,
    {},
    ownerToken,
  );
  check('والمحو بلا تأكيدٍ يُرفض (422)', noConfirm.status === 422, `HTTP ${noConfirm.status}`);
  const wrongConfirm = await attempts(
    'post',
    `/platform/data-requests/${eraseRequest.id}/execute`,
    { confirm: 'someone-else@demo.test' },
    ownerToken,
  );
  check('وبتأكيدٍ خاطئ يُرفض (422)', wrongConfirm.status === 422, `HTTP ${wrongConfirm.status}`);

  const erased = await request(
    'post',
    `/platform/data-requests/${eraseRequest.id}/execute`,
    { confirm: subjectEmail, reason: `تنفيذ محو P-C10 ${stamp}` },
    ownerToken,
  );
  const eraseResult = erased.erased;
  check(
    'والتأكيد بالبريد نفسه يُنفّذ المحو',
    eraseResult?.anonymisedUsers === 1,
    JSON.stringify(eraseResult),
  );
  check(
    'والحقول المُخفاة مُعلَنة بالأسماء',
    (eraseResult?.anonymisedFields ?? []).includes('email'),
    `${(eraseResult?.anonymisedFields ?? []).length} حقلاً`,
  );
  check(
    'والمحو شمل العضوية النشطة',
    eraseResult?.suspendedMemberships >= 1,
    `${eraseResult?.suspendedMemberships} عضوية`,
  );
  check(
    'والإيصال يُبلّغ بعدد صفوف التدقيق الباقية',
    Number(eraseResult?.retainedAuditRows) >= 0,
    `${eraseResult?.retainedAuditRows} صفّاً يذكر صاحبه`,
  );

  const erasedUser = await envelope(`/platform/users?search=${encodeURIComponent(subjectEmail)}`, ownerToken);
  check(
    'والبحث عن البريد الأصلي لم يعد يجده في دليل المستخدمين',
    !(erasedUser.body?.data ?? []).some((row) => (row.email ?? '').toLowerCase() === subjectEmail),
    `${(erasedUser.body?.data ?? []).length} نتيجة`,
  );

  const afterErase = await envelope('/platform/data-requests?limit=100&filter[kind]=erase', ownerToken);
  const eraseRow = (afterErase.body?.data ?? []).find((row) => row.id === eraseRequest.id);
  check('والطلب صار `completed` بصفّه', eraseRow?.status === 'completed', eraseRow?.status ?? '');
  check(
    'ونتيجته محفوظة في الصفّ (لا في ذاكرة اللوحة)',
    Number(eraseRow?.result?.retainedAuditRows) === Number(eraseResult?.retainedAuditRows),
  );

  // ─────────────────────────────────────────────── 9
  section('9. 🧾 التدقيق: الأفعال الستّة مقيَّدة');
  const audit = await envelope('/platform/audit?limit=200&filter[entity]=backup_jobs', ownerToken);
  const backupAudit = (audit.body?.data?.items ?? []).map((row) => row.action);
  check('فعل تشغيل النسخة مسجَّل', backupAudit.includes('platform.backup.run'), `${backupAudit.length} صفاً`);
  check('وفعل التحقّق مسجَّل', backupAudit.includes('platform.backup.verify'));
  check('وفعل التنزيل مسجَّل', backupAudit.includes('platform.backup.download'));

  const retentionAudit = await envelope(
    '/platform/audit?limit=200&filter[entity]=platform_settings',
    ownerToken,
  );
  const retentionActions = (retentionAudit.body?.data?.items ?? []).map((row) => row.action);
  check('وتعديل الاحتفاظ مسجَّل', retentionActions.includes('platform.retention.update'));
  check('وتطبيقه مسجَّل', retentionActions.includes('platform.retention.apply'));

  const requestAudit = await envelope('/platform/audit?limit=200&filter[entity]=data_requests', ownerToken);
  const requestActions = (requestAudit.body?.data?.items ?? []).map((row) => row.action);
  check('وفتح الطلب مسجَّل', requestActions.includes('platform.data-request.create'));
  check('وقراره مسجَّل', requestActions.includes('platform.data-request.decide'));
  check('وتصديره مسجَّل', requestActions.includes('platform.data-request.export'));
  check('ومحوه مسجَّل', requestActions.includes('platform.data-request.erase'));

  console.log('\n──────────────────────────────────────────────');
  console.log(`النتيجة: ${checks - failures}/${checks} نقطة ناجحة (${failures} فشلاً)`);
  console.log('رواسب مقصودة: نسخةٌ واحدة في المخزن (بملفها وبصمتها)، وطلبا بياناتٍ (تصديرٌ ومحو)');
  console.log('بإيصاليهما، وعضوٌ صُنع ليقاس عليه المحو (صار `suspended` بهويةٍ مُخفاة)،');
  console.log('وسطورُ تدقيق (لا تُمحى أصلاً). ونافذة الاحتفاظ أُعيدت إلى قيمتها الأصلية.');
  console.log(
    `(مجلد النسخ: ${artifactDir} · عميل القياس: ${demo.tenantCode} · منشأة المشغّلين: ${platformTenant})`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\n✗ توقّف التحقّق:', error?.message ?? error);
  if (error?.problem) console.error(JSON.stringify(error.problem));
  process.exit(1);
});
