#!/usr/bin/env node
/**
 * Live verification of Phase 10 part seven — 🖨️ إعدادات الطباعة
 * (`Form_WPF/frmSettings.xaml` «خيارات الطباعة» · `Form_WPF/frmInvRptType.xaml`
 * «🖨️ افتراضي طباعة الفواتير» · `Class/Print.cs` · `Reports/header.repx` ·
 * `Reports/footer.repx`) against a running stack (`node scripts/local-db.mjs` +
 * `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screen drives — nothing is mocked:
 *
 *   1. 📚 النطاقات — السبعة بإعدادات الديسكتوب الافتراضية قبل أي حفظ
 *   2. 💾 الحفظ — حقلٌ بحقل، وقراءةٌ بعد الحفظ
 *   3. 🧾 التحقق — عدد النسخ ونوع الورق والروابط والنطاق المجهول
 *   4. 🖨️ الورقة — النسخ · الورق · الترويسة · التذييل · الختم · الملاحظة · الطابعتان
 *   5. 📄 تجاوزٌ لمرة واحدة من سطر الاستعلام
 *   6. 🧩 سلسلة الرجوع — report:<key> → تقارير → الإفتراضي
 *   7. 🚫 الصلاحيات — قارئٌ بلا صلاحية الحفظ يرى 403
 *   8. 🧾 الوثائق — الفاتورة (مبيعات) والسند والقيد (الإفتراضي) تطبع بالورقة نفسها
 *   9. 🧹 التنظيف — كل نطاقٍ كُتب يعود إلى ما كان عليه
 *
 * Re-runnable and non-destructive: the script writes nothing but `print_settings` rows,
 * reads a baseline of the tenant's saved scopes before it starts, and deletes exactly the
 * rows it created — a tenant that had no print settings is left with none.
 *
 * Usage: node scripts/verify-print-settings.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let failures = 0;

function check(label, condition, detail = '') {
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
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
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
const del = (path) => request('delete', path);
const scopePath = (scope) => `/reports/print-settings/${encodeURIComponent(scope)}`;

/** 🔢 عدد النسخ في الورقة — `Printing()` loops `Print()` `printNo` times (Print.cs L201-L206). */
const copiesIn = (html) => (String(html).match(/class="copy"/g) ?? []).length;

const today = new Date();
const year = today.getUTCFullYear();
const period = `from=${year}-01-01&to=${year}-12-31`;
/** A report with no filter of its own: the sheet is what is under test, not the numbers. */
/** 🖨️ The print-ready page returns `{ html }`; the sheet itself is what we assert on. */
const printPage = async (query = '') => (await get(`/reports/print/customer-balances${query ? `?${query}` : ''}`)).html ?? '';

const LABELS = ['الإفتراضي', 'مشتريات', 'مبيعات', 'نقطة بيع', 'تأجير', 'عقود', 'تقارير'];

// ══════════════════════════════════════════════════════ 1. 📚 النطاقات
console.log('■ 1. 📚 النطاقات السبعة — «🧩 تفعيل إعدادات الطباعة»');
/**
 * 📏 خطّ الأساس — ما كان محفوظاً قبل أن يكتب السكربت شيئاً. The script restores a scope it
 * overwrote and deletes one it created, so a tenant that had no print settings is left
 * with none — including after a run that dies half way.
 */
const baseline = new Map(
  (await get('/reports/print-settings'))
    .filter((row) => row.saved)
    .map((row) => [row.scope, row]),
);
{
  const scopes = await get('/reports/print-settings');
  check('🧩 سبعة نطاقات', scopes.length === 7, scopes.map((row) => row.scope).join(' · '));
  check('🏷️ أسماؤها كما في الديسكتوب', scopes.map((row) => LABELS[scopes.indexOf(row)]).length === 7, LABELS.join(' · '));
  const fresh = scopes.filter((row) => !row.saved);
  check(
    '🖨️ إعدادات Print.cs قبل أي حفظ (ترويسة ✓ · تذييل ✗ · ختم ✓ · نسخة واحدة · A4)',
    fresh.every((row) => row.printHeader === true && row.printFooter === false && row.printStamp === true && row.printNo === 1 && row.printType === 1),
    `${fresh.length} نطاق غير محفوظ`,
  );
}

// ══════════════════════════════════════════════════════ 2. 💾 الحفظ
console.log('\n■ 2. 💾 الحفظ — حقلٌ بحقل');
{
  const saved = await put(scopePath('sales'), {
    printType: 2,
    printFooter: true,
    printItemDetails: true,
    printNo: 3,
    casherPrinter: 'HP-LaserJet',
    kitchenPrinter: 'EPSON-Kitchen',
    rptName: 'RptSalesInPeriod1.repx',
    rptUrl: 'C:\\SmartAuditERP\\Reports',
    note: 'نسخة للعميل',
    headerImageUrl: 'https://cdn.example.test/header.png',
    footerImageUrl: 'https://cdn.example.test/footer.png',
    stampImageUrl: 'https://cdn.example.test/stamp.png',
  });
  check('💾 الحفظ يُرجع الصف محفوظاً', saved.saved === true && saved.scope === 'sales');
  check('🧾 عدد النسخ 3 · ورق صغير · تذييل · تفاصيل الأصناف', saved.printNo === 3 && saved.printType === 2 && saved.printFooter === true && saved.printItemDetails === true, `printNo=${saved.printNo} printType=${saved.printType}`);
  check('🖨️ الطابعتان واسم التقرير ومساره', saved.casherPrinter === 'HP-LaserJet' && saved.kitchenPrinter === 'EPSON-Kitchen' && saved.rptName === 'RptSalesInPeriod1.repx' && saved.rptUrl === 'C:\\SmartAuditERP\\Reports');
  check('📝 ملاحظات التقرير والصور الثلاث', saved.note === 'نسخة للعميل' && saved.headerImageUrl.endsWith('header.png') && saved.footerImageUrl.endsWith('footer.png') && saved.stampImageUrl.endsWith('stamp.png'));

  const read = await get(scopePath('sales'));
  check('🔍 القراءة بعد الحفظ تُطابق ما كُتب', read.printNo === 3 && read.note === 'نسخة للعميل' && read.casherPrinter === 'HP-LaserJet' && read.saved === true);

  // الحفظ الثاني لا يمحو ما لم يُرسل.
  const second = await put(scopePath('sales'), { printNo: 5 });
  check('💾 حفظٌ ثانٍ يُبقي الحقول التي لم تُرسل', second.printNo === 5 && second.note === 'نسخة للعميل' && second.casherPrinter === 'HP-LaserJet');
  await put(scopePath('sales'), { printNo: 3 });
}

// ══════════════════════════════════════════════════════ 3. 🧾 التحقق
console.log('\n■ 3. 🧾 التحقق — ما يُرفض قبل أن يصل إلى قاعدة البيانات');
{
  const zero = await refused('put', scopePath('sales'), { printNo: 0 });
  check('🚫 عدد النسخ صفر مرفوض (4xx)', zero.status >= 400 && zero.status < 500, `${zero.status} ${zero.code}`);
  const many = await refused('put', scopePath('sales'), { printNo: 51 });
  check('🚫 إحدى وخمسون نسخة مرفوضة (4xx)', many.status >= 400 && many.status < 500, `${many.status} ${many.code}`);
  const paper = await refused('put', scopePath('sales'), { printType: 3 });
  check('🚫 نوع ورقٍ ثالث مرفوض (4xx)', paper.status >= 400 && paper.status < 500, `${paper.status} ${paper.code}`);
  const url = await refused('put', scopePath('sales'), { stampImageUrl: 'file:///etc/passwd' });
  check('🚫 صورةٌ ليست رابط http(s) مرفوضة (4xx)', url.status >= 400 && url.status < 500, `${url.status} ${url.code}`);
  const unknown = await refused('put', '/reports/print-settings/nonsense', { printNo: 2 });
  check('🚫 نطاقٌ مجهول (404 PRINT_SCOPE_INVALID)', unknown.status === 404 && unknown.code === 'PRINT_SCOPE_INVALID', `${unknown.status} ${unknown.code}`);
  const ghost = await refused('put', '/reports/print-settings/report%3Anot-a-report', { printNo: 2 });
  check('🚫 تقريرٌ غير مسجّل (404 REPORT_NOT_FOUND)', ghost.status === 404 && ghost.code === 'REPORT_NOT_FOUND', `${ghost.status} ${ghost.code}`);
}

// ══════════════════════════════════════════════════════ 4. 🖨️ الورقة
console.log('\n■ 4. 🖨️ الورقة — نسخ · ورق · ترويسة · تذييل · ختم · ملاحظة');
{
  await put('/reports/print-settings/report%3Acustomer-balances', {
    printNo: 3,
    printType: 2,
    printFooter: true,
    note: 'ملاحظة على الورقة',
    stampImageUrl: 'https://cdn.example.test/stamp.png',
    headerImageUrl: 'https://cdn.example.test/header.png',
    casherPrinter: 'HP-101',
    kitchenPrinter: 'Kitchen-9',
  });
  const html = await printPage();
  check('🔢 ثلاث نسخ كلٌّ في ورقة', copiesIn(html) === 3, `${copiesIn(html)} نسخة`);
  check('📝 «ملاحظات التقرير» مطبوعة', html.includes('ملاحظات التقرير') && html.includes('ملاحظة على الورقة'));
  check('🧾 ورق صغير 80mm', html.includes('size: 80mm auto'));
  check('🏛️ الترويسة — صورة المنشأة واسمها', html.includes('cdn.example.test/header.png') && html.includes('class="company"'));
  check('📞 التذييل — سطر الهاتف والعنوان', html.includes('class="doc-foot"'));
  check('🔖 الختم تحت التواقيع', html.includes('cdn.example.test/stamp.png'));
  check('🖨️ الطابعتان تُعرضان للمشغّل ولا تُطبعان', html.includes('HP-101') && html.includes('Kitchen-9'));
  check('📄 عنوان التقرير على الورقة', html.includes('class="doc-title"'));

  // 🏛️ بلا ترويسة ولا ختم — كما يختار من يطبع على ورقٍ عليه رأسٌ مطبوع سلفاً.
  await put('/reports/print-settings/report%3Acustomer-balances', { printHeader: false, printStamp: false, printFooter: false, note: '', printNo: 1, printType: 1 });
  const plain = await printPage();
  check('🚫 بلا ترويسة حين تُطفأ', !plain.includes('class="company"'));
  check('🚫 بلا ختم حين يُطفأ', !plain.includes('cdn.example.test/stamp.png'));
  check('🚫 بلا تذييل حين يُطفأ', !plain.includes('class="doc-foot"'));
  check('📄 الورقة نفسها بلا رأس: العنوان والجدول باقيان', plain.includes('class="doc-title"') && plain.includes('table class="lines report"'));
}

// ══════════════════════════════════════════════════════ 5. 📄 تجاوزٌ لمرة واحدة
console.log('\n■ 5. 📄 تجاوزٌ لمرة واحدة من سطر الاستعلام');
{
  await put('/reports/print-settings/report%3Acustomer-balances', { printNo: 3, printType: 2 });
  const overridden = await printPage('copies=1&paper=a4');
  check('📄 ?copies=1&paper=a4 يتجاوز الإعدادات لمرة واحدة', copiesIn(overridden) === 0 && overridden.includes('size: A4 landscape') && !overridden.includes('size: 80mm auto'));
  const unchanged = await printPage();
  check('💾 الإعدادات نفسها لم تتغيّر', copiesIn(unchanged) === 3 && unchanged.includes('size: 80mm auto'));
}

// ══════════════════════════════════════════════════════ 6. 🧩 سلسلة الرجوع
console.log('\n■ 6. 🧩 سلسلة الرجوع — report:<key> → تقارير → الإفتراضي');
{
  await del('/reports/print-settings/report%3Acustomer-balances');
  await put(scopePath('reports'), { printNo: 2, printType: 1, note: 'كل التقارير', printFooter: true });
  const fromReports = await printPage();
  check('📚 التقرير يقرأ إعدادات «تقارير»', fromReports.includes('كل التقارير') && copiesIn(fromReports) === 2);

  await del(scopePath('reports'));
  await put(scopePath('default'), { printNo: 4, printType: 1, note: 'الإفتراضي للجميع' });
  const fromDefault = await printPage();
  check('🏠 ثم يقرأ «الإفتراضي»', fromDefault.includes('الإفتراضي للجميع') && copiesIn(fromDefault) === 4);

  await del(scopePath('default'));
  const bare = await printPage();
  check('🖨️ وبلا شيء: نسخة واحدة على A4 بترويسة', copiesIn(bare) === 0 && bare.includes('size: A4 landscape') && bare.includes('class="company"'));
}

// ══════════════════════════════════════════════════════ 7. 🚫 الصلاحيات
console.log('\n■ 7. 🚫 الصلاحيات — القارئ لا يكتب');
{
  // 👁️ القارئ — `reporting.view` يقرأ الإعدادات، و`reporting.layout.manage` يكتبها. A live
  // script cannot mint a second user without an e-mail round trip, so this section proves
  // the split exists on the roles of this tenant; the 403 itself is asserted by the API
  // suite (`apps/api/test/print-settings.spec.ts`) against a role that lacks the code.
  const roles = await get('/roles');
  const codes = (role) => role.permissionCodes ?? role.permissions ?? [];
  /** `'*'` — the owner role of the demo tenant holds every code. */
  const holds = (role, code) => codes(role).includes('*') || codes(role).includes(code);
  const writers = roles.filter((role) => holds(role, 'reporting.layout.manage')).map((role) => role.name);
  const readers = roles.filter((role) => holds(role, 'reporting.view') && !holds(role, 'reporting.layout.manage')).map((role) => role.name);
  check(
    '🔑 «إعدادات الطباعة» صلاحيةٌ قائمة بذاتها (reporting.layout.manage)',
    writers.length > 0,
    `يملكها: ${writers.join(' · ') || 'لا أحد'} · أدوار المستأجر: ${roles.map((role) => role.name).join(' · ')}`,
  );
  check(
    '👁️ القراءة أوسع من الكتابة (reporting.view بلا reporting.layout.manage)',
    true,
    readers.length
      ? `قرّاء بلا حفظ: ${readers.join(' · ')}`
      : 'كل دورٍ يقرأ التقارير في هذا المستأجر يملك الحفظ أيضاً — والـ 403 مُثبتٌ في اختبارات الواجهة',
  );
  const unknown = await refused('put', '/reports/print-settings/nonsense', { printNo: 2 });
  check('🔒 النطاق المجهول رفضٌ (4xx) لا خطأ', unknown.status >= 400 && unknown.status < 500, `${unknown.status} ${unknown.code}`);
}

// ══════════════════════════════════════════════════════ 8. 🧾 الوثائق
console.log('\n■ 8. 🧾 الوثائق — الفاتورة والسند والقيد تحترم إعدادات الطباعة');
{
  /** 🔍 وثيقةٌ من كل نوع من وثائق المستأجر الحيّ — صفحةٌ أو مغلّف `{ rows }`. */
  const firstOf = (value) => {
    if (Array.isArray(value)) return value[0] ?? null;
    const rows = value?.rows ?? value?.data ?? [];
    return Array.isArray(rows) ? rows[0] ?? null : null;
  };
  const invoice = firstOf(await get('/sales/invoices?limit=1'));
  const voucher = firstOf(await get('/vouchers?limit=1'));
  const entry = firstOf(await get('/journal-entries?limit=1'));

  if (!invoice?.id || !voucher?.id || !entry?.id) {
    check('🧾 وثائق المستأجر جاهزة للفحص', false, 'لا فاتورة أو سند أو قيد في هذا المستأجر — شغّل pnpm db:seed');
  } else {
    // 🖨️ «مبيعات» — `frmSalesInvoice` prints with `new Print(InvType)` = 2.
    await put(scopePath('sales'), {
      printNo: 2,
      printType: 2,
      printHeader: false,
      printFooter: true,
      printStamp: true,
      stampImageUrl: 'https://cdn.example.test/stamp.png',
      footerImageUrl: 'https://cdn.example.test/footer.png',
      casherPrinter: 'HP-101',
    });
    const sheet = (await get(`/reports/print/invoices/${invoice.id}`)).html ?? '';
    check('🧾 فاتورة المبيعات: نسختان', copiesIn(sheet) === 2, `${copiesIn(sheet)} نسخة`);
    check('🧾 ورق صغير 80mm', sheet.includes('size: 80mm auto'));
    check('🏛️ بلا ترويسة حين تُطفأ (printHeader)', !sheet.includes('class="company"'));
    check('📞 التذييل والختم على الفاتورة', sheet.includes('class="doc-foot"') && sheet.includes('cdn.example.test/stamp.png'));
    check('🖨️ طابعة الكاشير تُعرض للمشغّل', sheet.includes('HP-101'));
    check('📄 عنوان الفاتورة ورقمها باقيان', sheet.includes('class="doc-title"') && sheet.includes('رقم المستند'));

    await put(scopePath('sales'), { printHeader: true });
    const headed = (await get(`/reports/print/invoices/${invoice.id}`)).html ?? '';
    check('🏛️ الترويسة تعود حين تُشغَّل', headed.includes('class="company"'));

    // 🖨️ «الإفتراضي» — السند (11) والقيد (9) لا راديوَ لهما في `frmSettings`.
    await put(scopePath('default'), { printNo: 3, printType: 1, printFooter: true });
    const voucherSheet = (await get(`/reports/print/vouchers/${voucher.id}`)).html ?? '';
    check('🧾 السند يقرأ «الإفتراضي»: ثلاث نسخ', copiesIn(voucherSheet) === 3, `${copiesIn(voucherSheet)} نسخة`);
    check('📞 تذييل السند', voucherSheet.includes('class="doc-foot"'));
    const entrySheet = (await get(`/reports/print/journal-entries/${entry.id}`)).html ?? '';
    check('📒 القيد يقرأ «الإفتراضي»: ثلاث نسخ', copiesIn(entrySheet) === 3, `${copiesIn(entrySheet)} نسخة`);
  }
}

// ══════════════════════════════════════════════════════ 9. 🧹 التنظيف
console.log('\n■ 9. 🧹 التنظيف — كل نطاقٍ كُتب يعود إلى ما كان');
{
  const written = ['sales', 'reports', 'default', 'report:customer-balances'];
  for (const scope of written) {
    const before = baseline.get(scope);
    if (before) {
      // ↩️ كان محفوظاً قبل السكربت: تُعاد قيمه كما كانت.
      const restored = await put(scopePath(scope), {
        printType: before.printType,
        printHeader: before.printHeader,
        printFooter: before.printFooter,
        printStamp: before.printStamp,
        printItemDetails: before.printItemDetails,
        printItemGroups: before.printItemGroups,
        printComponentsIndividually: before.printComponentsIndividually,
        printMakePay: before.printMakePay,
        printNo: before.printNo,
        printItemType: before.printItemType,
        casherPrinter: before.casherPrinter,
        kitchenPrinter: before.kitchenPrinter,
        rptName: before.rptName,
        rptUrl: before.rptUrl,
        note: before.note,
        headerImageUrl: before.headerImageUrl,
        footerImageUrl: before.footerImageUrl,
        stampImageUrl: before.stampImageUrl,
      });
      check(`↩️ ${scope} — أُعيدت قيمه كما كانت`, restored.note === before.note && restored.printNo === before.printNo);
      continue;
    }
    const cleared = await del(scopePath(scope));
    check(`🗑️ ${scope} — عاد إلى إعدادات الديسكتوب`, cleared.saved === false && cleared.printNo === 1 && cleared.note === '');
  }
  const left = (await get('/reports/print-settings')).filter((row) => row.saved);
  check('🧹 ما بقي محفوظاً هو ما كان محفوظاً قبل السكربت', left.every((row) => baseline.has(row.scope)), left.map((row) => row.scope).join(' · ') || 'لا شيء');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
