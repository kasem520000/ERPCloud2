#!/usr/bin/env node
/**
 * Live verification of P-C12 «التحليلات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4) against a
 * running stack (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API — nothing is mocked — and it is **read-only**: لا ينشئ عميلاً ولا
 * ترخيصاً ولا فاتورة، ولا يحتاج تنظيفاً بعد التشغيل. وهذا مقصود: هذا الجزء كله قراءة، فلو
 * احتاج التحقّق منه كتابةً لكان في التصميم شيءٌ يستحقّ السؤال.
 *
 *   1. 🔐 الأبواب — `console.analytics.view`: المشغّل يقرأ، ورمز العميل 403، والمجهول 401
 *   2. 🧮 النظرة العامة — التعريفات الأربعة معلَنة، و`mrr`/`arr` **حرفاً بحرف** كما في لوحة
 *      الإيراد (P-C4)، و`counts.total` يطابق عدد المنشآت الحقيقي
 *   3. 📈 منحنى الإيراد — طوله بطول النافذة المطلوبة، والقائم في آخر شهر يطابق `mrr`
 *   4. 📉 التسرّب — مرّتين (شعارات ومال)، والمقام معلَن، **ولا كذبة الصفر**: منشأةٌ بمقامٍ
 *      صفري تعطي `null` لا «٠٪»
 *   5. 🕳️ قمع التفعيل — أربع خطوات مرتّبة متناقصة، والأولى بلا «نسبة من السابقة»، والوسيط
 *      والمئين ٩٠ مقيَّسان، والنافذة الضيّقة تُغيّر العدّ فعلاً
 *   6. 👥 الأفواج — عدد الصفوف = عدد الأشهر، والخلايا مثلّثية، وكل خليّة تحمل مقامها
 *   7. 📊 الاستخدام لكل باقة — ثمانية مقاييس بالترتيب نفسه، و`utilization` بلا حدّ = `null`
 *   8. ⛔ الحدود — كل نافذةٍ خارج العقد تُردّ 400 (لا تُقصّ بصمت)
 *   9. 🧾 ملف CSV — ترويسةٌ تطابق أعمدة العقد حرفاً بحرف، وعدد الأسطر = المنشآت + سطران،
 *      ولا `NaN` ولا `undefined` في الملف (أصدق اختبارٍ لتنسيق المال)
 *
 * Usage: node scripts/verify-platform-analytics.mjs
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

/**
 * أعمدة الملف كما هي في العقد `analyticsExportColumns` (P-C12) — مكتوبةٌ هنا **صراحةً لا
 * باستيراد**: هذا السكربت يقيس الـAPI، ولو استورد القائمة التي يقيسها لكان يقيس نفسه.
 */
const EXPORT_HEADER = [
  'tenant_code',
  'tenant_name',
  'tenant_status',
  'plan_code',
  'subscription_status',
  'activated_at',
  'monthly_value',
  'currency',
  'invoice_count_window',
  'einvoice_count_window',
  'last_invoice_at',
  'days_since_last_invoice',
  'peak_utilization_percent',
  'open_alerts',
].join(',');

const METRIC_ORDER = [
  'users',
  'branches',
  'items',
  'invoices_per_month',
  'storage_mb',
  'api_calls_per_day',
  'whatsapp_per_month',
  'email_sends_per_month',
];

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

async function request(method, path, token) {
  const response = await raw(method, path, undefined, token);
  if (response.status >= 400) {
    const problem = response.body ?? {};
    const error = new Error(
      `${method} ${path} → ${response.status} ${problem.code ?? ''} ${problem.detail ?? problem.message ?? ''}`,
    );
    error.status = response.status;
    error.problem = problem;
    throw error;
  }
  return response.body?.data ?? response.body;
}

async function signIn(tenantCode, credentials) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await raw('post', '/auth/login', { tenantCode, ...credentials });
    // الدخول مقيَّد بمعدّل: نُعيد المحاولة بأدبٍ بدل أن نسقط في أول 429.
    if (response.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      continue;
    }
    const login = response.body?.data ?? response.body;
    const token = login?.accessToken ?? login?.access_token ?? login?.token;
    if (!token) throw new Error(`login failed for ${credentials.email}: HTTP ${response.status}`);
    return token;
  }
}

const money = (value) => Number(value ?? 0);

async function main() {
  const ownerToken = await signIn(platformTenant, operator);

  // ─────────────────────────────────────────────── 1. الأبواب
  section('■ 1. 🔐 الأبواب');
  const overview = await request('get', '/platform/analytics/overview', ownerToken);
  check('المشغّل يقرأ النظرة العامة', Number.isFinite(money(overview.mrr)), `mrr=${overview.mrr}`);
  const anonymous = await raw('get', '/platform/analytics/overview');
  check('والمجهول يُردّ 401', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const demoToken = await signIn(demo.tenantCode, demo);
  const asCustomer = await raw('get', '/platform/analytics/overview', undefined, demoToken);
  check('ورمز العميل يُردّ 403 على سطح المنصة', asCustomer.status === 403, `HTTP ${asCustomer.status}`);

  // ─────────────────────────────────────────────── 2. النظرة العامة
  section('■ 2. 🧮 النظرة العامة — تعريفٌ واحد لا تعريفان');
  const revenue = await request('get', '/platform/revenue', ownerToken);
  check('mrr يطابق لوحة الإيراد حرفاً بحرف', overview.mrr === revenue.mrr, `${overview.mrr} · ${revenue.mrr}`);
  check('arr = 12 × mrr', money(overview.arr) === Math.round(money(overview.mrr) * 12 * 100) / 100, overview.arr);
  check('والعملة هي عملة الإيراد', overview.currency === revenue.currency, overview.currency);
  const tenants = await request('get', '/platform/tenants?limit=200', ownerToken);
  const tenantRows = Array.isArray(tenants) ? tenants : (tenants.data ?? tenants.items ?? []);
  check(
    'counts.total يطابق عدد المنشآت الحقيقي',
    overview.counts.total === tenantRows.length,
    `${overview.counts.total} · ${tenantRows.length}`,
  );
  check(
    'والتعريفات الأربعة معلَنة (بلا رقمٍ بلا تعريف)',
    ['mrr', 'churn', 'trial', 'activity'].every((key) => (overview.definitions?.[key] ?? '').length > 10),
  );
  check(
    'التجربة تحمل نافذتها ونسبتها (أو null حين لا تجارب)',
    overview.trials.windowDays === 90 &&
      (overview.trials.conversionRate === null || typeof overview.trials.conversionRate === 'number'),
    `conversionRate=${overview.trials.conversionRate}`,
  );
  check(
    'التنبيهات: بلا عددٍ صفري، وبوجهةٍ لكل تنبيه، وبأمثلةٍ لا تزيد على خمسة',
    overview.alerts.every(
      (alert) => alert.count > 0 && alert.href.startsWith('/') && alert.examples.length <= 5,
    ),
    `${overview.alerts.length} تنبيهاً`,
  );

  // ─────────────────────────────────────────────── 3. منحنى الإيراد
  section('■ 3. 📈 منحنى الإيراد');
  const short = await request('get', '/platform/analytics/overview?months=3', ownerToken);
  check('نافذة ٣ أشهر تُعيد ٣ نقاط', short.mrrSeries.length === 3, `${short.mrrSeries.length}`);
  const long = await request('get', '/platform/analytics/overview?months=12', ownerToken);
  check('ونافذة ١٢ تُعيد ١٢', long.mrrSeries.length === 12, `${long.mrrSeries.length}`);
  check(
    'والقائم في آخر شهر (الشهر الجاري) يطابق mrr المعروض',
    long.mrrSeries.at(-1).mrr === long.mrr,
    `${long.mrrSeries.at(-1).mrr} · ${long.mrr}`,
  );
  check(
    'والصافي = المضاف − الساقط في كل نقطة',
    long.mrrSeries.every(
      (point) => money(point.netValue) === Math.round((money(point.newValue) - money(point.churnedValue)) * 100) / 100,
    ),
  );
  check(
    'وضهور المنحنى تصاعدي الشهور',
    long.mrrSeries.every((point, index) => index === 0 || point.month > long.mrrSeries[index - 1].month),
  );

  // ─────────────────────────────────────────────── 4. التسرّب
  section('■ 4. 📉 التسرّب — بالشعارات وبالمال');
  const churn = long.churn;
  check('طول التسرّب = طول النافذة', churn.points.length === churn.windowMonths && churn.windowMonths === 12);
  check(
    'كل نقطة تحمل مقامها (عدداً وقيمة) لا النسبة وحدها',
    churn.points.every(
      (point) =>
        typeof point.baseCount === 'number' &&
        typeof point.churnedCount === 'number' &&
        typeof point.baseValue === 'string',
    ),
  );
  check(
    'بلا مقام ⇒ null لا ٠٪ (لا نسبة من صفر)',
    churn.points.every(
      (point) => point.baseCount > 0 || (point.logoRate === null && point.revenueRate === null),
    ),
  );
  check(
    'ومع المقام ⇒ نسبةٌ حقيقية لا تتجاوز ١٠٠',
    churn.points.every(
      (point) => point.logoRate === null || (point.logoRate >= 0 && point.logoRate <= 100),
    ),
  );
  check(
    'والقيمة الساقطة تظهر في المنحنى أيضاً (مقياسٌ واحد لحادثةٍ واحدة)',
    churn.points.every((point, index) => point.churnedValue === long.mrrSeries[index].churnedValue),
  );

  // ─────────────────────────────────────────────── 5. القمع
  section('■ 5. 🕳️ قمع التفعيل');
  const funnel = await request('get', '/platform/analytics/funnel?days=90', ownerToken);
  check(
    'أربع خطوات بالترتيب',
    funnel.rows.map((row) => row.step).join('→') === 'signed_up→activated→first_invoice→first_einvoice',
    funnel.rows.map((row) => row.step).join('→'),
  );
  check('النافذة تُبلَّغ كما طُلبت', funnel.windowDays === 90);
  check('والخطوة الأولى بلا نسبةٍ من سابقة', funnel.rows[0].conversionFromPrevious === null);
  check(
    'والعدّ لا يصعد بين خطوةٍ والتي تليها',
    funnel.rows.every((row, index) => index === 0 || row.tenants <= funnel.rows[index - 1].tenants),
  );
  check(
    'وكل خطوةٍ لها مهلتها: الأولى بلا مهل، وما بعدها وسيطٌ ومئين ٩٠ (أو null إن لم يصل أحد)',
    funnel.rows.every((row) => {
      if (row.step === 'signed_up') return row.medianDaysFromSignup === null && row.p90DaysFromSignup === null;
      if (row.tenants === 0) return row.medianDaysFromSignup === null && row.p90DaysFromSignup === null;
      return typeof row.medianDaysFromSignup === 'number' && typeof row.p90DaysFromSignup === 'number';
    }),
  );
  const allTime = await request('get', '/platform/analytics/funnel', ownerToken);
  check('وبلا نافذة: كل الفترات (windowDays = null)', allTime.windowDays === null);
  check(
    'والنافذة الأوسع لا تُنقص العدد',
    allTime.rows[0].tenants >= funnel.rows[0].tenants,
    `${allTime.rows[0].tenants} ≥ ${funnel.rows[0].tenants}`,
  );

  // ─────────────────────────────────────────────── 6. الأفواج
  section('■ 6. 👥 أفواج الاحتفاظ');
  const cohorts = await request('get', '/platform/analytics/cohorts?months=3&basis=signup', ownerToken);
  check('ثلاثة أفواج لثلاثة أشهر', cohorts.rows.length === 3, `${cohorts.rows.length}`);
  check(
    'والخلايا مثلّثية: الفوج الأقدم يظهر في كل الأشهر',
    cohorts.rows.map((row) => row.cells.length).join(',') === '3,2,1',
    cohorts.rows.map((row) => row.cells.length).join(','),
  );
  check(
    'وكل خليّة تحمل حجم الفوج نفسه مقاماً',
    cohorts.rows.every((row) => row.cells.every((cell) => cell.size === row.size)),
  );
  check(
    'والمتعاقد والمستخدِم لا يتجاوزان الحجم',
    cohorts.rows.every(
      (row) =>
        row.cells.every(
          (cell) =>
            cell.contracted >= 0 &&
            cell.active >= 0 &&
            cell.contracted <= cell.size &&
            cell.active <= cell.size &&
            cell.activeRate <= 100,
        ),
    ),
  );
  const activationCohorts = await request('get', '/platform/analytics/cohorts?months=3&basis=activation', ownerToken);
  check('وفوج التفعيل يُقال إنه فوج تفعيل', activationCohorts.basis === 'activation');

  // ─────────────────────────────────────────────── 7. الاستخدام لكل باقة
  section('■ 7. 📊 الاستخدام لكل باقة');
  check('ثمة باقةٌ واحدة على الأقل في القراءة', overview.usageByPlan.length >= 1, `${overview.usageByPlan.length}`);
  check(
    'وكل مجموعة تحمل المقاييس الثمانية بالترتيب نفسه',
    overview.usageByPlan.every((group) => group.metrics.map((metric) => metric.metric).join(',') === METRIC_ORDER.join(',')),
  );
  check(
    'والحدّ الصريح هو الشرط الوحيد للنسبة: بلا حدّ ⇒ utilization = null',
    overview.usageByPlan.every((group) =>
      group.metrics.every((metric) => (metric.limit === null ? metric.utilization === null : metric.utilization !== null)),
    ),
  );
  check(
    'والمتوسط لا يتجاوز الذروة في أي مقياس',
    overview.usageByPlan.every((group) => group.metrics.every((metric) => metric.average <= metric.peak)),
  );

  // ─────────────────────────────────────────────── 8. الحدود
  section('■ 8. ⛔ الحدود المعلَنة في العقد');
  for (const [path, expected] of [
    ['/platform/analytics/overview?months=2', 400],
    ['/platform/analytics/overview?months=25', 400],
    ['/platform/analytics/funnel?days=6', 400],
    ['/platform/analytics/funnel?days=400', 400],
    ['/platform/analytics/cohorts?basis=plan', 400],
    ['/platform/analytics/export.csv?days=0', 400],
  ]) {
    const response = await raw('get', path, undefined, ownerToken);
    check(`${path} ⇒ ${expected}`, response.status === expected, `HTTP ${response.status}`);
  }

  // ─────────────────────────────────────────────── 9. الملف
  section('■ 9. 🧾 ملف CSV');
  const exported = await raw('get', '/platform/analytics/export.csv?days=30', undefined, ownerToken);
  check('يُرسل كملف CSV', (exported.headers.get('content-type') ?? '').includes('text/csv'));
  check('وباسم ملفّ صريح', (exported.headers.get('content-disposition') ?? '').includes('platform-analytics.csv'));
  const lines = exported.text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
  check('يبدأ بترويسةٍ تحمل تاريخ التوليد والنافذة', lines[0].startsWith('# platform analytics export · generated'));
  check('وسطر الأعمدة يطابق العقد حرفاً بحرف', lines[1] === EXPORT_HEADER, lines[1]?.slice(0, 60));
  check('وسطرٌ لكل منشأة + سطران', lines.length === 2 + tenantRows.length, `${lines.length} · ${tenantRows.length}`);
  check(
    'ولا NaN ولا undefined في أي خليّة (وهذا أصدق قياسٍ لتنسيق المال)',
    lines.every((line) => !line.includes('NaN') && !line.includes('undefined')),
  );
  check(
    'وكل سطرٍ عميله من قائمة المنشآت نفسها',
    tenantRows.every((tenant) => lines.some((line) => line.startsWith(`${tenant.code},`))),
  );

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} فحصاً ناجحاً`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  if (error.problem) console.error(JSON.stringify(error.problem).slice(0, 500));
  process.exit(1);
});
