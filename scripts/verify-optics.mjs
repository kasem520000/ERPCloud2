#!/usr/bin/env node
/**
 * Live verification of Phase 09 part five — 👓 النظارات — against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. ⚙️ أسماء الحقول — عشرة صناديق (حقل 1…5 لليمين، 6…10 لليسار) بعناوينها الأصلية
 *      «RE-SPH» … «LE-IPD» كما يقرؤها `isnull` من `Other_Column`
 *   2. 💾 حفظ الأسماء — «delete then insert»: الصفّ يُستبدل، والفارغ يُقرأ ببديله
 *   3. 👓 بيانات النظارات — عشر قيمٍ نصية: «PL» و«+1.25» تُحفظ كما كُتبت، بلا تحليل
 *   4. الرفوض — «الرجاء اختيار عميل» · «لم يتم العثور على عميل» · «الوصفة غير موجودة»
 *   5. ✏️ تعديل — ونسخةٌ قديمة تُرفض بـ `VERSION_CONFLICT`
 *   6. 🔍 بحث و📋 قائمة — `mobile LIKE @Search OR name LIKE @Search`، و«الكل» و«عميل»
 *   7. قسم الطباعة — «👓 بيانات النظارات» بعناوين المؤسسة (`Class/Print.cs` L710)
 *   8. 🗑️ حذف، ثم التنظيف — وصفات هذا التشغيل تُحذف، وعناوين الحقول تُعاد كما كانت
 *
 * Re-runnable and non-destructive: the وصفات this script writes are deleted at the end
 * (in a `finally`, so a failed check still cleans up), a عميل is only created when the
 * tenant has none, and «⚙️ أسماء الحقول» is restored — if the tenant had no row before
 * the run, the ten defaults are written back, and they read exactly as the defaults do.
 *
 * Usage: node scripts/verify-optics.mjs
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

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    // Node 22's undici rejects lowercase verbs: `patch` comes back a 405 with an empty
    // body, and `JSON.parse('')` then throws instead of reporting the real problem.
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
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail;
    throw error;
  }
  return parsed;
}

async function call(method, path, body) {
  const parsed = await request(method, path, body);
  return parsed.data ?? parsed;
}

/** `call()` unwraps `data`; the قائمة carries `meta.customer` beside it, so keep the body. */
const callBody = (method, path, body) => request(method, path, body);

/** A refusal is a result, not a crash — the desktop shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    await call(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

let token = '';
const login = await call('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path);
const post = (path, body) => call('post', path, body);
const put = (path, body) => call('put', path, body);
const patch = (path, body) => call('patch', path, body);
const del = (path) => call('delete', path);

const caption = (row, key, side) => row?.[side]?.find((entry) => entry.key === key)?.label ?? '—';

// ---------------------------------------------------------------------------
console.log('1. ⚙️ أسماء الحقول — عشرة صناديق بعناوينها الأصلية');

const original = await get('/optics/field-labels');
const DEFAULTS = ['RE-SPH', 'RE-CYL', 'RE-AX', 'RE-ADD', 'RE-IPD'];
const DEFAULTS_L = ['LE-SPH', 'LE-CYL', 'LE-AX', 'LE-ADD', 'LE-IPD'];

const rightLabels = ['r1', 'r2', 'r3', 'r4', 'r5'].map((slot) => original[slot]).join(' · ');
check(
  'اليمين — «RE-SPH» · «RE-CYL» · «RE-AX» · «RE-ADD» · «RE-IPD» حين لا صفَّ بعد، وإلا ما سمّاه صاحب المحل',
  // `isnull(R1,'RE-SPH') …` — with no row the defaults speak; a tenant that saved names
  // reads its own, and what matters is that no box is left without a caption.
  (original.id === null && rightLabels === DEFAULTS.join(' · ')) ||
    (original.id !== null && ['r1', 'r2', 'r3', 'r4', 'r5', 'l1', 'l2', 'l3', 'l4', 'l5'].every((slot) => String(original[slot] ?? '').trim())),
  rightLabels,
);
check(
  '«حقل 1» … «حقل 10» — حقل 6 هو أول العين اليسرى (L1)',
  original.fields.length === 10 &&
    original.fields.map((field) => field.placeholder).join(' · ') ===
      Array.from({ length: 10 }, (_, index) => `حقل ${index + 1}`).join(' · ') &&
    original.fields[5].slot === 'l1' &&
    original.fields[5].side === 'L',
  original.fields.map((field) => `${field.placeholder}=${field.slot}`).join(' · '),
);
check(
  '🔴 العين اليمنى (RE) و🟢 العين اليسرى (LE) — خمس عناوين لكل عين',
  original.right.length === 5 && original.left.length === 5,
  `${original.right.map((entry) => entry.label).join(' · ')} | ${original.left.map((entry) => entry.label).join(' · ')}`,
);

// ---------------------------------------------------------------------------
console.log('\n2. 💾 حفظ الأسماء — «delete then insert»، والفارغ يُقرأ ببديله');

try {
  const saved = await put('/optics/field-labels', {
    r1: `SPH يمين ${stamp}`,
    r2: 'CYL يمين',
    r3: 'AX يمين',
    r4: 'ADD يمين',
    r5: 'IPD يمين',
    l1: 'SPH يسار',
    // l3 is sent blank: the desktop would store «» and the box would lose its caption;
    // `isnull` cannot tell «لم يُسمَّ» from «سُمّي بلا اسم», so the default answers.
    l3: '   ',
    l4: 'ADD يسار',
    l5: 'IPD يسار',
  });
  check('«تم الحفظ بنجاح» — العنوان الأول صار ما كتبناه', saved.r1 === `SPH يمين ${stamp}`, saved.r1);
  check('الفارغ يُقرأ ببديله — `isnull(L3,\'LE-AX\')`', saved.l3 === 'LE-AX', `l3 = ${saved.l3}`);

  const replaced = await put('/optics/field-labels', { r1: 'درجة اليمين' });
  check(
    'الصفّ يُستبدل كله — ما لم يُرسَل يعود إلى أصله، لا يبقى من المرة الأولى',
    replaced.r1 === 'درجة اليمين' && replaced.l1 === 'LE-SPH' && replaced.id !== saved.id,
    `r1 = ${replaced.r1} · l1 = ${replaced.l1}`,
  );
  const reread = await get('/optics/field-labels');
  check('إعادة القراءة — ما حُفظ هو ما يُقرأ', reread.r1 === 'درجة اليمين', reread.r1);
} finally {
  // -------------------------------------------------------------------------
  console.log('\n  … إعادة العناوين كما كانت');

  const restore = { r1: original.r1, r2: original.r2, r3: original.r3, r4: original.r4, r5: original.r5, l1: original.l1, l2: original.l2, l3: original.l3, l4: original.l4, l5: original.l5 };
  const restored = await put('/optics/field-labels', restore);
  check(
    'التنظيف — «⚙️ أسماء الحقول» عادت كما كانت قبل التشغيل',
    ['r1', 'r2', 'r3', 'r4', 'r5', 'l1', 'l2', 'l3', 'l4', 'l5'].every((slot) => restored[slot] === original[slot]),
    ['r1', 'l5'].map((slot) => restored[slot]).join(' · '),
  );
}

// ---------------------------------------------------------------------------
console.log('\n3. 👓 بيانات النظارات — عشر قيمٍ نصية، بلا تحليل');

const customers = await callBody('get', '/parties?kind=customer');
const customerList = customers.data ?? customers;
const borrowed = customerList[0]?.id;
const customer = borrowed ? customerList[0] : await post('/parties', { kind: 'customer', name: `عميل نظارات ${stamp}`, phone: '0551234567' });
check('👤 بيانات العميل', Boolean(customer?.id), borrowed ? `${customer.name} (عميل قائم)` : `أُنشئ: ${customer.name}`);

// Every وصفة this script writes is deleted in the `finally` below.
const written = [];

try {
  const prescription = await post('/optics/prescriptions', {
    partyId: customer.id,
    orientation: 'distance',
    rightEye: { sph: '-2.00', cyl: '-0.50', axis: '90', add: '+1.25', ipd: '62' },
    // «PL» (plano) is a legitimate value, and `bindClass` writes it as text.
    leftEye: { sph: 'PL', cyl: '-0.25', axis: '85', add: '+1.25', ipd: '62' },
    notes: `وصفة ${stamp}`,
  });
  written.push(prescription.id);

  check(
    '🔴 العين اليمنى (RE) — `SPH · CYL · AX · ADD · IPD` كما كُتبت',
    ['sph', 'cyl', 'axis', 'add', 'ipd'].map((key) => prescription.rightEye[key]).join(' · ') === '-2.00 · -0.50 · 90 · +1.25 · 62',
    ['sph', 'cyl', 'axis', 'add', 'ipd'].map((key) => prescription.rightEye[key]).join(' · '),
  );
  check(
    '🟢 العين اليسرى (LE) — «PL» تُحفظ نصاً كما في `VarChar`',
    prescription.leftEye.sph === 'PL' && prescription.leftEye.axis === '85',
    ['sph', 'cyl', 'axis', 'add', 'ipd'].map((key) => prescription.leftEye[key]).join(' · '),
  );
  check('🔢 عدد القيم المدخلة', prescription.filledCount === 10, `${prescription.filledCount} من 10`);
  check('📝 الملاحظات', prescription.notes === `وصفة ${stamp}`, prescription.notes);

  // -------------------------------------------------------------------------
  console.log('\n4. الرفوض — بجملة الديسكتوب نفسها');

  const noCustomer = await refused('post', '/optics/prescriptions', { rightEye: { sph: '-1.00' } });
  check(
    '«الرجاء اختيار عميل» (`frmOrderDetails` L324)',
    noCustomer.status === 422 && noCustomer.code === 'OPTICS_CUSTOMER_REQUIRED' && noCustomer.detail === 'الرجاء اختيار عميل',
    `${noCustomer.status} ${noCustomer.code} — ${noCustomer.detail}`,
  );
  const unknownCustomer = await refused('post', '/optics/prescriptions', {
    partyId: '00000000-0000-4000-8000-000000000000',
    rightEye: { sph: '-1.00' },
  });
  check(
    '«لم يتم العثور على عميل»',
    unknownCustomer.status === 404 && unknownCustomer.detail === 'لم يتم العثور على عميل',
    `${unknownCustomer.status} ${unknownCustomer.code} — ${unknownCustomer.detail}`,
  );
  const unknownPrescription = await refused('get', '/optics/prescriptions/00000000-0000-4000-8000-000000000000');
  check(
    '«الوصفة غير موجودة»',
    unknownPrescription.status === 404 && unknownPrescription.code === 'OPTICS_PRESCRIPTION_NOT_FOUND',
    `${unknownPrescription.status} ${unknownPrescription.code}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n5. ✏️ تعديل — ونسخةٌ قديمة تُرفض');

  const stale = await refused('patch', `/optics/prescriptions/${prescription.id}`, { version: 99, notes: 'قديم' });
  check('نسخةٌ قديمة تُرفض', stale.status === 409 && stale.code === 'VERSION_CONFLICT', `${stale.status} ${stale.code}`);
  const updated = await patch(`/optics/prescriptions/${prescription.id}`, {
    version: prescription.version,
    rightEye: { sph: '-2.25', cyl: '-0.50', axis: '90', add: '+1.25', ipd: '62' },
    notes: 'وصفة الشتاء',
  });
  check('✏️ تعديل — SPH صار -2.25 والملاحظات تغيّرت', updated.rightEye.sph === '-2.25' && updated.notes === 'وصفة الشتاء', `${updated.rightEye.sph} · ${updated.notes}`);
  check('العين الأخرى لم تُمسّ — `bindControls` يقرأ R أو L', updated.leftEye.sph === 'PL', updated.leftEye.sph);
  check('النسخة تتقدّم', updated.version === prescription.version + 1, `${prescription.version} → ${updated.version}`);

  // -------------------------------------------------------------------------
  console.log('\n6. 🔍 بحث و📋 قائمة');

  const blankSearch = await refused('get', `/optics/prescriptions?search=${encodeURIComponent('   ')}`);
  check(
    '«الرجاء إدخال رقم الجوال أو اسم العميل»',
    blankSearch.status === 422 && blankSearch.detail === 'الرجاء إدخال رقم الجوال أو اسم العميل',
    `${blankSearch.status} ${blankSearch.code} — ${blankSearch.detail}`,
  );
  const missingCustomer = await refused('get', '/optics/prescriptions?search=0000000000');
  check(
    '«لم يتم العثور على عميل»',
    missingCustomer.status === 404 && missingCustomer.detail === 'لم يتم العثور على عميل',
    `${missingCustomer.status} ${missingCustomer.code}`,
  );

  const byPhone = await callBody('get', `/optics/prescriptions?search=${encodeURIComponent(customer.phone ?? '')}`);
  check(
    '🔍 بحث بالجوال — `mobile LIKE @Search`، وأول صفٍّ هو العميل',
    byPhone.meta?.customer?.id === customer.id,
    `العميل: ${byPhone.meta?.customer?.name ?? '—'} · الجوال: ${byPhone.meta?.customer?.phone ?? '—'}`,
  );
  check('📋 وصفاته وحدها', (byPhone.data ?? []).some((row) => row.id === prescription.id), `${(byPhone.data ?? []).length} وصفة`);

  const byName = await callBody('get', `/optics/prescriptions?search=${encodeURIComponent(customer.name)}`);
  check('🔍 بحث بالاسم — `name LIKE @Search`', byName.meta?.customer?.id === customer.id, customer.name);

  const forParty = await callBody('get', `/optics/prescriptions?partyId=${customer.id}`);
  check('?partyId= — وصفات عميلٍ واحد', (forParty.data ?? []).every((row) => row.partyId === customer.id), `${(forParty.data ?? []).length} وصفة`);

  const all = await callBody('get', '/optics/prescriptions');
  check(
    '📋 كل الوصفات — الأحدث أولاً (`ORDER BY created_at DESC`)',
    (all.data ?? []).every((row, index) => index === 0 || (all.data[index - 1].createdAt ?? '') >= (row.createdAt ?? '')),
    `عدد السجلات: ${all.meta?.total ?? (all.data ?? []).length}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n7. قسم الطباعة — `Class/Print.cs` L710');

  const section = await get(`/optics/invoice-lines/${prescription.id}/print-section`);
  check(
    '«👓 بيانات النظارات» — العنوان والصفوف',
    typeof section === 'object' && section.title === '👓 بيانات النظارات' && Array.isArray(section.rows),
    `${section.title} · ${section.rows.length} صف`,
  );
  check(
    'العناوين العشرة تُرافق القسم',
    section.labels.right.length === 5 && section.labels.left.length === 5,
    `${section.labels.right.map((entry) => entry.label).join(' · ')} | ${section.labels.left.map((entry) => entry.label).join(' · ')}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n8. 🗑️ حذف');

  const second = await post('/optics/prescriptions', { partyId: customer.id, rightEye: { sph: '+1.00' } });
  written.push(second.id);
  const removed = await del(`/optics/prescriptions/${second.id}`);
  check('🗑️ حذف — «تم الحذف بنجاح»', removed?.deleted === true, `#${removed?.id ?? ''}`);
  const gone = await refused('get', `/optics/prescriptions/${second.id}`);
  check('«الوصفة غير موجودة» بعد الحذف', gone.status === 404 && gone.code === 'OPTICS_PRESCRIPTION_NOT_FOUND', `${gone.status} ${gone.code}`);
  const remaining = await callBody('get', `/optics/prescriptions?partyId=${customer.id}`);
  check(
    'الوصفة المحذوفة لا تظهر في القائمة، والأخرى باقية',
    !(remaining.data ?? []).some((row) => row.id === second.id) && (remaining.data ?? []).some((row) => row.id === prescription.id),
    `${(remaining.data ?? []).length} وصفة`,
  );
} finally {
  // -------------------------------------------------------------------------
  console.log('\n9. التنظيف');

  for (const id of written) {
    await del(`/optics/prescriptions/${id}`).catch(() => {});
  }
  const after = await callBody('get', `/optics/prescriptions?partyId=${customer.id}`);
  check(
    'التنظيف — لا أثر لوصفات هذا التشغيل',
    !(after.data ?? []).some((row) => written.includes(row.id)),
    `عدد السجلات: ${(after.data ?? []).length}`,
  );

  if (!borrowed) {
    const removal = await refused('delete', `/parties/${customer.id}`);
    check(
      'التنظيف — العميل المُصنع',
      removal.status === 200 || removal.status === 422,
      removal.status === 200 ? 'حُذف' : `تُرك برصيد مفتوح (${removal.code ?? 'PARTY_HAS_OPEN_BALANCE'})`,
    );
  }
}

console.log(`\n${failures === 0 ? '✅ كل الفحوص نجحت' : `❌ ${failures} فحص فشل`}`);
process.exitCode = failures === 0 ? 0 : 1;
