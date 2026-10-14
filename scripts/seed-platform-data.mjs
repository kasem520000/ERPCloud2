#!/usr/bin/env node
/**
 * Seed the platform (multi-tenant SaaS console) with a believable customer base.
 *
 * Creates 9 Saudi tenants through the real platform API (provisioning runs exactly as a
 * human operator would see it), then varies their life-cycle states — active, trial,
 * past-due (with dunning), suspended, canceled — and backfills the platform billing
 * history (monthly invoices issued & paid), backups, leads and files that a console
 * without any customers simply would not have.
 *
 * Idempotent: tenants are keyed by code, invoices by (subscription, period start).
 * Needs the API on :3000 and the local database. Run: node scripts/seed-platform-data.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire('/home/user/ERPCloud/packages/testing/package.json');
const { Client } = require('pg');

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const PW = 'S4as-Demo!9x';

const db = new Client({ connectionString: 'postgres://app:app-dev-password@127.0.0.1:5432/app' });
await db.connect();

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// -------------------------------------------------------------------------- login
const env = await (await import('node:fs')).promises.readFile('/home/user/ERPCloud/.env', 'utf8');
const adminPassword = env.match(/^PLATFORM_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim() ?? 'ChangeMe-Platform!2026';
const login = await api('/auth/login', {
  method: 'POST',
  body: { email: 'admin@platform.test', password: adminPassword, tenantCode: 'platform' },
});
const token = login.data.accessToken;
console.log('platform admin logged in');

// --------------------------------------------------------------------------- plans
const { data: plans } = await api('/platform/plans', { token });
const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));
console.log(`plans: ${plans.map((p) => `${p.code}=${p.amount}${p.currency}`).join(', ')}`);

// --------------------------------------------------------------------- tenants
const TENANTS = [
  { code: 'alnoor-trading', name: 'شركة النور للتجارة', owner: 'سارة الحربي', email: 'sara@alnoor.test', plan: 'pro-monthly', age: 95, state: 'active' },
  { code: 'shams-distribution', name: 'شركة الشمس للتوزيع', owner: 'فهد العتيبي', email: 'fahad@shams.test', plan: 'pro-monthly', age: 80, state: 'active' },
  { code: 'majlis-restaurant', name: 'مطعم مجلس الرياض', owner: 'خالد الدوسري', email: 'khaled@majlis.test', plan: 'starter-monthly', age: 62, state: 'active' },
  { code: 'riyadh-ecom', name: 'متجر الرياض أونلاين', owner: 'نورة القحطاني', email: 'noura@riyadhecom.test', plan: 'pro-monthly', age: 47, state: 'active' },
  { code: 'hajar-industries', name: 'شركة حجر الصناعية', owner: 'ماجد الشهري', email: 'majed@hajar.test', plan: 'pro-monthly', age: 33, state: 'active' },
  { code: 'dawa-pharmacy', name: 'صيدلية الدعوة', owner: 'سعاد المطيري', email: 'suaad@dawa.test', plan: 'starter-monthly', age: 58, state: 'past_due' },
  { code: 'qimam-logistics', name: 'شركة قِمم اللوجستية', owner: 'عبدالله الزهراني', email: 'abdullah@qimam.test', plan: 'pro-monthly', age: 71, state: 'suspended' },
  { code: 'wasl-coffee', name: 'كافيه وصل', owner: 'ريم الغامدي', email: 'reem@wasl.test', plan: 'pro-yearly', age: 12, state: 'trial' },
  { code: 'baraka-llc', name: 'شركة بركة للاستثمار', owner: 'طارق السلمي', email: 'tareq@baraka.test', plan: 'starter-monthly', age: 88, state: 'canceled' },
];

const vatFor = (code) => '3' + String(1000000000000 + hash(code) % 8999999999999).padEnd(14, '0');

const existing = await db.query(`select code, id from tenants`);
const existingCodes = new Set(existing.rows.map((r) => r.code));

const created = [];
for (const t of TENANTS) {
  let tenantId;
  if (existingCodes.has(t.code)) {
    tenantId = existing.rows.find((r) => r.code === t.code).id;
    console.log(`· ${t.code} exists`);
  } else {
    const r = await api('/platform/tenants', {
      method: 'POST',
      token,
      body: { code: t.code, name: t.name, ownerEmail: t.email, ownerFullName: t.owner, ownerPassword: PW, planId: planByCode[t.plan].id },
    });
    tenantId = r.data.tenantId;
    console.log(`+ ${t.code} (${t.name})`);
  }
  created.push({ ...t, tenantId });
}
const byCode = (code) => created.find((t) => t.code === code);

// ------------------------------------------------------------- backfill dates
for (const t of created) {
  const since = daysAgo(t.age);
  await db.query(
    `update tenants set created_at = $2 where id = $1`,
    [t.tenantId, since],
  );
  await db.query(
    `update users u set created_at = $2 from memberships m where m.tenant_id = $1 and m.is_owner and m.user_id = u.id`,
    [t.tenantId, since],
  );
  await db.query(
    `update memberships set created_at = $2 where tenant_id = $1`,
    [t.tenantId, since],
  );
}
await db.query(`update tenants set created_at = $1 where code = 'demo'`, [daysAgo(1)]);

// wasl-coffee is a trial (never billed); dawa-pharmacy is past-due (latest month unpaid).
// Both are fixed BEFORE the billing loop, and their old invoices from earlier runs are
// wiped so the paid/unpaid mix is rebuilt correctly.
{
  const w = byCode('wasl-coffee');
  await db.query(`delete from platform_payments where tenant_id = $1`, [w.tenantId]);
  await db.query(`delete from platform_invoice_lines where tenant_id = $1`, [w.tenantId]);
  await db.query(`delete from platform_invoices where tenant_id = $1`, [w.tenantId]);
  await db.query(
    `update tenant_subscriptions set status = 'trialing', trial_ends_at = $2, current_period_start = $3
     where tenant_id = $1`,
    [w.tenantId, daysAgo(-12), daysAgo(12)],
  );
  const d = byCode('dawa-pharmacy');
  await db.query(`delete from platform_payments where tenant_id = $1`, [d.tenantId]);
  await db.query(`delete from platform_invoice_lines where tenant_id = $1`, [d.tenantId]);
  await db.query(`delete from platform_invoices where tenant_id = $1`, [d.tenantId]);
}

// ------------------------------------------------------------------ invoices
const subOf = async (tenantId) => {
  const r = await db.query(`select id, status, plan_id from tenant_subscriptions where tenant_id = $1`, [tenantId]);
  return r.rows[0] ?? null;
};

const planAmount = (planId) => Number(plans.find((p) => p.id === planId)?.amount ?? 0);
const planInterval = (planId) => plans.find((p) => p.id === planId)?.interval ?? 'month';

const monthStart = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return d;
};
const monthEnd = (n) => {
  const d = new Date();
  d.setDate(0); // last day of previous month when n=1
  if (n > 1) d.setMonth(d.getMonth() - (n - 2));
  return d;
};

let invoicesMade = 0;
for (const t of created) {
  const sub = await subOf(t.tenantId);
  if (!sub) continue;
  if (!['active', 'past_due'].includes(sub.status)) continue; // trials & canceled don't bill
  const amount = planAmount(sub.plan_id);
  const vat = vatFor(t.code);

  // months to bill: never more than 6, never older than the tenant
  const monthsTotal = planInterval(sub.plan_id) === 'year' ? 1 : Math.min(Math.floor(t.age / 30), 6);
  const already = new Set(
    (await db.query(`select to_char(period_start, 'YYYY-MM-DD') d from platform_invoices where subscription_id = $1`, [sub.id])).rows.map((r) => r.d),
  );

  for (let m = monthsTotal; m >= 1; m -= 1) {
    const ps = monthStart(m);
    const pe = monthEnd(m);
    if (already.has(iso(ps))) continue;

    const draft = await api('/platform/invoices', {
      method: 'POST',
      token,
      body: {
        subscriptionId: sub.id,
        periodStart: iso(ps),
        periodEnd: iso(pe),
        buyerTaxNumber: vat,
        reason: 'فوترة فترة اشتراك دورية',
      },
    });
    const inv = draft.data;
    const issueDate = new Date(ps.getTime() + 3 * 86400000);
    const issued = (await api(`/platform/invoices/${inv.id}/issue`, {
      method: 'POST',
      token,
      body: { issueDate: iso(issueDate), note: `اشتراك ${t.name} — ${iso(pe).slice(0, 7)}` },
    })).data;

    invoicesMade += 1;
    // A past-due customer leaves their latest invoice unpaid (the dunning target).
    if (t.state === 'past_due' && m === 1) continue;
    const payDate = new Date((issued.issuedAt ? Date.parse(issued.issuedAt) : Date.now()) + 5 * 86400000);
    const payBody = { method: 'bank_transfer', reference: `TRF-${t.code.slice(0, 4).toUpperCase()}-${Math.abs(hash(t.code + m)) % 99999}`, receivedAt: payDate.toISOString(), note: 'تحويل بنكي' };
    await api(`/platform/invoices/${issued.id}/pay`, { method: 'POST', token, body: payBody });
  }
}
console.log(`invoices made: ${invoicesMade}`);

// Self-heal: pay any invoice left unpaid by an earlier crashed run (dawa's latest stays open).
for (const t of created) {
  if (t.state === 'past_due' || t.state === 'trial') continue;
  const open = (
    await db.query(`select id, issue_date from platform_invoices where tenant_id = $1 and status = 'issued' order by issue_date`, [t.tenantId])
  ).rows;
  for (const row of open) {
    const payDate = new Date((Date.parse(row.issue_date) || Date.now()) + 5 * 86400000);
    await api(`/platform/invoices/${row.id}/pay`, {
      method: 'POST',
      token,
      body: { method: 'bank_transfer', reference: `TRF-${t.code.slice(0, 4).toUpperCase()}-HEAL`, receivedAt: payDate.toISOString(), note: 'تحويل بنكي' },
    });
    console.log(`· paid stale invoice for ${t.code} (${iso(row.issue_date)})`);
  }
}

// ------------------------------------------------- life-cycle state changes
try {
  const q = byCode('qimam-logistics');
  await api(`/platform/tenants/${q.tenantId}/status`, {
    method: 'POST',
    token,
    body: { status: 'suspended', reason: 'تجاوز الحد الائتماني ثلاث مرات بلا سداد' },
  });
  console.log('· qimam-logistics suspended');
} catch (e) {
  console.log('qimam suspend skipped:', e.message.slice(0, 90));
}

try {
  const b = byCode('baraka-llc');
  const bsub = await subOf(b.tenantId);
  await api(`/platform/subscriptions/${bsub.id}/cancel`, {
    method: 'POST',
    token,
    body: { reason: 'قرار الإدارة بإلغاء الخدمة', atPeriodEnd: false },
  });
  console.log('· baraka-llc subscription canceled');
} catch (e) {
  console.log('baraka cancel skipped:', e.message.slice(0, 90));
}

// past-due via direct state (the trial was already set before billing)
const dawa = byCode('dawa-pharmacy');
await db.query(
  `update tenant_subscriptions set status = 'past_due', current_period_end = $2 where tenant_id = $1`,
  [dawa.tenantId, daysAgo(6)],
);
console.log('· dawa-pharmacy past due');

// --------------------------------------------------------------- dunning rows
const dawaSub = await subOf(dawa.tenantId);
const dawaInv = (
  await db.query(`select id from platform_invoices where subscription_id = $1 and status <> 'paid' order by issue_date desc limit 1`, [dawaSub.id])
).rows[0];
const dunningExist = (await db.query(`select count(*)::int n from dunning_attempts where subscription_id = $1`, [dawaSub.id])).rows[0].n;
if (dunningExist === 0 && dawaInv) {
  await db.query(
    `insert into dunning_attempts (id, tenant_id, subscription_id, invoice_id, attempt_no, channel, status, scheduled_at, sent_at, message, created_at)
     values ($1, $2, $3, $4, 1, 'email', 'sent', $5, $5, 'تنبيه أول: فاتورة غير مسددة — المهلة تنتهي خلال 7 أيام', $5),
            ($6, $2, $3, $4, 2, 'email', 'scheduled', $7, null, 'تذكير ثانٍ قبل التوقيف', $5)`,
    [crypto.randomUUID(), dawa.tenantId, dawaSub.id, dawaInv.id, daysAgo(4), crypto.randomUUID(), daysAgo(-1)],
  );
  console.log('· dunning attempts for dawa-pharmacy');
}

// ------------------------------------------------------------- activation queue
const signup = (body) => api('/signup', { method: 'POST', body });
for (const [name, code, owner, email, plan] of [
  ['مقهى الروضة', 'rawda-cafe', 'أسامة الرميح', 'osama@rawda.test', 'pro-monthly'],
  ['مكتبة المعرفة', 'maraya-books', 'ليان السبيعي', 'layan@maraya.test', 'starter-monthly'],
]) {
  if (!existingCodes.has(code)) {
    try {
      await signup({ companyName: name, code, ownerFullName: owner, ownerEmail: email, ownerPassword: PW, planId: planByCode[plan].id });
      console.log(`+ signup ${code} (pending activation)`);
    } catch (e) {
      console.log(`${code} signup skipped:`, e.message.slice(0, 120));
    }
  }
}

// -------------------------------------------------------------------- backups
const backupFor = async (code, tenantId, daysAgoN, failed = false) => {
  const owner = (await db.query(`select m.user_id from memberships m where m.tenant_id=$1 and m.is_owner`, [tenantId])).rows[0];
  const stamp = daysAgo(daysAgoN).toISOString().slice(0, 16).replace('T', 'T');
  if (failed) {
    const exists = (await db.query(`select count(*)::int n from backup_runs where tenant_id=$1 and status='failed'`, [tenantId])).rows[0].n;
    if (exists > 0) return;
    await db.query(
      `insert into backup_runs (id, tenant_id, kind, status, note, tables, total_rows, failed_reason, created_at, version)
       values ($1, $2, 'manual', 'failed', 'نسخ احتياطي مجدول', '[]'::jsonb, 0, 'انتهت المهلة أثناء انتظار القفل الحصري', $3, 1)`,
      [crypto.randomUUID(), tenantId, daysAgo(daysAgoN)],
    );
    console.log(`· failed backup for ${code}`);
    return;
  }
  const exists = (await db.query(`select count(*)::int n from backup_runs where tenant_id=$1 and status='success'`, [tenantId])).rows[0].n;
  if (exists > 0) return;
  const rows = 4000 + hash(code) % 40000;
  const bytes = 2000000 + hash(code + 'b') % 9000000;
  const runId = crypto.randomUUID();
  const checksum = crypto.createHash('sha256').update(runId).digest('hex');
  await db.query(
    `insert into backup_runs (id, tenant_id, kind, status, note, tables, row_counts, total_rows, size_bytes, checksum, completed_at, created_at, created_by, version)
     values ($1, $2, 'manual', 'success', 'نسخ احتياطي كامل عبر لوحة المنصة', '["sales_invoices","journal_entries","items","customers"]'::jsonb,
             $3::jsonb, $4, $5, $6, $7, $7, $8, 1)`,
    [
      runId,
      tenantId,
      JSON.stringify({ sales_invoices: 800 + hash(code) % 2000, journal_entries: 900 + hash(code) % 2000, items: 200 + hash(code) % 400, customers: 150 + hash(code) % 350 }),
      rows,
      bytes,
      checksum,
      daysAgo(daysAgoN),
      owner?.user_id,
    ],
  );
  const artifactId = crypto.randomUUID();
  await db.query(
    `insert into backup_artifacts (id, kind, store, object_key, format, encryption, iv, bytes, checksum, tables, rows, created_at, created_by)
     values ($1, 'platform-dump', 'filesystem', $2, 'json', 'aes-256-gcm', encode(gen_random_bytes(12), 'hex'), $3, $4, 4, $5, $6, $7)`,
    [artifactId, `backups/${code}/backup-${stamp}.json.enc`, bytes, crypto.createHash('sha256').update(artifactId).digest('hex'), rows, daysAgo(daysAgoN), owner?.user_id],
  );
  console.log(`· backup for ${code}`);
};
const demoId = (await db.query(`select id from tenants where code='demo'`)).rows[0].id;
await backupFor('demo', demoId, 1);
await backupFor('alnoor-trading', byCode('alnoor-trading').tenantId, 2);
await backupFor('shams-distribution', byCode('shams-distribution').tenantId, 0);
await backupFor('dawa-pharmacy', dawa.tenantId, 1, true);

// ----------------------------------------------------------------------- leads
const hex8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8).toUpperCase();
const leadRows = [
  ['أحمد باوزير', 'مطاعم البحر الأحمر', 'ahmed@bahrmr.com', 'new', 'form', 'pro-monthly', 2, 'أرغب في الانتقال من برنامج محاسبي قديم، لدينا ثلاثة فروع وموظفون بالمفوضات.'],
  ['هند العنزي', 'معارض العنزي للسيارات', 'hind@anazi.com.sa', 'contacted', 'demo', 'pro-monthly', 5, 'جربت العرض التجريبي وأعجبني شاشات المخزون. نحتاج ربطاً مع فاتورة ضريبية.'],
  ['يوسف كمال', 'مكتب كمال للاستشارات', 'yousef@kamal.sa', 'qualified', 'form', 'pro-monthly', 9, 'نحتاج صلاحيات دقيقة وسجل تدقيق، وسنتخذ القرار نهاية الشهر.'],
  ['لمى الشهري', 'متجر لمى للأزياء', 'lama@lama.sa', 'won', 'newsletter', 'starter-monthly', 12, 'متجر أونلاين صغير، بدأت بالباقة الأساسية وسأترقى لاحقاً.'],
  ['سامي الحارثي', 'مزارع الحارثي', 'sami@harthi.sa', 'rejected', 'campaign', 'starter-monthly', 17, 'الميزانية غير متاحة هذا الموسم، سأعود في الربع القادم.'],
  ['جواهر الدوسري', 'عيادات جواهر', 'jawaher@jawaher.sa', 'new', 'form', 'starter-monthly', 1, 'أبحث عن نظام بسيط للعيادات مع تقارير يومية.'],
];
const leadsN = (await db.query(`select count(*)::int n from leads`)).rows[0].n;
if (leadsN === 0) {
  const wonTenant = (await db.query(`select id from tenants where code = 'hajar-industries'`)).rows[0]?.id ?? null;
  for (const [name, company, email, status, source, plan, days, message] of leadRows) {
    await db.query(
      `insert into leads (id, reference, full_name, company_name, email, dedupe_key, phone, branch_count, plan_interest, message, status, source, locale, accepts_marketing, converted_tenant_id, converted_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ar', true, $13, $14, $15)`,
      [
        crypto.randomUUID(),
        `L-${hex8(email)}`,
        name,
        company,
        email,
        email.toLowerCase(),
        `+9665${(50000000 + hash(email) % 49999999).toString()}`,
        1 + (hash(email) % 3),
        plan,
        message,
        status,
        source,
        status === 'won' ? wonTenant : null,
        status === 'won' ? daysAgo(days - 3) : null,
        daysAgo(days),
      ],
    );
  }
  console.log(`· ${leadRows.length} leads`);
}

// ----------------------------------------------------------------------- files
const filesFor = async (code, tenantId) => {
  const n = (await db.query(`select count(*)::int n from files where tenant_id = $1`, [tenantId])).rows[0].n;
  if (n > 0) return;
  const owner = (await db.query(`select m.user_id from memberships m where m.tenant_id=$1 and m.is_owner`, [tenantId])).rows[0]?.user_id;
  const base = [
    ['logo', 'شعار الشركة.png', 'image/png', 84_210, 'logo'],
    ['company_profile', 'سجل-التجارة.pdf', 'application/pdf', 412_933, 'document'],
  ];
  for (const [entity, name, mime, size] of base) {
    const fileId = crypto.randomUUID();
    await db.query(
      `insert into files (id, tenant_id, bucket, object_key, name, mime, size_bytes, checksum, status, entity, uploaded_by, created_at, created_by, version)
       values ($1, $2, 'erp', $3, $4, $5, $6, $7, 'ready', $8, $9, now(), $9, 1)`,
      [fileId, tenantId, `tenants/${code}/${entity}/${name}`, name, mime, size + hash(name) % 100000, crypto.createHash('sha256').update(fileId).digest('hex'), entity, owner],
    );
  }
};
for (const t of created) await filesFor(t.code, t.tenantId);
await filesFor('demo', demoId);
console.log('· files for all tenants');

// -------------------------------------------------------------------- verify
const overview = await api('/platform/overview', { token });
console.log('\n=== overview ===');
console.log(JSON.stringify(overview.data, null, 1));
const rev = await api('/platform/revenue', { token });
console.log('\n=== revenue (shape) ===');
console.log(JSON.stringify(rev.data).slice(0, 400));
const tenants = await api('/platform/tenants', { token });
console.log(`\ntenants list: ${tenants.data.length} rows`);
const invoices = await api('/platform/invoices', { token });
console.log(`invoices: ${Array.isArray(invoices.data) ? invoices.data.length : invoices.data}`);
await db.end();
console.log('\nplatform seed complete');
