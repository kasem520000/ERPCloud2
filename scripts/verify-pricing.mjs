/**
 * verify-pricing.mjs — التحقّق الحيّ لـ P-M3 «الباقات والأسعار»
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5) على مساحةٍ تعمل
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * ويقيس **الطريق كاملاً لا المخرَج**: باقةٌ تُكتب في لوحة المنصة ⇒ تظهر في `/public/plans`
 * ⇒ تظهر في HTML صفحة `/pricing` — وبلا إعادة تشغيل ولا نشرة كود (زمن إعادة التحقّق صفر في
 * التطوير). وأربعة أقسام:
 *
 *   1. 🔓 الواجهة العامة — بلا جلسة، النشطة وحدها، وبلا معرّف مزوّد الدفع.
 *   2. 🧮 الأرقام والحقوق — العملة، والمكافئ الشهري مقابل ما يُدفع في السنة، والحقوق بلغتين.
 *   3. 🖥️ الصفحة المعروضة — الجدول والمبدّل وملاحظة الضريبة وأسئلة التسعير والبيانات المنظَّمة.
 *   4. ✍️ من اللوحة إلى الموقع — إنشاء باقة بحقٍّ، تغيير سعرها، ثم إيقافها فيختفي كل ذلك.
 *
 * **والتنظيف مقصود**: باقة التحقّق تُترك موقوفةً لا محذوفة (السعر يبقى تاريخاً في التدقيق)،
 * ونسبة الضريبة تعود إلى ما كانت. ولا يُلمس سعر باقةٍ حقيقية.
 *
 * Usage: node scripts/verify-pricing.mjs
 */
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

const stamp = Date.now().toString(36);
const verificationCode = `verify-pm3-${stamp}`;

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
    throw error;
  }
  return { status: response.status, data: parsed.data, meta: parsed.meta, raw: parsed };
}

const get = (path, options) => call('get', path, options);
const post = (path, body, token) => call('post', path, { body, token });
const put = (path, body, token) => call('put', path, { body, token });
const patch = (path, body, token) => call('patch', path, { body, token });

async function page(path) {
  const response = await fetch(`${siteBase}${path}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
}

async function signIn() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await call('post', '/auth/login', { body: { tenantCode: platformTenant, ...operator } });
      const token = login.data?.accessToken ?? login.data?.access_token ?? login.data?.token;
      if (!token) throw new Error('login failed');
      return token;
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
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

let planId = null;
let taxRateBefore = null;

try {
  // ══════════════════════════════════════════════════════ 1. 🔓 الواجهة العامة
  console.log(`■ 1. 🔓 الواجهة العامة — ${apiBase}/public/plans`);
  const anonymous = await get('/public/plans');
  check('الباقات العامة تُقرأ بلا جلسة', anonymous.status === 200 && Array.isArray(anonymous.data));
  const plans = anonymous.data;
  check('وفيها باقاتٌ معلنة', plans.length > 0, `${plans.length} باقة`);

  for (const plan of plans) {
    check(
      `كل باقة تحمل السعر والدورة (${plan.code})`,
      typeof plan.amount === 'string' && /^\d+\.\d{2}$/.test(plan.amount) && ['month', 'year'].includes(plan.interval),
      `${plan.amount} ${plan.currency} / ${plan.interval}`,
    );
  }
  check(
    'والعملة SAR في كل الباقات',
    plans.every((plan) => plan.currency === 'SAR'),
    [...new Set(plans.map((plan) => plan.currency))].join(', '),
  );
  check(
    'ولا يُسرَّب معرّف مزوّد الدفع ولا راية النشاط',
    !JSON.stringify(anonymous.raw).includes('stripe') && !('active' in plans[0]) && !('activeSubscriptions' in plans[0]),
    Object.keys(plans[0]).join(','),
  );
  const token = await signIn();
  const adminPlans = await get('/platform/plans', { token });
  check(
    'وكل ما يُعرض نشطٌ في اللوحة',
    plans.every((plan) => adminPlans.data.find((entry) => entry.id === plan.id)?.active === true),
  );

  // ══════════════════════════════════════════════════════ 2. 🧮 الأرقام والحقوق
  console.log('\n■ 2. 🧮 الأرقام والحقوق — السعر مقابل ما تحصل عليه');
  const monthly = plans.filter((plan) => plan.interval === 'month');
  const yearly = plans.filter((plan) => plan.interval === 'year');
  check('الباقات معلنة بالدورتين', monthly.length > 0 && yearly.length > 0, `${monthly.length} شهري · ${yearly.length} سنوي`);

  const yearlyPlan = yearly[0];
  const monthlyEquivalent = Number(yearlyPlan.monthlyAmount);
  const yearlyAmount = Number(yearlyPlan.amount);
  check(
    'المكافئ الشهري للسنوي = المبلغ ÷ 12',
    Math.abs(monthlyEquivalent - yearlyAmount / 12) < 0.01,
    `${yearlyAmount} ÷ 12 = ${monthlyEquivalent}`,
  );
  check('وما يُدفع في السنة للسنوي هو مبلغها', yearlyPlan.annualAmount === yearlyPlan.amount, yearlyPlan.annualAmount);
  check(
    'وللشهرية اثنا عشر شهراً',
    monthly.every((plan) => Number(plan.annualAmount) === Number(plan.amount) * 12),
    monthly.map((plan) => `${plan.amount}×12=${plan.annualAmount}`).join(' · '),
  );
  check(
    'والترتيب بالمكافئ الشهري تصاعدياً',
    plans.every((plan, index) => index === 0 || Number(plans[index - 1].monthlyAmount) <= Number(plan.monthlyAmount)),
    plans.map((plan) => `${plan.code}:${plan.monthlyAmount}`).join(' ≤ '),
  );
  const savingPercent = (() => {
    const family = (code) => code.replace(/-(monthly|yearly)$/, '');
    const twin = monthly.find((plan) => family(plan.code) === family(yearlyPlan.code));
    if (!twin) return null;
    const base = Number(twin.amount) * 12;
    return Math.round(((base - yearlyAmount) / base) * 100);
  })();
  check('والتوفير السنوي يُحسب من أرقام الباقتين', savingPercent === null || savingPercent > 0, `${savingPercent ?? '—'}%`);

  const entitled = plans.filter((plan) => plan.entitlements.length > 0);
  check('الحقوق معلنةٌ لكل باقة', entitled.length === plans.length, `${entitled.length}/${plans.length}`);
  check(
    'وكل حقٍّ يحمل معرّفاً ونوعاً واسمين (عربي وإنجليزي)',
    plans.every((plan) =>
      plan.entitlements.every(
        (entry) =>
          entry.key.length > 0 &&
          ['module', 'limit', 'flag'].includes(entry.kind) &&
          entry.labelAr.length > 0 &&
          entry.labelEn.length > 0,
      ),
    ),
  );
  const allEntitlements = [...new Set(plans.flatMap((plan) => plan.entitlements.map((entry) => entry.key)))];
  check('والحدود القابلة للمقارنة موجودة', allEntitlements.includes('limits.max_users') && allEntitlements.includes('limits.max_branches'), allEntitlements.length + ' مفتاحاً');
  const posEntry = plans.flatMap((plan) => plan.entitlements).find((entry) => entry.key === 'feature.pos');
  check(
    'واسم حزمة المنتج من سجلّ المنتج لا من ترجمة الواجهة',
    posEntry?.labelAr === 'نقطة البيع' && posEntry?.labelEn === 'Point of sale',
    posEntry ? `${posEntry.labelAr} / ${posEntry.labelEn}` : '—',
  );
  const numbers = plans.flatMap((plan) => plan.entitlements.filter((entry) => typeof entry.value === 'number'));
  check('وقيم الحدود أعدادٌ صحيحة موجبة', numbers.every((entry) => Number.isInteger(entry.value) && entry.value >= 0), `${numbers.length} حدًّا`);

  // ══════════════════════════════════════════════════════ 3. 🖥️ الصفحة المعروضة
  console.log('\n■ 3. 🖥️ الصفحة المعروضة — /pricing');
  const pricing = await page('/pricing');
  const pricingText = textOf(pricing.html);
  check('الصفحة تُخدَم', pricing.status === 200);
  check('وفيها عنوانها', pricingText.includes('الباقات والأسعار'));
  check(
    'وأسماء الباقات الشهرية المعلنة نفسها',
    monthly.every((plan) => pricingText.includes(plan.name)),
    monthly.map((plan) => plan.name).join(' · '),
  );
  const yearlyView = await page('/pricing?interval=year');
  const yearlyText = textOf(yearlyView.html);
  check('وللوجه السنوي صفحةٌ على الخادم لا زرٌّ في المتصفح', yearlyView.status === 200 && yearly.every((plan) => yearlyText.includes(plan.name)), yearly.map((plan) => plan.name).join(' · '));
  // العرض ينسّق الأرقام (`4,990.00`) والـAPI يرسلها خامّة (`4990.00`) — يُقاس الرقم لا الفاصلة.
  const withoutSeparators = yearlyText.replace(/,/g, '');
  check(
    'وفيها مبلغ السنة والمكافئ الشهري',
    yearly.every((plan) => withoutSeparators.includes(plan.amount) && withoutSeparators.includes(plan.monthlyAmount)),
    yearly.map((plan) => `${plan.amount}/${plan.monthlyAmount}`).join(' · '),
  );
  check('وتُعلن توفير السنة المئوي', /وفّر|Save/.test(yearlyText) && String(savingPercent) !== 'null' && yearlyText.includes(`${savingPercent}%`), `${savingPercent}%`);
  check(
    'والأسعار كما في الـAPI',
    plans.filter((plan) => plan.interval === 'month').every((plan) => pricingText.includes(plan.amount)),
    plans.filter((plan) => plan.interval === 'month').map((plan) => plan.amount).join(' · '),
  );
  check(
    'ومبدّل شهري/سنوي رابطٌ إلى الوجهين',
    pricingText.includes('شهري') && pricingText.includes('سنوي') && pricing.html.includes('/pricing?interval=year'),
  );
  check('وجدول مقارنة بعناوين الحقوق', pricingText.includes('مقارنة الباقات بالحقوق') && pricingText.includes('المستخدمون') && pricingText.includes('الفروع'));
  check('وصفّ الوحدات', plans.some((plan) => plan.entitlements.some((entry) => entry.key.startsWith('feature.'))) && pricingText.includes('نقطة البيع'));
  check('وصفّ بوابات الدفع بمصدره', pricingText.includes('بوابات الدفع') && pricing.html.includes('apps/api/src/modules/payments/gateways/index.ts'));
  check('ورابط الجدول إلى المصدر العام', pricing.html.includes('GET /public/plans'));
  const vatRate = anonymous.meta?.vatRatePercent ?? anonymous.raw.meta?.vatRatePercent;
  check('ونسبة الضريبة معلنة من المنصة', Number.isFinite(vatRate), `${vatRate}%`);
  check('وملاحظة الضريبة في الصفحة تحمل النسبة نفسها', pricingText.includes('لا تشمل ضريبة القيمة المضافة') && pricingText.includes(String(vatRate)));
  check('وأسئلة التسعير الثمانية', (pricing.html.match(/<details>/g) ?? []).length === 8);
  check('ودعوتان للتسجيل والتواصل', pricing.html.includes('/onboarding') && pricing.html.includes('/contact'));
  check(
    'وبيانات منظَّمة Product وFAQPage',
    ['Product', 'FAQPage'].every((type) => pricing.html.includes(`"@type":"${type}"`)),
  );
  check('وcanonical للصفحة', /rel="canonical" href="[^"]*\/pricing"/.test(pricing.html));
  const sitemap = await (await fetch(`${siteBase}/sitemap.xml`)).text();
  check('والصفحة في خريطة الموقع', sitemap.includes('/pricing'));
  check('ودعوة الاشتراك تحمل رمز الباقة', pricing.html.includes(`/onboarding?plan=`), 'رمز الباقة في الرابط');

  // ══════════════════════════════════════════════════════ 4. ✍️ من اللوحة إلى الموقع
  console.log('\n■ 4. ✍️ من اللوحة إلى الموقع — باقةٌ تُكتب فتظهر، وتُوقف فتختفي');
  const created = await post(
    '/platform/plans',
    { code: verificationCode, name: `باقة التحقّق ${stamp}`, interval: 'month', amount: '79.00', currency: 'SAR' },
    token,
  );
  planId = created.data.id;
  check('باقة التحقّق تُنشأ من اللوحة', Boolean(planId), verificationCode);

  const unknownKey = await put(
    `/platform/plans/${planId}/entitlements`,
    { entitlements: [{ kind: 'limit', key: 'limits.max_telepathy', value: 9 }], reason: 'قياس P-M3' },
    token,
  ).catch((error) => ({ status: error.status }));
  check('وحقٌّ لا وجود له في المنتج يُرفض', unknownKey.status === 422, String(unknownKey.status));

  await put(
    `/platform/plans/${planId}/entitlements`,
    {
      entitlements: [
        { kind: 'limit', key: 'limits.max_users', value: 7 },
        { kind: 'module', key: 'feature.projects', value: true },
      ],
      reason: 'قياس P-M3: حقوق باقة التحقّق',
    },
    token,
  );
  let publicNow = (await get('/public/plans')).data;
  let verificationPlan = publicNow.find((plan) => plan.code === verificationCode);
  check('والباقة الجديدة تظهر في الـAPI العام', Boolean(verificationPlan), verificationPlan?.amount ?? '—');
  check(
    'بحقوقها بلغتين',
    verificationPlan?.entitlements.find((entry) => entry.key === 'limits.max_users')?.value === 7 &&
      verificationPlan?.entitlements.find((entry) => entry.key === 'feature.projects')?.labelEn === 'Projects',
  );

  const withNewPlan = textOf((await page('/pricing')).html);
  check('وتظهر في الصفحة المعروضة بلا نشرة', withNewPlan.includes(`باقة التحقّق ${stamp}`) && withNewPlan.includes('79.00'));
  check('وحقّها الجديد يظهر في الجدول', withNewPlan.includes('المشاريع'));

  await patch(`/platform/plans/${planId}`, { amount: '69.00', reason: 'قياس P-M3: تعديل السعر' }, token);
  publicNow = (await get('/public/plans')).data;
  check(
    'وتعديل السعر يظهر فوراً في الـAPI',
    publicNow.find((plan) => plan.code === verificationCode)?.amount === '69.00',
    publicNow.find((plan) => plan.code === verificationCode)?.amount ?? '—',
  );
  check('وفي الصفحة كذلك', textOf((await page('/pricing')).html).includes('69.00'));

  await patch(`/platform/plans/${planId}`, { active: false, reason: 'قياس P-M3: انتهى القياس' }, token);
  publicNow = (await get('/public/plans')).data;
  check('وبعد الإيقاف تختفي من الـAPI', !publicNow.some((plan) => plan.code === verificationCode));
  const afterPause = textOf((await page('/pricing')).html);
  check('ومن الصفحة أيضاً', !afterPause.includes(`باقة التحقّق ${stamp}`));
  check(
    'وبقيت اللوحة تراها (الإيقاف لا الحذف)',
    (await get('/platform/plans', { token })).data.some((plan) => plan.code === verificationCode),
  );

  // ══════════════════════════════════════════════════════ 5. 🧾 الضريبة من الإعدادات
  console.log('\n■ 5. 🧾 الضريبة — الرقم من إعدادات المنصة لا من نصٍّ في الصفحة');
  const settings = await get('/platform/settings', { token });
  taxRateBefore = Number(settings.data.settings.find((setting) => setting.key === 'billing.tax_rate')?.value ?? vatRate);
  await put('/platform/settings', { values: { 'billing.tax_rate': 6 } }, token);
  const afterRate = await get('/public/plans');
  check('تغيير الإعداد يغيّر ما يعلنه الـAPI', afterRate.meta?.vatRatePercent === 6, String(afterRate.meta?.vatRatePercent));
  check('والصفحة تعلن النسبة الجديدة', textOf((await page('/pricing')).html).includes('6'));
  await put('/platform/settings', { values: { 'billing.tax_rate': taxRateBefore } }, token);
  const restored = await get('/public/plans');
  check('وتعود النسبة كما كانت', restored.meta?.vatRatePercent === taxRateBefore, String(restored.meta?.vatRatePercent));
} catch (error) {
  failures += 1;
  console.error(`\n✗ توقّف التحقّق: ${error.message}`);
} finally {
  // تنظيف الأنظمة: النسبة تعود، وباقة التحقّق تبقى موقوفة (لا تُحذف: السعر تاريخٌ مدقَّق).
  try {
    if (taxRateBefore !== null) {
      const token = await signIn();
      await put('/platform/settings', { values: { 'billing.tax_rate': taxRateBefore } }, token);
      if (planId) {
        await call('patch', `/platform/plans/${planId}`, {
          token,
          body: { active: false, reason: 'تنظيف تحقّق P-M3' },
          allowFailure: true,
        });
      }
    }
  } catch {
    /* التنظيف لا يُفشل التحقّق: الأرقام أعلاه هي الحكم */
  }
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} نقطة تحقّق ناجحة`);
  process.exit(failures === 0 ? 0 : 1);
}
