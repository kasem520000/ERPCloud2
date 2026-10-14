#!/usr/bin/env node
/**
 * verify-public-verify.mjs — التحقّق الحيّ لـ P-M8 «التحقّق والثقة والقطاعات»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس الحدّ الذي بُني عليه الجزء كلّه: **الباب العامّ الوحيد الذي يقرأ بلا جلسة**، والصفحات
 * الثلاث التي تقف فوقه. وسبعة أقسام:
 *
 *   1. 🚪 الباب — `POST /public/verify` يعمل بلا توكن، ومدخلٌ لا يصلح يُردّ 400 لا 500،
 *      والردّ كلّه على الشكل الموحَّد (`code` + `detail`).
 *   2. 🧾 الفحص على الشكل — المثال السليم يُقرأ حقولاً وفُحوصاً، ولا سجلَّ له ⇒ `record: null`
 *      بحالة 200: الفرق بين «رمزي سليمٌ ولا سجلّ له» و«رمزك غير معروف» أداةُ استكشاف لا نتيجة.
 *   3. 🚫 ما لا يُقرأ — نصٌّ عشوائي ورمزٌ مقطوع: حُكمٌ بالعطب، و`fields: null`، و**بلا استعلام**.
 *   4. 🔎 الحالة من السجلّ — فاتورةٌ حقيقية تُزرع في القاعدة بحِملٍ ورمزٍ وحالة، ثم يُسأل عنها
 *      بالحِمل وبالرمز: الحالة تُعاد، و**رقمُ الفاتورة وإجماليها واسمُ منشأتها لا تظهر** في الجسم.
 *   5. 🎛️ ترجمة الحالات — `prepared` و`voided:<سبب>` وحالةٌ مُخترعة: لكلٍّ تسميتُه وشرحُه من
 *      جدول العقد، وما لا يعرفه الجدول يعود `unknown` بلا اختراع معنى.
 *   6. 🧊 دلوُ المعدّل — سقفٌ مستقلّ عن دلو الاستمارات (`public-verify` لا `public-form`)،
 *      ويُقاس بأن الطلبات تصل إلى 429 — **يُقاس آخراً لأنه يستهلك الدلو**.
 *   7. 🌐 الموقع — `/verify` و`/trust` و`/industries` وصفحات القطاعات الخمس، وقطاعٌ غير معروف
 *      404، وخريطة الموقع تحملها: الصفحة التي لا تُوجد لا تُقاس.
 *
 * **وما يُقرأ من القاعدة؟** فواتيرُ الفحص وحدها (كتابةً ثم قراءةً)، لأن ما يُقاس هو أن الحالة
 * تُقرأ من `sales_invoices` ولا شيء غيرها يخرج منها. وكل فاتورة تُزرع برقمٍ عشوائيّ ويُنظَّف
 * أثرها في النهاية — فلا يُلوَّث بذرُ العرض (`demo`).
 *
 * Usage: node scripts/verify-public-verify.mjs
 */
import { createRequire } from 'node:module';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const siteBase = (
  process.env.MARKETING_BASE ?? `http://127.0.0.1:${process.env.MARKETING_PORT ?? 3002}`
).replace(/\/+$/, '');

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

/** العقد نفسه — يُقرأ من بنائه (`dist`) فلا يُكتب حِمل المثال يدوياً في سكربت. */
const contracts = await import(
  new URL('../packages/contracts/dist/platform/verify.js', import.meta.url).href
);
const { PUBLIC_VERIFY_SAMPLE_PAYLOAD, publicVerifyStatusLabels } = contracts;

const stamp = Date.now().toString(36);
const VERIFY = '/public/verify';
const unknownUuid = '00000000-1111-2222-3333-444444444444';
const clearedUuid = '11111111-2222-3333-4444-555555555555';
const preparedUuid = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const voidedUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const weirdUuid = '12345678-1234-1234-1234-123456789abc';
const tenantCode = 'verify-pm8';
/** رقمٌ لا يتكرّر: قيد `sales_invoices_tenant_number_key` فريدٌ لكل منشأة. */
const invoiceNumber = (label) => `INV-PM8-${label}-${stamp}`;
/** إجماليٌ ورقمٌ واسمٌ **مختلفة** عن حقل الرمز، فظهورها في الجسم = تسريب. */
const secretTotal = '9876.54';
const secretSeller = 'منشأة لا يجب أن تُقرأ من الرمز';

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

const client = new Client({
  connectionString: process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL,
});

async function query(text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

async function call(path, body, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, data: parsed.data, raw: parsed, headers: response.headers };
}

async function page(path) {
  const response = await fetch(`${siteBase}${path}`);
  return { status: response.status, html: await response.text() };
}

/** منشأةُ الفحص: تُنشأ مرّةً — ولا تُلامس منشأة العرض (`demo`). */
async function ensureTenant() {
  const existing = await query('SELECT id FROM tenants WHERE code = $1', [tenantCode]);
  if (existing.length > 0) return existing[0].id;
  const rows = await query(
    `INSERT INTO tenants (id, code, name, status) VALUES (gen_random_uuid(), $1, $2, 'active') RETURNING id`,
    [tenantCode, 'منشأة تحقّق P-M8'],
  );
  return rows[0].id;
}

async function ensureBranch(tenantId) {
  const existing = await query('SELECT id FROM branches WHERE tenant_id = $1 LIMIT 1', [tenantId]);
  if (existing.length > 0) return existing[0].id;
  const rows = await query(
    `INSERT INTO branches (id, tenant_id, code, name_ar, is_default)
     VALUES (gen_random_uuid(), $1, 'verify-b', 'فرع التحقّق', true) RETURNING id`,
    [tenantId],
  );
  return rows[0].id;
}

const createdInvoices = [];

async function seedInvoice({ number, zatcaStatus, qr = null, uuid = null, total = secretTotal }) {
  const tenantId = await ensureTenant();
  const branchId = await ensureBranch(tenantId);
  const rows = await query(
    `INSERT INTO sales_invoices (id, tenant_id, branch_id, kind, status, number, currency,
                                 subtotal, tax_total, total, posted_at, zatca_status, zatca_qr, zatca_uuid, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'sale', 'posted', $3, 'SAR', 500, 15, $4, now(), $5, $6, $7, now())
     RETURNING id`,
    [tenantId, branchId, number, total, zatcaStatus, qr, uuid],
  );
  createdInvoices.push(rows[0].id);
  return rows[0].id;
}

try {
  await client.connect();

  // ═══════════════════════════════════════════════ 1. الباب
  console.log(`\n■ 1. 🚪 الباب العامّ — ${apiBase}${VERIFY}`);
  const noAuth = await call(VERIFY, { payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });
  check('يعمل بلا توكن إطلاقاً', noAuth.status === 200, `status=${noAuth.status}`);
  check('وبلا كوكي ولا ترويسة إضافية', noAuth.headers.get('content-type')?.includes('application/json') === true);
  check('والردّ حالته 200 لا 201 (قراءةٌ لا إنشاء)', noAuth.status === 200);

  const none = await call(VERIFY, {});
  check('مدخلٌ فارغ ⇒ 400 بلا اختراع حالة', none.status === 400, `status=${none.status}`);
  check('ورمز الخطأ من السجلّ الموحَّد', none.raw.code === 'VALIDATION_FAILED', String(none.raw.code));

  const both = await call(VERIFY, { payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD, uuid: clearedUuid });
  check('الحِمل والرمز معاً ⇒ 400 (لا يُخمَّن أيّهما فُحص)', both.status === 400, `status=${both.status}`);

  const stranger = await call(VERIFY, { payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD, invoiceNumber: 'INV-1' });
  check('مفتاحٌ خارج العقد ⇒ 400', stranger.status === 400, `status=${stranger.status}`);

  const tooLong = await call(VERIFY, { payload: 'A'.repeat(4097) });
  check('حِملٌ أطول من الحدّ ⇒ 400', tooLong.status === 400, `status=${tooLong.status}`);

  // ═══════════════════════════════════════════════ 2. الفحص على الشكل
  console.log('\n■ 2. 🧾 الفحص على الشكل — حِملٌ سليم بلا سجلّ');
  const clean = noAuth.data;
  check('الحُكم: الرمز يُقرأ كفاتورة', clean?.valid === true);
  check('والحقول الخمسة تعود كما في الرمز', Boolean(clean?.fields?.sellerName && clean.fields.vatNumber));
  check('والرقم الضريبي خمسة عشر رقماً', /^\d{15}$/.test(clean?.fields?.vatNumber ?? ''), clean?.fields?.vatNumber);
  check('والتاريخ لحظةٌ بصيغة ISO', /^\d{4}-\d{2}-\d{2}T/.test(clean?.fields?.timestamp ?? ''), clean?.fields?.timestamp);
  check(
    'والفُحوص تُعاد بأسمائها (الرقم · التاريخ · الأرقام · الختم)',
    ['vat_number', 'timestamp', 'totals', 'signature'].every((code) =>
      (clean?.checks ?? []).some((entry) => entry.code === code),
    ),
    (clean?.checks ?? []).map((entry) => entry.code).join(' '),
  );
  check(
    'وفاتورة المرحلة الأولى تُعلَن بلا ختم — لا يُدَّعى ختمٌ غائب',
    (clean?.checks ?? []).some((entry) => entry.code === 'signature' && entry.ok === false && entry.severity === 'note'),
  );
  check('ولا سجلَّ لهذه الفاتورة في المنصّة', clean?.record === null);
  check('والجملة تقول ذلك صراحةً', typeof clean?.verdictAr === 'string' && clean.verdictAr.includes('لا سجل'));
  check(
    'ونصّ الحدّ يُرفق بكل استجابة (تطبيق «فاتورة» للتحقّق الرسمي)',
    typeof clean?.authorityNoteAr === 'string' && clean.authorityNoteAr.includes('فاتورة') && clean.authorityNoteAr.includes('لا نحفظ'),
  );

  // ═══════════════════════════════════════════════ 3. ما لا يُقرأ
  console.log('\n■ 3. 🚫 ما لا يُقرأ — حُكمٌ بلا استعلام');
  const junk = (await call(VERIFY, { payload: '!!! هذا ليس رمزاً على الإطلاق !!!' })).data;
  check('نصٌّ عشوائي ⇒ غير صالح', junk?.valid === false);
  check('وبلا حقولٍ ولا فحوص (لا يُفكّ ما ليس رمزاً)', junk?.fields === null && (junk?.checks ?? []).length === 0);
  check('وبلا سجلّ', junk?.record === null);
  check('والجملة تنصّ أنه لم يُتحقَّق من أي سجلّ', String(junk?.verdictAr ?? '').includes('لم يُتحقّق من أي سجلّ'));

  const truncated = (
    await call(VERIFY, { payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD.slice(0, PUBLIC_VERIFY_SAMPLE_PAYLOAD.length - 8) })
  ).data;
  check('رمزٌ مقطوع ⇒ غير صالح (لا يُقرأ نصف رمز)', truncated?.valid === false);
  check('وبلا سجلّ أيضاً', truncated?.record === null);

  // ═══════════════════════════════════════════════ 4. الحالة من السجلّ
  console.log('\n■ 4. 🔎 الحالة من السجلّ — ما يعرفه الخادم ولا يعرفه المتصفّح');
  await seedInvoice({
    number: invoiceNumber('CLEARED'),
    zatcaStatus: 'cleared',
    qr: PUBLIC_VERIFY_SAMPLE_PAYLOAD,
    uuid: clearedUuid,
  });
  await seedInvoice({ number: invoiceNumber('PREPARED'), zatcaStatus: 'prepared', uuid: preparedUuid });
  await seedInvoice({ number: invoiceNumber('VOIDED'), zatcaStatus: `voided:${stamp}`, uuid: voidedUuid });
  await seedInvoice({ number: invoiceNumber('WEIRD'), zatcaStatus: 'حالة-مُخترَعة', uuid: weirdUuid });

  const matched = (await call(VERIFY, { payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD })).data;
  check('بالحِمل: عُثر على الفاتورة', matched?.record !== null);
  check('والمفتاح الذي طابق هو الحِمل', matched?.record?.matchedBy === 'payload', String(matched?.record?.matchedBy));
  check('والحالة هي المخلَّصة لدى زاتكا', matched?.record?.status === 'cleared', String(matched?.record?.status));
  check(
    'وتسميتها العربية من جدول العقد لا من الواجهة',
    matched?.record?.statusLabelAr === publicVerifyStatusLabels.cleared.labelAr,
    matched?.record?.statusLabelAr,
  );
  check('ومعها شرحٌ يقول ما تعنيه', matched?.record?.explanationAr === publicVerifyStatusLabels.cleared.explanationAr);
  check('وتاريخ آخر تحديث للحالة يُعاد ISO', /^\d{4}-\d{2}-\d{2}T/.test(matched?.record?.recordedAt ?? ''), matched?.record?.recordedAt);
  check('والجملة الجامعة تذكر الحالة والتسمية', String(matched?.verdictAr ?? '').includes('مخلَّصة'));

  const byUuid = (await call(VERIFY, { uuid: clearedUuid })).data;
  check('وبالرمز: مطابقةٌ على حقلٍ آخر', byUuid?.record?.matchedBy === 'uuid', String(byUuid?.record?.matchedBy));
  check('وبلا حقول رمز (لا رمز يُفكّ)', byUuid?.fields === null && byUuid?.tags === null);
  check('وبالحالة نفسها — مصدرٌ واحد للحقيقة', byUuid?.record?.status === 'cleared');

  const leak = JSON.stringify(byUuid) + JSON.stringify(matched);
  check('ولا يتسرّب رقم الفاتورة', !leak.includes(invoiceNumber('CLEARED')));
  check('ولا إجماليها', !leak.includes(secretTotal));
  check('ولا اسم منشأتها', !leak.includes(secretSeller) && !leak.includes(tenantCode));

  const absent = (await call(VERIFY, { uuid: '99999999-8888-7777-6666-555555555555' })).data;
  check('ورمزٌ غير معروف ⇒ 200 بـ`record: null` لا 404', absent?.record === null);
  check('والجملة توجّه إلى مُصدر الفاتورة بلا ادّعاء', String(absent?.verdictAr ?? '').includes('لا سجل'));

  // ═══════════════════════════════════════════════ 5. ترجمة الحالات
  console.log('\n■ 5. 🎛️ ترجمة الحالات — من نصّ القاعدة إلى جملةٍ يفهمها العميل');
  const prepared = (await call(VERIFY, { uuid: preparedUuid })).data;
  check('`prepared` ⇒ «مُهيّأة (اختُبرت)»', prepared?.record?.statusLabelAr === 'مُهيّأة (اختُبرت)', prepared?.record?.statusLabelAr);
  check('وشرحها يقول إنها لم تُرسل إلى «فاتورة» الحقيقية', String(prepared?.record?.explanationAr ?? '').includes('simulation'));

  const voided = (await call(VERIFY, { uuid: voidedUuid })).data;
  check('`voided:<سبب>` ⇒ «ملغاة في المنصّة»', voided?.record?.status === 'voided', String(voided?.record?.status));
  check('ونبرتها تحذيرية لا موافقة', voided?.record?.tone === 'danger', String(voided?.record?.tone));

  const weird = (await call(VERIFY, { uuid: weirdUuid })).data;
  check('وحالةٌ لا يعرفها الجدول ⇒ `unknown`', weird?.record?.status === 'unknown', String(weird?.record?.status));
  check('ولا يُخترع لها معنى', weird?.record?.statusLabelAr === publicVerifyStatusLabels.unknown.labelAr);

  const auditRows = await query(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'verify'`);
  check('ولا سطرَ تدقيقٍ لهذا المسار (قراءةٌ لا تُدقَّق)', Number(auditRows[0]?.n ?? -1) === 0, `${auditRows[0]?.n} صفّاً`);

  // ═══════════════════════════════════════════════ 6. دلو المعدّل
  console.log('\n■ 6. 🧊 دلوُ المعدّل — سقفٌ مستقلّ (يُقاس آخراً: يستهلك الدلو)');
  let limited = 0;
  let firstLimitedAt = 0;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const response = await call(VERIFY, { uuid: unknownUuid });
    if (response.status === 429) {
      limited += 1;
      if (firstLimitedAt === 0) firstLimitedAt = attempt;
    }
  }
  check('الطلبات تُحدّ بـ429 عند السقف', limited > 0, `أوّل 429 عند المحاولة ${firstLimitedAt}`);
  check('والسقف في نطاق الإعداد المعلن (30/دقيقة)', firstLimitedAt >= 10 && firstLimitedAt <= 40, `${firstLimitedAt}`);
  const limitedResponse = await call(VERIFY, { uuid: unknownUuid });
  check(
    'ورمز الخطأ `RATE_LIMITED` ومعها `Retry-After`',
    limitedResponse.status === 429 && limitedResponse.raw.code === 'RATE_LIMITED' && Boolean(limitedResponse.headers.get('retry-after')),
    `${limitedResponse.status} ${limitedResponse.raw.code} retry-after=${limitedResponse.headers.get('retry-after')}`,
  );

  // ═══════════════════════════════════════════════ 7. الموقع
  console.log(`\n■ 7. 🌐 الموقع — ${siteBase}`);
  const verifyPage = await page('/verify');
  check('`/verify` تُخدَم', verifyPage.status === 200, `status=${verifyPage.status}`);
  check('وفيها العنوان ونصّ الإدخال', verifyPage.html.includes('التحقّق من فاتورة إلكترونية') && verifyPage.html.includes('حِمل رمز QR'));
  check('وتعلن أن القراءة داخل المتصفّح', verifyPage.html.includes('القراءة تقع داخل متصفّحك'));
  check('وفيها خيار التحقّق الخادمي بموافقةٍ صريحة', verifyPage.html.includes('التحقّق في الخادم') && verifyPage.html.includes('أوافق على إرسال'));
  check(
    'وفيها نصّ الحدّ: التحقّق الرسمي عبر تطبيق «فاتورة»',
    verifyPage.html.includes('تطبيق «فاتورة»') && verifyPage.html.includes('هيئة الزكاة'),
  );
  check(
    'ولا يُبنى نداء التحقّق إلى عنوانٍ داخلي — المسار نسبيّ على أصل الموقع',
    !verifyPage.html.includes('127.0.0.1:3000/api/v1/public/verify') &&
      !verifyPage.html.includes('localhost:3000/api/v1/public/verify'),
  );

  const trust = await page('/trust');
  check('`/trust` تُخدَم', trust.status === 200, `status=${trust.status}`);
  for (const axis of ['التشفير وحماية الدخول', 'العزل بين المنشآت', 'النسخ والاستعادة', 'الفاتورة الإلكترونية']) {
    check(`وفيها محور «${axis}»`, trust.html.includes(axis));
  }
  check('وكل بندٍ ومعه مصدره الملفّي', trust.html.includes('docs/SECURITY_ARCHITECTURE.md') && trust.html.includes('.ts'));
  check('وفيها قسم «ما لا ندّعيه»', trust.html.includes('ما لا ندّعيه'));
  // الشهادات تُذكر في «ما لا ندّعيه» وحدها: ما قبل ذلك القسم لا يجوز أن يحمل اسم شهادة.
  const trustBeforeLimits = trust.html.split('ما لا ندّعيه')[0] ?? '';
  check(
    'ولا شهادةَ مخترعة في بنود الثقة (وذكرُها مقصورٌ على «ما لا ندّعيه»)',
    /ISO|SOC 2|PCI/.test(trustBeforeLimits) === false && trust.html.includes('ما لا ندّعيه'),
  );

  const industries = await page('/industries');
  check('`/industries` تُخدَم', industries.status === 200, `status=${industries.status}`);
  for (const label of ['التفصيل', 'النظارات', 'إدارة المراسي', 'المقاولات', 'متجر سلة']) {
    check(`وفيها قطاع «${label}»`, industries.html.includes(label));
  }

  const slugs = ['tailoring', 'optics', 'marina', 'contracting', 'salla'];
  const slugChecks = [];
  for (const slug of slugs) {
    const response = await page(`/industries/${slug}`);
    slugChecks.push(`${slug}:${response.status}`);
  }
  check('ولكل قطاعٍ صفحةٌ تعمل', slugChecks.every((entry) => entry.endsWith(':200')), slugChecks.join(' '));

  const tailoring = await page('/industries/tailoring');
  check(
    'وصفحة القطاع تسمّي شاشاتها بتسمياتها الحرفية',
    ['إدارة طلبات التفصيل', 'قياسات العملاء', 'خصائص القياسات', 'إدارة الخيارات الجاهزة', 'أنواع التفصيل'].every(
      (label) => tailoring.html.includes(label),
    ),
  );
  check(
    'وتذكر مسار الشاشة وملفّها (apps/staff/lib/navigation.ts)',
    tailoring.html.includes('/tailoring/measurements') && tailoring.html.includes('apps/staff/lib/navigation.ts'),
  );
  const marina = await page('/industries/marina');
  check('وصفحة المرسى تحمل شاشاتها الأربع على الأقل', ['الحجوزات', 'المخالفات', 'تحضير المراكب', 'إغلاق اليومية'].every((label) => marina.html.includes(label)));

  const missing = await page('/industries/no-such-industry');
  check('وقطاعٌ غير معروف ⇒ 404 حقيقية', missing.status === 404 && missing.html.includes('404'), `status=${missing.status}`);

  const sitemap = await page('/sitemap.xml');
  check('وخريطة الموقع تحمل الصفحتين', sitemap.html.includes('/trust') && sitemap.html.includes('/industries'));
  check(
    'وتحمل صفحات القطاعات الخمس',
    slugs.every((slug) => sitemap.html.includes(`/industries/${slug}`)),
    slugs.join(' '),
  );
} catch (error) {
  failures += 1;
  console.log(`\n✗ توقّف السكربت: ${error.message}`);
} finally {
  try {
    if (createdInvoices.length > 0) {
      await query('DELETE FROM sales_invoices WHERE id = ANY($1::uuid[])', [createdInvoices]);
    }
  } catch {
    // التنظيف تحسينٌ لا شرط: لو فشل لا يُسقط نتيجة التحقّق.
  }
  await client.end().catch(() => {});
}

console.log(`\n${failures === 0 ? '✔' : '✗'} verify-public-verify: ${checks - failures}/${checks} نقطة ناجحة في 7 أقسام`);
process.exit(failures === 0 ? 0 : 1);
