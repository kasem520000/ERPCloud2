/**
 * `pnpm db:seed` — the demo dataset.
 *
 * `seedPlatform` (seed.ts) creates the *minimum* a deployment needs: the permission
 * registry, one tenant, its owner, the baseline roles and the platform operator. That is
 * not enough to open the product and start working: a fresh tenant has no chart of
 * accounts, no fiscal calendar and no licence, so the first thing an evaluator sees is a
 * string of empty screens.
 *
 * This module fills that gap with an opinionated, **idempotent** demo company:
 *
 *   • the billing catalogue (three plans) and an active licence for the tenant
 *   • organisation defaults: base currency, main branch, warehouse, safe, bank, price list
 *   • the desktop chart of accounts (4 roots, 112 accounts + COGS) wired to the safe/bank
 *   • cost centres, the fiscal year and its twelve monthly periods
 *   • a balanced opening journal entry, posted, with the document sequence advanced
 *   • an accountant and a cashier user next to the owner
 *
 * Every step keys off a natural code and is skipped when it already exists, so running
 * the seed twice changes nothing. Passwords are never invented here: the caller hashes
 * them (Argon2id lives in the API app) and a user without a hash is created as `invited`.
 */
import { Client } from 'pg';

import { DESKTOP_DEFAULT_COA } from './desktop-coa.js';
import { newId } from './ids.js';

export type DemoUserSpec = {
  email: string;
  fullName: string;
  /** Must match one of the baseline role names, e.g. `Accountant`. */
  roleName: string;
  /** Argon2id PHC string. Omit to create the user as `invited`. */
  passwordHash?: string;
};

export type DemoSeedOptions = {
  /** Tenant that receives the data. Defaults to `demo`. */
  tenantCode?: string;
  /** Calendar year of the fiscal year to create. Defaults to the current year. */
  fiscalYear?: number;
  /** Plan code to activate for the tenant. Defaults to `pro-monthly`. */
  planCode?: string;
  subscriptionMonths?: number;
  users?: DemoUserSpec[];
  /** Post the opening entry (capital → cash / bank / fixed assets). Default true. */
  withOpeningEntry?: boolean;
  log?: (message: string) => void;
};

export type DemoSeedReport = {
  tenantId: string;
  tenantCode: string;
  plans: number;
  subscription: 'created' | 'existing' | 'skipped';
  branchId: string;
  warehouseId: string;
  safeId: string;
  bankId: string;
  accounts: number;
  costCenters: number;
  catalog: { units: number; categories: number; taxGroups: number };
  /** `created` the first time the tenant-wide posting profile is written. */
  postingProfile: 'created' | 'existing' | 'extended';
  fiscalYearId: string;
  periods: number;
  openingEntryNumber?: string;
  users: Array<{ email: string; role: string; status: string }>;
};

type AccountSeed = {
  code: string;
  nameAr: string;
  nameEn?: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  /** Overrides the natural side — used by contra accounts. */
  normalBalance?: 'debit' | 'credit';
  parent?: string;
  postable?: boolean;
};

/**
 * The default chart of accounts every tenant — demo or subscribed — starts with.
 * It is the desktop product's real `Accounts_Index` (see `./desktop-coa.js`, generated
 * from the legacy `CrystalLiteDB.txt`/`AlterDb.txt` scripts), plus one cloud extension:
 * sales/inventory postings need a cost-of-goods account the desktop seed never shipped,
 * so `3200004` hangs under group 32 with the next free leaf code.
 */
export const DEMO_CHART_OF_ACCOUNTS: AccountSeed[] = [
  ...DESKTOP_DEFAULT_COA,
  { code: '3200004', nameAr: 'تكلفة المبيعات', type: 'expense', parent: '32' },
  // Phase 05 extensions — a perpetual stock ledger cannot post transfers or counts
  // without an in-transit and a variance account, and the desktop chart has none.
  { code: '1270003', nameAr: 'بضاعة تحت التحويل', type: 'asset', parent: '127' },
  { code: '3121004', nameAr: 'تسويات المخزون', type: 'expense', parent: '3121' },
  // R13 extension — the same reasoning for money: `/cash-transfers` takes the amount out
  // of the source safe on send and into the destination on receive, so the days in
  // between need an account to hold it. `1211` صناديق الفرع الرئيسي already has
  // `1211001` الصندوق الرئيسي and `1211002` عهدة الإغلاق, so the next free leaf is used.
  { code: '1211003', nameAr: 'نقد تحت التحويل', type: 'asset', parent: '1211' },
];

/**
 * An item cannot be created without a category and a base unit, and a sales line cannot
 * compute VAT without a tax group. Seeding the three directories is what makes the
 * inventory / sales / purchase screens usable on the first run.
 */
const DEMO_UNITS = [
  { code: 'PCS', nameAr: 'حبة', nameEn: 'Piece' },
  { code: 'BOX', nameAr: 'كرتون', nameEn: 'Box' },
  { code: 'KG', nameAr: 'كيلوجرام', nameEn: 'Kilogram' },
  { code: 'LTR', nameAr: 'لتر', nameEn: 'Litre' },
];

const DEMO_CATEGORIES = [
  { code: 'GEN', nameAr: 'بضاعة عامة', nameEn: 'General goods' },
  { code: 'SRV', nameAr: 'خدمات', nameEn: 'Services' },
];

/** Rate is stored as a fraction (0.1500 = 15%), matching `tax_groups.rate`. */
const DEMO_TAX_GROUPS = [
  { nameAr: 'ضريبة القيمة المضافة 15%', nameEn: 'VAT 15%', rate: '0.1500', vatAccountCode: '2222001' },
  { nameAr: 'معفاة من الضريبة', nameEn: 'Exempt', rate: '0.0000', vatAccountCode: undefined },
];

/**
 * The tenant-wide (`*`) posting profile. Without it every document post fails with
 * `ACCOUNT_PROFILE_MISSING`, so a demo tenant that cannot issue an invoice is not a demo.
 * Keys are `POST_PROFILE_ACCOUNT_KEYS` from `@erp/contracts`; values are account codes
 * from the chart above and are resolved to ids at seed time.
 */
export const DEMO_POSTING_PROFILE: Record<string, string> = {
  salesAccountId: '4100001',
  salesReturnAccountId: '4100002',
  purchasesAccountId: '3200001',
  purchaseReturnAccountId: '3200002',
  discountGivenAccountId: '4100003',
  discountReceivedAccountId: '3200003',
  // The desktop seed ships a single VAT account shared by both sides.
  vatOutputAccountId: '2222001',
  vatInputAccountId: '2222001',
  exciseTaxAccountId: '2222002',
  inventoryAccountId: '1270001',
  cogsAccountId: '3200004',
  openingBalanceAccountId: '1270002',
  inventoryAdjustmentAccountId: '3121004',
  stockInTransitAccountId: '1270003',
  cashAccountId: '1211001',
  bankAccountId: '1221001',
  receivableAccountId: '12310001',
  payableAccountId: '22111001',
  // R12 — 🧾 الوردية: العهدة التي يأوي إليها المعدود (`1211002` «عهدة الإغلاق») والفرق
  // (`3110004` «فرق بالصندوق»، وهو ثابت الديسكتوب في `Class/EntryOper.cs`). بلا هذين
  // المفتاحين كان إغلاق ورديةٍ بفرقٍ في النسخة التجريبية يُرفض (422) لملفٍّ ناقص.
  custodyAccountId: '1211002',
  cashDifferenceAccountId: '3110004',
  // R13 — 🧾 مناقلة الخزن: المال في الطريق بين خزنتين (`1211003` «نقد تحت التحويل»).
  cashInTransitAccountId: '1211003',
};

const DEMO_COST_CENTERS = [
  { code: 'ADMIN', nameAr: 'الإدارة العامة', nameEn: 'Administration' },
  { code: 'SALES', nameAr: 'المبيعات', nameEn: 'Sales' },
  { code: 'STORE', nameAr: 'المستودع', nameEn: 'Warehouse' },
];

/**
 * Catalogue shown on the pricing page and in the console. Amounts are strings on purpose.
 *
 * **والحقوق معه** (`billing_plan_entitlements`، ترحيل `0068`): باقةٌ بلا حقوقها سعرٌ بلا
 * مقابل — وصفحة `/pricing` (P-M3) تُبنى على السؤال «ماذا أحصل عليه؟». والقيم بذرةُ عرضٍ
 * (demo) لا سياسةُ تسعير: المشغّل يعدّلها من اللوحة (`PUT /platform/plans/:id/entitlements`)
 * وتظهر في الموقع فوراً، لأن الموقع يقرأ القاعدة لا الكود.
 *
 * والقيم داخل سقوف السجلّ (`packages/contracts/src/platform/console.ts`): كل مفتاح `limits.*`
 * له `max` يُتحقَّق منه عند الكتابة من اللوحة، والبذرة تُحترمه حتى لا تُنتج بياناتٍ ترفضها
 * نقطة النهاية نفسها.
 */
export const DEMO_PLANS: Array<{
  code: string;
  name: string;
  interval: 'month' | 'year';
  amount: string;
  currency: string;
  entitlements: Array<{ kind: 'module' | 'limit' | 'flag'; key: string; value: boolean | number }>;
}> = [
  {
    code: 'starter-monthly',
    name: 'الباقة الأساسية',
    interval: 'month',
    amount: '199.00',
    currency: 'SAR',
    entitlements: [
      { kind: 'limit', key: 'limits.max_users', value: 5 },
      { kind: 'limit', key: 'limits.max_branches', value: 1 },
      { kind: 'limit', key: 'limits.max_invoices_per_month', value: 500 },
      { kind: 'limit', key: 'limits.max_items', value: 1_000 },
      { kind: 'limit', key: 'limits.max_whatsapp_per_month', value: 200 },
      { kind: 'limit', key: 'limits.max_emails_per_month', value: 1_000 },
      { kind: 'limit', key: 'limits.max_storage_mb', value: 2_048 },
      { kind: 'limit', key: 'limits.max_api_calls_per_day', value: 5_000 },
    ],
  },
  {
    code: 'pro-monthly',
    name: 'الباقة الاحترافية',
    interval: 'month',
    amount: '499.00',
    currency: 'SAR',
    entitlements: [
      { kind: 'limit', key: 'limits.max_users', value: 25 },
      { kind: 'limit', key: 'limits.max_branches', value: 5 },
      { kind: 'limit', key: 'limits.max_invoices_per_month', value: 5_000 },
      { kind: 'limit', key: 'limits.max_items', value: 20_000 },
      { kind: 'limit', key: 'limits.max_whatsapp_per_month', value: 2_000 },
      { kind: 'limit', key: 'limits.max_emails_per_month', value: 10_000 },
      { kind: 'limit', key: 'limits.max_storage_mb', value: 20_480 },
      { kind: 'limit', key: 'limits.max_api_calls_per_day', value: 50_000 },
      { kind: 'module', key: 'feature.pos', value: true },
      { kind: 'module', key: 'feature.projects', value: true },
      { kind: 'module', key: 'feature.hrm', value: true },
      { kind: 'module', key: 'feature.niche', value: false },
    ],
  },
  {
    // السنة نفسها بسعرٍ أقل: الحقوق مطابقة للشهرية تماماً — وهذا ما يُقاس في `public-plans.spec.ts`
    // (باقةٌ سنوية بحقوق أخرى هي باقةٌ أخرى، لا خصمٌ على الدفع مقدّماً).
    code: 'pro-yearly',
    name: 'الباقة الاحترافية (سنوي)',
    interval: 'year',
    amount: '4990.00',
    currency: 'SAR',
    entitlements: [
      { kind: 'limit', key: 'limits.max_users', value: 25 },
      { kind: 'limit', key: 'limits.max_branches', value: 5 },
      { kind: 'limit', key: 'limits.max_invoices_per_month', value: 5_000 },
      { kind: 'limit', key: 'limits.max_items', value: 20_000 },
      { kind: 'limit', key: 'limits.max_whatsapp_per_month', value: 2_000 },
      { kind: 'limit', key: 'limits.max_emails_per_month', value: 10_000 },
      { kind: 'limit', key: 'limits.max_storage_mb', value: 20_480 },
      { kind: 'limit', key: 'limits.max_api_calls_per_day', value: 50_000 },
      { kind: 'module', key: 'feature.pos', value: true },
      { kind: 'module', key: 'feature.projects', value: true },
      { kind: 'module', key: 'feature.hrm', value: true },
      { kind: 'module', key: 'feature.niche', value: false },
    ],
  },
];

function normalSideOf(account: AccountSeed): 'debit' | 'credit' {
  if (account.normalBalance) return account.normalBalance;
  return account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit';
}

/** ltree labels accept letters, digits, `_` and (since PG 16) `-`, which covers a UUID. */
function ltreeChild(parentPath: string | undefined, id: string): string {
  return parentPath ? `${parentPath}.${id}` : id;
}

export async function seedDemoData(
  connectionString: string,
  options: DemoSeedOptions = {},
): Promise<DemoSeedReport> {
  const log = options.log ?? (() => undefined);
  const tenantCode = options.tenantCode ?? 'demo';
  const year = options.fiscalYear ?? new Date().getUTCFullYear();
  const planCode = options.planCode ?? 'pro-monthly';
  const months = Math.min(Math.max(options.subscriptionMonths ?? 12, 1), 120);

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const tenantRow = await client.query<{ id: string; base_currency: string }>(
      `SELECT id, base_currency FROM tenants WHERE code = $1`,
      [tenantCode],
    );
    const tenantId = tenantRow.rows[0]?.id;
    if (!tenantId) {
      throw new Error(`Tenant "${tenantCode}" does not exist — run the platform seed first.`);
    }
    const currencyCode = (tenantRow.rows[0]?.base_currency ?? 'SAR').trim().toUpperCase();

    // Every tenant-scoped table below is protected by FORCE ROW LEVEL SECURITY, which
    // applies to the table owner too, so the tenant GUC has to be bound for the session.
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    const plans = await seedPlans(client);
    log(`seed  billing plans: ${plans}`);

    const subscription = await ensureSubscription(client, tenantId, planCode, months);
    log(`seed  subscription: ${subscription}`);

    const org = await seedOrganisation(client, tenantId, currencyCode);
    log(`seed  organisation: branch ${org.branchCode}, warehouse, safe + bank`);

    const chart = await seedDefaultChartOfAccounts(client, tenantId);
    log(`seed  chart of accounts: ${chart.inserted} new (${chart.total} total)`);

    const adjustmentTypes = await seedSalaryAdjustmentTypes(client, tenantId);
    log(`seed  salary adjustment types: ${adjustmentTypes.inserted} new (${adjustmentTypes.total} total)`);

    await linkCashAccounts(client, tenantId, org.safeId, org.bankId, chart.byCode);

    const catalog = await seedCatalogBasics(client, tenantId, chart.byCode);
    log(
      `seed  catalog: ${catalog.units} units, ${catalog.categories} categories, ${catalog.taxGroups} tax groups`,
    );

    const costCenters = await seedCostCenters(client, tenantId, org.branchId);
    log(`seed  cost centers: ${costCenters}`);

    const postingProfile = await seedPostingProfile(client, tenantId, chart.byCode);
    log(`seed  posting profile (tenant-wide): ${postingProfile}`);

    const calendar = await seedFiscalCalendar(client, tenantId, year);
    log(`seed  fiscal year ${year}: ${calendar.periods} periods`);

    let openingEntryNumber: string | undefined;
    if (options.withOpeningEntry !== false) {
      openingEntryNumber = await seedOpeningEntry(client, tenantId, {
        branchId: org.branchId,
        periodId: calendar.firstPeriodId,
        date: `${year}-01-01`,
        byCode: chart.byCode,
      });
      if (openingEntryNumber) log(`seed  opening entry: ${openingEntryNumber}`);
    }

    const users = await seedUsers(client, tenantId, options.users ?? []);
    for (const user of users) log(`seed  user: ${user.email} (${user.role}, ${user.status})`);

    return {
      tenantId,
      tenantCode,
      plans,
      subscription,
      branchId: org.branchId,
      warehouseId: org.warehouseId,
      safeId: org.safeId,
      bankId: org.bankId,
      accounts: chart.total,
      costCenters,
      catalog,
      postingProfile,
      fiscalYearId: calendar.fiscalYearId,
      periods: calendar.periods,
      openingEntryNumber,
      users,
    };
  } finally {
    await client.end();
  }
}

// --------------------------------------------------------------------------- billing

async function seedPlans(client: Client): Promise<number> {
  // `billing_plan_entitlements` بتفعيل RLS الإجباري (`FORCE ROW LEVEL SECURITY` في 0068)،
  // وسياستها تسمح بالكتابة لمشغّل المنصة. والبذرة مشغّل: تُعلن نفسها كذلك للجلسة كلها
  // (`set_config(..., false)` مثل `app.tenant_id` في `seed.ts`) — فلا تُخترع مستخدمٌ ولا
  // جلسة، ولا يُخفَّف القيد من أجل سكربت.
  await client.query(`SELECT set_config('app.is_platform_admin', 'on', false)`);

  try {
    for (const plan of DEMO_PLANS) {
      const planId = newId();
      const saved = await client.query<{ id: string }>(
        `INSERT INTO billing_plans (id, code, name, interval, amount, currency, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name,
                                          interval = EXCLUDED.interval,
                                          amount = EXCLUDED.amount,
                                          currency = EXCLUDED.currency,
                                          active = true
         RETURNING id`,
        [planId, plan.code, plan.name, plan.interval, plan.amount, plan.currency],
      );
      const id = saved.rows[0]!.id;

      for (const entitlement of plan.entitlements) {
        // كتابةٌ بالمفتاح نفسه تُحدّث القيمة: البذرة تُعاد في كل تشغيل، فلا تضاعف الحقوق ولا
        // تتعارض مع تعديلٍ من اللوحة على نفس المفتاح (التعديل يفوز، لأن البذرة آخر كاتب).
        await client.query(
          `INSERT INTO billing_plan_entitlements (id, plan_id, kind, key, value)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (plan_id, key) DO UPDATE SET kind = EXCLUDED.kind,
                                                    value = EXCLUDED.value,
                                                    updated_at = now()`,
          [newId(), id, entitlement.kind, entitlement.key, JSON.stringify(entitlement.value)],
        );
      }

      // وحقٌّ شُطب من البذرة يُشطب من القاعدة: البذرة تصف المجموعة كاملةً لا إضافاتٍ متراكمة.
      await client.query(
        `DELETE FROM billing_plan_entitlements
          WHERE plan_id = $1 AND key <> ALL($2::text[])`,
        [id, plan.entitlements.map((entry) => entry.key)],
      );
    }
    return DEMO_PLANS.length;
  } finally {
    await client.query(`SELECT set_config('app.is_platform_admin', 'off', false)`);
  }
}

async function ensureSubscription(
  client: Client,
  tenantId: string,
  planCode: string,
  months: number,
): Promise<'created' | 'existing' | 'skipped'> {
  const existing = await client.query(
    `SELECT id FROM tenant_subscriptions WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  if ((existing.rowCount ?? 0) > 0) return 'existing';

  const plan = await client.query<{ id: string }>(`SELECT id FROM billing_plans WHERE code = $1`, [planCode]);
  const planId = plan.rows[0]?.id;
  if (!planId) return 'skipped';

  await client.query(
    `INSERT INTO tenant_subscriptions
       (id, tenant_id, plan_id, status, provider, activated_at, current_period_start, current_period_end)
     VALUES ($1, $2, $3, 'active', 'manual', now(), now(), now() + ($4 || ' months')::interval)`,
    [newId(), tenantId, planId, String(months)],
  );
  return 'created';
}

// ---------------------------------------------------------------------- organisation

async function seedOrganisation(
  client: Client,
  tenantId: string,
  currencyCode: string,
): Promise<{ branchId: string; branchCode: string; warehouseId: string; safeId: string; bankId: string }> {
  await client.query(
    `INSERT INTO currencies (tenant_id, code, name_ar, name_en, minor_units, is_base, is_active)
     VALUES ($1, $2::char(3), $2::text, $2::text, $3, true, true)
     ON CONFLICT (tenant_id, code) DO UPDATE SET is_base = true, is_active = true`,
    [tenantId, currencyCode, ['KWD', 'BHD', 'OMR'].includes(currencyCode) ? 3 : 2],
  );

  const companyName = await client.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  await client.query(
    `INSERT INTO company_profiles (tenant_id, name_ar, name_en, tax_no, cr_no, phones, email, country_code)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [
      tenantId,
      companyName.rows[0]?.name ?? 'شركة تجريبية',
      'Demo Trading Co.',
      '300000000000003',
      '1010000000',
      JSON.stringify(['+966500000000']),
      'info@demo.test',
      'SA',
    ],
  );

  const branch = await upsertById(
    client,
    `SELECT id FROM branches WHERE tenant_id = $1 AND code = 'MAIN' AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO branches (id, tenant_id, code, name_ar, name_en, is_default, is_active)
         VALUES ($1, $2, 'MAIN', 'الفرع الرئيسي', 'Main branch', true, true)`,
        [id, tenantId],
      ),
  );

  const warehouse = await upsertById(
    client,
    `SELECT id FROM warehouses WHERE tenant_id = $1 AND code = 'MAIN' AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
         VALUES ($1, $2, $3, 'MAIN', 'المستودع الرئيسي', true, true)`,
        [id, tenantId, branch],
      ),
  );

  const safe = await upsertById(
    client,
    `SELECT id FROM cash_locations WHERE tenant_id = $1 AND kind = 'safe' AND is_default AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO cash_locations (id, tenant_id, branch_id, kind, name, currency_code, is_default, is_active)
         VALUES ($1, $2, $3, 'safe', 'الصندوق الرئيسي', $4, true, true)`,
        [id, tenantId, branch, currencyCode],
      ),
  );

  const bank = await upsertById(
    client,
    `SELECT id FROM cash_locations WHERE tenant_id = $1 AND kind = 'bank' AND is_default AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO cash_locations (id, tenant_id, branch_id, kind, name, currency_code, is_default, is_active, bank)
         VALUES ($1, $2, $3, 'bank', 'الحساب البنكي الرئيسي', $4, true, true, $5::jsonb)`,
        [
          id,
          tenantId,
          branch,
          currencyCode,
          JSON.stringify({
            bankName: 'البنك الأهلي',
            iban: 'SA0000000000000000000000',
            accountNo: '000000000000',
          }),
        ],
      ),
  );

  for (const cashLocationId of [safe, bank]) {
    await client.query(
      `INSERT INTO cash_location_balances (tenant_id, cash_location_id, currency_code, balance)
       VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
      [tenantId, cashLocationId, currencyCode],
    );
  }

  await upsertById(
    client,
    `SELECT id FROM price_lists WHERE tenant_id = $1 AND is_default AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO price_lists (id, tenant_id, name, currency_code, is_default, is_active)
         VALUES ($1, $2, 'قائمة الأسعار الافتراضية', $3, true, true)`,
        [id, tenantId, currencyCode],
      ),
  );

  await upsertById(
    client,
    `SELECT id FROM parties WHERE tenant_id = $1 AND (code = 'CUST-GEN' OR name = 'عميل عام') AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO parties (id, tenant_id, code, kind, name, legal_name, credit_limit)
         VALUES ($1, $2, 'CUST-GEN', 'customer', 'عميل عام', 'عميل عام', 0)`,
        [id, tenantId],
      ),
  );

  await upsertById(
    client,
    `SELECT id FROM parties WHERE tenant_id = $1 AND (code = 'SUPP-GEN' OR name = 'مورد عام') AND deleted_at IS NULL`,
    [tenantId],
    (id) =>
      client.query(
        `INSERT INTO parties (id, tenant_id, code, kind, name, legal_name, credit_limit)
         VALUES ($1, $2, 'SUPP-GEN', 'supplier', 'مورد عام', 'مورد عام', 0)`,
        [id, tenantId],
      ),
  );

  return { branchId: branch, branchCode: 'MAIN', warehouseId: warehouse, safeId: safe, bankId: bank };
}

// ------------------------------------------------------------------------ accounting

/**
 * 🎁 أنواع الحوافز والجزاءات — `frmEmpSalaryAddSub` cannot open without them.
 * `SalaryAddSubTypes` is a table in the desktop whose rows are not in the repository, but
 * the code-behind names three by id: 1 = مكافأة (an addition), 2 = خصم, 3 = سلفة (both
 * deductions). Migration `0050` plants them for every tenant that already existed and
 * `OrgProvisioningService` for every tenant the API creates afterwards; this does it for a
 * tenant the seed script writes directly, so the demo company is not the one tenant with
 * an empty «نوع الإجراء» box.
 */
export const DEMO_SALARY_ADJUSTMENT_TYPES: Array<{ code: string; name: string; kind: string; sortOrder: number }> = [
  { code: 'bonus', name: 'مكافأة', kind: 'addition', sortOrder: 1 },
  { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 2 },
  { code: 'advance', name: 'سلفة', kind: 'deduction', sortOrder: 3 },
];

/** Seeds `DEMO_SALARY_ADJUSTMENT_TYPES`, skipping codes the tenant already has. */
export async function seedSalaryAdjustmentTypes(client: Client, tenantId: string): Promise<{ inserted: number; total: number }> {
  const existing = await client.query<{ code: string }>(
    `SELECT code FROM salary_adjustment_types WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  const present = new Set(existing.rows.map((row) => row.code));
  let inserted = 0;
  for (const type of DEMO_SALARY_ADJUSTMENT_TYPES) {
    if (present.has(type.code)) continue;
    await client.query(
      `INSERT INTO salary_adjustment_types (id, tenant_id, code, name, kind, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [newId(), tenantId, type.code, type.name, type.kind, type.sortOrder],
    );
    inserted += 1;
  }
  return { inserted, total: present.size + inserted };
}

/** Seeds `DEMO_CHART_OF_ACCOUNTS`, skipping codes the tenant already has. Exported for the `seed:coa` backfill CLI. */
export async function seedDefaultChartOfAccounts(
  client: Client,
  tenantId: string,
): Promise<{ inserted: number; total: number; byCode: Map<string, string> }> {
  const byCode = new Map<string, string>();
  const pathByCode = new Map<string, string>();
  const levelByCode = new Map<string, number>();

  const existing = await client.query<{ id: string; code: string; path: string; level: number }>(
    `SELECT id, code, path::text AS path, level FROM accounts WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  for (const row of existing.rows) {
    byCode.set(row.code, row.id);
    pathByCode.set(row.code, row.path);
    levelByCode.set(row.code, row.level);
  }

  let inserted = 0;
  // Parents always precede their children in DEMO_CHART_OF_ACCOUNTS, so one pass is enough.
  for (const account of DEMO_CHART_OF_ACCOUNTS) {
    if (byCode.has(account.code)) continue;

    const id = newId();
    const parentId = account.parent ? byCode.get(account.parent) : undefined;
    const parentPath = account.parent ? pathByCode.get(account.parent) : undefined;
    const level = account.parent ? (levelByCode.get(account.parent) ?? 0) + 1 : 0;
    const path = ltreeChild(parentPath, id);

    await client.query(
      `INSERT INTO accounts (id, tenant_id, code, name_ar, name_en, parent_id, level, path, type,
                             normal_balance, is_postable, allow_manual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::ltree, $9, $10, $11, $11)`,
      [
        id,
        tenantId,
        account.code,
        account.nameAr,
        account.nameEn ?? null,
        parentId ?? null,
        level,
        path,
        account.type,
        normalSideOf(account),
        account.postable !== false,
      ],
    );

    byCode.set(account.code, id);
    pathByCode.set(account.code, path);
    levelByCode.set(account.code, level);
    inserted += 1;
  }

  return { inserted, total: byCode.size, byCode };
}

/** A safe or a bank posts to a real account; without the link no voucher can be posted. */
async function linkCashAccounts(
  client: Client,
  tenantId: string,
  safeId: string,
  bankId: string,
  byCode: Map<string, string>,
): Promise<void> {
  const pairs: Array<[string, string | undefined]> = [
    [safeId, byCode.get('1211001')],
    [bankId, byCode.get('1221001')],
  ];
  for (const [cashLocationId, accountId] of pairs) {
    if (!accountId) continue;
    await client.query(
      `UPDATE cash_locations SET account_id = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3 AND account_id IS NULL`,
      [accountId, cashLocationId, tenantId],
    );
  }
}

async function seedCatalogBasics(
  client: Client,
  tenantId: string,
  byCode: Map<string, string>,
): Promise<{ units: number; categories: number; taxGroups: number }> {
  for (const unit of DEMO_UNITS) {
    await client.query(
      `INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM units_of_measure WHERE tenant_id = $2 AND code = $3 AND deleted_at IS NULL)`,
      [newId(), tenantId, unit.code, unit.nameAr, unit.nameEn],
    );
  }

  for (const category of DEMO_CATEGORIES) {
    await client.query(
      `INSERT INTO item_categories (id, tenant_id, code, name_ar, name_en)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM item_categories WHERE tenant_id = $2 AND code = $3 AND deleted_at IS NULL)`,
      [newId(), tenantId, category.code, category.nameAr, category.nameEn],
    );
  }

  for (const group of DEMO_TAX_GROUPS) {
    await client.query(
      `INSERT INTO tax_groups (id, tenant_id, name_ar, name_en, rate, vat_account_id)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (SELECT 1 FROM tax_groups WHERE tenant_id = $2 AND name_ar = $3 AND deleted_at IS NULL)`,
      [
        newId(),
        tenantId,
        group.nameAr,
        group.nameEn,
        group.rate,
        group.vatAccountCode ? (byCode.get(group.vatAccountCode) ?? null) : null,
      ],
    );
  }

  return { units: DEMO_UNITS.length, categories: DEMO_CATEGORIES.length, taxGroups: DEMO_TAX_GROUPS.length };
}

async function seedPostingProfile(
  client: Client,
  tenantId: string,
  byCode: Map<string, string>,
): Promise<'created' | 'existing' | 'extended'> {
  const mapping: Record<string, string | number> = { version: 1 };
  for (const [key, code] of Object.entries(DEMO_POSTING_PROFILE)) {
    const accountId = byCode.get(code);
    if (accountId) mapping[key] = accountId;
  }

  const inserted = await client.query(
    `INSERT INTO branch_posting_profiles (id, tenant_id, branch_id, doc_type, mapping)
     SELECT $1, $2, NULL, '*', $3::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM branch_posting_profiles
       WHERE tenant_id = $2 AND branch_id IS NULL AND doc_type = '*'
     )
     RETURNING id`,
    [newId(), tenantId, JSON.stringify(mapping)],
  );
  if (inserted.rowCount) return 'created';

  // Tenants seeded before a mapping key existed (e.g. `exciseTaxAccountId`) keep
  // their profile, but the missing defaults are merged in — keys the accountant
  // already set are never touched.
  const merged = await client.query(
    `UPDATE branch_posting_profiles
     SET mapping = $3::jsonb || mapping
     WHERE tenant_id = $1 AND branch_id IS NULL AND doc_type = '*'
       AND NOT (mapping ?& $2::text[])
     RETURNING id`,
    [tenantId, Object.keys(mapping).filter((key) => key !== 'version'), JSON.stringify(mapping)],
  );
  return merged.rowCount ? 'extended' : 'existing';
}

async function seedCostCenters(client: Client, tenantId: string, branchId: string): Promise<number> {
  for (const center of DEMO_COST_CENTERS) {
    await client.query(
      `INSERT INTO cost_centers (id, tenant_id, code, name_ar, name_en, branch_id)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (
         SELECT 1 FROM cost_centers WHERE tenant_id = $2 AND code = $3 AND deleted_at IS NULL
       )`,
      [newId(), tenantId, center.code, center.nameAr, center.nameEn, branchId],
    );
  }
  return DEMO_COST_CENTERS.length;
}

async function seedFiscalCalendar(
  client: Client,
  tenantId: string,
  year: number,
): Promise<{ fiscalYearId: string; periods: number; firstPeriodId: string }> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM fiscal_years WHERE tenant_id = $1 AND start_date = $2`,
    [tenantId, startDate],
  );

  let fiscalYearId = existing.rows[0]?.id;
  if (!fiscalYearId) {
    fiscalYearId = newId();
    await client.query(
      `INSERT INTO fiscal_years (id, tenant_id, name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, 'open')`,
      [fiscalYearId, tenantId, String(year), startDate, endDate],
    );
  }

  for (let month = 1; month <= 12; month += 1) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    const periodStart = `${label}-01`;
    const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO fiscal_periods (id, tenant_id, fiscal_year_id, name, start_date, end_date, status)
       SELECT $1, $2, $3, $4, $5, $6, 'open'
       WHERE NOT EXISTS (
         SELECT 1 FROM fiscal_periods WHERE tenant_id = $2 AND fiscal_year_id = $3 AND name = $4
       )`,
      [newId(), tenantId, fiscalYearId, label, periodStart, periodEnd],
    );
  }

  const first = await client.query<{ id: string }>(
    `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND fiscal_year_id = $2 ORDER BY start_date LIMIT 1`,
    [tenantId, fiscalYearId],
  );

  return { fiscalYearId, periods: 12, firstPeriodId: first.rows[0]?.id as string };
}

/**
 * Opening entry: 250,000 of capital sitting in the safe, the bank and fixed assets.
 * Posted, so the trial balance and the ledger are not empty on the very first login.
 */
async function seedOpeningEntry(
  client: Client,
  tenantId: string,
  input: { branchId: string; periodId: string; date: string; byCode: Map<string, string> },
): Promise<string | undefined> {
  const idempotencyKey = `seed:opening:${input.date}`;
  const already = await client.query<{ number: string }>(
    `SELECT number FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  if ((already.rowCount ?? 0) > 0) return already.rows[0]?.number ?? undefined;

  const cash = input.byCode.get('1211001');
  const bank = input.byCode.get('1221001');
  const furniture = input.byCode.get('1160001');
  const capital = input.byCode.get('2110001');
  if (!cash || !bank || !furniture || !capital || !input.periodId) return undefined;

  const entryId = newId();
  const number = 'JE-000001';
  await client.query(
    `INSERT INTO journal_entries (id, tenant_id, branch_id, fiscal_period_id, date, number, kind, status,
                                  description, idempotency_key, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', 'posted', $7, $8, now())`,
    [
      entryId,
      tenantId,
      input.branchId,
      input.periodId,
      input.date,
      number,
      'قيد افتتاحي — رأس المال',
      idempotencyKey,
    ],
  );

  const lines: Array<[string, string, string, string]> = [
    [cash, '50000.0000', '0', 'نقدية بالصندوق'],
    [bank, '180000.0000', '0', 'رصيد بنكي'],
    [furniture, '20000.0000', '0', 'أثاث ومعدات'],
    [capital, '0', '250000.0000', 'رأس المال المدفوع'],
  ];
  let lineNo = 1;
  for (const [accountId, debit, credit, description] of lines) {
    await client.query(
      `INSERT INTO journal_entry_lines (entry_id, line_no, tenant_id, account_id, debit, credit, branch_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entryId, lineNo, tenantId, accountId, debit, credit, input.branchId, description],
    );
    lineNo += 1;
  }

  // The application allocates journal numbers from `document_sequences`; advance it so the
  // next entry posted through the API does not re-use JE-000001.
  await client.query(
    `INSERT INTO document_sequences (id, tenant_id, branch_id, doc_type, fiscal_year_id, prefix, current_value, padding)
     SELECT $1, $2, $3, 'journal_entry', fy.id, 'JE-', 1, 6
     FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
     WHERE fp.id = $4
     ON CONFLICT (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type,
                  coalesce(fiscal_year_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET current_value = GREATEST(document_sequences.current_value, 1)`,
    [newId(), tenantId, input.branchId, input.periodId],
  );

  return number;
}

// ----------------------------------------------------------------------------- users

async function seedUsers(
  client: Client,
  tenantId: string,
  specs: DemoUserSpec[],
): Promise<Array<{ email: string; role: string; status: string }>> {
  const created: Array<{ email: string; role: string; status: string }> = [];

  for (const spec of specs) {
    const email = spec.email.trim().toLowerCase();
    const status = spec.passwordHash ? 'active' : 'invited';

    const userRow = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, full_name, status, password_hash, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [newId(), email, spec.fullName, status, spec.passwordHash ?? null, !spec.passwordHash],
    );
    const userId = userRow.rows[0]?.id as string;

    const membershipRow = await client.query<{ id: string }>(
      `INSERT INTO memberships (id, tenant_id, user_id, display_name, status, is_owner)
       VALUES ($1, $2, $3, $4, 'active', false)
       ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL
         DO UPDATE SET status = 'active', display_name = EXCLUDED.display_name
       RETURNING id`,
      [newId(), tenantId, userId, spec.fullName],
    );
    const membershipId = membershipRow.rows[0]?.id as string;

    const roleRow = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [tenantId, spec.roleName],
    );
    const roleId = roleRow.rows[0]?.id;
    if (roleId) {
      await client.query(
        `INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [membershipId, roleId],
      );
      for (const scopeType of ['branch', 'warehouse', 'cash_location'] as const) {
        await client.query(
          `INSERT INTO membership_role_scopes (membership_id, role_id, scope_type, scope_id)
           VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000'::uuid)
           ON CONFLICT DO NOTHING`,
          [membershipId, roleId, scopeType],
        );
      }
    }

    created.push({ email, role: roleId ? spec.roleName : `${spec.roleName} (missing)`, status });
  }

  return created;
}

// --------------------------------------------------------------------------- helpers

async function upsertById(
  client: Client,
  selectSql: string,
  params: unknown[],
  insert: (id: string) => Promise<unknown>,
): Promise<string> {
  const existing = await client.query<{ id: string }>(selectSql, params);
  const found = existing.rows[0]?.id;
  if (found) return found;
  const id = newId();
  await insert(id);
  return id;
}
