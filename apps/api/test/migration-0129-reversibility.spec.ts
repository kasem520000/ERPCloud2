import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 ترحيل `0129` — الأصول الثابتة (`asset_categories` / `fixed_assets` /
 * `asset_depreciation_entries`).
 *
 * الميزة معزولة بالتصميم (M6.1): ثلاثة جداول جديدة وصفر تعديل على الجداول
 * القائمة، وكل ترحيل إهلاك يمرّ عبر `AccountingService.postJournalInTx` —
 * حارس التوازن والفترة المفتوحة وقفل الوحدة في مكان واحد — فالترحيل يحمل
 * البنية لا منطق الترحيل المحاسبي.
 *
 * يُختبر على قاعدة اختبار معزولة:
 *   1. الترحيل مُطبَّق من الحاضنة، وإعادة تطبيقه لا تغيّر شيئاً (idempotent)،
 *      والقيود صارمة (عمر/تكلفة/قيمة إنقاذ/طريقة/صيغة فترة/مبلغ/تفرد)؛
 *   2. الجداول الثلاثة تحمل سياسة عزل المستأجر القياسية ومنح `erp_api`؛
 *   3. ملف التراجع يحذف الجداول الثلاثة — ومسار السجل (`GET /fixed-assets`)
 *      يفشل بصوتٍ مسموع (500) لا بقراءةٍ صامتة؛ ثم يعود الترحيل فارغاً
 *      (القيود المحاسبية المرحّلة في `journal_entries` لم تُمَس — إنها دفتر
 *      المحاسب، وعكسها قيد عكسيّ لا جدولٌ محذوف)؛
 *   4. `0124`…`0129` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0129_fixed_assets.sql';
const DOWN_NAME = 'down/0129_fixed_assets.down.sql';
const PREVIOUS_NAMES = [
  '0124_van_sales_stock_and_custody_settlement.sql',
  '0125_journal_reversal_convention.sql',
  '0126_explicit_van_sales_permissions.sql',
  '0127_production_batch_cost_basis.sql',
  '0128_field_sync_queue.sql',
];
const TABLES = ['asset_categories', 'fixed_assets', 'asset_depreciation_entries'] as const;

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0129 — fixed assets', () => {
  let ctx: TestApp;
  let pool: Pool;
  /** صاحب الحساب — يكتب الجداول مباشرة عبر مالك القاعدة ويفحص البصمات. */
  let owner: Actor;
  let categoryId = '';
  let assetId = '';
  let journalEntryId = '';

  const tableExists = async (table: string): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [table],
    );
    return result.rows.length > 0;
  };

  const rowCount = async (table: string): Promise<number> => {
    const result = await pool.query(`SELECT COUNT(*)::int AS cnt FROM ${table}`);
    return (result.rows[0] as { cnt: number }).cnt;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0129');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    owner = await createActor(ctx, {
      tenantCode: 'mig-0129',
      tenantName: 'مصانع ترحيل الأصول',
      email: 'owner@mig-0129.test',
      permissions: [...ALL_TENANT_PERMISSIONS, 'accounting.assets.view'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    // تصنيف وأصل عبر مالك القاعدة مباشرة — قيدان صالحان يقفان قبل التراجع.
    categoryId = newId();
    assetId = newId();
    await pool.query(
      `INSERT INTO asset_categories (id, tenant_id, code, name_ar, default_useful_life_months)
       VALUES ($1, $2, 'MIG-CAT', 'آلات الترحيل', 60)`,
      [categoryId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO fixed_assets (id, tenant_id, code, name_ar, category_id, acquisition_date,
                                  acquisition_cost, salvage_value, useful_life_months, method, status)
       VALUES ($1, $2, 'MIG-ASSET', 'مكبس الترحيل', $3, '2026-01-15', 240000, 30000, 60, 'straight_line', 'active')`,
      [assetId, owner.tenantId, categoryId],
    );

    // سجل الإهلاك يشير إلى قيد يومية حقيقي (`journal_entry_id` NOT NULL FK) —
    // نبنيه بحدّه الأدنى: فرع + سنة مالية + فترة + قيد.
    const branchId = newId();
    const fiscalYearId = newId();
    const fiscalPeriodId = newId();
    journalEntryId = newId();
    await pool.query(
      `INSERT INTO branches (id, tenant_id, code, name_ar, is_default, is_active)
       VALUES ($1, $2, 'MIG-BR', 'فرع الترحيل', true, true)`,
      [branchId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO fiscal_years (id, tenant_id, name, start_date, end_date)
       VALUES ($1, $2, 'FY-MIG', '2026-01-01', '2026-12-31')`,
      [fiscalYearId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO fiscal_periods (id, tenant_id, fiscal_year_id, name, start_date, end_date)
       VALUES ($1, $2, $3, 'يناير 2026', '2026-01-01', '2026-01-31')`,
      [fiscalPeriodId, owner.tenantId, fiscalYearId],
    );
    await pool.query(
      `INSERT INTO journal_entries (id, tenant_id, branch_id, fiscal_period_id, date, number, status)
       VALUES ($1, $2, $3, $4, '2026-01-31', 'JV-MIG-001', 'posted')`,
      [journalEntryId, owner.tenantId, branchId, fiscalPeriodId],
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied by the harness and changes nothing when re-applied', async () => {
    for (const table of TABLES) {
      expect(await tableExists(table), `${table} must exist`).toBe(true);
    }
    expect(await rowCount('asset_categories')).toBe(1);
    expect(await rowCount('fixed_assets')).toBe(1);

    const before = await rowCount('fixed_assets');
    await pool.query(await readSql(UP_NAME));
    expect(await rowCount('fixed_assets')).toBe(before);
    expect(await rowCount('asset_categories')).toBe(1);

    // القيود: عمر غير موجب، وتكلفة غير موجبة، وقيمة إنقاذ فوق التكلفة، وطريقة غير معتمدة.
    await expect(
      pool.query(
        `INSERT INTO asset_categories (id, tenant_id, code, name_ar, default_useful_life_months)
         VALUES ($1, $2, 'MIG-BAD-LIFE', 'تصنيف فاسد', 0)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/asset_categories_life_check/i);
    await expect(
      pool.query(
        `INSERT INTO fixed_assets (id, tenant_id, code, name_ar, category_id, acquisition_date,
                                   acquisition_cost, salvage_value, useful_life_months, method, status)
         VALUES ($1, $2, 'MIG-BAD-COST', 'أصل فاسد', $3, '2026-01-15', 0, 0, 60, 'straight_line', 'active')`,
        [newId(), owner.tenantId, categoryId],
      ),
    ).rejects.toThrow(/fixed_assets_cost_check/i);
    await expect(
      pool.query(
        `INSERT INTO fixed_assets (id, tenant_id, code, name_ar, category_id, acquisition_date,
                                   acquisition_cost, salvage_value, useful_life_months, method, status)
         VALUES ($1, $2, 'MIG-BAD-SALVAGE', 'أصل فاسد', $3, '2026-01-15', 1000, 2000, 60, 'straight_line', 'active')`,
        [newId(), owner.tenantId, categoryId],
      ),
    ).rejects.toThrow(/fixed_assets_salvage_check/i);
    await expect(
      pool.query(
        `INSERT INTO fixed_assets (id, tenant_id, code, name_ar, category_id, acquisition_date,
                                   acquisition_cost, salvage_value, useful_life_months, method, status)
         VALUES ($1, $2, 'MIG-BAD-METHOD', 'أصل فاسد', $3, '2026-01-15', 1000, 0, 60, 'double_declining', 'active')`,
        [newId(), owner.tenantId, categoryId],
      ),
    ).rejects.toThrow(/fixed_assets_method_check/i);

    // تفرد الرمز داخل المستأجر — تصنيفاً وأصلاً.
    await expect(
      pool.query(
        `INSERT INTO asset_categories (id, tenant_id, code, name_ar, default_useful_life_months)
         VALUES ($1, $2, 'MIG-CAT', 'مكرر', 36)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/asset_categories_tenant_code_key/i);
    await expect(
      pool.query(
        `INSERT INTO fixed_assets (id, tenant_id, code, name_ar, category_id, acquisition_date,
                                   acquisition_cost, salvage_value, useful_life_months, method, status)
         VALUES ($1, $2, 'MIG-ASSET', 'مكرر', $3, '2026-01-15', 1000, 0, 60, 'straight_line', 'active')`,
        [newId(), owner.tenantId, categoryId],
      ),
    ).rejects.toThrow(/fixed_assets_tenant_code_key/i);

    // سجل الإهلاك: صيغة فترة فاسدة، ومبلغ غير موجب، وقيد (أصل، فترة) لا يتكرر أبداً —
    // هذا التفرد هو بوابه idempotency للتشغيل الشهري.
    const entryId = newId();
    await pool.query(
      `INSERT INTO asset_depreciation_entries (id, tenant_id, asset_id, period, depreciation_date,
                                               amount, journal_entry_id)
       VALUES ($1, $2, $3, '2026-01', '2026-01-31', 3500, $4)`,
      [entryId, owner.tenantId, assetId, journalEntryId],
    );
    await expect(
      pool.query(
        `INSERT INTO asset_depreciation_entries (id, tenant_id, asset_id, period, depreciation_date,
                                                 amount, journal_entry_id)
         VALUES ($1, $2, $3, '2026-1', '2026-02-28', 3500, $4)`,
        [newId(), owner.tenantId, assetId, journalEntryId],
      ),
    ).rejects.toThrow(/asset_depreciation_entries_period_check/i);
    await expect(
      pool.query(
        `INSERT INTO asset_depreciation_entries (id, tenant_id, asset_id, period, depreciation_date,
                                                 amount, journal_entry_id)
         VALUES ($1, $2, $3, '2026-02', '2026-02-28', 0, $4)`,
        [newId(), owner.tenantId, assetId, journalEntryId],
      ),
    ).rejects.toThrow(/asset_depreciation_entries_amount_check/i);
    await expect(
      pool.query(
        `INSERT INTO asset_depreciation_entries (id, tenant_id, asset_id, period, depreciation_date,
                                                 amount, journal_entry_id)
         VALUES ($1, $2, $3, '2026-01', '2026-01-31', 3500, $4)`,
        [newId(), owner.tenantId, assetId, journalEntryId],
      ),
    ).rejects.toThrow(/asset_depreciation_entries_asset_period_key/i);
  });

  it('carries the canonical tenant-isolation RLS policy on all three tables', async () => {
    for (const table of TABLES) {
      const policy = await pool.query(
        `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = $1`,
        [table],
      );
      expect(policy.rows, `${table} policy`).toHaveLength(1);
      const row = policy.rows[0] as { policyname: string; cmd: string; qual: string };
      expect(row.policyname).toBe(`${table}_tenant_isolation`);
      expect(row.cmd).toBe('ALL');
      /** بوستغريس يطبّع التعبير — المقارنة على الجوهر لا الشكل. */
      expect(row.qual.toLowerCase()).toContain("tenant_id = (nullif(current_setting('app.tenant_id'");
      expect(row.qual.toLowerCase()).not.toContain('app.is_platform_admin');

      const rls = await pool.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect((rls.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
      expect((rls.rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
    }

    // الجداول الثلاثة مسجَّلة في قائمة الجداول المحمية — عزل المستأجرين يغطيها تلقائياً.
    const { rlsProtectedTables } = await import('@erp/database');
    for (const table of TABLES) {
      expect(rlsProtectedTables).toContain(table);
    }
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    // صفوف قائمة قبل التراجع.
    expect(await rowCount('asset_categories')).toBe(1);
    expect(await rowCount('fixed_assets')).toBe(1);

    await pool.query(await readSql(DOWN_NAME));
    for (const table of TABLES) {
      expect(await tableExists(table), `${table} must be gone`).toBe(false);
    }

    /** مسار السجل يفشل صراحةً — لا قراءة صامتة لجداولٍ لم تعد موجودة. */
    const broken = await api(ctx.server, 'get', '/api/v1/fixed-assets', { token: owner.token });
    expect(broken.status).toBe(500);

    await pool.query(await readSql(UP_NAME));
    for (const table of TABLES) {
      expect(await tableExists(table), `${table} must be back`).toBe(true);
      // ما يُفقد بالتراجع هو السجل نفسه؛ الجداول تعود فارغة وقابلة للكتابة.
      expect(await rowCount(table)).toBe(0);
    }
    await pool.query(
      `INSERT INTO asset_categories (id, tenant_id, code, name_ar, default_useful_life_months)
       VALUES ($1, $2, 'MIG-AFTER-UP', 'تصنيف ما بعد العودة', 48)`,
      [newId(), owner.tenantId],
    );
    expect(await rowCount('asset_categories')).toBe(1);

    // العزل يعود مع الجداول: جلسة مستأجرٍ آخر لا ترى شيئاً.
    const otherTenantId = newId();
    for (const table of TABLES) {
      const seen = await withTenantTx(ctx.handle.db, otherTenantId, async (tx) => {
        const result = await tx.execute(sql`SELECT COUNT(*)::int AS cnt FROM ${sql.identifier(table)}`);
        const rowsList = Array.isArray(result)
          ? (result as Array<{ cnt: number }>)
          : ((result as { rows: Array<{ cnt: number }> }).rows ?? []);
        return rowsList[0]?.cnt ?? 0;
      });
      expect(seen, `${table} must be invisible to another tenant`).toBe(0);
    }
  });

  it('leaves the historical migrations exactly as they were recorded', async () => {
    const result = await pool.query(
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' ORDER BY name`,
    );
    const recorded = new Map(
      (result.rows as Array<{ name: string; checksum: string }>).map((row) => [row.name, row.checksum]),
    );
    for (const name of [...PREVIOUS_NAMES, UP_NAME]) {
      const onDisk = await readSql(name);
      expect(recorded.get(name), `${name} must be recorded as applied`).toBeTruthy();
      expect(recorded.get(name), `${name} must not have been edited`).toBe(sha256(onDisk));
    }
  });
});
