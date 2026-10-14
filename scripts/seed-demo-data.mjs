#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `node scripts/seed-demo-data.mjs` — populate the `demo` tenant with a realistic
 * operating dataset so the redesigned UIs can be evaluated end-to-end:
 *
 *   part 1 (SQL, migrator role)  chart of accounts · currency · units · tax groups ·
 *                                fiscal year + periods · branches · warehouses ·
 *                                cash locations · payment methods · price list ·
 *                                posting profile · categories · items · customers ·
 *                                salesmen · opening stock
 *
 *   part 2 (API, owner session)  55+ sales invoices over the last 35 days — created
 *                                and POSTED through the real posting engine (journal
 *                                entries, stock movements, receivables all genuine) —
 *                                plus payments, quotations, drafts and sales returns.
 *
 * The script is idempotent: re-running it only adds new documents. It touches the
 * `demo` tenant exclusively and never alters schema or API code.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireRoot = createRequire(join(root, 'package.json'));
const requireTesting = createRequire(join(root, 'packages', 'testing', 'package.json'));
let Client;
try {
  ({ Client } = requireRoot('pg'));
} catch {
  ({ Client } = requireTesting('pg'));
}
const dbPkg = requireRoot(join(root, 'packages', 'database', 'dist', 'index.js'));
const { seedDefaultChartOfAccounts, DEMO_POSTING_PROFILE } = dbPkg;

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const daysAgo = (n, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, (n * 17) % 60, 0, 0);
  return d.toISOString();
};

// --------------------------------------------------------------------------- part 1
const db = new Client({ connectionString: env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL });
await db.connect();
await db.query(`SET search_path TO public`);

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const [tenant] = await q(`select id, name, base_currency from tenants where code = 'demo'`);
if (!tenant) throw new Error('demo tenant missing — run `pnpm db:seed` first');
const tid = tenant.id;
await db.query(`select set_config('app.tenant_id', $1, false)`, [tid]);

const [owner] = await q(
  `select u.id from users u join memberships m on m.user_id = u.id where m.tenant_id = $1 and m.is_owner limit 1`,
  [tid],
);
if (!owner) throw new Error('demo owner missing');

const run = async (label, fn) => {
  const before = process.hrtime.bigint();
  await fn();
  const ms = Number(process.hrtime.bigint() - before) / 1e6;
  console.log(`  ${label} (${ms.toFixed(0)}ms)`);
};

console.log('part 1 — master data (SQL)');

await run('chart of accounts', async () => {
  const [row] = await q(`select count(*)::int n from accounts where tenant_id = $1`, [tid]);
  if (row.n > 0) return;
  const chart = await seedDefaultChartOfAccounts(db, tid);
  console.log(`    ↳ ${chart.inserted} accounts`);
});

await run('currency + units + tax groups', async () => {
  await q(
    `insert into currencies (tenant_id, code, name_ar, name_en, minor_units, is_base, is_active, created_at, created_by)
     values ($1, 'SAR', 'ريال سعودي', 'Saudi Riyal', 2, true, true, now(), $2) on conflict do nothing`,
    [tid, owner.id],
  );
  const units = [
    ['PIECE', 'قطعة', 'Piece'],
    ['BOX', 'صندوق', 'Box'],
    ['CARTON', 'كرتون', 'Carton'],
    ['KG', 'كيلوجرام', 'Kilogram'],
    ['LITER', 'لتر', 'Litre'],
    ['METER', 'متر', 'Metre'],
  ];
  for (const [code, ar, en] of units) {
    await q(
      `insert into units_of_measure (id, tenant_id, code, name_ar, name_en, created_at, created_by, version)
       values ($1, $2, $3, $4, $5, now(), $6, 1) on conflict do nothing`,
      [uuid(), tid, code, ar, en, owner.id],
    );
  }
  const unitOf = Object.fromEntries(
    (await q(`select code, id from units_of_measure where tenant_id = $1`, [tid])).map((r) => [r.code, r.id]),
  );
  const vatAccount = (await q(`select id from accounts where tenant_id = $1 and code = '2222001'`, [tid]))[0]?.id ?? null;
  const groups = [
    ['VAT15', 'ضريبة القيمة المضافة 15٪', '15', vatAccount, true],
    ['VAT0', 'ضريبة القيمة المضافة 0٪', '0', vatAccount, false],
    ['EXEMPT', 'معفاة من الضريبة', '0', null, false],
  ];
  for (const [code, name, rate, vatAcct, def] of groups) {
    const [exists] = await q(`select 1 from tax_groups where tenant_id = $1 and name_ar = $2`, [tid, name]);
    if (exists) continue;
    await q(
      `insert into tax_groups (id, tenant_id, name_ar, name_en, rate, vat_account_id, is_inclusive_default, created_at, created_by, version)
       values ($1, $2, $3, $4, $5, $6, $7, now(), $8, 1)`,
      [uuid(), tid, name, name, rate, vatAcct, def, owner.id],
    );
  }
});

await run('fiscal year 2026 + periods', async () => {
  const [fy] = await q(`select id from fiscal_years where tenant_id = $1 and name = '2026'`, [tid]);
  let fyId = fy?.id;
  if (!fyId) {
    fyId = uuid();
    await q(
      `insert into fiscal_years (id, tenant_id, name, start_date, end_date, status, created_at, created_by, version)
       values ($1, $2, '2026', '2026-01-01', '2026-12-31', 'open', now(), $3, 1)`,
      [fyId, tid, owner.id],
    );
  }
  const names = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(2026, m, 1));
    const end = new Date(Date.UTC(2026, m + 1, 1));
    const [exists] = await q(
      `select 1 from fiscal_periods where tenant_id = $1 and fiscal_year_id = $2 and start_date = $3`,
      [tid, fyId, start.toISOString()],
    );
    if (exists) continue;
    await q(
      `insert into fiscal_periods (id, tenant_id, fiscal_year_id, name, start_date, end_date, status, is_active, created_at, created_by, version)
       values ($1, $2, $3, $4, $5, $6, 'open', true, now(), $7, 1)`,
      [uuid(), tid, fyId, `${names[m]} 2026`, start.toISOString(), end.toISOString(), owner.id],
    );
  }
});

const branches = [
  { code: 'MAIN', ar: 'الفرع الرئيسي — الرياض', en: 'Main Branch — Riyadh' },
  { code: 'JED', ar: 'فرع جدة', en: 'Jeddah Branch' },
  { code: 'DMK', ar: 'فرع الدمام', en: 'Dammam Branch' },
];
const branchId = {};
const warehouseId = {};
await run('branches + warehouses + cash locations', async () => {
  // The API provisions the default branch/warehouse on first login — reuse it, never duplicate it.
  const [defaultBranch] = await q(`select id from branches where tenant_id = $1 and is_default = true and deleted_at is null`, [tid]);
  const [defaultWarehouse] = await q(`select id from warehouses where tenant_id = $1 and is_default = true and deleted_at is null`, [tid]);
  for (const [i, b] of branches.entries()) {
    let row = (await q(`select id from branches where tenant_id = $1 and code = $2`, [tid, b.code]))[0];
    if (!row) row = defaultBranch && i === 0 ? { id: defaultBranch.id } : undefined;
    if (!row) {
      const id = uuid();
      await q(
        `insert into branches (id, tenant_id, code, name_ar, name_en, is_default, is_active, created_at, created_by, version)
         values ($1, $2, $3, $4, $5, $6, true, now(), $7, 1)`,
        [id, tid, b.code, b.ar, b.en, i === 0 && !defaultBranch, owner.id],
      );
      row = { id };
    }
    branchId[b.code] = row.id;
    let wh = (await q(`select id from warehouses where tenant_id = $1 and branch_id = $2`, [tid, row.id]))[0];
    if (!wh) wh = defaultWarehouse && i === 0 ? { id: defaultWarehouse.id } : undefined;
    if (!wh) {
      const id = uuid();
      await q(
        `insert into warehouses (id, tenant_id, branch_id, code, name, is_default, is_active, created_at, created_by, version)
         values ($1, $2, $3, $4, $5, $6, true, now(), $7, 1)`,
        [id, tid, row.id, `WH-${b.code}`, b.en, i === 0 && !defaultWarehouse, owner.id],
      );
      wh = { id };
    }
    warehouseId[b.code] = wh.id;
    await q(
      `insert into stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version, updated_at)
       select $1, i.id, $2, 0, 0, 0, 1, now() from items i where i.tenant_id = $1
       on conflict do nothing`,
      [tid, wh.id],
    );
  }
  const [safe] = await q(`select id from cash_locations where tenant_id = $1 and kind = 'safe' and is_default = true`, [tid]);
  if (!safe) {
    const cashAcct = (await q(`select id from accounts where tenant_id = $1 and code = '1211001'`, [tid]))[0]?.id ?? null;
    await q(
      `insert into cash_locations (id, tenant_id, branch_id, kind, name, account_id, currency_code, is_default, is_active, created_at, created_by, version)
       values ($1, $2, $3, 'safe', 'الخزنة الرئيسية', $4, 'SAR', true, true, now(), $5, 1)`,
      [uuid(), tid, branchId.MAIN, cashAcct, owner.id],
    );
  }
  const [bank] = await q(`select id from cash_locations where tenant_id = $1 and kind = 'bank'`, [tid]);
  if (!bank) {
    const bankAcct = (await q(`select id from accounts where tenant_id = $1 and code = '1221001'`, [tid]))[0]?.id ?? null;
    await q(
      `insert into cash_locations (id, tenant_id, branch_id, kind, name, account_id, currency_code, is_default, bank, is_active, created_at, created_by, version)
       values ($1, $2, $3, 'bank', 'حساب البنك الأهلي', $4, 'SAR', false, 'البنك الأهلي', true, now(), $5, 1)`,
      [uuid(), tid, branchId.MAIN, bankAcct, owner.id],
    );
  }
});

await run('payment methods + price list + posting profile', async () => {
  const methods = [
    ['CASH', 'نقدي', 'Cash', 'cash', true, null],
    ['CARD', 'شبكة / بطاقة', 'Card', 'card', false, null],
    ['BANK', 'تحويل بنكي', 'Bank transfer', 'bank', false, null],
  ];
  const safeId = (await q(`select id from cash_locations where tenant_id = $1 and kind = 'safe'`, [tid]))[0]?.id;
  const bankId = (await q(`select id from cash_locations where tenant_id = $1 and kind = 'bank'`, [tid]))[0]?.id;
  for (const [code, ar, en, kind, def, loc] of methods) {
    const [exists] = await q(`select 1 from payment_methods where tenant_id = $1 and code = $2`, [tid, code]);
    if (exists) continue;
    await q(
      `insert into payment_methods (id, tenant_id, code, name_ar, name_en, kind, due_days, cash_location_id, is_active, is_default, created_at, created_by, version)
       values ($1, $2, $3, $4, $5, $6, 15, $7, true, $8, now(), $9, 1)`,
      [uuid(), tid, code, ar, en, kind, kind === 'bank' ? bankId : safeId, def, owner.id],
    );
  }
  const [pl] = await q(`select id from price_lists where tenant_id = $1 and is_default = true`, [tid]);
  if (!pl) {
    await q(
      `insert into price_lists (id, tenant_id, name, currency_code, is_default, is_active, created_at, created_by, version)
       values ($1, $2, 'قائمة البيع الأساسية', 'SAR', true, true, now(), $3, 1)`,
      [uuid(), tid, owner.id],
    );
  }
  const [profile] = await q(
    `select id from branch_posting_profiles where tenant_id = $1 and branch_id is null and doc_type = '*'`,
    [tid],
  );
  if (!profile) {
    const codes = [...new Set(Object.values(DEMO_POSTING_PROFILE))];
    const accounts = await q(
      `select id, code from accounts where tenant_id = $1 and code = any($2::text[])`,
      [tid, codes],
    );
    const byCode = new Map(accounts.map((a) => [a.code.trim(), a.id]));
    const mapping = { version: 1 };
    for (const [key, code] of Object.entries(DEMO_POSTING_PROFILE)) {
      const id = byCode.get(code);
      if (id) mapping[key] = id;
    }
    await q(
      `insert into branch_posting_profiles (id, tenant_id, branch_id, doc_type, mapping, created_at, created_by)
       values ($1, $2, null, '*', $3::jsonb, now(), $4)`,
      [uuid(), tid, JSON.stringify(mapping), owner.id],
    );
    console.log(`    ↳ posting profile with ${Object.keys(mapping).length - 1} account mappings`);
  }
});

// ---------------------------------------------------------------- categories & items
const CATEGORIES = [
  ['ELEC', 'الإلكترونيات'],
  ['BEV', 'مشروبات'],
  ['GROC', 'مواد غذائية'],
  ['DAIRY', 'ألبان وأجبان'],
  ['SNACK', 'وجبات خفيفة'],
  ['HOME', 'منازل ومطبخ'],
  ['CLEAN', 'منظفات'],
  ['OFFICE', 'قرطاسية ومكتب'],
];
const ITEM_DEFS = [
  // [sku, name_ar, name_en, cat, unit, price, cost, min, opening(main, jed, dmk)]
  ['ELC-1001', 'جهاز لوحي 10 بوصة', 'Tablet 10"', 'ELEC', 'PIECE', 1450, 1050, 5, [14, 6, 4]],
  ['ELC-1002', 'سماعة بلوتوث لاسلكية', 'Wireless Earbuds', 'ELEC', 'PIECE', 220, 140, 10, [40, 15, 12]],
  ['ELC-1003', 'شاحن سريع 65 واط', '65W Fast Charger', 'ELEC', 'PIECE', 89, 52, 12, [60, 25, 20]],
  ['ELC-1004', 'كابل شحن USB-C 2م', 'USB-C Cable 2m', 'ELEC', 'PIECE', 25, 12, 25, [200, 80, 60]],
  ['ELC-1005', 'ماوس لاسلكي', 'Wireless Mouse', 'ELEC', 'PIECE', 65, 38, 10, [35, 12, 10]],
  ['BEV-2001', 'ماء معدني 330مل (كرتون 24)', 'Water 330ml ×24', 'BEV', 'CARTON', 18, 13, 40, [160, 70, 55]],
  ['BEV-2002', 'مشروب طاقية 250مل (كرتون 24)', 'Energy Drink 250ml ×24', 'BEV', 'CARTON', 42, 31, 30, [90, 40, 30]],
  ['BEV-2003', 'عصير برتقال 1 لتر', 'Orange Juice 1L', 'BEV', 'LITER', 12, 8, 36, [120, 50, 40]],
  ['BEV-2004', 'قهوة عربية 500غ', 'Arabic Coffee 500g', 'BEV', 'PIECE', 34, 24, 15, [70, 30, 25]],
  ['GRO-3001', 'أرز بسمتي 5كجم', 'Basmati Rice 5kg', 'GROC', 'PIECE', 58, 45, 20, [110, 45, 35]],
  ['GRO-3002', 'زيت دوار الشمس 1.5ل', 'Sunflower Oil 1.5L', 'GROC', 'PIECE', 19, 15, 30, [150, 60, 45]],
  ['GRO-3003', 'دقيق فاخر 2كجم', 'Premium Flour 2kg', 'GROC', 'PIECE', 11, 8, 40, [220, 90, 70]],
  ['GRO-3004', 'معكرونة 500غ', 'Pasta 500g', 'GROC', 'PIECE', 4.5, 3, 60, [300, 120, 90]],
  ['DAI-4001', 'حليب طويل الأمد 1ل (كرتون 12)', 'UHT Milk 1L ×12', 'DAIRY', 'CARTON', 36, 28, 35, [130, 55, 40]],
  ['DAI-4002', 'جبن شيدر 400غ', 'Cheddar Cheese 400g', 'DAIRY', 'PIECE', 27, 20, 20, [80, 30, 24]],
  ['DAI-4003', 'زبادي طبيعي (درزن)', 'Natural Yogurt Dozen', 'DAIRY', 'CARTON', 24, 17, 25, [100, 40, 30]],
  ['SNK-5001', 'شوكولاتة 90غ', 'Chocolate Bar 90g', 'SNACK', 'PIECE', 7.5, 4.8, 50, [260, 100, 80]],
  ['SNK-5002', 'بسكويت محشي (علبة 12)', 'Filling Biscuits ×12', 'SNACK', 'PIECE', 15, 10, 30, [140, 55, 45]],
  ['SNK-5003', 'مكسرات مشكلة 250غ', 'Mixed Nuts 250g', 'SNACK', 'PIECE', 39, 28, 15, [75, 30, 22]],
  ['HOM-6001', 'طقم أكواب زجاجية (6)', 'Glass Cup Set (6)', 'HOME', 'PIECE', 45, 30, 10, [45, 18, 14]],
  ['HOM-6002', 'مقلاة تيفال 24سم', 'Tefal Frying Pan 24cm', 'HOME', 'PIECE', 165, 118, 8, [26, 10, 8]],
  ['HOM-6003', 'ملفوفة شاي كهربائية', 'Electric Kettle 1.7L', 'HOME', 'PIECE', 99, 68, 10, [38, 15, 12]],
  ['CLN-7001', 'مكونفلة (عبوة 3ل)', 'Dish Liquid 3L', 'CLEAN', 'PIECE', 22, 15, 25, [120, 50, 40]],
  ['CLN-7002', 'مسحوق غسيل 5كجم', 'Laundry Detergent 5kg', 'CLEAN', 'PIECE', 48, 36, 20, [95, 40, 30]],
  ['CLN-7003', 'معطر أرضيات 1ل', 'Floor Cleaner 1L', 'CLEAN', 'PIECE', 14, 9, 30, [110, 45, 35]],
  ['OFC-8001', 'دفاتر A4 (ربطة 5)', 'A4 Notebooks Pack of 5', 'OFFICE', 'PIECE', 28, 19, 20, [90, 35, 28]],
  ['OFC-8002', 'أقلام جاف (علبة 12)', 'Gel Pens Box of 12', 'OFFICE', 'PIECE', 21, 13, 25, [105, 40, 32]],
  ['OFC-8003', 'ورق طباعة A4 (رزمة 500)', 'A4 Paper 500 Sheets', 'OFFICE', 'CARTON', 33, 26, 20, [85, 34, 26]],
];
const CUSTOMERS = [
  ['مؤسسة النور للتجارة', '+966501111111', 25000],
  ['شركة الرياض للتوزيع', '+966502222222', 40000],
  ['مكتب البيان للاستشارات', '+966503333333', 10000],
  ['مطاعم الذواقة', '+966504444444', 30000],
  ['فندق البحر الأحمر', '+966505555555', 60000],
  ['مجمع الأمل الصحي', '+966506666666', 15000],
  ['مدرسة الرواد الأهلية', '+966507777777', 12000],
  ['شركة الخليج للمقاولات', '+966508888888', 50000],
  ['عبدالله المطيري', '+966509999999', 5000],
  ['نورة العتيبي', '+966501234567', 5000],
  ['مقاهي لافندر', '+966502468135', 20000],
  ['سعود القحطاني', '+966503691472', 8000],
];
const SALESMEN = ['فهد الدوسري', 'محمد الشهري', 'خالد العنزي', 'عمر الحربي'];

await run('categories + items + units', async () => {
  const cats = {};
  for (const [code, name] of CATEGORIES) {
    let row = (await q(`select id from item_categories where tenant_id = $1 and code = $2`, [tid, code]))[0];
    if (!row) {
      const id = uuid();
      await q(
        `insert into item_categories (id, tenant_id, code, name_ar, name_en, sort_order, show_in_pos, show_in_sale, show_in_purch, created_at, created_by, version)
         values ($1, $2, $3, $4, $4, $5, true, true, true, now(), $6, 1)`,
        [id, tid, code, name, Object.keys(cats).length, owner.id],
      );
      row = { id };
    }
    cats[code] = row.id;
  }
  const units = await q(`select code, id from units_of_measure where tenant_id = $1`, [tid]);
  const unitId = Object.fromEntries(units.map((u) => [u.code, u.id]));
  const vatGroup = (await q(`select id from tax_groups where tenant_id = $1 and rate = '15'`, [tid]))[0];
  const exemptGroup = (await q(`select id from tax_groups where tenant_id = $1 and name_ar like 'معفاة%'`, [tid]))[0];
  const itemId = {};
  for (const [sku, ar, en, cat, unit, price, cost, minQty, opening] of ITEM_DEFS) {
    let row = (await q(`select id from items where tenant_id = $1 and sku = $2`, [tid, sku]))[0];
    if (!row) {
      const id = uuid();
      const taxGroup = cat === 'OFC' && sku === 'OFC-8003' ? exemptGroup?.id : vatGroup?.id;
      await q(
        `insert into items (id, tenant_id, sku, name_ar, name_en, category_id, base_unit_id, kind, sale_price, purchase_price,
          tax_group_id, min_qty, track_lot, track_serial, weighted_scale, show_in_pos, kind_flags, created_at, created_by, version)
         values ($1, $2, $3, $4, $5, $6, $7, 'stock', $8, $9, $10, $11, false, false, false, true, '{}'::jsonb, now(), $12, 1)`,
        [id, tid, sku, ar, en, cats[cat], unitId[unit], price, cost, taxGroup, minQty, owner.id],
      );
      row = { id };
    }
    itemId[sku] = row.id;
    const [hasBase] = await q(
      `select 1 from item_units where item_id = $1 and unit_id = $2 and tenant_id = $3`,
      [row.id, unitId[unit], tid],
    );
    if (!hasBase) {
      await q(
        `insert into item_units (item_id, unit_id, ratio, is_default_purchase, is_default_sale, tenant_id)
         values ($1, $2, 1, true, true, $3)`,
        [row.id, unitId[unit], tid],
      );
    }
  }
  // opening stock + purchase transactions
  const whRows = await q(
    `select w.id, b.code from warehouses w join branches b on b.id = w.branch_id where w.tenant_id = $1 and b.deleted_at is null and w.deleted_at is null`,
    [tid],
  );
  const whByCode = Object.fromEntries(whRows.map((w) => [w.code, w.id]));
  const stocked = (await q(`select count(*)::int n from stock_balances where tenant_id = $1 and quantity > 0`, [tid])).n;
  if (stocked > 0) {
    console.log('    ↳ opening stock already present, skipped');
    return;
  }
  for (const [sku, , , , , price, cost, , opening] of ITEM_DEFS) {
    const [whMain, whJed, whDmk] = [whByCode['MAIN'], whByCode['JED'], whByCode['DMK']];
    const rows = [
      [whMain, opening[0]],
      [whJed, opening[1]],
      [whDmk, opening[2]],
    ];
    for (const [wh, qty] of rows) {
      await q(
        `update stock_balances set quantity = $2, value = ($2::numeric * $3::numeric), average_cost = $3, updated_at = now()
         where tenant_id = $1 and item_id = $4 and warehouse_id = $5`,
        [tid, qty, cost, itemId[sku], wh],
      );
      await q(
        `insert into inventory_transactions (id, tenant_id, item_id, warehouse_id, occurred_at, doc_type, doc_id, direction, qty, base_qty, unit_cost, total_cost, costing, metadata, created_at, created_by)
         values ($1, $2, $3, $4, $5, 'opening', $9, 'in', $6, $6, $7, ($6::numeric * $7::numeric), 'avg', '{}'::jsonb, $5, $8)`,
        [uuid(), tid, itemId[sku], wh, daysAgo(40), qty, cost, owner.id, uuid()],
      );
    }
  }
});

await run('customers + salesmen', async () => {
  for (const [i, [name, phone, credit]] of CUSTOMERS.entries()) {
    const [exists] = await q(`select 1 from parties where tenant_id = $1 and name = $2`, [tid, name]);
    if (exists) continue;
    await q(
      `insert into parties (id, tenant_id, code, kind, name, phone, credit_limit, is_owner, is_contractor, created_at, created_by, version)
       values ($1, $2, $3, 'customer', $4, $5, $6, false, false, now(), $7, 1)`,
      [uuid(), tid, `CUST-${String(i + 1).padStart(3, '0')}`, name, phone, credit, owner.id],
    );
  }
  for (const [i, name] of SALESMEN.entries()) {
    const [exists] = await q(`select 1 from salesmen where tenant_id = $1 and name = $2`, [tid, name]);
    if (exists) continue;
    await q(
      `insert into salesmen (id, tenant_id, name, active, created_at, created_by, version, commission_rate, tel)
       values ($1, $2, $3, true, now(), $4, 1, 2, '+96650${String(10000000 + i * 1111111)}')`,
      [uuid(), tid, name, owner.id],
    );
  }
});

const summary = {
  branches: await q(`select code, id from branches where tenant_id = $1`, [tid]),
  customers: (await q(`select count(*)::int n from parties where tenant_id = $1 and kind = 'customer'`, [tid])).n,
  items: (await q(`select count(*)::int n from items where tenant_id = $1`, [tid])).n,
  invoices: (await q(`select count(*)::int n from sales_invoices where tenant_id = $1`, [tid])).n,
};
await db.end();
console.log('part 1 done:', JSON.stringify(summary));

// --------------------------------------------------------------------------- part 2
const apiBase = 'http://127.0.0.1:3000/api/v1';

const login = await (
  await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@demo.test', password: env.DEMO_OWNER_PASSWORD, tenantCode: 'demo' }),
  })
).json();
const token = login.data?.accessToken ?? login.accessToken;
if (!token) throw new Error('demo owner login failed: ' + JSON.stringify(login).slice(0, 300));

const call = async (path, { method = 'GET', body, key } = {}) => {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return data?.data ?? data;
};

const arr = (x) => (Array.isArray(x) ? x : x?.items ?? x?.rows ?? []);

// One admin (migrator) connection for backdating + finishing — RLS-aware.
const adm = new Client({ connectionString: env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL });
await adm.connect();
const tid2 = (await adm.query(`select id from tenants where code = 'demo'`)).rows[0].id;
await adm.query(`select set_config('app.tenant_id', $1, false)`, [tid2]);
const admQ = async (sql, params) => (await adm.query(sql, params)).rows;

// Drop synthetic drafts left by interrupted runs so the target counts stay exact.
await adm.query(`delete from sales_invoices where tenant_id = $1 and status = 'draft'`, [tid2]);
await adm.query(
  `update sales_invoices set status = 'draft', number = null, posted_at = null, paid_total = 0, payment_status = 'unpaid'
   where tenant_id = $1 and status = 'posted' and not exists (select 1 from journal_entries je where je.source_id = sales_invoices.id)`,
  [tid2],
);

// Per-branch document sequences all start at 1 while invoice numbers are unique
// tenant-wide — posting the second branch's first document would collide. Offset
// each branch's counters so the demo history can span all three branches.
const branchRows = await admQ(`select id from branches where tenant_id = $1 and deleted_at is null order by created_at`, [tid2]);
const docTypes = ['sale', 'quotation', 'journal_entry'];
for (const [bi, br] of branchRows.entries()) {
  for (const docType of docTypes) {
    const base = (bi + 1) * 10000;
    const [row] = await admQ(
      `select current_value::int cv from document_sequences where tenant_id = $1 and doc_type = $2 and branch_id = $3`,
      [tid2, docType, br.id],
    );
    if (!row) {
      await adm.query(
        `insert into document_sequences (id, tenant_id, branch_id, doc_type, prefix, current_value, padding, created_at, updated_at)
         values ($1, $2, $3, $4, '', $5, 6, now(), now())`,
        [uuid(), tid2, br.id, docType, base],
      );
    } else if (row.cv < base) {
      await adm.query(`update document_sequences set current_value = $2, updated_at = now() where tenant_id = $1 and doc_type = $3 and branch_id = $4`, [tid2, base, docType, br.id]);
    }
  }
}

const customers = arr(await call('/parties?kind=customer'));
const sms = arr(await call('/sales/salesmen'));
const brs = arr(await call('/branches'));
const whs = arr(await call('/warehouses'));
const items = arr(await call('/organization/catalog/items'));
const periods = arr(await call('/fiscal-periods'));
if (!customers.length || !items.length) throw new Error('master data missing after part 1');

const nowMs = Date.now();
const currentPeriod =
  periods.find((p) => {
    const s = new Date(p.start_date ?? p.startDate ?? p.starts_on).getTime();
    const e = new Date(p.end_date ?? p.endDate ?? p.ends_on).getTime();
    return s <= nowMs && e >= nowMs;
  }) ?? periods[0];

let seed = 20260923;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const money2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const whForBranch = (code) => whs.find((w) => (w.code ?? '').includes(code)) ?? whs[0];
const branchOf = (code) => brs.find((b) => b.code === code) ?? brs[0];

const cashLocRows = await admQ(`select id, account_id, kind from cash_locations where tenant_id = $1 and is_active = true`, [tid2]);
const safeRow = cashLocRows.find((l) => l.kind === 'safe') ?? cashLocRows[0];
const bankRow = cashLocRows.find((l) => l.kind === 'bank');

const postedCount = (await admQ(`select count(*)::int n from sales_invoices where tenant_id = $1 and status = 'posted'`, [tid2]))[0].n;
const TARGET_POSTED = 60;
const toCreate = Math.max(0, TARGET_POSTED - postedCount);
console.log(`  existing posted: ${postedCount}, creating: ${toCreate}`);

let posted = 0;
let settled = 0;
let failed = 0;
for (let i = 0; i < toCreate; i++) {
  const dayOffset = Math.floor(rnd() * 2); // 0..1 days ago — journal entries are immutable
  const isRecent = dayOffset <= 1;
  const branchCode = isRecent ? (rnd() < 0.55 ? 'MAIN' : rnd() < 0.5 ? 'JED' : 'DMK') : pick(['MAIN', 'JED', 'DMK']);
  const branch = branchOf(branchCode);
  const warehouse = whForBranch(branchCode);
  const lineCount = 1 + Math.floor(rnd() * 3.4);
  const used = new Set();
  const lines = [];
  for (let l = 0; l < lineCount; l++) {
    let item = pick(items);
    let guard = 0;
    while (used.has(item.id) && guard++ < 10) item = pick(items);
    used.add(item.id);
    const qty = 1 + Math.floor(rnd() * (Number(item.sale_price ?? item.salePrice ?? 0) < 20 ? 12 : 4));
    lines.push({
      itemId: item.id,
      quantity: String(qty),
      unitPrice: money2(item.sale_price ?? item.salePrice ?? 0),
    });
  }
  const useCustomer = rnd() < 0.82;
  const customer = pick(customers);
  const body = {
    branchId: branch.id,
    warehouseId: warehouse.id,
    kind: 'sale',
    priceIncludesVat: false,
    lines,
    ...(rnd() < 0.3 ? { salesmanId: pick(sms).id } : {}),
    ...(useCustomer
      ? { partyId: customer.id }
      : { cashCustomerName: pick(['زبون نقدي', 'عميل نقدي', 'زائر', 'صاحب مخيم']), cashCustomerMobile: pick([null, '+966551112223']) }),
  };
  let invoice;
  try {
    invoice = await call('/sales/invoices', { method: 'POST', body, key: `seed-${uuid()}` });
  } catch (error) {
    failed += 1;
    console.error('  ! create failed:', String(error).slice(0, 200));
    continue;
  }
  const id = invoice?.id ?? invoice;
  const r = rnd();
  const settlement = r < 0.5 ? 'cash' : r < 0.62 ? 'card' : r < 0.72 ? 'bank' : 'credit';
  const when = daysAgo(dayOffset, 9 + Math.floor(rnd() * 9));
  try {
    await call(`/sales/invoices/${id}/post`, {
      method: 'POST',
      key: `post-${uuid()}`,
      body: {
        fiscalPeriodId: currentPeriod?.id,
        ...(settlement === 'credit'
          ? { settlement: 'credit' }
          : {
              settlement,
              settlementCashLocationId: (settlement === 'bank' ? bankRow : safeRow)?.id,
              settlementAccountId: (settlement === 'bank' ? bankRow : safeRow)?.account_id,
            }),
      },
    });
    posted += 1;
    if (settlement !== 'credit') settled += 1;
    await adm.query(`update sales_invoices set created_at = $2, posted_at = $2, updated_at = $2 where id = $1`, [id, when]);
    await adm.query(`update invoice_payments set created_at = $2 where invoice_id = $1`, [id, when]);
    // The stock ledger is append-only by design — never rewrite it.
    await adm.query(
      `update journal_entries set date = (select (date_trunc('day', $2::timestamptz) at time zone 'Asia/Riyadh')::date), created_at = $2 where source_id = $1`,
      [id, when],
    );
    await adm.query(
      `update journal_entry_lines set created_at = $2 where journal_entry_id in (select id from journal_entries where source_id = $1)`,
      [id, when],
    );
  } catch (error) {
    failed += 1;
    console.error('  ! post failed:', String(error).slice(0, 200));
  }
}

for (let i = 0; i < 5; i++) {
  const customer = pick(customers);
  const branch = pick(brs);
  const item = pick(items);
  try {
    await call('/sales/invoices', {
      method: 'POST',
      key: `draft-${uuid()}`,
      body: {
        branchId: branch.id,
        warehouseId: whForBranch(branch.code).id,
        kind: 'sale',
        priceIncludesVat: false,
        partyId: customer.id,
        lines: [
          { itemId: item.id, quantity: String(2 + Math.floor(rnd() * 5)), unitPrice: money2(item.sale_price ?? item.salePrice ?? 0) },
          { description: 'توصيل وتغليف', quantity: '1', unitPrice: '15' },
        ],
      },
    });
  } catch (error) {
    console.error('  ! draft failed:', String(error).slice(0, 150));
  }
}

for (let i = 0; i < 3; i++) {
  const customer = pick(customers);
  const item = pick(items);
  try {
    await call('/sales/quotations', {
      method: 'POST',
      key: `q-${uuid()}`,
      body: {
        branchId: brs[0].id,
        partyId: customer.id,
        kind: 'quotation',
        priceIncludesVat: false,
        lines: [{ itemId: item.id, quantity: '10', unitPrice: money2(item.sale_price ?? item.salePrice ?? 0) }],
      },
    });
  } catch (error) {
    console.error('  ! quotation failed:', String(error).slice(0, 150));
  }
}

// Re-date every posted sales document into the last two days, deterministically
// from its id (journal entries are immutable by design and keep today's date, so
// the sales history must stay within reach of it). Stable across re-runs.
const postedRows = await admQ(`select id, created_at from sales_invoices where tenant_id = $1 and status = 'posted' order by created_at`, [tid2]);
for (const row of postedRows) {
  let h = 0;
  for (const ch of row.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const d = new Date();
  d.setDate(d.getDate() - (h % 2));
  d.setHours(9 + ((h >> 3) % 9), (h >> 7) % 60, (h >> 11) % 60, 0);
  const target = d.toISOString();
  if (Math.abs(new Date(row.created_at).getTime() - d.getTime()) < 60_000) continue;
  await adm.query(`update sales_invoices set created_at = $2, posted_at = $2, updated_at = $2 where id = $1`, [row.id, target]);
  await adm.query(`update invoice_payments set created_at = $2 where invoice_id = $1`, [row.id, target]);
}

// Low-stock scenario: drag four fast movers under their minimum so the dashboard warns.
const lowSkus = ['BEV-2002', 'CLN-7001', 'OFC-8002', 'SNK-5002'];
for (const sku of lowSkus) {
  await admQ2(sku);
}
async function admQ2(sku) {
  const rows = await admQ(`select sb.item_id, sb.warehouse_id, sb.quantity, i.min_qty, i.name_ar
    from stock_balances sb join items i on i.id = sb.item_id
    where sb.tenant_id = $1 and i.sku = $2 and sb.quantity > 0 order by sb.quantity desc limit 1`, [tid2, sku]);
  const row = rows[0];
  if (!row) return;
  const target = Math.max(1, Math.ceil(Number(row.min_qty) * 0.4));
  if (Number(row.quantity) <= target) return;
  await adm.query(`update stock_balances set quantity = $2, value = $2 * coalesce(average_cost, 0), updated_at = now() where tenant_id = $1 and item_id = $3 and warehouse_id = $4`, [tid2, target, row.item_id, row.warehouse_id]);
  await adm.query(
    `insert into inventory_transactions (id, tenant_id, item_id, warehouse_id, occurred_at, doc_type, doc_id, direction, qty, base_qty, unit_cost, total_cost, costing, metadata, created_at, created_by)
     values ($1, $2, $3, $4, $5, 'adjustment', $6, 'out', $7, $7, 0, 0, 'avg', '{}'::jsonb, $5, $8)`,
    [uuid(), tid2, row.item_id, row.warehouse_id, new Date().toISOString(), uuid(), Number(row.quantity) - target, null],
  );
  console.log(`  ↳ ${sku} reduced to ${target} (min ${row.min_qty})`);
}

await adm.end();
console.log(`part 2 done: ${posted} posted (${settled} settled, ${failed} failed), 5 drafts, 3 quotations`);
console.log('dashboard preview ready — sign in with owner@demo.test / tenant demo');
