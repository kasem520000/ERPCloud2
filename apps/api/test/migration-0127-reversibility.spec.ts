import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 ترحيل `0127` — عمود `factory_production_batches.cost_basis`.
 *
 * الأساس كان يُستنتج عند القراءة من «هل ارتبطت الدفعة بأمر رسمي؟». وكان استنتاجاً صادقاً حين كان
 * الربط اختيارياً، وصار كذباً حين صار مصدر المواد إلزامياً (ب): كل دفعة صارت مرتبطة، فكل دفعة
 * تُقرأ «تكلفة فعلية من أمر تصنيع» — حتى الدفعة التي موادها بلا قيمة وسعّرها المحاسب أو بطاقة
 * الصنف، وحتى الفاقد الذي لم تُصرف له مادة فيُقال إنه محمّل على المنتج الجيد.
 *
 * يُختبر على قاعدة اختبار معزولة:
 *   1. الترحيل مُطبَّق من الحاضنة، وإعادة تطبيقه لا تغيّر شيئاً (idempotent)؛
 *   2. الدفعة الجديدة تحفظ أساسها الحقيقي، والصفوف السابقة (NULL) تُقرأ بالاستنتاج القديم؛
 *   3. ملف التراجع يحذف العمود — والشاشة التي تقرأه تفشل صراحةً بدل أن تستنتج بصمت — ثم يعود
 *      الترحيل بلا خسارة في الأرصدة أو الحركات (ما يُفقد هو الأساس المكتوب وحده)؛
 *   4. `0123`…`0127` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0127_production_batch_cost_basis.sql';
const DOWN_NAME = 'down/0127_production_batch_cost_basis.down.sql';
const PREVIOUS_NAMES = [
  '0123_van_sales_rep_workspace_and_receipt_workflow.sql',
  '0124_van_sales_stock_and_custody_settlement.sql',
  '0125_journal_reversal_convention.sql',
  '0126_explicit_van_sales_permissions.sql',
];

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0127 — production batch cost basis', () => {
  let ctx: TestApp;
  let pool: Pool;
  let actor: Actor;

  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let componentItemId = '';
  let unvaluedComponentId = '';
  let noCostItemId = '';
  let legacyOrderId = '';

  const batches = async (): Promise<Array<Record<string, unknown>>> => {
    const response = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: actor.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body.data.productionBatches ?? []) as Array<Record<string, unknown>>;
  };

  const basisOf = async (batchNo: string): Promise<Record<string, unknown> | undefined> =>
    (await batches()).find((row) => row.batchNo === batchNo);

  const columnOf = async (batchNo: string): Promise<string | null> => {
    const result = await pool.query(
      `SELECT cost_basis FROM factory_production_batches WHERE tenant_id = $1 AND batch_no = $2`,
      [actor.tenantId, batchNo],
    );
    return (result.rows[0] as { cost_basis: string | null } | undefined)?.cost_basis ?? null;
  };

  const columnExists = async (): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'factory_production_batches' AND column_name = 'cost_basis'`,
    );
    return result.rows.length > 0;
  };

  const produce = (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: actor.token,
      body: { itemId, warehouseId, ...body },
    });

  beforeAll(async () => {
    ctx = await createTestApp('migration_0127');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    actor = await createActor(ctx, {
      tenantCode: 'mig-0127',
      tenantName: 'مخابز أساس التكلفة',
      email: 'owner@mig-0127.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'accounting.period.view',
        'accounting.period.close',
        'inventory.view',
        'inventory.production.manage',
        'inventory.production.complete',
        'van_sales.view',
        'van_sales.production.manage',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    itemId = newId();
    noCostItemId = newId();
    componentItemId = newId();
    unvaluedComponentId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${actor.tenantId}::uuid, 'CAT-127', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${actor.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      // الأسعار نصوصاً: المال في هذا المشروع `decimal.js`/نصّ، لا `number`.
      for (const [id, sku, name, cardPrice] of [
        [itemId, 'SKU-127-1', 'خبز بلدي', '4.0000'],
        [noCostItemId, 'SKU-127-2', 'كيك بلا تكلفة', '0'],
        [componentItemId, 'SKU-127-F', 'دقيق أبيض', '4.0000'],
        [unvaluedComponentId, 'SKU-127-W', 'ماء وملح', '0'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                             purchase_price, sale_price, track_lot)
          VALUES (${id}::uuid, ${actor.tenantId}::uuid, ${sku}, ${name}, ${categoryId}::uuid,
                  ${baseUnitId}::uuid, 'stock', ${cardPrice}::numeric, ${cardPrice}::numeric, false)
        `);
      }
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES
          (${actor.tenantId}::uuid, ${componentItemId}::uuid, ${warehouseId}::uuid, 10000, 40000, 4.0000, 1),
          (${actor.tenantId}::uuid, ${unvaluedComponentId}::uuid, ${warehouseId}::uuid, 10000, 0, 0, 1)
      `);
    });

    // أمر إنتاج رسمي (مسودة) — link for a legacy batch row written before the column existed.
    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: actor.token,
      body: {
        warehouseId,
        outputItemId: itemId,
        outputQty: '1',
        components: [{ itemId: componentItemId, qty: '1' }],
      },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    legacyOrderId = ((order.body.data ?? order.body) as { id: string }).id;
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied by the harness and changes nothing when re-applied', async () => {
    expect(await columnExists()).toBe(true);

    const before = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(produced_qty), 0)::text AS qty
       FROM factory_production_batches`,
    );
    await pool.query(await readSql(UP_NAME));
    const after = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(produced_qty), 0)::text AS qty
       FROM factory_production_batches`,
    );
    expect(after.rows).toEqual(before.rows);

    // العمود اختياري ومقيَّد: لا يُجبر صفاً تاريخياً على قيمة، ولا يقبل أساساً مخترعاً.
    const nullable = await pool.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'factory_production_batches' AND column_name = 'cost_basis'`,
    );
    expect((nullable.rows[0] as { is_nullable: string }).is_nullable).toBe('YES');
    await expect(
      pool.query(
        `INSERT INTO factory_production_batches (id, tenant_id, batch_no, cost_basis)
         VALUES ($1, $2, 'BAD-BASIS', 'invented')`,
        [newId(), actor.tenantId],
      ),
    ).rejects.toThrow(/cost_basis/i);
  });

  it('stores the basis a batch was really costed by, and keeps legacy rows on the old reading', async () => {
    // دفعة موادها مقيَّمة ⇒ الأساس الأمر الرسمي، وهو ما خرج من الرفّ فعلاً.
    const fromShelf = await produce({
      batchNo: 'BASIS-ORDER',
      producedQty: '10',
      components: [{ itemId: componentItemId, qty: '10' }],
      idempotencyKey: 'basis-order',
    });
    expect(fromShelf.status, JSON.stringify(fromShelf.body)).toBe(201);
    expect(await columnOf('BASIS-ORDER')).toBe('manufacturing_order');
    expect(await basisOf('BASIS-ORDER')).toMatchObject({
      costBasis: 'manufacturing_order',
      scrapCostLoaded: false,
    });

    /**
     * صفوف ما قبل العمود (NULL) تُقرأ بالاستنتاج القديم: مرتبطة بأمر ⇒ «تكلفة فعلية»، وغير
     * مرتبطة ⇒ «إدخال أو بطاقة صنف». لا يُكتب لها تخمين في التاريخ.
     */
    await pool.query(
      `INSERT INTO factory_production_batches
         (id, tenant_id, branch_id, batch_no, item_id, warehouse_id, produced_qty,
          production_order_id, cost_basis)
       VALUES ($1, $2, $3, 'LEGACY-LINKED', $4, $5, 5, $6, NULL),
              ($7, $2, $3, 'LEGACY-PLAIN', $4, $5, 5, NULL, NULL)`,
      [newId(), actor.tenantId, branchId, itemId, warehouseId, legacyOrderId, newId()],
    );
    expect(await basisOf('LEGACY-LINKED')).toMatchObject({ costBasis: 'manufacturing_order' });
    expect(await basisOf('LEGACY-PLAIN')).toMatchObject({ costBasis: 'manual_input_or_item_cost' });

    // دفعة موادها بلا قيمة تُرفض قبل أن تُصرف مادة — فلا أساس يُكتب لشيء لم يحدث.
    const unvalued = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: actor.token,
      body: {
        itemId: noCostItemId,
        warehouseId,
        batchNo: 'BASIS-UNVALUED',
        producedQty: '5',
        unitCost: '7.50',
        components: [{ itemId: unvaluedComponentId, qty: '5' }],
        idempotencyKey: 'basis-unvalued',
      },
    });
    expect(unvalued.status, JSON.stringify(unvalued.body)).toBe(422);
    expect((unvalued.body as { code?: string }).code).toBe('VAN_PRODUCTION_COST_REQUIRED');
    expect(await basisOf('BASIS-UNVALUED')).toBeUndefined();
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(produced_qty), 0)::text AS qty
       FROM factory_production_batches`,
    );
    const stockBefore = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty, COALESCE(SUM(value), 0)::text AS val
       FROM stock_balances`,
    );

    await pool.query(await readSql(DOWN_NAME));
    expect(await columnExists()).toBe(false);
    /**
     * والكود ما زال يقرأ العمود ⇒ الشاشة تفشل بصوتٍ مسموع (500) لا بقراءةٍ مستنتَجة تُعرض على
     * أنها المكتوبة. لهذا يحذّر ملف التراجع من تشغيله وحده.
     */
    const broken = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', { token: actor.token });
    expect(broken.status).toBe(500);

    await pool.query(await readSql(UP_NAME));
    expect(await columnExists()).toBe(true);
    // ما يُفقد بالتراجع هو الأساس المكتوب وحده: الصفوف تعود NULL وتُقرأ بالاستنتاج القديم.
    expect(await columnOf('BASIS-ORDER')).toBeNull();
    expect(await basisOf('BASIS-ORDER')).toMatchObject({ costBasis: 'manufacturing_order' });

    const after = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(produced_qty), 0)::text AS qty
       FROM factory_production_batches`,
    );
    const stockAfter = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty, COALESCE(SUM(value), 0)::text AS val
       FROM stock_balances`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(stockAfter.rows).toEqual(stockBefore.rows);
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
