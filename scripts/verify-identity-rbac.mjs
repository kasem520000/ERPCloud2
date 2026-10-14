#!/usr/bin/env node
/**
 * Live verification of R1 — «مطابقة شاشتي المستخدمين والصلاحيات»
 * (`docs/roadmap/AUDIT_PHASES_01_04.md` §6، تكملة المرحلة 01) against a running stack
 * (`node scripts/local-db.mjs` + `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * المصادر المكتبية التي تُقابلها كل نقطة:
 *   `Desktop_ERP/SmartAuditERP/Form_WPF/frmAddUsers.xaml(+.cs)`      — بطاقة المستخدم ودعوته
 *   `Form_WPF/frmUsersPermissions.xaml(+.cs)`                        — مصفوفة النماذج × الأفعال وحدّ الخصم
 *   `Form_WPF/frmOperPermission.xaml(+.cs)`                          — صلاحيات العمليات (OperNo 1..5)
 *   `Class/User.cs`                                                  — خصائص العمليات المسموحة
 *   `Class/FormPermission.cs`                                        — الأعلام الخمسة للأزرار
 *
 * يدفع الـAPI الحقيقي بالتوكن الحقيقي — لا شيء مُحاكى:
 *
 *   1. 📖 خطّ الأساس — ما تعرضه الشاشتان قبل أن تُمسّا
 *   2. 🧾 التهيئة — فرعٌ ومستودع وصنفٌ ورصيدٌ وعميلان
 *   3. 👤 دعوة مستخدم — الدور والنطاق وحدّ الخصم، وأبوابٌ مغلقة (150٪ · -5 · مفتاح غريب · بلا أدوار)
 *   4. 🌿 نطاق الفرع — فرعٌ جديد يُضاف ثم يُلغى (`branch_scope: null` = كل الفروع)
 *   5. 🧩 مصفوفة الصلاحيات — السجلّ والدور ورمزٌ مجهول يُرفض
 *   6. 🚫 الرفض بلا رمز — الكاشير يقرأ ما يملكه ويُرفض فيما لا يملك
 *   7. 💰 حدّ الخصم — بديل `OperMaxDiscount`: نسبةٌ وقيمة، في الفاتورة وفي الكاشير
 *   8. 🌍 عزل المستأجر — معرّفٌ مجهول 404، وكل صفٍّ لمستأجرنا
 *   9. 🧹 التنظيف — العضوية تُحذف والحدود تعود إلى خطّ الأساس
 *
 * Re-runnable and non-destructive: العضوية المدعوّة تُحذف في القسم 9، وحدود الخصم على
 * عضوية الكاشير وعضوية المالك تُعاد إلى ما كانت عليه، والفرع المؤقّت يُحذف. وما يبقى في
 * مستأجر العرض (كالقالب `verify-whatsapp.mjs`): صنفٌ ووحدةٌ وتصنيفٌ وحركة رصيد، وعميلان،
 * والفواتير التي أُنشئت للفحص، **وصفّ مستخدمٍ مدعوّ** لا واجهة لحذفه — والعضوية وحدها
 * تُحذف فلو خرجت الدعوة من الشاشة خرج الحساب من العدّ (`users` يُقاس بالعضويات).
 *
 * Usage: node scripts/verify-identity-rbac.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const owner = {
  email: process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test',
  password: process.env.DEMO_OWNER_PASSWORD ?? '',
};
const cashier = {
  email: process.env.DEMO_CASHIER_EMAIL ?? 'cashier@demo.test',
  password: process.env.DEMO_CASHIER_PASSWORD ?? '',
};
const accountant = {
  email: process.env.DEMO_ACCOUNTANT_EMAIL ?? 'accountant@demo.test',
  password: process.env.DEMO_ACCOUNTANT_PASSWORD ?? '',
};

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
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    error.detail = parsed.detail ?? parsed.message;
    error.errors = parsed.errors ?? [];
    throw error;
  }
  return parsed.data ?? parsed;
}

/** نداءٌ **يُتوقَّع** رفضه: حالته ورمزه هما الجواب. */
async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '', detail: '', errors: [] };
  } catch (error) {
    return {
      status: error.status ?? 0,
      code: error.code ?? '',
      detail: error.detail ?? '',
      errors: error.errors ?? [],
    };
  }
}

async function signIn(credentials) {
  // المنصّة تخنق `/auth/login` لكل عنوان، والتشغيل يسجّل دخولاً مرّتين؛ والـ429 ليس فشلاً.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const login = await request('post', '/auth/login', { tenantCode, ...credentials });
      const next = login.accessToken ?? login.access_token ?? login.token;
      if (!next) throw new Error(`login failed for ${credentials.email}`);
      return next;
    } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

const get = (path) => request('get', path);
const post = (path, body) => request('post', path, body);
const patch = (path, body) => request('patch', path, body);
const del = (path) => request('delete', path);

token = await signIn(owner);
console.log(`✔ logged in to ${tenantCode} as ${owner.email}\n`);

const memberships = () => get('/memberships').then((view) => view.data ?? view);
const membership = (id) => get(`/memberships/${id}`);
const roles = () => get('/roles').then((view) => view.data ?? view);

// ══════════════════════════════════════════════════════ 1. 📖 خطّ الأساس
console.log('■ 1. 📖 خطّ الأساس — ما تعرضه الشاشتان قبل أن تُمسّا');
const baseline = await memberships();
const baselineOwner = baseline.find((row) => row.isOwner);
const ownerCaps = {
  pct: baselineOwner?.maxDiscountPct ?? null,
  amount: baselineOwner?.maxDiscountAmount ?? null,
};
check('قائمة المستخدمين تُقرأ', Array.isArray(baseline) && baseline.length >= 3, `${baseline.length} عضوية`);
check(
  'كل صفٍّ يحمل مستأجرنا وحده',
  baseline.every((row) => row.tenantCode === tenantCode),
  [...new Set(baseline.map((row) => row.tenantCode))].join('، '),
);
check('صفّ المالك معلَّم `isOwner`', Boolean(baselineOwner));
check(
  'المالك بلا حدّ خصم افتراضاً — `null` لا صفر',
  ownerCaps.pct === null && ownerCaps.amount === null,
  `${ownerCaps.pct} / ${ownerCaps.amount}`,
);
check(
  'الحدّان معلَنان في العقد لكل عضوية',
  'maxDiscountPct' in baselineOwner && 'maxDiscountAmount' in baselineOwner,
);
const baselineRoles = await roles();
check(
  'الأدوار الأساسية الثلاثة موجودة',
  ['Owner', 'Accountant', 'Cashier'].every((name) => baselineRoles.some((role) => role.name === name)),
  baselineRoles.map((role) => role.name).join('، '),
);
const accountantRole = baselineRoles.find((role) => role.name === 'Accountant');
const ownerRole = baselineRoles.find((role) => role.name === 'Owner');
check(
  'دور المحاسب يحمل رموزاً حقيقية من السجل',
  (accountantRole?.permissionCodes ?? []).includes('sales.invoice.create'),
  `${accountantRole?.permissionCodes?.length ?? 0} رمزاً`,
);
const registry = await get('/permissions').then((view) => view.data ?? view);
check('سجلّ الصلاحيات يُقرأ من القاعدة', registry.length >= 140, `${registry.length} رمزاً`);
check('لا رمز مكرّراً في السجل', new Set(registry.map((entry) => entry.code)).size === registry.length);
check(
  'كل رمزٍ مُصنَّف بوصفه',
  registry.every((entry) => typeof entry.module === 'string' && typeof entry.description === 'string'),
);

// دور المالك يُبَثّ برموز السجل كلها (لا حرف `*` في الصفّ): كلّ رمزٍ في السجل له صفٌّ في الدور.
const ownerCodes = new Set(ownerRole?.permissionCodes ?? []);
const missingFromOwner = registry.filter((entry) => !ownerCodes.has(entry.code)).map((entry) => entry.code);
check(
  'دور المالك يحمل كل رموز السجل غير المهجورة',
  (ownerRole?.permissionCodes ?? []).length > 100 &&
    missingFromOwner.every((code) => code.startsWith('platform.')),
  `${ownerCodes.size} رمزاً · على السجل ${registry.length}`,
);

// ══════════════════════════════════════════════════════ 2. 🧾 التهيئة
console.log('\n■ 2. 🧾 التهيئة — فرعٌ ومستودع وصنفٌ ورصيدٌ وعميلان');
const branches = await get('/branches').then((view) => view.data ?? view);
const warehouses = await get('/warehouses').then((view) => view.data ?? view);
const branchId = branches[0]?.id;
const warehouseId = warehouses[0]?.id;
check(
  'فرعٌ ومستودع في مستأجر العرض',
  Boolean(branchId && warehouseId),
  `${branches[0]?.code ?? '—'} · ${warehouses[0]?.name ?? '—'}`,
);

const stamp = Date.now().toString(36).toUpperCase();
const unitId = (await post('/organization/catalog/units', { code: `VU-${stamp}`, nameAr: 'حبة' })).id;
const categoryId = (await post('/organization/catalog/categories', { code: `VC-${stamp}`, nameAr: 'عام' }))
  .id;
const item = await post('/organization/catalog/items', {
  sku: `VAR-${stamp}`,
  nameAr: 'صنف تحقّق الصلاحيات',
  categoryId,
  baseUnitId: unitId,
  kind: 'stock',
  salePrice: '1000',
});
await post('/inventory/ledger/record', {
  lines: [
    {
      itemId: item.id,
      warehouseId,
      qty: '50',
      unitCost: '700',
      direction: 'in',
      docType: 'opening',
      docId: '00000000-0000-4000-8000-0000000000aa',
    },
  ],
});
const cashParty = await post('/parties', { kind: 'customer', name: 'عميل نقدي — تحقّق الصلاحيات' });
const creditParty = await post('/parties', { kind: 'customer', name: 'عميل آجل — تحقّق الصلاحيات' });
check(
  'صنفٌ برصيدٍ كافٍ وعميلان جاهزون',
  Boolean(item.id && cashParty.id && creditParty.id),
  `${item.sku} · سعر ${item.salePrice}`,
);

/** فاتورة بيع مسودّة على الصنف نفسه: أساسٌ 1000 لكل فحص خصم. */
const draftInvoice = (discount, extra = {}) =>
  post('/sales/invoices', {
    branchId,
    warehouseId,
    cashCustomerName: cashParty.name,
    invoiceDiscount: discount,
    lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
    ...extra,
  });

// ══════════════════════════════════════════════════════ 3. 👤 دعوة مستخدم
console.log('\n■ 3. 👤 دعوة مستخدم — الدور والنطاق وحدّ الخصم');
const invitedEmail = `verify-rbac-${stamp.toLowerCase()}@demo.test`;
const invited = await post('/memberships', {
  email: invitedEmail,
  fullName: 'موظف تحقّق',
  roleIds: [accountantRole.id],
  branchScope: [branchId],
  maxDiscountPct: '7.5000',
});
check('الدعوة تُنشئ عضوية', Boolean(invited.id), invited.id);
check('الاسم المعروض كما أُرسل', invited.displayName === 'موظف تحقّق', invited.displayName);
check('الحالة `invited` — بلا كلمة مرورٍ بعد', invited.status === 'invited', invited.status);
check('نطاق الفرع محفوظ', JSON.stringify(invited.branchScope) === JSON.stringify([branchId]));
check('«أعلى نسبة للخصم %» محفوظة', invited.maxDiscountPct === '7.5000', invited.maxDiscountPct);
check(
  '«أعلى قيمة للخصم» لم تُرسل ⇒ `null` لا صفر',
  invited.maxDiscountAmount === null,
  `${invited.maxDiscountAmount}`,
);
const readBack = await membership(invited.id);
check('العضوية تُقرأ بمعرّفها وحدها', readBack.id === invited.id && readBack.status === 'invited');
check(
  'الدور ارتبط بالعضوية',
  (readBack.roles ?? []).some((role) => role.id === accountantRole.id),
);

const renamed = await patch(`/memberships/${invited.id}`, { displayName: 'موظف تحقّق — بعد التعديل' });
check('تعديل الاسم المعروض يمرّ', renamed.displayName === 'موظف تحقّق — بعد التعديل', renamed.displayName);

const badPct = await refused('patch', `/memberships/${invited.id}`, { maxDiscountPct: '150' });
const badPctNegative = await refused('patch', `/memberships/${invited.id}`, { maxDiscountPct: '-1' });
const badPctText = await refused('patch', `/memberships/${invited.id}`, { maxDiscountPct: 'abc' });
const badAmount = await refused('patch', `/memberships/${invited.id}`, { maxDiscountAmount: '-5' });
check('نسبة 150٪ تُرفض', badPct.status === 400, `${badPct.status} ${badPct.code}`);
check('نسبة سالبة تُرفض', badPctNegative.status === 400, `${badPctNegative.status}`);
check('نسبة غير رقمية تُرفض', badPctText.status === 400, `${badPctText.status}`);
check('قيمة سالبة للخصم تُرفض', badAmount.status === 400, `${badAmount.status}`);
const foreignKey = await refused('patch', `/memberships/${invited.id}`, { discountLimit: '5' });
check(
  'مفتاحٌ غير معلَن يُرفض — `.strict()` لا يتجاهل',
  foreignKey.status === 400,
  `${foreignKey.status} ${foreignKey.code}`,
);
const emptyRoles = await refused('post', '/memberships', {
  email: `x-${stamp.toLowerCase()}@demo.test`,
  roleIds: [],
});
check('دعوة بلا أدوار تُرفض', emptyRoles.status === 400, `${emptyRoles.status} ${emptyRoles.code}`);
const dupe = await refused('post', '/memberships', { email: invitedEmail, roleIds: [accountantRole.id] });
check('دعوة ثانية للبريد نفسه تُرفض', dupe.status >= 400 && dupe.status < 500, `${dupe.status} ${dupe.code}`);

// ══════════════════════════════════════════════════════ 4. 🌿 نطاق الفرع
console.log('\n■ 4. 🌿 نطاق الفرع — `branch_scope` بديل قائمة فروع المستخدم');
const tempBranch = await post('/branches', { code: `VB${stamp}`, nameAr: 'فرع تحقّق مؤقّت' });
check('فرعٌ جديد يُنشأ للفحص', Boolean(tempBranch.id), tempBranch.code);
const scoped = await patch(`/memberships/${invited.id}`, { branchScope: [tempBranch.id] });
check('النطاق يُضبط على فرعٍ واحد', JSON.stringify(scoped.branchScope) === JSON.stringify([tempBranch.id]));
const allBranches = await patch(`/memberships/${invited.id}`, { branchScope: null });
check('`null` تعني «كل الفروع»', allBranches.branchScope === null, `${allBranches.branchScope}`);
const scopedAgain = await patch(`/memberships/${invited.id}`, { branchScope: [tempBranch.id] });
check('النطاق يعود فيُقرأ', JSON.stringify(scopedAgain.branchScope) === JSON.stringify([tempBranch.id]));

// ══════════════════════════════════════════════════════ 5. 🧩 مصفوفة الصلاحيات
console.log('\n■ 5. 🧩 مصفوفة الصلاحيات — السجل والدور (بديل شجرة النماذج)');
check(
  'الدور لا يحمل رمزاً لم يُنشأ بعد (`*` للمالك وحده)',
  !(accountantRole.permissionCodes ?? []).includes('*'),
);
check(
  'رموز الدور كلها من السجل',
  (accountantRole.permissionCodes ?? []).every((code) => registry.some((entry) => entry.code === code)),
  `${accountantRole.permissionCodes.length} رمزاً`,
);
const modules = new Set(registry.map((entry) => entry.module));
check('السجل مجمَّع بوحدات (نافذة الشاشة تقرأ بها)', modules.size >= 10, `${modules.size} وحدة`);
const unknownCode = await refused('post', `/roles/${accountantRole.id}/permissions`, {
  permissionCodes: ['not.a.real.code'],
});
check(
  'رمز مجهول يُرفض ولا يُسجَّل صامتاً',
  unknownCode.status >= 400 && unknownCode.status < 500,
  `${unknownCode.status} ${unknownCode.code}`,
);
const unknownBody = await refused('post', `/roles/${accountantRole.id}/permissions`, {
  codes: ['sales.view'],
});
check('مفتاح `codes` الغريب يُرفض', unknownBody.status === 400, `${unknownBody.status} ${unknownBody.code}`);
const stillIntact = (await roles()).find((role) => role.id === accountantRole.id);
check(
  'مجموعة الدور لم تُمسّ بمحاولةٍ فاشلة',
  JSON.stringify(stillIntact.permissionCodes) === JSON.stringify(accountantRole.permissionCodes),
);

// ══════════════════════════════════════════════════════ 6. 🚫 الرفض بلا رمز
console.log('\n■ 6. 🚫 الرفض بلا رمز — ما يملكه الكاشير وما لا يملكه');
const cashierToken = await signIn(cashier);
const ownerToken = token;
token = cashierToken;
const cashierMemberships = await refused('get', '/memberships');
const cashierInvite = await refused('post', '/memberships', {
  email: invitedEmail,
  roleIds: [accountantRole.id],
});
const cashierPatch = await refused('patch', `/memberships/${invited.id}`, { displayName: 'مسروق' });
const cashierDelete = await refused('delete', `/memberships/${invited.id}`);
const cashierScopes = await refused('post', `/memberships/${invited.id}/scopes`, { scopes: [] });
const cashierRoles = await refused('get', '/roles');
const cashierRegistry = await refused('get', '/permissions');
const cashierSales = await refused('get', '/sales/invoices');
check(
  'الكاشير لا يقرأ قائمة المستخدمين',
  cashierMemberships.status === 403,
  `${cashierMemberships.status} ${cashierMemberships.code}`,
);
check('الكاشير لا يدعو مستخدماً', cashierInvite.status === 403);
check('الكاشير لا يعدّل عضوية', cashierPatch.status === 403);
check('الكاشير لا يحذف عضوية', cashierDelete.status === 403);
check('الكاشير لا يضبط نطاقات الأدوار', cashierScopes.status === 403);
check('الكاشير لا يدير الأدوار', cashierRoles.status === 403);
check('سجلّ الصلاحيات مقروء لمن يقرأ الشاشة', cashierRegistry.status === 200, `${cashierRegistry.status}`);
check('وما يملكه الكاشير يعمل: `sales.view`', cashierSales.status === 200, `${cashierSales.status}`);
const cashierMe = await refused('get', '/me');
check('`/me` يعيد عضوية الكاشير', cashierMe.status === 200);

// ══════════════════════════════════════════════════════ 7. 💰 حدّ الخصم
console.log('\n■ 7. 💰 حدّ الخصم — بديل `OperMaxDiscount` (نسبةٌ وقيمة، فاتورةٌ وكاشير)');
const cashierMembership = baseline.find((row) => (row.roles ?? []).some((role) => role.name === 'Cashier'));
check('عضوية الكاشير موجودة في القائمة', Boolean(cashierMembership), cashierMembership?.displayName ?? '—');
const cashierBaseline = {
  pct: cashierMembership?.maxDiscountPct ?? null,
  amount: cashierMembership?.maxDiscountAmount ?? null,
};
check('الكاشير بلا حدّ قبل الفحص', cashierBaseline.pct === null && cashierBaseline.amount === null);

token = ownerToken; // الحدود تُضبط بيد المالك (رمز `tenant.membership.manage`)
await patch(`/memberships/${cashierMembership.id}`, { maxDiscountPct: '5.0000', maxDiscountAmount: null });
token = cashierToken;
const meAfterCap = await get('/me');
check(
  'الحدّ يظهر في `/me` — الشاشة تقرأه قبل الكتابة',
  meAfterCap.membership.maxDiscountPct === '5.0000',
  `${meAfterCap.membership.maxDiscountPct}`,
);
const percentRefusal = await refused('post', '/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '60',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check(
  'خصم 60 من 1000 (6٪) يُرفض والحدّ 5٪',
  percentRefusal.status === 422 && percentRefusal.code === 'DISCOUNT_LIMIT_EXCEEDED',
  `${percentRefusal.status} ${percentRefusal.code}`,
);
check(
  'والرفض يسمّي الحدّ المُخترَق: نسبة',
  percentRefusal.errors?.[0]?.limitKind === 'percent',
  `${percentRefusal.errors?.[0]?.discountPct}٪`,
);
const percentDetail = percentRefusal.errors?.[0] ?? {};
check(
  'والرفض يذكر المقدار والحدّ والأساس',
  percentDetail.limit === '5.0000' &&
    percentDetail.discount === '60.0000' &&
    percentDetail.gross === '1000.0000',
);

token = ownerToken;
await patch(`/memberships/${cashierMembership.id}`, {
  maxDiscountPct: '5.0000',
  maxDiscountAmount: '10.0000',
});
token = cashierToken;
const amountRefusal = await refused('post', '/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '11',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check(
  'خصم 11 والحدّ 10: النسبة مقبولة والقيمة لا',
  amountRefusal.status === 422 && amountRefusal.errors?.[0]?.limitKind === 'amount',
  `${amountRefusal.status} · ${amountRefusal.errors?.[0]?.limitKind}`,
);
const insideLimit = await post('/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '4',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check(
  'خصم 4 داخل الحدّين يمرّ',
  insideLimit.id && insideLimit.invoiceDiscount === '4.0000',
  `${insideLimit.number} · ${insideLimit.invoiceDiscount}`,
);
const lineAndHeader = await refused('post', '/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '5',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15', discountAmount: '6' }],
});
check(
  'خصم السطر والرأس يُجمعان: 5 + 6 = 11 > 10',
  lineAndHeader.status === 422,
  `${lineAndHeader.status} ${lineAndHeader.code}`,
);

// الكاشير: الشاشتان تعملان، والحدّ لا يمسّ ما لا خصم فيه.
const noDiscount = await post('/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check('فاتورةٌ بلا خصم تمرّ بالحدّ نفسه', Boolean(noDiscount.id), noDiscount.number);

// «تجاوز الخصم الافتراضي» — `ckDiscount` في الشاشة، وحامل الرمز يتجاوز رقمه.
token = ownerToken;
const accountantMembership = baseline.find((row) =>
  (row.roles ?? []).some((role) => role.name === 'Accountant'),
);
const accountantBaseline = {
  pct: accountantMembership?.maxDiscountPct ?? null,
  amount: accountantMembership?.maxDiscountAmount ?? null,
};
await patch(`/memberships/${accountantMembership.id}`, { maxDiscountPct: '5.0000', maxDiscountAmount: null });
const accountantToken = await signIn(accountant);
token = accountantToken; // النداءات التالية بلسان المحاسب لا بلسان المالك
const accountantMe = await get('/me');
check(
  'المحاسب يحمل الحدّ ولا يحمل رمز التجاوز',
  accountantMe.membership.maxDiscountPct === '5.0000' &&
    !accountantMe.permissions.includes('sales.discount.override'),
  `${accountantMe.membership.maxDiscountPct} · ${accountantMe.permissions.length} رمزاً`,
);
const accountantCapped = await refused('post', '/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '60',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check(
  'الحدّ يمسّ كل دورٍ لا يحمل رمز التجاوز (المحاسب)',
  accountantCapped.status === 422 && accountantCapped.code === 'DISCOUNT_LIMIT_EXCEEDED',
  `${accountantCapped.status} ${accountantCapped.code}`,
);

// المالك يحمل `sales.discount.override` من دوره، والحدّ نفسه موضوعٌ على عضويته.
token = ownerToken;
const ownerBaselineCaps = { pct: ownerCaps.pct, amount: ownerCaps.amount };
await patch(`/memberships/${baselineOwner.id}`, { maxDiscountPct: '5.0000', maxDiscountAmount: null });
const overrideInvoice = await refused('post', '/sales/invoices', {
  branchId,
  warehouseId,
  cashCustomerName: cashParty.name,
  invoiceDiscount: '400',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
});
check(
  'حامل رمز التجاوز يمنح 400 والحدّ 5٪',
  overrideInvoice.status < 300,
  `${overrideInvoice.status} ${overrideInvoice.code || 'OK'}`,
);
check('والمقدار نفسه على دورٍ لا يحمل الرمز يُرفض', accountantCapped.status === 422);
const tillOverride = await refused('post', '/pos/checkout', {
  branchId,
  warehouseId,
  partyId: creditParty.id,
  invoiceDiscount: '60',
  lines: [{ itemId: item.id, quantity: '1', unitPrice: '1000', taxRate: '15' }],
  payment: { method: 'credit' },
});
check(
  'والكاشير كذلك: الحدّ يُفحص في الخدمة لا في الشاشة',
  tillOverride.status < 300,
  `${tillOverride.status} ${tillOverride.code || 'OK'}`,
);
await patch(`/memberships/${baselineOwner.id}`, {
  maxDiscountPct: ownerBaselineCaps.pct,
  maxDiscountAmount: ownerBaselineCaps.amount,
});
await patch(`/memberships/${accountantMembership.id}`, {
  maxDiscountPct: accountantBaseline.pct,
  maxDiscountAmount: accountantBaseline.amount,
});
await patch(`/memberships/${cashierMembership.id}`, {
  maxDiscountPct: cashierBaseline.pct,
  maxDiscountAmount: cashierBaseline.amount,
});
token = ownerToken;
const restoredOwner = (await memberships()).find((row) => row.isOwner);
check(
  'وحدّ المالك عاد قبل نهاية القسم',
  restoredOwner.maxDiscountPct === ownerBaselineCaps.pct,
  `${restoredOwner.maxDiscountPct}`,
);
const bigDiscount = await draftInvoice('400');
check(
  'والمالك بلا حدّ يمنح 400 كما كان',
  bigDiscount.id && bigDiscount.invoiceDiscount === '400.0000',
  bigDiscount.number,
);

// ══════════════════════════════════════════════════════ 8. 🌍 عزل المستأجر
console.log('\n■ 8. 🌍 عزل المستأجر — المجهول 404، والقائمة لمستأجرنا');
const ghost = crypto.randomUUID();
const ghostRead = await refused('get', `/memberships/${ghost}`);
const ghostPatch = await refused('patch', `/memberships/${ghost}`, { maxDiscountPct: '100' });
const ghostDelete = await refused('delete', `/memberships/${ghost}`);
check('معرّفٌ مجهول يُقرأ 404', ghostRead.status === 404, `${ghostRead.status} ${ghostRead.code}`);
check('معرّفٌ مجهول يُعدَّل 404', ghostPatch.status === 404, `${ghostPatch.status}`);
check('معرّفٌ مجهول يُحذف 404', ghostDelete.status === 404, `${ghostDelete.status}`);
const rowsNow = await memberships();
check(
  'لا يظهر في القائمة إلا مستأجرنا',
  rowsNow.every((row) => row.tenantCode === tenantCode),
);
check('وكل عضويةٍ لها معرّفٌ فريد', new Set(rowsNow.map((row) => row.id)).size === rowsNow.length);

// ══════════════════════════════════════════════════════ 9. 🧹 التنظيف
console.log('\n■ 9. 🧹 التنظيف — العضوية تُحذف والحدود تعود إلى خطّ الأساس');
await del(`/memberships/${invited.id}`);
const afterDelete = await memberships();
check('العضوية المدعوّة خرجت من القائمة', !afterDelete.some((row) => row.id === invited.id));
check(
  'والعدّ عاد إلى خطّ الأساس',
  afterDelete.length === baseline.length,
  `${afterDelete.length} بعد ${baseline.length} قبل`,
);
const goneRead = await refused('get', `/memberships/${invited.id}`);
check('وقراءتها بعد الحذف 404 — المحذوف يُقرأ مفقوداً', goneRead.status === 404, `${goneRead.status}`);
await del(`/branches/${tempBranch.id}`);
const branchesNow = await get('/branches').then((view) => view.data ?? view);
check(
  'الفرع المؤقّت خرج من القائمة',
  !branchesNow.some((row) => row.id === tempBranch.id),
  `${branchesNow.length} فرعاً`,
);

const finalOwner = (await memberships()).find((row) => row.isOwner);
check(
  'حدّ المالك عاد `null`',
  finalOwner.maxDiscountPct === ownerCaps.pct && finalOwner.maxDiscountAmount === ownerCaps.amount,
  `${finalOwner.maxDiscountPct} / ${finalOwner.maxDiscountAmount}`,
);
token = ownerToken;
const finalCashier = (await memberships()).find((row) => row.id === cashierMembership.id);
check(
  'وحدّ الكاشير عاد `null`',
  finalCashier.maxDiscountPct === cashierBaseline.pct &&
    finalCashier.maxDiscountAmount === cashierBaseline.amount,
  `${finalCashier.maxDiscountPct} / ${finalCashier.maxDiscountAmount}`,
);
const finalAccountant = (await memberships()).find((row) => row.id === accountantMembership.id);
check(
  'وحدّ المحاسب عاد إلى خطّ الأساس',
  finalAccountant.maxDiscountPct === accountantBaseline.pct &&
    finalAccountant.maxDiscountAmount === accountantBaseline.amount,
  `${finalAccountant.maxDiscountPct} / ${finalAccountant.maxDiscountAmount}`,
);
check(
  'ولا عضوية تحمل حدّاً تركناه',
  (await memberships()).every((row) => row.maxDiscountPct === null && row.maxDiscountAmount === null),
);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
