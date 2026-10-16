import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { newId } from '@erp/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 ترحيل `0130` — عمودا مرحلة «تحت التشغيل» في `production_orders`.
 *
 * ترحيلٌ تعديلي لا إنشائي: `issued_at` و`wip_posted` فقط، بلا جدول جديد ولا تغيير RLS
 * (الجدول يحمل سياسة العزل القياسية أصلًا). يُختبر على قاعدة معزولة:
 *   1. العمودان موجودان بقيمهما الافتراضية (`wip_posted` = false)، وإعادة تطبيق الترحيل
 *      لا تغيّر شيئًا (idempotent)؛
 *   2. ملف التراجع يحذف العمودين ويُبقي الصفوف — ومسار قراءة السجل
 *      (`GET /inventory/production-orders`) يفشل بصوتٍ مسموع (500) لا بقراءةٍ صامتة؛ ثم
 *      يعودان فارغَي القيمة (false) والصفوف كما كانت؛
 *   3. `0125`…`0130` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0130_production_wip.sql';
const DOWN_NAME = 'down/0130_production_wip.down.sql';
const PREVIOUS_NAMES = [
  '0125_journal_reversal_convention.sql',
  '0126_explicit_van_sales_permissions.sql',
  '0127_production_batch_cost_basis.sql',
  '0128_field_sync_queue.sql',
  '0129_fixed_assets.sql',
];

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0130 — production WIP columns', () => {
  let ctx: TestApp;
  let pool: Pool;
  /** صاحب الحساب — يقرأ السجل عبر المسار الرسمي ويفحص البصمات. */
  let owner: Actor;
  let orderId = '';

  const columnExists = async (column: string): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'production_orders' AND column_name = $1`,
      [column],
    );
    return result.rows.length > 0;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0130');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    owner = await createActor(ctx, {
      tenantCode: 'mig-0130',
      tenantName: 'مخابز ترحيل التشغيل',
      email: 'owner@mig-0130.test',
      permissions: [...ALL_TENANT_PERMISSIONS, 'inventory.view', 'inventory.production.manage', 'inventory.production.complete'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    // مستودع وصنف وأمر إنتاج صالحان يقفان قبل التراجع — أدنى قالب يقبله الجدول.
    const { OrgProvisioningService } = await import(
      '../src/modules/organization/provisioning/org-provisioning.service.js'
    );
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    const itemId = newId();
    const categoryId = newId();
    const unitId = newId();
    orderId = newId();
    await pool.query(
      `INSERT INTO item_categories (id, tenant_id, code, name_ar) VALUES ($1, $2, 'CAT-MIG-WIP', 'ترحيل التشغيل')`,
      [categoryId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en) VALUES ($1, $2, 'KG-MIG', 'كيلوجرام', 'Kilogram')`,
      [unitId, owner.tenantId],
    );
    await pool.query(
      `INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
       VALUES ($1, $2, 'SKU-MIG-WIP', 'خبز الترحيل', $3, $4, 'stock', 0, 0, false)`,
      [itemId, owner.tenantId, categoryId, unitId],
    );
    await pool.query(
      `INSERT INTO production_orders (id, tenant_id, warehouse_id, number, order_date, status, output_item_id, output_qty, wip_posted)
       VALUES ($1, $2, $3, 'MO-MIG-WIP', '2026-01-15', 'in_progress', $4, 10, true)`,
      [orderId, owner.tenantId, defaults.warehouseId, itemId],
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied by the harness and changes nothing when re-applied', async () => {
    expect(await columnExists('issued_at')).toBe(true);
    expect(await columnExists('wip_posted')).toBe(true);

    // القيمة المكتوبة قبل إعادة التطبيق باقية كما هي.
    const before = await pool.query(`SELECT wip_posted, issued_at FROM production_orders WHERE id = $1`, [orderId]);
    expect((before.rows[0] as { wip_posted: boolean }).wip_posted).toBe(true);

    await pool.query(await readSql(UP_NAME));
    const after = await pool.query(`SELECT wip_posted FROM production_orders WHERE id = $1`, [orderId]);
    expect((after.rows[0] as { wip_posted: boolean }).wip_posted).toBe(true);

    // والافتراضي لصفٍّ جديد false.
    const defaults = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'production_orders' AND column_name = 'wip_posted'`,
    );
    expect((defaults.rows[0] as { column_default: string }).column_default).toBe('false');
    expect((defaults.rows[0] as { is_nullable: string }).is_nullable).toBe('NO');
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    // الصف قائم قبل التراجع.
    expect(await pool.query(`SELECT COUNT(*)::int AS cnt FROM production_orders WHERE id = $1`, [orderId])).toMatchObject({ rows: [{ cnt: 1 }] });

    await pool.query(await readSql(DOWN_NAME));
    expect(await columnExists('issued_at')).toBe(false);
    expect(await columnExists('wip_posted')).toBe(false);

    /** مسار السجل يفشل صراحةً — لا قراءة صامتة لأعمدةٍ لم تعد موجودة. */
    const broken = await api(ctx.server, 'get', '/api/v1/inventory/production-orders', { token: owner.token });
    expect(broken.status).toBe(500);

    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('issued_at')).toBe(true);
    expect(await columnExists('wip_posted')).toBe(true);
    // الصف باقٍ (ALTER لا يمسّ الصفوف)، والعمود عاد بقيمته الافتراضية لا بقيمته القديمة —
    // ما يُفقد بالتراجع هو معرفة حالة التشغيل وحدها، لا الأوامر ولا قيودها.
    const after = await pool.query(`SELECT status, wip_posted FROM production_orders WHERE id = $1`, [orderId]);
    expect((after.rows[0] as { status: string }).status).toBe('in_progress');
    expect((after.rows[0] as { wip_posted: boolean }).wip_posted).toBe(false);
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
