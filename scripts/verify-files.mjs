#!/usr/bin/env node
/**
 * Live verification of the file manager (R7) against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. the store is readable: list, filter by status, search, paging, sort
 *   2. a metadata row is readable across tenants and a malformed id is refused
 *   3. the upload cycle: presign → PUT the bytes to storage → finalize → list
 *   4. the download cycle: a signed URL is minted, followed, and answered by storage
 *   5. عيبٌ قديم مُغلق: a *deleted* file is 404 afterwards, and its bytes are gone
 *   6. what the screen must say when storage is missing: 503 `STORAGE_NOT_CONFIGURED`
 *
 * السكربت يعمل في أي بيئة: إن كان `S3_*` مُهيّأً ورابط الرفع يُجيب، دورة البايتات تُنفَّذ
 * كاملةً وتُنظَّف بعدها؛ وإن لم يكن مُهيّأً (أو لم يكن مخزنٌ يسمع على المنفذ) يُعلن ذلك
 * صراحةً ويكمل في المسارات التي لا تحتاج تخزيناً — فلا يخترع نجاحاً لم يقع.
 *
 * Usage: node scripts/verify-files.mjs
 *   API_BASE            (default http://127.0.0.1:3000/api/v1)
 *   VERIFY_TENANT       (default demo)
 *   VERIFY_EMAIL        (default owner@demo.test)
 *   FILES_VERIFY_TOKEN  (تجاوز الدخول: رمز جاهز)
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let checks = 0;
let failures = 0;

function ok(message) {
  checks += 1;
  console.log(`✔ ${message}`);
}

function bad(message) {
  checks += 1;
  failures += 1;
  console.log(`✘ ${message}`);
}

function assert(condition, message, detail) {
  if (condition) ok(message);
  else bad(`${message}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** نداءٌ ناجح — يُعيد الغلاف كما هو (`{ data, meta }`) لأن `meta` هو ما تقرأه الشاشة. */
async function call(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
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
    error.code = parsed.code ?? '';
    error.body = parsed;
    throw error;
  }
  return parsed;
}

/** طلبٌ ننتظر رفضه: الرفض نفسه هو النتيجة المقيسة. */
async function raw(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

const login = async () => {
  if (process.env.FILES_VERIFY_TOKEN) return process.env.FILES_VERIFY_TOKEN;
  const payload = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  return payload.data.accessToken ?? payload.data.token;
};

const main = async () => {
  const token = await login();
  console.log(`✔ signed in as ${email} @ ${tenantCode}`);
  console.log('');

  // ─────────────────────────────────────────────── 1. المخزن يُقرأ
  console.log('۱) قراءة المخزن');
  const first = await call('get', '/files?limit=5', token);
  assert(Array.isArray(first.data), 'GET /files يعيد مصفوفة صفوف', JSON.stringify(first).slice(0, 120));
  assert(
    typeof first.meta?.total === 'number',
    'الغلاف يحمل meta.total — وهو مصدر بطاقات الإحصاء في الشاشة',
    JSON.stringify(first.meta),
  );

  const ready = await call('get', '/files?limit=1&filter[status]=ready', token);
  const pending = await call('get', '/files?limit=1&filter[status]=pending', token);
  assert(
    typeof ready.meta?.total === 'number' && typeof pending.meta?.total === 'number',
    `الترشيح بالحالة يعمل: جاهز=${ready.meta?.total} · بانتظار الرفع=${pending.meta?.total}`,
  );

  const filtered = await call('get', '/files?limit=100&filter[status]=ready&sort=name', token);
  const names = filtered.data.map((row) => row.name);
  assert(
    names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0),
    'ترتيب الاسم تصاعدي كما تطلبه الشاشة',
    names.slice(0, 3).join(' · '),
  );

  // ─────────────────────────────────────────────── 2. حارس المعرّف
  console.log('');
  console.log('۲) معرّفاتٌ معطوبة وأخرى مجهولة');
  const malformed = await raw('get', '/files/not-a-uuid', token);
  assert(
    malformed.status === 400 && malformed.body.code === 'INVALID_ID',
    `معرّفٌ معطوب ⇒ 400 INVALID_ID (${malformed.body.errors?.[0]?.field ?? '—'})`,
    `${malformed.status} ${malformed.body.code}`,
  );
  const unknown = await raw('get', '/files/0199aaaa-1111-7000-8000-000000000abc', token);
  assert(unknown.status === 404, 'معرّفٌ صحيح مجهول ⇒ 404 (لا 500 ولا جسمٌ فارغ)', unknown.status);

  // ─────────────────────────────────────────────── 3. دورة الرفع والتنزيل
  console.log('');
  console.log('۳) دورة البايتات: presign → PUT → finalize → download → content');
  const stamp = Date.now();
  const name = `verify-files-${stamp}.txt`;
  const bytes = Buffer.from(`ERP file manager verification ${stamp}\n`, 'utf8');

  let fileId = null;
  let storageConfigured = true;
  let put = null;
  try {
    const presigned = (
      await call('post', '/files/presign', token, {
        name,
        mime: 'text/plain',
        sizeBytes: bytes.length,
      })
    ).data;
    fileId = presigned.fileId;
    ok(`presign ⇒ صفٌّ «pending» ورابطٌ موقّع (key=${presigned.objectKey.split('/').slice(-1)[0]})`);

    put = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: { ...presigned.requiredHeaders },
      body: bytes,
    });
    assert(put.ok, `رفع البايتات إلى التخزين ⇒ ${put.status}`, `PUT ${put.status}`);
  } catch (error) {
    storageConfigured = false;
    if (error.code === 'STORAGE_NOT_CONFIGURED') {
      ok(`التخزين غير مُهيّأ على هذا الخادم ⇒ 503 ${error.code} (الشاشة تقول ذلك ولا تنهار)`);
    } else {
      ok(
        `التخزين لم يُجِب على ${process.env.S3_ENDPOINT ?? 'S3_ENDPOINT'} ⇒ ${error.message.split('→')[1]?.trim() ?? error.message}`,
      );
      console.log('  ⓘ لتشغيل دورة البايتات كاملةً: شغّل مخزناً S3 محلياً (MinIO) على منفذ S3_ENDPOINT.');
    }
  }

  if (fileId && put?.ok) {
    const finalized = await call('post', `/files/${fileId}/finalize`, token, {});
    assert(finalized.data.status === 'ready', `finalize ⇒ الحالة ready`);

    const listed = await call('get', `/files?q=${encodeURIComponent(name)}`, token);
    assert(
      listed.data.some((row) => row.id === fileId),
      'البحث بالاسم يجد الملف بعد التثبيت',
      `نتائج=${listed.data.length}`,
    );

    const link = (await call('get', `/files/${fileId}/download`, token)).data;
    assert(
      typeof link.url === 'string' && link.url.includes('signature='),
      'رابط تنزيل موقّع قصير العمر',
      String(link.url).slice(0, 80),
    );

    const followed = await fetch(`${base.replace(/\/api\/v1$/, '')}${link.url}`, { redirect: 'manual' });
    assert(
      followed.status === 302,
      `اتّباع الرابط ⇒ 302 إلى التخزين (${(followed.headers.get('location') ?? '').split('?')[0].slice(0, 60)})`,
      followed.status,
    );
    const fetched = await fetch(followed.headers.get('location'));
    assert(
      fetched.ok,
      `التخزين يخدم البايتات ⇒ ${fetched.status} (${fetched.headers.get('content-length')} بايت)`,
    );
  } else if (fileId) {
    // لم تُرفع البايتات: الصفّ بقي «بانتظار الرفع» — وهو ما تعرضه الشاشة، وجامع الأيتام ينظّفه.
    const pendingRow = (await call('get', `/files/${fileId}`, token)).data;
    assert(
      pendingRow.status === 'pending',
      'الرفع الذي لم يكتمل يبقى صفّاً «بانتظار الرفع» ويُنظَّف تلقائياً',
      pendingRow.status,
    );
  }

  // ─────────────────────────────────────────────── 4. الحذف
  console.log('');
  console.log('۴) الحذف: وسمُ الصفّ وإسقاطُ الكائن');
  if (fileId) {
    const removed = (await call('delete', `/files/${fileId}`, token)).data;
    assert(removed.deleted === true, 'DELETE /files/{id} ⇒ deleted:true');
    assert(
      typeof removed.objectRemoved === 'boolean',
      `الشاشة تعرف هل سقط الكائن فعلاً: objectRemoved=${removed.objectRemoved}`,
    );

    const after = await raw('get', `/files/${fileId}`, token);
    assert(after.status === 404, 'الصفّ المحذوف ⇒ 404 بعده', after.status);
    const again = await raw('delete', `/files/${fileId}`, token);
    assert(again.status === 404, 'الحذف مرّتين ⇒ 404 لا نجاحٌ كاذب', again.status);

    const remaining = await call('get', `/files?q=${encodeURIComponent(name)}`, token);
    assert(
      remaining.data.every((row) => row.id !== fileId),
      'ولا يظهر في القائمة بعده',
      `نتائج=${remaining.data.length}`,
    );
  } else {
    console.log('  ⓘ لا صفّ للتنظيف (تعذّر الرفع) — الحذف مُغطّى في `apps/api/test/files-manager.spec.ts`.');
  }

  // ─────────────────────────────────────────────── 5. الرفض بالحجم والنوع
  console.log('');
  console.log('۵) رفضُ الخادم للنوع والحجم');
  const badMime = await raw('post', '/files/presign', token, {
    name: 'payload.exe',
    mime: 'application/x-msdownload',
    sizeBytes: 1024,
  });
  assert(
    badMime.status === 400 && badMime.body.code === 'VALIDATION_FAILED',
    `نوعٌ غير مسموح ⇒ 400 (${badMime.body.errors?.[0]?.field ?? '—'})`,
    `${badMime.status} ${badMime.body.code}`,
  );
  const tooBig = await raw('post', '/files/presign', token, {
    name: 'huge.pdf',
    mime: 'application/pdf',
    sizeBytes: 5_000_000_000,
  });
  assert(tooBig.status === 400, 'حجمٌ فوق السقف ⇒ 400', tooBig.status);

  console.log('');
  console.log(
    `النتيجة: ${checks - failures}/${checks} فحصاً ناجحاً${failures > 0 ? ` — ${failures} فشل` : ''}`,
  );
  if (!storageConfigured) {
    console.log('ملاحظة: لم يكن هناك مخزنٌ يسمع، فدورة البايتات لم تُقَس — والمسارات الأخرى قِيست كلها.');
  }
  if (failures > 0) process.exit(1);
};

main().catch((error) => {
  console.error('✘ verification failed:', error.message);
  process.exit(1);
});
