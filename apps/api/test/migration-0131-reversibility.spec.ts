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
 * 🔁 ترحيل `0131` — جدولا الموازنات (`budgets` / `budget_lines`).
 *
 * جدولان جديدان فقط (M6.4)، بلا أي تعديل على جداول قائمة — الموازنات لا تُرحِّل قيودًا
 * فلا شيء في الدفتر يعتمد عليها. يُختبر على قاعدة اختبار معزولة:
 *   1. الترحيل مُطبَّق من الحاضنة، وإعادة تطبيقه لا تغيّر شيئاً (idempotent)، والقيود
 *      صارمة (حالة/اسم/مبلغ سالب/تفرد الاسم في السنة/تفرد السطر)؛
 *   2. الجدولان يحملان سياسة عزل المستأجر القياسية ومنح `erp_api`؛
 *   3. ملف التراجع يحذف الجدولين — ومسار القائمة (`GET /budgets`) يفشل بصوتٍ مسموع
 *      (500) لا بقراءةٍ صامتة؛ ثم يعود الترحيل فارغًا مع عزلٍ عامل؛
 *   4. `0126`…`0131` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0131_budgets.sql';
const DOWN_NAME = 'down/0131_budgets.down.sql';
const PREVIOUS_NAMES = [
  '0126_explicit_van_sales_permissions.sql',
  '0127_production_batch_cost_basis.sql',
  '0128_field_sync_queue.sql',
  '0129_fixed_assets.sql',
  '0130_production_wip.sql',
];
const TABLES = ['budgets', 'budget_lines'] as const;

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0131 — budgets', () => {
  let ctx: TestApp;
  let pool: Pool;
  /** صاحب الحساب — يكتب الجدولين مباشرة عبر مالك القاعدة ويفحص البصمات. */
  let owner: Actor;
  let budgetId = '';
  let accountId = '';
  let periodId = '';

  const tableExists = async (table: string): Promise<boolean> => {
    const result = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table]);
    return result.rows.length > 0;
  };

  const rowCount = async (table: string): Promise<number> => {
    const result = await pool.query(`SELECT COUNT(*)::int AS cnt FROM ${table}`);
    return (result.rows[0] as { cnt: number }).cnt;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0131');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    owner = await createActor(ctx, {
      tenantCode: 'mig-0131',
      tenantName: 'مخابز ترحيل الموازنات',
      email: 'owner@mig-0131.test',
      permissions: [...ALL_TENANT_PERMISSIONS, 'accounting.budget.view'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    // الحدّ الأدنى الذي تقبله السطور: سنة مالية + فترة + حساب قابل للترحيل.
    const fiscalYearId = newId();
    periodId = newId();
    accountId = newId();
    budgetId = newId();
    await pool.query(
      `INSERT INTO fiscal_years (id, tenant_id, name, start_date, end_date)
       VALUES ($1, $2, 'FY-MIG-131', '2026-01-01', '2026-12-31')`,
      [fiscalYearId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO fiscal_periods (id, tenant_id, fiscal_year_id, name, start_date, end_date)
       VALUES ($1, $2, $3, '2026-01', '2026-01-01', '2026-01-31')`,
      [periodId, owner.tenantId, fiscalYearId],
    );
    await pool.query(
      `INSERT INTO accounts (id, tenant_id, code, name_ar, type, normal_balance, path, level, is_postable)
       VALUES ($1, $2, '1390001', 'حساب ترحيل الموازنة', 'expense', 'debit', '1390001', 1, true)`,
      [accountId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO budgets (id, tenant_id, name, fiscal_year_id, status)
       VALUES ($1, $2, 'موازنة الترحيل', $3, 'draft')`,
      [budgetId, owner.tenantId, fiscalYearId],
    );
    await pool.query(
      `INSERT INTO budget_lines (id, tenant_id, budget_id, account_id, fiscal_period_id, amount)
       VALUES ($1, $2, $3, $4, $5, 2500)`,
      [newId(), owner.tenantId, budgetId, accountId, periodId],
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
    expect(await rowCount('budgets')).toBe(1);
    expect(await rowCount('budget_lines')).toBe(1);

    await pool.query(await readSql(UP_NAME));
    expect(await rowCount('budgets')).toBe(1);
    expect(await rowCount('budget_lines')).toBe(1);

    // القيود: حالة غير معروفة، واسم فارغ، ومبلغ سالب.
    await expect(
      pool.query(
        `INSERT INTO budgets (id, tenant_id, name, fiscal_year_id, status)
         VALUES ($1, $2, 'حالة فاسدة', (SELECT fiscal_year_id FROM budgets WHERE id = $3), 'archived')`,
        [newId(), owner.tenantId, budgetId],
      ),
    ).rejects.toThrow(/budgets_status_check/i);
    await expect(
      pool.query(
        `INSERT INTO budgets (id, tenant_id, name, fiscal_year_id)
         VALUES ($1, $2, '', (SELECT fiscal_year_id FROM budgets WHERE id = $3))`,
        [newId(), owner.tenantId, budgetId],
      ),
    ).rejects.toThrow(/budgets_name_check/i);
    await expect(
      pool.query(
        `INSERT INTO budget_lines (id, tenant_id, budget_id, account_id, fiscal_period_id, amount)
         VALUES ($1, $2, $3, $4, $5, -10)`,
        [newId(), owner.tenantId, budgetId, accountId, periodId],
      ),
    ).rejects.toThrow(/budget_lines_amount_check/i);

    // تفرد الاسم داخل (المستأجر، السنة)، وتفرد السطر (موازنة، حساب، فترة).
    await expect(
      pool.query(
        `INSERT INTO budgets (id, tenant_id, name, fiscal_year_id)
         VALUES ($1, $2, 'موازنة الترحيل', (SELECT fiscal_year_id FROM budgets WHERE id = $3))`,
        [newId(), owner.tenantId, budgetId],
      ),
    ).rejects.toThrow(/budgets_tenant_year_name_key/i);
    await expect(
      pool.query(
        `INSERT INTO budget_lines (id, tenant_id, budget_id, account_id, fiscal_period_id, amount)
         VALUES ($1, $2, $3, $4, $5, 99)`,
        [newId(), owner.tenantId, budgetId, accountId, periodId],
      ),
    ).rejects.toThrow(/budget_lines_budget_account_period_key/i);
  });

  it('carries the canonical tenant-isolation RLS policy on both tables', async () => {
    for (const table of TABLES) {
      const policy = await pool.query(
        `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = $1`,
        [table],
      );
      expect(policy.rows, `${table} policy`).toHaveLength(1);
      const row = policy.rows[0] as { policyname: string; cmd: string; qual: string };
      expect(row.policyname).toBe(`${table}_tenant_isolation`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual.toLowerCase()).toContain("tenant_id = (nullif(current_setting('app.tenant_id'");
      expect(row.qual.toLowerCase()).not.toContain('app.is_platform_admin');

      const rls = await pool.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect((rls.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
      expect((rls.rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
    }

    // الجدولان مسجَّلان في قائمة الجداول المحمية — عزل المستأجرين يغطيهما تلقائياً.
    const { rlsProtectedTables } = await import('@erp/database');
    for (const table of TABLES) {
      expect(rlsProtectedTables).toContain(table);
    }
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    expect(await rowCount('budgets')).toBe(1);
    expect(await rowCount('budget_lines')).toBe(1);

    await pool.query(await readSql(DOWN_NAME));
    for (const table of TABLES) {
      expect(await tableExists(table), `${table} must be gone`).toBe(false);
    }

    /** مسار القائمة يفشل صراحةً — لا قراءة صامتة لجداولٍ لم تعد موجودة. */
    const broken = await api(ctx.server, 'get', '/api/v1/budgets', { token: owner.token });
    expect(broken.status).toBe(500);

    await pool.query(await readSql(UP_NAME));
    for (const table of TABLES) {
      expect(await tableExists(table), `${table} must be back`).toBe(true);
      expect(await rowCount(table)).toBe(0);
    }
    const revivedId = newId();
    await pool.query(
      `INSERT INTO budgets (id, tenant_id, name, fiscal_year_id)
       VALUES ($1, $2, 'موازنة ما بعد العودة', (SELECT id FROM fiscal_years WHERE tenant_id = $2 LIMIT 1))`,
      [revivedId, owner.tenantId],
    );
    expect(await rowCount('budgets')).toBe(1);

    // العزل يعود مع الجدولين: جلسة مستأجرٍ آخر لا ترى شيئًا.
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
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' OR name LIKE '013%' ORDER BY name`,
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
