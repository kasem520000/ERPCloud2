#!/usr/bin/env node
/**
 * Live verification of P-C4 «الباقات والتراخيص والفوترة»
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the console drives — nothing is mocked:
 *
 *   1. 🔐 الجلسة والأبواب — رموز الفوترة الثلاثة، وجلسة مستأجر لا تدخل
 *   2. 🏢 عميل التحقّق — منشأة واحدة مخصّصة للقياس، تُنشأ مرة وتُعاد في كل تشغيل
 *   3. 🏷️ الباقات — السعر والمكافئ الشهري وحقوق الباقة (وحدة · حدّ · راية)
 *   4. ⚙️ إعدادات الفاتورة — هوية البائع والضريبة ومهلة السداد تُقرأ من إعدادات المنصة
 *   5. 🗓️ التراخيص — تفعيل، تجربة، وترخيصٌ حيّ واحد لكل عميل
 *   6. 🔁 تغيير الباقة — الرصيد والمقابل والصافي، ومستندٌ يوزن نفسه
 *   7. 🧾 المستندات — مسودّة بلا رقم، إصدار برقم متسلسل، تحصيل، إلغاء، وطباعة
 *   8. ⏰ المتأخّرة والمتابعة — سلّمٌ يُنفَّذ خطوةً خطوةً ويتوقّف عند السقف
 *   9. 📈 الإيراد — MRR و ARR والمتأخّر وما حُصِّل
 *  10. 🚫 الأبواب المغلقة — دور العمليات يقرأ العملاء ولا يقرأ المستندات
 *  11. 🧹 التنظيف — الإعدادات تعود، والدور المؤقت يُسحب، والترخيص يُلغى
 *
 * Re-runnable: the plan is upserted by its code, the fixture customer is re-used by its code,
 * and every licence this run issues is cancelled in §11. Two residues are stated rather than
 * hidden:
 *
 *   · **المستندات لا تُحذف** — وهذا مقصود لا نقص: التسلسل الضريبي لا يُفرَّغ، فكل تشغيل
 *     يضيف مستنداتٍ بأرقامٍ جديدة. العملاء الحقيقيون لا يقرأون مستندات عميل التحقّق.
 *   · **صفُّ إعدادٍ إضافي** إن كتبنا قيمةً هي الافتراضية نفسها: القيمة الفعلية لا تتغيّر،
 *     والحالة كما كانت.
 *
 * Usage: node scripts/verify-platform-billing.mjs
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
const fixtureCode = process.env.VERIFY_PC4_TENANT ?? 'verify-pc4';

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

async function request(method, path, body, token) {
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
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail ?? parsed.message;
    throw error;
  }
  return parsed.data ?? parsed;
}

/** A call that is *expected* to be refused: its status and detail are the answer. */
async function refused(method, path, body, token = ownerToken) {
  try {
    await request(method, path, body, token);
    return { status: 200, detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, detail: error.detail ?? '' };
  }
}

async function signIn(tenantCode, credentials) {
  // The platform throttles /auth/login per address; a 429 is not a failed check.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const token = login.accessToken ?? login.access_token ?? login.token;
      if (!token) throw new Error(`login failed for ${credentials.email}`);
      return { token, user: login.user };
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const day = 86_400_000;
const dateOnly = (value) => new Date(value).toISOString().slice(0, 10);
const money = (value) => Number(value).toFixed(2);

const ownerSession = await signIn(platformTenant, operator);
const ownerToken = ownerSession.token;
console.log(`✔ logged in to ${platformTenant} as ${operator.email}\n`);

const get = (path, token = ownerToken) => request('get', path, undefined, token);
const post = (path, body, token = ownerToken) => request('post', path, body, token);
const put = (path, body, token = ownerToken) => request('put', path, body, token);
const patch = (path, body, token = ownerToken) => request('patch', path, body, token);

// ═══════════════════════════════════════════════ 1. 🔐 الجلسة والأبواب
console.log('■ 1. 🔐 الجلسة والأبواب — رموز الفوترة الثلاثة');
const ownerMe = await get('/me');
const consoleCodes = ownerMe.platformPermissions ?? [];
for (const code of ['console.plans.manage', 'console.subscriptions.manage', 'console.billing.manage']) {
  check(`المالك يحمل ${code}`, consoleCodes.includes(code));
}
const demoSessionEarly = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
const demoTokenEarly = demoSessionEarly.token;
const tenantDoor = await refused('get', '/platform/invoices', undefined, demoTokenEarly);
check('جلسة العميل لا تدخل الفواتير', tenantDoor.status === 403, String(tenantDoor.status));
// جلسةٌ فارغة صريحة: `refused` تستعمل رمز المالك افتراضاً، وهذا الفحص عن المجهول.
const anonymous = await refused('get', '/platform/invoices', undefined, '');
check('وبلا جلسة: 401', anonymous.status === 401, String(anonymous.status));

// ═══════════════════════════════════════ 2. 🏢 عميل التحقّق (مرة واحدة)
console.log('\n■ 2. 🏢 عميل التحقّق — منشأة القياس');
const foundTenants = await get(`/platform/tenants?search=${fixtureCode}`);
let fixtureTenant = foundTenants.find((tenant) => tenant.code === fixtureCode);
if (!fixtureTenant) {
  const created = await post('/platform/tenants', {
    code: fixtureCode,
    name: 'عميل التحقّق (P-C4)',
    ownerEmail: `${fixtureCode}-owner@erpverify.test`,
    ownerFullName: 'مالك عميل التحقّق',
  });
  check('أُنشئ عميل التحقّق', Boolean(created.tenantId), created.tenantId ?? '');
  fixtureTenant = (await get(`/platform/tenants?search=${fixtureCode}`)).find((tenant) => tenant.code === fixtureCode);
} else {
  console.log(`  · عميل التحقّق موجود من تشغيل سابق (${fixtureTenant.id}) — يُعاد استخدامه`);
}
check('وعميل التحقّق مقروء من اللوحة', Boolean(fixtureTenant?.id), fixtureTenant?.code ?? '—');
const tenantId = fixtureTenant.id;

// ══════════════════════════════════════════════════════════════ 3. 🏷️ الباقات
console.log('\n■ 3. 🏷️ الباقات — السعر والمكافئ الشهري والحقوق');
const catalogue = await get('/platform/plans/entitlement-keys');
const catalogKeys = catalogue.map((entry) => entry.key);
check('فهرس الحقوق يحتوي وحدات المنتج', catalogKeys.includes('feature.pos'), `${catalogue.length} مفتاحاً`);
check('ويحتوي الحدود القابلة للتفاوض', catalogKeys.includes('limits.max_branches'));
check(
  'وكل حقّ يحمل اسماً عربياً',
  catalogue.every((entry) => typeof entry.labelAr === 'string' && entry.labelAr.length > 0),
);
check('والنوع معلَن (وحدة · حدّ · راية)', catalogue.every((entry) => ['module', 'limit', 'flag'].includes(entry.kind)));
check(
  'ولا يُعرض إعدادٌ ليس حقًّا',
  !catalogKeys.includes('branding.sender_name') && !catalogKeys.includes('allow_negative_stock'),
);

const upserted = await post('/platform/plans', {
  code: 'verify-pc4-basic',
  name: 'باقة التحقّق الأساسية',
  interval: 'month',
  amount: '199.00',
  currency: 'SAR',
});
check('باقة التحقّق تُحفظ برمزها', upserted.code === 'verify-pc4-basic' && upserted.amount === '199.00', upserted.amount);
const proPlan = await post('/platform/plans', {
  code: 'verify-pc4-pro',
  name: 'باقة التحقّق الاحترافية',
  interval: 'month',
  amount: '499.00',
  currency: 'SAR',
});
const yearlyPlan = await post('/platform/plans', {
  code: 'verify-pc4-yearly',
  name: 'باقة التحقّق السنوية',
  interval: 'year',
  amount: '4990.00',
  currency: 'SAR',
});
check('المكافئ الشهري للسنوي محسوب', yearlyPlan.monthlyAmount === '415.83', yearlyPlan.monthlyAmount);
check('والشهري كما هو', proPlan.monthlyAmount === '499.00', proPlan.monthlyAmount);

const ent = await put(`/platform/plans/${proPlan.id}/entitlements`, {
  entitlements: [
    { kind: 'module', key: 'feature.pos', value: true },
    { kind: 'limit', key: 'limits.max_branches', value: 5 },
  ],
  reason: 'تحقّق P-C4: حقوق الباقة',
});
check('حقوق الباقة تُكتب مجموعةً', ent.entitlements.length === 2, `${ent.entitlements.length} حقًّا`);
check('وحقّ الوحدة قيمةٌ منطقية', ent.entitlements.find((entry) => entry.key === 'feature.pos')?.value === true);
check('وحدّ الفروع رقم', ent.entitlements.find((entry) => entry.key === 'limits.max_branches')?.value === 5);
check(
  'وكل حقّ باسمه العربي من الفهرس',
  ent.entitlements.every((entry) => entry.labelAr.length > 0),
);
const unknownKey = await refused('put', `/platform/plans/${proPlan.id}/entitlements`, {
  entitlements: [{ kind: 'module', key: 'feature.telepathy', value: true }],
  reason: 'حقّ لا وجود له',
});
check('مفتاح حقٍّ مجهول يُرفض 422', unknownKey.status === 422, String(unknownKey.status));
const wrongValue = await refused('put', `/platform/plans/${proPlan.id}/entitlements`, {
  entitlements: [{ kind: 'module', key: 'feature.pos', value: 'نعم' }],
  reason: 'قيمة بنوع خاطئ',
});
check('وقيمة بنوع خاطئ تُرفض 422', wrongValue.status === 422, String(wrongValue.status));
const duplicate = await refused('put', `/platform/plans/${proPlan.id}/entitlements`, {
  entitlements: [
    { kind: 'limit', key: 'limits.max_branches', value: 3 },
    { kind: 'limit', key: 'limits.max_branches', value: 9 },
  ],
  reason: 'حدّ مكرَّر',
});
check('وحدٌّ مكرَّر يُرفض 422', duplicate.status === 422, String(duplicate.status));
const noReason = await refused('patch', `/platform/plans/${proPlan.id}`, { amount: '489.00' });
check('تعديل باقة بلا سبب يُرفض 400', noReason.status === 400, String(noReason.status));
const patched = await patch(`/platform/plans/${proPlan.id}`, { amount: '499.00', reason: 'تحقّق P-C4: تثبيت السعر' });
check('وبسببٍ مكتوب يمرّ', patched.amount === '499.00', patched.amount);

// ═══════════════════════════════════════════ 4. ⚙️ إعدادات الفاتورة
console.log('\n■ 4. ⚙️ إعدادات الفاتورة — هوية البائع والضريبة والمهلة');
const settingsBefore = await get('/platform/settings');
const settingsMap = Object.fromEntries(settingsBefore.settings.map((setting) => [setting.key, setting.value]));
const billingKeys = [
  'billing.seller_name',
  'billing.seller_tax_number',
  'billing.seller_address',
  'billing.tax_rate',
  'billing.payment_terms_days',
  'billing.dunning_days',
];
for (const key of billingKeys) {
  check(`مفتاح ${key} معلَن بقيمة`, key in settingsMap, String(settingsMap[key]));
}
check('ونسبة الضريبة النظامية 15٪', Number(settingsMap['billing.tax_rate']) === 15, String(settingsMap['billing.tax_rate']));
check(
  'وسلّم المتابعة ثلاثة أيام',
  JSON.stringify(settingsMap['billing.dunning_days']) === JSON.stringify(['0', '3', '7']),
  String(settingsMap['billing.dunning_days']),
);
const termsBefore = settingsMap['billing.payment_terms_days'];
await put('/platform/settings', { values: { 'billing.payment_terms_days': 21 } });
const termsNow = await get('/platform/settings');
check(
  'وكتابة مهلة السداد تعمل',
  Number(termsNow.settings.find((setting) => setting.key === 'billing.payment_terms_days')?.value) === 21,
);

// ════════════════════════════════════════════════════════════ 5. 🗓️ التراخيص
console.log('\n■ 5. 🗓️ التراخيص — تفعيل وتجربة وترخيصٌ حيّ واحد');
const licence = await post('/platform/subscriptions', {
  tenantId,
  planId: upserted.id,
  months: 1,
  billingEmail: `${fixtureCode}-billing@erpverify.test`,
});
check('ترخيص فعّال يُصدر', licence.status === 'active', licence.status);
check('وفترته من اليوم شهراً', Boolean(licence.currentPeriodStart && licence.currentPeriodEnd));
check('والمكافئ الشهري معروض', licence.monthlyAmount === '199.00', licence.monthlyAmount);
check('وبريد الفوترة محفوظ', licence.billingEmail === `${fixtureCode}-billing@erpverify.test`);
check('وقد سُجّل وقت التفعيل', Boolean(licence.activatedAt));

const trial = await post('/platform/subscriptions', { tenantId, planId: upserted.id, months: 1, trialDays: 14 });
check('ترخيص بتجربة يصير trialing', trial.status === 'trialing', trial.status);
check('ونهاية التجربة بعد 14 يوماً', Math.round((Date.parse(trial.trialEndsAt) - Date.now()) / day) === 14);
check(
  'والفترة المدفوعة تبدأ بنهاية التجربة',
  Math.abs(Date.parse(trial.currentPeriodStart) - Date.parse(trial.trialEndsAt)) < day,
);
check('ولا وقت تفعيل في تجربة', trial.activatedAt === null, String(trial.activatedAt));
const activeList = await get('/platform/subscriptions?status=active');
check('الترخيص الأول توقّف: ترخيصٌ حيّ واحد لكل عميل', !activeList.some((row) => row.id === licence.id));
const canceledList = await get('/platform/subscriptions?status=canceled');
check('والسابق محفوظ ملغىً لا محذوفاً', canceledList.some((row) => row.id === licence.id));

// ═══════════════════════════════════════════ 6. 🔁 تغيير الباقة والتناسب
console.log('\n■ 6. 🔁 تغيير الباقة — رصيدٌ ومقابل وصافٍ ومستند');
const upgrade = await post(`/platform/subscriptions/${trial.id}/change-plan`, {
  planId: proPlan.id,
  reason: 'تحقّق P-C4: ترقية من التجربة',
});
check('الترقية عادت بترخيصٍ فعّال', upgrade.subscription.status === 'active', upgrade.subscription.status);
check('والتجربة لا رصيد فيها', upgrade.proration.credit === '0.00', upgrade.proration.credit);
check('فالمقابل كامل سعر الباقة الجديدة', upgrade.proration.charge === '499.00', upgrade.proration.charge);
check('والصافي = المقابل − الرصيد', upgrade.proration.net === '499.00', upgrade.proration.net);
check('والمستند فاتورة', upgrade.invoiceKind === 'invoice', String(upgrade.invoiceKind));

const upgradeDocument = await get(`/platform/invoices/${upgrade.invoiceId}`);
check('المستند مسودّة بلا رقم', upgradeDocument.status === 'draft' && upgradeDocument.number === null);
check(
  'والإجمالي = قبل الضريبة + الضريبة',
  money(Number(upgradeDocument.subtotal) + Number(upgradeDocument.taxAmount)) === money(upgradeDocument.total),
  `${upgradeDocument.subtotal} + ${upgradeDocument.taxAmount} = ${upgradeDocument.total}`,
);
check(
  'والصافي = مجموع السطور',
  money(upgradeDocument.lines.reduce((sum, line) => sum + Number(line.amount), 0)) === money(upgradeDocument.subtotal),
);
check(
  'ونسبة الضريبة من إعدادات المنصة',
  Number(upgradeDocument.taxRate) === Number(settingsMap['billing.tax_rate']),
  upgradeDocument.taxRate,
);
check(
  'ورقم البائع الضريبي مطبوع على المستند',
  /^\d{15}$/.test(upgradeDocument.sellerTaxNumber ?? ''),
  upgradeDocument.sellerTaxNumber ?? '—',
);
check('وسطور المستند معلَنة', upgradeDocument.lines.length >= 1, `${upgradeDocument.lines.length} سطراً`);

const downgrade = await post(`/platform/subscriptions/${trial.id}/change-plan`, {
  planId: upserted.id,
  reason: 'تحقّق P-C4: تخفيض إلى الأساسية',
});
check('التخفيض رصيدٌ أكبر من المقابل', Number(downgrade.proration.net) < 0, downgrade.proration.net);
check('والمستند إشعار دائن', downgrade.invoiceKind === 'credit_note', String(downgrade.invoiceKind));
const downgradeDocument = await get(`/platform/invoices/${downgrade.invoiceId}`);
check('والإشعار سالب بإشارته', Number(downgradeDocument.subtotal) < 0, downgradeDocument.subtotal);
check(
  'وضريبته سالبة بإشارتها',
  Number(downgradeDocument.taxAmount) < 0 &&
    money(Number(downgradeDocument.subtotal) + Number(downgradeDocument.taxAmount)) === money(downgradeDocument.total),
  `${downgradeDocument.taxAmount} · ${downgradeDocument.total}`,
);
const sameplan = await refused('post', `/platform/subscriptions/${trial.id}/change-plan`, {
  planId: upserted.id,
  reason: 'نفس الباقة',
});
check('ونفس الباقة تُرفض 422', sameplan.status === 422, String(sameplan.status));
const noReasonChange = await refused('post', `/platform/subscriptions/${trial.id}/change-plan`, { planId: proPlan.id });
check('وتغيير بلا سبب يُرفض 400', noReasonChange.status === 400, String(noReasonChange.status));

// ══════════════════════════════════════════════════════════ 7. 🧾 المستندات
console.log('\n■ 7. 🧾 المستندات — إصدار وتحصيل وإلغاء وطباعة');
const payBeforeIssue = await refused('post', `/platform/invoices/${upgradeDocument.id}/pay`, { method: 'bank_transfer' });
check('مسودّة لا تُحصَّل 422', payBeforeIssue.status === 422, String(payBeforeIssue.status));
const issued = await post(`/platform/invoices/${upgradeDocument.id}/issue`, { dueInDays: 21 });
check('الإصدار يخصّص رقماً متسلسلاً', /^PINV-\d{5}$/.test(issued.number ?? ''), issued.number ?? '—');
check('ويحدّد تاريخ الاستحقاق من المهلة', issued.dueDate === dateOnly(Date.now() + 21 * day), issued.dueDate);
check('والحالة تصير صادرة', issued.status === 'issued', issued.status);
const secondIssue = await refused('post', `/platform/invoices/${upgradeDocument.id}/issue`, {});
check('ولا تُصدَر مرتين 422', secondIssue.status === 422, String(secondIssue.status));

const partial = await post(`/platform/invoices/${upgradeDocument.id}/pay`, {
  method: 'bank_transfer',
  amount: '100.00',
  reference: 'TRF-VERIFY-1',
});
check('دفعة جزئية تُسجَّل', partial.paidAmount === '100.00', partial.paidAmount);
check('والمتبقّي محسوب', money(Number(partial.total) - 100) === money(partial.remaining), partial.remaining);
check('وباقي المستند صادر لا مدفوع', partial.status === 'issued', partial.status);
const overpay = await refused('post', `/platform/invoices/${upgradeDocument.id}/pay`, {
  method: 'bank_transfer',
  amount: '900.00',
});
check('والدفع أكثر من المتبقّي يُرفض 422', overpay.status === 422, String(overpay.status));
check('والردّ يقول المتبقّي كم هو', overpay.detail.includes(partial.remaining), overpay.detail.slice(0, 70));
const settled = await post(`/platform/invoices/${upgradeDocument.id}/pay`, { method: 'cash' });
check('ثم يُسدَّد كاملاً', settled.status === 'paid' && settled.remaining === '0.00', `${settled.status} · ${settled.remaining}`);
check('وبتاريخ سداد', Boolean(settled.paidAt));
check('ودفعتاه محفوظتان', settled.payments.length === 2, `${settled.payments.length} دفعة`);
const payAgain = await refused('post', `/platform/invoices/${upgradeDocument.id}/pay`, { method: 'cash' });
check('ولا يُحصَّل مرتين 422', payAgain.status === 422, String(payAgain.status));
const voidPaid = await refused('post', `/platform/invoices/${upgradeDocument.id}/void`, { reason: 'إلغاء فاتورة مدفوعة' });
check('والفاتورة المدفوعة لا تُلغى 422', voidPaid.status === 422, voidPaid.detail.slice(0, 60));

const creditIssued = await post(`/platform/invoices/${downgradeDocument.id}/issue`, {});
check('الإشعار الدائن له سلسلته الخاصة', /^PCN-\d{5}$/.test(creditIssued.number ?? ''), creditIssued.number ?? '—');
const creditVoided = await post(`/platform/invoices/${downgradeDocument.id}/void`, { reason: 'تحقّق P-C4: إلغاء الإشعار' });
check('والإشعار يُلغى بسببٍ مكتوب', creditVoided.status === 'void', creditVoided.status);
check('ورقمه يبقى عليه بعد الإلغاء', creditVoided.number === creditIssued.number, creditVoided.number ?? '—');

const printed = await get(`/platform/invoices/${upgradeDocument.id}/print`);
const html = printed.html ?? '';
check('الطباعة تُخرج ورقة كاملة', html.startsWith('<!doctype html>'), `${html.length} حرفاً`);
check('بعنوان ضريبي', html.includes('فاتورة ضريبية'));
check('ورقم الفاتورة مطبوع', html.includes(issued.number ?? 'PINV-—'));
check('وبيانات البائع مطبوعة', html.includes(upgradeDocument.sellerName) && html.includes('الرياض'));
check('والإجمالي بالحروف (تفقيط)', html.includes('بالحروف') && html.includes('لا غير'));
check('ورمز ZATCA مرسوم (QR)', html.includes('<svg'));
check('والورقة مكتفية بذاتها', !html.includes('<link') && !html.includes('<img') && !html.includes('url(http'));

// ═══════════════════════ 8. ⏸️ الإيقاف المؤقّت والاستئناف (وأثره على الإيراد)
console.log('\n■ 8. ⏸️ الإيقاف المؤقّت والاستئناف — الأيام المتوقّفة تُعاد');
const revenueBeforePause = await get('/platform/revenue');
// القراءة من اللوحة لا من الكائن القديم: تغييرا الباقة أعادا ضبط نهاية المدة.
const periodEndBeforePause = Date.parse(
  (await get('/platform/subscriptions')).find((row) => row.id === trial.id).currentPeriodEnd,
);
const paused = await post(`/platform/subscriptions/${trial.id}/pause`, { reason: 'تحقّق P-C4: إيقاف مؤقّت' });
check('الإيقاف المؤقّت يعمل', paused.status === 'paused', paused.status);
check('وبوقت الإيقاف مسجَّل', Boolean(paused.pausedAt));
const pauseAgain = await refused('post', `/platform/subscriptions/${trial.id}/pause`, { reason: 'إيقاف مكرَّر' });
check('ولا يُوقَف مرتين 422', pauseAgain.status === 422, String(pauseAgain.status));
const revenueWhilePaused = await get('/platform/revenue');
check(
  'والموقوف مؤقتاً يخرج من الإيراد المتكرّر',
  money(Number(revenueBeforePause.mrr) - Number(trial.monthlyAmount)) === revenueWhilePaused.mrr,
  `${revenueBeforePause.mrr} → ${revenueWhilePaused.mrr} (ناقص ${trial.monthlyAmount})`,
);
check('وعدّاد الموقوفة يرتفع', revenueWhilePaused.counts.paused >= 1, String(revenueWhilePaused.counts.paused));
const resumed = await post(`/platform/subscriptions/${trial.id}/resume`, { reason: 'تحقّق P-C4: عاد النشاط' });
check('والاستئناف يعيده فعّالاً', resumed.status === 'active', resumed.status);
check('وبوقت الاستئناف مسجَّل', Boolean(resumed.resumedAt));
check(
  'والأيام المتوقّفة تُعاد إلى نهاية المدة',
  Date.parse(resumed.currentPeriodEnd) >= periodEndBeforePause,
  `${dateOnly(periodEndBeforePause)} → ${dateOnly(resumed.currentPeriodEnd)}`,
);
const resumeAgain = await refused('post', `/platform/subscriptions/${trial.id}/resume`, { reason: 'استئناف بلا إيقاف' });
check('ولا يُستأنف ما ليس موقوفاً 422', resumeAgain.status === 422, String(resumeAgain.status));
check(
  'والإيراد يعود بعد الاستئناف',
  money(Number(revenueBeforePause.mrr)) === money((await get('/platform/revenue')).mrr),
  revenueBeforePause.mrr,
);

// ══════════════════════════════════════════ 9. ⏰ المتأخّرة والمتابعة
console.log('\n■ 9. ⏰ المتأخّرة والمتابعة — سلّمٌ يُنفَّذ ويتوقّف عند السقف');
const lateLicence = await post('/platform/subscriptions', { tenantId, planId: proPlan.id, months: 1 });
check('ترخيص ثالث للفاتورة المتأخّرة', lateLicence.status === 'active', lateLicence.status);
const overdueDraft = await post('/platform/invoices', {
  subscriptionId: lateLicence.id,
  buyerTaxNumber: '300000000000003',
  reason: 'تحقّق P-C4: فاتورة متأخّرة',
});
check('مسودّة الفاتورة المتأخّرة بلا رقم', overdueDraft.status === 'draft' && overdueDraft.number === null);
check('والرقم الضريبي للمشتري محفوظ عليها', overdueDraft.buyerTaxNumber === '300000000000003');
const overdueIssued = await post(`/platform/invoices/${overdueDraft.id}/issue`, {
  dueDate: dateOnly(Date.now() - 5 * day),
});
check('تُصدَر بتاريخ استحقاق ماضٍ', overdueIssued.daysOverdue >= 4, `${overdueIssued.daysOverdue} يوماً`);
const overduePrinted = await get(`/platform/invoices/${overdueDraft.id}/print`);
check('والرقم الضريبي للمشتري مطبوع', (overduePrinted.html ?? '').includes('300000000000003'));

const board = await get('/platform/dunning');
check('السلّم المعلَن ثلاثة أيام', JSON.stringify(board.ladderDays) === JSON.stringify([0, 3, 7]), board.ladderDays.join('·'));
check('وسقف المحاولات ثلاث', board.maxAttempts === 3, String(board.maxAttempts));
const scheduled = board.schedule.find((row) => row.invoiceId === overdueDraft.id);
check('والفاتورة المتأخّرة في الجدول', Boolean(scheduled), scheduled ? `${scheduled.attemptsMade} محاولة` : '—');
check('ودورها القادم معروض', Boolean(scheduled?.nextAttemptAt), scheduled?.nextAttemptAt?.slice(0, 10) ?? '—');
check('والمتبقّي عليها معلَن', Number(scheduled?.remaining) > 0, scheduled?.remaining ?? '—');

const run1 = await post(`/platform/dunning/${lateLicence.id}/run`, { channel: 'email', invoiceId: overdueDraft.id });
check('المحاولة الأولى تُنشأ', run1.created.length === 1 && run1.created[0].attemptNo === 1, String(run1.created.length));
check(
  'وتُسجَّل مجدولةً: لا خدمة بريد بعد فلا ندّعي إرسالاً',
  run1.created[0]?.status === 'scheduled',
  run1.created[0]?.status ?? '—',
);
check('ورسالتها تحمل رقم الفاتورة', (run1.created[0]?.message ?? '').includes(overdueIssued.number ?? 'PINV-—'));
check('والتأخّر يقلب حالة الترخيص إلى past_due', run1.subscriptionStatus === 'past_due', run1.subscriptionStatus);
const run2 = await post(`/platform/dunning/${lateLicence.id}/run`, { channel: 'manual', invoiceId: overdueDraft.id });
check('والمحاولة الثانية برقمها', run2.created[0]?.attemptNo === 2, String(run2.created[0]?.attemptNo));
check('والاتّصال اليدوي يُسجَّل مُرسَلاً', run2.created[0]?.status === 'sent', run2.created[0]?.status ?? '—');
const run3 = await post(`/platform/dunning/${lateLicence.id}/run`, { channel: 'email', invoiceId: overdueDraft.id });
check('والثالثة كذلك', run3.created[0]?.attemptNo === 3, String(run3.created[0]?.attemptNo));
const run4 = await post(`/platform/dunning/${lateLicence.id}/run`, { channel: 'email', invoiceId: overdueDraft.id });
check('والرابعة لا تُنشأ', run4.created.length === 0, String(run4.created.length));
check('بل تُتجاوَز بسببها المعلَن', (run4.skipped[0]?.reason ?? '').includes('استُنفدت'), run4.skipped[0]?.reason ?? '—');
const ledger = await get(`/platform/dunning?subscriptionId=${lateLicence.id}`);
check('والسجلّ يعرض المحاولات الثلاث', ledger.attempts.length >= 3, `${ledger.attempts.length} محاولة`);
check(
  'بأرقامها المتسلسلة',
  [...new Set(ledger.attempts.map((attempt) => attempt.attemptNo))].sort().join(',') === '1,2,3',
  ledger.attempts.map((attempt) => attempt.attemptNo).join(','),
);
check(
  'وبرسائلها المكتوبة',
  ledger.attempts.every((attempt) => typeof attempt.message === 'string' && attempt.message.length > 10),
);

// ══════════════════════════════════════════════════════════════ 10. 📈 الإيراد
console.log('\n■ 10. 📈 الإيراد — MRR و ARR والمتأخّر وما حُصِّل');
const revenue = await get('/platform/revenue');
check('MRR رقمٌ بمنزلتين', /^\d+\.\d{2}$/.test(revenue.mrr), revenue.mrr);
check('وARR = MRR × 12', money(Number(revenue.mrr) * 12) === revenue.arr, `${revenue.mrr} × 12 = ${revenue.arr}`);
check('المتأخّر محسوب', Number(revenue.overdue) > 0, `${revenue.overdue} ${revenue.currency}`);
check('وعدد الفواتير المتأخّرة معلَن', revenue.overdueCount >= 1, String(revenue.overdueCount));
check('والمتأخّرة تحمل ترخيصنا', revenue.upcoming.some((row) => row.invoiceId === overdueDraft.id));
check(
  'وكل متأخّرة لها أيام تأخير محسوبة',
  revenue.upcoming.filter((row) => row.daysOverdue > 0).length >= 1,
  String(revenue.overdueCount),
);
check('وعدّادات التراخيص تُقرأ', revenue.counts.pastDue >= 1, JSON.stringify(revenue.counts));
check('والمحصَّل هذا الشهر رقمٌ بمنزلتين', /^\d+\.\d{2}$/.test(revenue.collectedThisMonth), revenue.collectedThisMonth);

const overduePaid = await post(`/platform/invoices/${overdueDraft.id}/pay`, { method: 'bank_transfer' });
check('سداد المتأخّرة', overduePaid.status === 'paid', overduePaid.status);
const afterPay = await get('/platform/revenue');
check('فتخرج من قائمة المتأخّرات', !afterPay.upcoming.some((row) => row.invoiceId === overdueDraft.id));
check(
  'والمتأخّر ينقص بمقدارها',
  Number(afterPay.overdue) <= Number(revenue.overdue),
  `${revenue.overdue} → ${afterPay.overdue}`,
);
check(
  'والمحصَّل يزيد',
  Number(afterPay.collectedThisMonth) >= Number(revenue.collectedThisMonth),
  `${revenue.collectedThisMonth} → ${afterPay.collectedThisMonth}`,
);

// ══════════════════════════════════════════════ 11. 🚫 الأبواب المغلقة
console.log('\n■ 11. 🚫 الأبواب المغلقة — العمليات تقرأ العملاء ولا تقرأ المستندات');
const demoUser = (await get(`/platform/users?search=${encodeURIComponent(demo.email)}`)).find(
  (row) => row.email === demo.email,
);
if (demoUser) {
  const granted = await post(`/platform/users/${demoUser.id}/roles`, {
    roleCode: 'platform_support',
    reason: 'تحقّق P-C4: قياس أبواب الفوترة',
  });
  check(
    'دور العمليات مُنح مؤقتاً',
    granted.roleCode === 'platform_support' && Boolean(granted.grantedAt),
    granted.grantedAt ?? '—',
  );
  const supportSession = await signIn(demo.tenantCode, { email: demo.email, password: demo.password });
  const supportToken = supportSession.token;
  const supportTenants = await refused('get', '/platform/tenants', undefined, supportToken);
  check('العمليات تقرأ العملاء', supportTenants.status === 200, String(supportTenants.status));
  const supportPlans = await refused('get', '/platform/plans', undefined, supportToken);
  check('ولا تقرأ الباقات 403', supportPlans.status === 403, supportPlans.detail.slice(0, 60));
  const supportInvoices = await refused('get', '/platform/invoices', undefined, supportToken);
  check('ولا المستندات 403', supportInvoices.status === 403, supportInvoices.detail.slice(0, 60));
  const supportRevenue = await refused('get', '/platform/revenue', undefined, supportToken);
  check('ولا الإيراد 403', supportRevenue.status === 403, String(supportRevenue.status));
  const supportWrite = await refused(
    'post',
    '/platform/subscriptions',
    { tenantId, planId: upserted.id, months: 1 },
    supportToken,
  );
  check('ولا تُصدر ترخيصاً 403', supportWrite.status === 403, String(supportWrite.status));
  const revoked = await request(
    'delete',
    `/platform/users/${demoUser.id}/roles/platform_support`,
    undefined,
    ownerToken,
  );
  check('والدور يُسحب بعد القياس', Boolean(revoked.revokedAt), revoked.revokedAt ?? '—');
  const afterRevoke = await get(`/platform/users/${demoUser.id}`);
  check(
    'ويسقط من بطاقة المستخدم',
    !(afterRevoke.platformRoles ?? []).includes('platform_support'),
    (afterRevoke.platformRoles ?? []).join(',') || 'بلا أدوار',
  );
} else {
  check('حساب العميل التجريبي موجود لقياس الأبواب', false, demo.email);
}

// ════════════════════════════════════════════════════════════════ 12. 🧹 التنظيف
console.log('\n■ 12. 🧹 التنظيف — الإعدادات تعود والتراخيص تُلغى');
await put('/platform/settings', { values: { 'billing.payment_terms_days': Number(termsBefore) } });
const settingsAfter = await get('/platform/settings');
const termsAfter = settingsAfter.settings.find((setting) => setting.key === 'billing.payment_terms_days')?.value;
check('مهلة السداد عادت', Number(termsAfter) === Number(termsBefore), `${termsBefore} → ${termsAfter}`);

const canceledLate = await post(`/platform/subscriptions/${lateLicence.id}/cancel`, {
  reason: 'تحقّق P-C4: انتهى القياس',
});
check('ترخيص التحقّق الأخير أُلغي', canceledLate.status === 'canceled', canceledLate.status);
check('وبسببٍ محفوظ', canceledLate.canceledReason === 'تحقّق P-C4: انتهى القياس', canceledLate.canceledReason ?? '—');
// ترخيص التجربة أُلغي ضمناً حين أُصدر الترخيص الثالث (ترخيصٌ حيّ واحد لكل عميل)،
// فمحاولة إلغائه مرة أخرى هي الاختبار: تُرفض برسالة لا بانهيار.
const canceledTrial = await refused('post', `/platform/subscriptions/${trial.id}/cancel`, {
  reason: 'تحقّق P-C4: انتهى القياس',
});
check('وإلغاء ما أُلغي يُرفض 422', canceledTrial.status === 422, canceledTrial.detail.slice(0, 60));
const canceledNow = await get('/platform/subscriptions?status=canceled');
check(
  'وترخيص التجربة وترخيص المتأخّرة كلاهما ملغى',
  canceledNow.some((row) => row.id === trial.id) && canceledNow.some((row) => row.id === lateLicence.id),
);
const liveAfter = await get('/platform/subscriptions?status=active');
check('ولا يبقى لعميل التحقّق ترخيصٌ حيّ', !liveAfter.some((row) => row.tenantId === tenantId));
const cancelAgain = await refused('post', `/platform/subscriptions/${trial.id}/cancel`, { reason: 'إلغاء مكرَّر' });
check('والإلغاء لا يتكرّر 422', cancelAgain.status === 422, String(cancelAgain.status));
const pauseCanceled = await refused('post', `/platform/subscriptions/${trial.id}/pause`, { reason: 'إيقاف ملغى' });
check('ولا يُوقَف ملغىً 422', pauseCanceled.status === 422, String(pauseCanceled.status));

const finalRevenue = await get('/platform/revenue');
check('وعدّاد الملغاة يرتفع', finalRevenue.counts.canceled >= 2, String(finalRevenue.counts.canceled));
check('وMRR لا يسلّب', Number(finalRevenue.mrr) >= 0, finalRevenue.mrr);

// ═══════════════════════════════════════════════════════════════ الخلاصة
console.log(`\n${'─'.repeat(70)}`);
console.log(` نقاط التحقّق: ${checks} · نجحت: ${checks - failures} · فشلت: ${failures}`);
console.log(`${'─'.repeat(70)}`);
process.exit(failures === 0 ? 0 : 1);
