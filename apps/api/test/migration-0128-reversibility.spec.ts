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
 * 🔁 ترحيل `0128` — جدول `field_sync_queue` (سجل إعادة تشغيل طابور المندوب).
 *
 * الجدول مقسّم على غرار `offline_queue` (0102): هويّة إعادة التشغيل + صندوق التعارضات
 * فقط، لا مستودع مستندات ثانٍ. ما أضافه تدفق المندوب: `salesman_id` (مستنتج من عضوية
 * المُعيد لا من الحمولة)، `operation` (الدفعة مختلطة)، و`result` (لقطة نتيجة المحرك).
 *
 * يُختبر على قاعدة اختبار معزولة:
 *   1. الترحيل مُطبَّق من الحاضنة، وإعادة تطبيقه لا تغيّر شيئاً (idempotent)؛
 *   2. القيود صارمة: حالة/عملية/تسلسل غير صالحة تُرفض، والـRLS سياسة العزل القياسية؛
 *   3. ملف التراجع يحذف الجدول — ومسار يقرأه (`GET /field-sync/queue`) يفشل بصوتٍ مسموع
 *      (500) لا بقراءةٍ صامتة؛ ثم يعود الترحيل فارغاً (ما يُفقد هو صفوف السجل وحدها
 *      — المستندات الرسمية في محركاتها لا تُمس)؛
 *   4. `0123`…`0128` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0128_field_sync_queue.sql';
const DOWN_NAME = 'down/0128_field_sync_queue.down.sql';
const PREVIOUS_NAMES = [
  '0123_van_sales_rep_workspace_and_receipt_workflow.sql',
  '0124_van_sales_stock_and_custody_settlement.sql',
  '0125_journal_reversal_convention.sql',
  '0126_explicit_van_sales_permissions.sql',
  '0127_production_batch_cost_basis.sql',
];

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0128 — field_sync_queue', () => {
  let ctx: TestApp;
  let pool: Pool;
  /** صاحب الحساب بلا بطاقة مندوب — يكتب الجدول مباشرة ويفحص البصمات. */
  let owner: Actor;
  /** مندوب ببطاقة ونطاق — الوحيد الذي يمرّ عبر حارس المسار إلى الجدول. */
  let rep: Actor;
  let branchId = '';

  const tableExists = async (): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'field_sync_queue'`,
    );
    return result.rows.length > 0;
  };

  const rowCount = async (): Promise<number> => {
    const result = await pool.query(`SELECT COUNT(*)::int AS cnt FROM field_sync_queue`);
    return (result.rows[0] as { cnt: number }).cnt;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0128');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    owner = await createActor(ctx, {
      tenantCode: 'mig-0128',
      tenantName: 'مخابز سجل الميدان',
      email: 'owner@mig-0128.test',
      permissions: [...ALL_TENANT_PERMISSIONS, 'van_sales.view'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    // بطاقة مندوب كاملة: مستودع سيارة + موظف مربوط بعضوية حساب دخول حقيقية.
    const { OrgProvisioningService } = await import(
      '../src/modules/organization/provisioning/org-provisioning.service.js'
    );
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;

    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'mig-0128',
      email: 'rep@mig-0128.test',
      permissions: ['van_sales.view'],
      roleNames: ['Rep'],
      isOwner: false,
    });

    const vanWarehouseId = newId();
    const employeeId = newId();
    const salesmanId = newId();
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
        VALUES (${vanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'VAN-MIG', 'سيارة المندوب', false, true)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES (${employeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-MIG', 'مندوب السجل', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب السجل', true, ${employeeId}::uuid, ${vanWarehouseId}::uuid, 'م-128')
      `);
    });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied by the harness and changes nothing when re-applied', async () => {
    expect(await tableExists()).toBe(true);

    await pool.query(
      `INSERT INTO field_sync_queue (id, tenant_id, device_id, salesman_id, offline_id, sequence_no, operation, payload)
       VALUES ($1, $2, 'mig-device-1', NULL, 'mig-offline-1', 1, 'invoice', '{"soldQty": "2"}'::jsonb)`,
      [newId(), owner.tenantId],
    );
    expect(await rowCount()).toBe(1);

    const before = await rowCount();
    await pool.query(await readSql(UP_NAME));
    expect(await rowCount()).toBe(before);

    // القيود: عملية غير معروفة، حالة غير صالحة، وتسلسل غير موجب — كلها تُرفض.
    await expect(
      pool.query(
        `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, payload)
         VALUES ($1, $2, 'mig-device-1', 'mig-offline-bad-op', 2, 'delivery', '{}'::jsonb)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/field_sync_queue_operation_check/i);
    await expect(
      pool.query(
        `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, status, payload)
         VALUES ($1, $2, 'mig-device-1', 'mig-offline-bad-status', 3, 'invoice', 'lost', '{}'::jsonb)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/field_sync_queue_status_check/i);
    await expect(
      pool.query(
        `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, payload)
         VALUES ($1, $2, 'mig-device-1', 'mig-offline-bad-seq', 0, 'invoice', '{}'::jsonb)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/field_sync_queue_sequence_check/i);

    // تفرد الهوية داخل المستأجر، وتفرد (جهاز، تسلسل) داخل المستأجر.
    await expect(
      pool.query(
        `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, payload)
         VALUES ($1, $2, 'mig-device-1', 'mig-offline-1', 9, 'invoice', '{}'::jsonb)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/field_sync_queue_tenant_offline_id_key/i);
    await expect(
      pool.query(
        `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, payload)
         VALUES ($1, $2, 'mig-device-1', 'mig-offline-2', 1, 'invoice', '{}'::jsonb)`,
        [newId(), owner.tenantId],
      ),
    ).rejects.toThrow(/field_sync_queue_tenant_device_sequence_key/i);
  });

  it('carries the canonical tenant-isolation RLS policy and the erp_api grants', async () => {
    const policy = await pool.query(
      `SELECT policyname, cmd, qual, with_check FROM pg_policies
       WHERE tablename = 'field_sync_queue'`,
    );
    expect(policy.rows).toHaveLength(1);
    const row = policy.rows[0] as {
      policyname: string;
      cmd: string;
      qual: string;
      with_check: string;
    };
    expect(row.policyname).toBe('field_sync_queue_tenant_isolation');
    expect(row.cmd).toBe('ALL');
    /** بوستغريس يطبّع التعبير (أحرف كبيرة وتحويلات نصية) — المقارنة على الجوهر لا الشكل. */
    expect(row.qual.toLowerCase()).toContain("tenant_id = (nullif(current_setting('app.tenant_id'");
    expect(row.qual.toLowerCase()).not.toContain('app.is_platform_admin');

    const rls = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'field_sync_queue'`,
    );
    expect((rls.rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
    expect((rls.rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);

    // الجدول مسجَّل في قائمة الجداول المحمية — عزل المستأجرين يغطيه تلقائياً.
    const { rlsProtectedTables } = await import('@erp/database');
    expect(rlsProtectedTables).toContain('field_sync_queue');
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    // صف واحد قائم قبل التراجع.
    expect(await rowCount()).toBe(1);

    await pool.query(await readSql(DOWN_NAME));
    expect(await tableExists()).toBe(false);

    /** المسار الذي يقرأ الجدول يفشل صراحةً — لا قراءة صامتة لسجلٍ لم يعد موجوداً. */
    const broken = await api(ctx.server, 'get', '/api/v1/field-sync/queue', {
      token: rep.token,
    });
    expect(broken.status).toBe(500);

    await pool.query(await readSql(UP_NAME));
    expect(await tableExists()).toBe(true);
    // ما يُفقد بالتراجع هو صفوف السجل وحدها؛ الجدول يعود فارغاً وقابلاً للكتابة.
    expect(await rowCount()).toBe(0);
    await pool.query(
      `INSERT INTO field_sync_queue (id, tenant_id, device_id, offline_id, sequence_no, operation, payload)
       VALUES ($1, $2, 'mig-device-2', 'mig-offline-after-up', 1, 'collection', '{}'::jsonb)`,
      [newId(), owner.tenantId],
    );
    expect(await rowCount()).toBe(1);

    // العزل يعود مع الجدول: جلسة مستأجرٍ آخر لا ترى الصفوف.
    const otherTenantId = newId();
    const seen = await withTenantTx(ctx.handle.db, otherTenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT COUNT(*)::int AS cnt FROM field_sync_queue`);
      const rowsList = Array.isArray(result)
        ? (result as Array<{ cnt: number }>)
        : ((result as { rows: Array<{ cnt: number }> }).rows ?? []);
      return rowsList[0]?.cnt ?? 0;
    });
    expect(seen).toBe(0);
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
