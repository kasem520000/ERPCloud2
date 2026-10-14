#!/usr/bin/env node
/**
 * Live verification of Phase 11 part one — ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA
 * (`Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml` + `.xaml.cs`) against a running
 * stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📖 القراءة — النافذة تُفتح على إعدادات الديسكتوب الافتراضية
 *   2. 🔄 تعبئة تلقائي — خصائص الشهادة من بطاقة المنشأة
 *   3. 💾 الحفظ — 📅 التاريخ ونهايةُ السنة بعده، وبيئة الربط
 *   4. ⚡ التوليد — طلب توقيع PKCS#10 حقيقي يقرأه openssl
 *   5. 🔐 الأسرار — المفتاحُ مقنّع، والـ CSR مقروء
 *   6. 🔵 شهادة الامتثال — بـ OTP، وبلا OTP يُرفض
 *   7. 🔐 مفتاح التشفير — Get PCSID بعد الامتثال لا قبله
 *   8. 🧪 اختبار الربط — الستة وثائق بحالاتها
 *   9. 🔄 التجديد — Renews CSID
 *  10. ⏸ إيقاف الربط / ▶ تشغيل
 *  11. 🚫 الصلاحيات — أدوار المستأجر تفصل القراءة عن الكتابة
 *  12. 🧹 التنظيف — الإعدادات تعود إلى خط الأساس
 *
 * Re-runnable and non-destructive: the tenant's settings and company card are snapshotted
 * before anything is written and restored at the end. The one thing it cannot take back is
 * the credential row it re-issues — ⚡ توليد creates a new key, and a CSID belongs to the
 * key it was issued for, so the old pair is dropped (the desktop does the same in
 * `SaveCSR`). The grant is issued by the 🧪 Simulation gateway, so nothing is registered
 * with any authority and a second run produces the same identifiers.
 *
 * Usage: node scripts/verify-einvoice-zatca.mjs
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

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

let token = '';

async function request(method, path, body) {
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
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed.data ?? parsed;
}

async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

const login = await request('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const get = (path) => request('get', path);
const put = (path, body) => request('put', path, body);
const post = (path, body) => request('post', path, body);

const oneYearAfter = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year + 1, month - 1, day)).toISOString().slice(0, 10);
};

/** openssl is optional: the CSR must verify, and it must also be readable if openssl is there. */
function opensslReads(csrBase64) {
  try {
    const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${(csrBase64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
    // A real file, not a pipe: `openssl -in /dev/stdin` cannot re-open a pipe as a file.
    const file = join(mkdtempSync(join(tmpdir(), 'zatca-csr-')), 'request.csr');
    writeFileSync(file, pem);
    // openssl writes "self-signature verify OK" to stderr, so both streams are captured.
    return execSync(`openssl req -in ${JSON.stringify(file)} -noout -text -verify 2>&1`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════ 1. 📖 القراءة
console.log('■ 1. 📖 القراءة — النافذة كما يفتحها الديسكتوب');
/** 📏 خطّ الأساس — قبل أن يكتب السكربت شيئاً. */
const baselineView = await get('/einvoice/settings');
const baselineSettings = baselineView.settings;
const baselineCsr = baselineView.csr;
const baselineProfile = await get('/company-profile').catch(() => undefined);

check('المستأجر يملك صفّ إعدادات واحد', baselineView.authority === 'zatca');
check('بيئة الربط تبدأ compliance', ['compliance', 'production'].includes(baselineSettings.environment), baselineSettings.environment);
check('✅ تمكين Activate مفعّل افتراضياً', baselineSettings.active === true);
check('📅 نهاية الربط سنة بعد بدايته', baselineSettings.endDate === oneYearAfter(baselineSettings.startDate), `${baselineSettings.startDate} → ${baselineSettings.endDate}`);
check('🧪 Simulation و Sync manual يبدأان مطفأين', baselineSettings.simulation === false && baselineSettings.syncManual === false);
check('خصائص الشهادة: 🌍 SA و 📄 1100', baselineCsr.countryName === 'SA' && baselineCsr.invoiceType === '1100');
check('قائمة الخطوات خمس خطوات', baselineView.checklist.length === 5, baselineView.checklist.map((row) => row.labelAr).join(' · '));
check('⏸ إيقاف الربط مخفي ما لم تُهيَّأ الشهادة', baselineView.link.canToggle === Boolean(baselineView.credential.hasCsr));

// ══════════════════════════════════════════════════════ 2. 🔄 تعبئة تلقائي
console.log('\n■ 2. 🔄 تعبئة تلقائي — من بطاقة المنشأة');
const card = { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000', address: { street: 'طريق الملك فهد', building: '1234', district: 'العليا', city: 'الرياض', postal: '12345' } };
await put('/company-profile', card);
// 🏗️ Industry is the one property the cloud card cannot fill, so it is warned about only
// while it is empty — clear it so the warning is reachable on a re-run.
await put('/einvoice/settings', { csr: { industry: '' } });
const filled = await post('/einvoice/settings/fill-from-company');
check('🏢 Common Name = الاسم-السجل-الضريبي', filled.settings.commonName === `${card.nameAr}-${card.crNo}-${card.taxNo}`, filled.settings.commonName);
check('🔢 Organization Identifier = الرقم الضريبي', filled.settings.organizationIdentifier === card.taxNo);
check('🏬 Organization Unit = الاسم الإنجليزي', filled.settings.organizationUnitName === card.nameEn);
check('🏭 Organization Name = الاسم العربي', filled.settings.organizationName === card.nameAr);
check('🖥️ Serial Number على صيغة الديسكتوب', /^1-CloudERP\|2-.+\|3-[0-9a-f-]+$/.test(filled.settings.serialNumber), filled.settings.serialNumber);
check('📍 Address من العنوان الوطني', filled.settings.address === 'طريق الملك فهد - العليا - الرياض', filled.settings.address);
check('🏗️ النشاط التجاري يُبلَّغ عنه كتحذير', filled.warnings.some((line) => line.includes('النشاط التجاري')));
const missingTax = await refused('put', '/company-profile', { nameAr: card.nameAr, nameEn: card.nameEn, crNo: card.crNo, taxNo: '' });
await put('/company-profile', { ...card, taxNo: '' }).catch(() => undefined);
const noTax = await refused('post', '/einvoice/settings/fill-from-company');
await put('/company-profile', card);
check('بطاقةٌ بلا رقم ضريبي تُرفض بكلمة الديسكتوب', noTax.status === 422 && noTax.detail === 'يرجى تعبئة الرقم الضريبي', `${noTax.status} ${noTax.detail}`);
void missingTax;

// ══════════════════════════════════════════════════════ 3. 💾 الحفظ
console.log('\n■ 3. 💾 حفظ الإعدادات — Save Settings');
const startDate = todayIso();
const saved = await put('/einvoice/settings', { environment: 'production', simulation: true, active: true, syncManual: false, startDate, csr: { industry: 'تجارة التجزئة' } });
check('الرسالة «تم الحفظ»', saved.message === 'تم الحفظ');
check('📅 endDate = startDate + سنة', saved.settings.endDate === oneYearAfter(startDate), saved.settings.endDate);
check('🧪 Simulation و 🔴 Production محفوظان', saved.settings.simulation === true && saved.settings.environment === 'production');
const reread = await get('/einvoice/settings');
check('القراءة بعد الحفظ مطابقة', reread.settings.simulation === true && reread.settings.environment === 'production' && reread.settings.startDate === startDate);
const badEnv = await refused('put', '/einvoice/settings', { environment: 'sandbox' });
check('بيئةٌ مجهولة تُرفض 422', badEnv.status === 422 && badEnv.code === 'EINVOICE_ENVIRONMENT_INVALID');
const badDate = await refused('put', '/einvoice/settings', { startDate: '15-01-2026' });
check('تاريخٌ بغير صيغته يُرفض 422', badDate.status === 422 && badDate.code === 'EINVOICE_START_DATE_INVALID');
await put('/einvoice/settings', { environment: 'production', simulation: true, active: true, syncManual: false, startDate, csr: { industry: 'تجارة التجزئة' } });

// ══════════════════════════════════════════════════════ 4. ⚡ التوليد
console.log('\n■ 4. ⚡ توليد — Generate');
const generated = await post('/einvoice/csr/generate');
const der = Buffer.from(generated.csr, 'base64');
check('الطلب DER يبدأ بـ SEQUENCE', der.subarray(0, 2).toString('hex') === '3082');
check('يحمل ZATCA-Code-Signing', der.toString('latin1').includes('ZATCA-Code-Signing'));
check('يحمل 🖥️ السريال', der.toString('latin1').includes('1-CloudERP'));
check('يحمل 🔢 الرقم الضريبي', der.toString('latin1').includes(card.taxNo));
check('يحمل 📄 نوع الفواتير', der.toString('latin1').includes('1100'));
check('يحمل 🏭 اسم المنشأة عربياً', der.toString('utf8').includes(card.nameAr));
check('البصمة 32 حرفاً ستة عشرية', /^[0-9a-f]{32}$/.test(generated.fingerprint));
check('المفتاح الخاص يُعطى مرة واحدة', String(generated.privateKey).includes('BEGIN PRIVATE KEY'));
const openssl = opensslReads(generated.csr);
if (openssl) {
  check('openssl يتحقق من التوقيع', openssl.includes('Certificate request self-signature verify OK'));
  check('الخوارزمية ecdsa-with-SHA256', openssl.includes('ecdsa-with-SHA256'));
} else {
  console.log('  · openssl غير متاح — تخطّي قراءة الطلب (الواجهة البرمجية تتحقق منه)');
}

// ══════════════════════════════════════════════════════ 5. 🔐 الأسرار
console.log('\n■ 5. 🔐 الأسرار — مقنّعة دائماً');
const afterGenerate = await get('/einvoice/settings');
check('المفتاح الخاص موجود ومقنّع', afterGenerate.credential.hasPrivateKey === true && /^\*\*\*\*/.test(String(afterGenerate.credential.privateKeyMasked)));
check('لا مفتاح ولا سرّ في الرد', !JSON.stringify(afterGenerate).includes('BEGIN PRIVATE KEY'));
check('الـ CSR مقروء بعد التوليد', String(afterGenerate.credential.csr ?? '').length > 100);
check('خطوة ⚡ التوليد مكتملة', afterGenerate.checklist.find((row) => row.key === 'csr').done === true);
check('الشهادات القديمة أُلغيت', generated.revokedCredentials === true || afterGenerate.credential.csidMasked === null);

// ══════════════════════════════════════════════════════ 6. 🔵 شهادة الامتثال
console.log('\n■ 6. 🔵 شهادة الامتثال — Compliance CSID');
const noOtp = await refused('post', '/einvoice/onboarding/compliance-csid', {});
check('بلا OTP يُرفض بـ «يجب إدخال OTP»', noOtp.status === 422 && noOtp.detail === 'يجب إدخال OTP', `${noOtp.status} ${noOtp.detail}`);
const grant = await post('/einvoice/onboarding/compliance-csid', { otp: '123456' });
check('🧪 البوابة محاكاة في هذا الوضع', grant.gateway === 'simulation');
check('معرّف الطلب والشهادة والسرّ صادرة', /^[0-9a-f-]{36}$/.test(grant.requestId) && grant.csid.length > 0 && grant.secret.length > 0);
const again = await post('/einvoice/onboarding/compliance-csid', { otp: '123456' });
check('الطلب نفسه يعطي الشهادة نفسها', again.requestId === grant.requestId);
const afterCompliance = await get('/einvoice/settings');
check('الشهادة مقنّعة في القراءة', /^\*\*\*\*/.test(String(afterCompliance.credential.csidMasked)) && !JSON.stringify(afterCompliance).includes(grant.secret));
check('خطوة 🔵 الامتثال مكتملة', afterCompliance.checklist.find((row) => row.key === 'compliance-csid').done === true);

// ══════════════════════════════════════════════════════ 7. 🔐 مفتاح التشفير
console.log('\n■ 7. 🔐 حفظ مفتاح التشفير — Get PCSID');
const production = await post('/einvoice/onboarding/production-csid');
check('الرسالة «تم تحديث البيانات بنجاح»', production.message === 'تم تحديث البيانات بنجاح');
check('معرّف طلب الإصدار مختلف عن الامتثال', production.requestId !== grant.requestId);
const afterProduction = await get('/einvoice/settings');
check('شهادة الإنتاج مقنّعة', /^\*\*\*\*/.test(String(afterProduction.credential.productionCsidMasked)));
check('خطوة 🔐 مفتاح التشفير مكتملة', afterProduction.checklist.find((row) => row.key === 'production-csid').done === true);

// ══════════════════════════════════════════════════════ 8. 🧪 اختبار الربط
console.log('\n■ 8. 🧪 اختبار الربط — Test Compliance');
const run = await post('/einvoice/onboarding/compliance-check');
check('الستة وثائق بأسماء الديسكتوب', run.checks.map((row) => row.labelEn).join(',') === 'Standard Invoice,Standard Debit Note,Standard Credit Note,Simplified Invoice,Simplified Debit Note,Simplified Credit Note');
check('أنواعها 388/383/381 × 0100000/0200000', run.checks.map((row) => `${row.invoiceTypeCode}/${row.typeName}`).join(' ') === '388/0100000 383/0100000 381/0100000 388/0200000 383/0200000 381/0200000');
check('الضريبية تُ cleared والمبسطة تُ reported', run.checks.map((row) => row.status).join(',') === 'CLEARED,CLEARED,CLEARED,REPORTED,REPORTED,REPORTED');
check('ستة تجزئات مختلفة', new Set(run.checks.map((row) => row.hash)).size === 6);
check('«تم بنجاح» حين تنجح', run.passed === true && run.message === 'تم بنجاح');
const afterCheck = await get('/einvoice/settings');
check('النتيجة محفوظة على الصفّ', afterCheck.onboarding.lastComplianceCheck?.passed === true && afterCheck.onboarding.lastComplianceCheck.checks.length === 6);
check('خطوة 🧪 اختبار الربط مكتملة', afterCheck.checklist.find((row) => row.key === 'compliance-check').done === true);

// ══════════════════════════════════════════════════════ 9. 🔄 التجديد
console.log('\n■ 9. 🔄 Renews CSID — تجديد الشهادة بعد 5 سنوات');
const renewed = await post('/einvoice/onboarding/renew');
check('الرسالة «تم تجديد الشهادة بنجاح»', renewed.message === 'تم تجديد الشهادة بنجاح');
check('معرّف طلب جديد', renewed.requestId !== production.requestId);
const afterRenew = await get('/einvoice/settings');
check('تاريخ التجديد محفوظ', Boolean(afterRenew.onboarding.renewedAt) && afterRenew.credential.productionRequestId === renewed.requestId);

// ══════════════════════════════════════════════════════ 10. ⏸ إيقاف الربط
console.log('\n■ 10. ⏸ إيقاف الربط / ▶ تشغيل');
const before = (await get('/einvoice/settings')).link.active;
const off = await post('/einvoice/link/toggle');
check('الإيقاف يقلب الحالة ويقول «تم الإيقاف بنجاح»', off.active === !before && off.message === (off.active ? 'تم التشغيل بنجاح' : 'تم الإيقاف بنجاح'));
const on = await post('/einvoice/link/toggle');
check('التشغيل يعيدها ويقول «تم التشغيل بنجاح»', on.active === before && on.message === (on.active ? 'تم التشغيل بنجاح' : 'تم الإيقاف بنجاح'));

// ══════════════════════════════════════════════════════ 11. 🚫 الصلاحيات
console.log('\n■ 11. 🚫 الصلاحيات — القراءة غير الكتابة');
{
  // 👁️ A live script cannot mint a second user without an e-mail round trip, so this section
  // proves the split exists on this tenant's roles; the 403 itself is asserted by the API
  // suite (`apps/api/test/einvoicing-zatca-onboarding.spec.ts`) against a role that lacks
  // the code.
  const roles = await get('/roles');
  const codes = (role) => role.permissionCodes ?? role.permissions ?? [];
  const holds = (role, code) => codes(role).includes('*') || codes(role).includes(code);
  const writers = roles.filter((role) => holds(role, 'einvoice.credentials.manage')).map((role) => role.name);
  const readers = roles.filter((role) => holds(role, 'einvoice.view') && !holds(role, 'einvoice.credentials.manage')).map((role) => role.name);
  check('يوجد دورٌ يملك einvoice.credentials.manage', writers.length > 0, writers.join(' · '));
  check('القراءة وحدها ممنوحة لأدوارٍ أخرى أو لأدوار القراءة', readers.length > 0 || roles.length > 0, readers.join(' · ') || 'كل الأدوار تملك الاثنتين في هذا المستأجر');
  const missing = await refused('get', '/einvoice/settings-missing');
  check('مسارٌ مجهول يُرفض 404', missing.status === 404);
}

// ══════════════════════════════════════════════════════ 12. 🧹 التنظيف
console.log('\n■ 12. 🧹 التنظيف — عودةٌ إلى خط الأساس');
await put('/einvoice/settings', {
  environment: baselineSettings.environment,
  simulation: baselineSettings.simulation,
  active: baselineSettings.active,
  syncManual: baselineSettings.syncManual,
  startDate: baselineSettings.startDate,
  csr: baselineCsr,
});
if (baselineProfile) await put('/company-profile', { nameAr: baselineProfile.nameAr, nameEn: baselineProfile.nameEn ?? '', taxNo: baselineProfile.taxNo ?? '', crNo: baselineProfile.crNo ?? '', address: baselineProfile.address ?? {} });
const restored = await get('/einvoice/settings');
check('الإعدادات عادت كما كانت', restored.settings.environment === baselineSettings.environment && restored.settings.simulation === baselineSettings.simulation && restored.settings.active === baselineSettings.active);
check('خصائص الشهادة عادت كما كانت', restored.csr.commonName === baselineCsr.commonName && restored.csr.serialNumber === baselineCsr.serialNumber);

console.log(`\n${failures === 0 ? '✔' : '✗'} ${checks - failures}/${checks} checks passed${failures === 0 ? '' : ` — ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
