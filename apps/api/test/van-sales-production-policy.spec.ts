import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🏭 سياسة إنتاج المخبز — the rules in force for a production batch, tested against the official
 * ledger (not against the add-on tables alone):
 *
 *   1. **مصدر المواد إلزامي** (ب): قائمة مواد (BOM) أو مكوّنات مدخلة. دفعةٌ بلا مواد تُدخل
 *      مخزوناً بلا مصدر ولا تكلفة، فترفض بـ 422 `VAN_PRODUCTION_INPUT_REQUIRED`. والبديل
 *      النظامي للوارد من خارج المنشأة إذن إدخال مخزني رسمي أو تسوية جرد معتمدة — لا هذا الباب.
 *   2. **المواد يجب أن تكون مقيَّمة**: تكلفة الإنتاج الرسمية هي ما يخرج من الرفّ فعلاً. موادٌ لا
 *      قيمة لها في الرصيد تعني ناتجاً يدخل الدفتر بصفر، ورقمٌ يُكتب في الشاشة لا يغيّر ما سجّله
 *      المستودع — فيُرفض الإنتاج **قبل أن تُصرف مادة** (`VAN_PRODUCTION_COST_REQUIRED`).
 *   3. **الترتيب المعتمد للتكلفة**: أمر تصنيع/إنتاج رسمي ← تكلفة مدخلة موجبة ← تكلفة بطاقة
 *      الصنف ← رفض. وبما أن المصدر الرسمي صار إلزامياً فالتكلفة الفعلية هي التي تُعتمد، والرقم
 *      المدخل لا يتجاوز ما خرج من الرفّ. وأساس التكلفة **يُحفظ على الدفعة** (`cost_basis`) لا
 *      يُستنتج من وجود أمر مرتبط.
 *   4. **الفاقد**: كميته وسببه ودفعته تُسجَّل معاً، ولا يدخل المخزون الصالح للبيع، ولا يُنشأ له
 *      قيد تخميني ولا مصروف افتراضي — وتكلفته **غير محمّلة على المنتج الجيد** لأن الأمر الرسمي
 *      يُنتج الكمية الصالحة وحدها (تحميل فاقد المخبز قرار سياسة لم يُتخذ، فقولُه على الشاشة
 *      ادّعاء).
 *
 * وكل فحص رفضٍ هنا يثبت معه أن **شيئاً لم يتحرك**: لا رصيد الصنف المنتج ولا رصيد المكوّن ولا
 * صفّ دفعة. التفويض إلى الأمر الرسمي يُثبَّت في معاملة مستقلة، فأي رفض بعده كان سيترك المواد
 * مصروفة رسمياً ودفعةً غير موجودة — ولهذا تُحسم الفحوص كلها قبل التفويض.
 */
describe('Van Sales — production cost & scrap policy', () => {
  let ctx: TestApp;
  let owner: Actor;
  let accountant: Actor;

  let branchId: string;
  let mainWarehouseId: string;
  let itemId: string;
  let noCostItemId: string;
  /** 🌾 مكوّن مقيَّم بمتوسط 4.00 — مصدر المواد القانوني للدفعة. */
  let componentItemId: string;
  /** 💧 مكوّن بلا قيمة في الرصيد — لإثبات أن الإنتاج لا يُقيَّم من العدم. */
  let freeComponentItemId: string;
  let baseUnitId: string;
  let categoryId: string;

  async function officialQty(warehouseId: string, item: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(quantity, 0)::text AS qty, COALESCE(value, 0)::text AS val
        FROM stock_balances
        WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${item}::uuid
          AND warehouse_id = ${warehouseId}::uuid
      `);
      return Number((rows as { rows: Array<{ qty: string }> }).rows[0]?.qty ?? '0');
    });
  }

  async function batchCount(item: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM factory_production_batches
        WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${item}::uuid
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
  }

  /** الحركات الرسمية لصنف: كم مرة دخل/خرج من الدفتر فعلاً، وبأي مستند. */
  async function officialMovements(item: string, direction: 'in' | 'out') {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT doc_type, qty::text
        FROM inventory_transactions
        WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${item}::uuid
          AND direction = ${direction}
        ORDER BY occurred_at ASC
      `);
      return (rows as { rows: Array<{ doc_type: string; qty: string }> }).rows;
    });
  }

  async function scrapMovements(batchNo: string) {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT movement_type, qty::text, unit_price::text, amount::text, reason
        FROM van_stock_movements
        WHERE tenant_id = ${owner.tenantId}::uuid AND batch_no = ${batchNo}
        ORDER BY created_at ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
  }

  const produce = (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: { itemId, warehouseId: mainWarehouseId, ...body },
    });

  /**
   * الدفعة الافتراضية: 40 كجم من مكوّن مقيَّم 1:1 بمتوسط 4.00 ⇒ تكلفة الوحدة 4.00 من أمر
   * الإنتاج الرسمي. من يتجاوز `producedQty` تتجاوز معه الكمية المستهلكة تلقائياً.
   */
  const batchOf = (body: Record<string, unknown>, key: string) => {
    const producedQty = String(body.producedQty ?? '40');
    return {
      producedQty,
      unitCost: '4.00',
      components: [{ itemId: componentItemId, qty: producedQty }],
      idempotencyKey: key,
      ...body,
    };
  };

  beforeAll(async () => {
    ctx = await createTestApp('van-production-policy');
    owner = await createActor(ctx, {
      tenantCode: 'prod-policy',
      tenantName: 'مخابز سياسة التكلفة',
      email: 'owner@prod-policy.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'accounting.period.close',
        'accounting.period.view',
        'accounting.reports.view',
        'accounting.account.view',
        'inventory.view',
        'inventory.adjust',
        'sales.view',
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });
    accountant = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'prod-policy',
      email: 'accountant@prod-policy.test',
      permissions: ['van_sales.view', 'van_sales.production.manage'],
      roleNames: ['Accountant'],
      isOwner: false,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;
    mainWarehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    itemId = newId();
    noCostItemId = newId();
    componentItemId = newId();
    freeComponentItemId = newId();
    baseUnitId = newId();
    categoryId = newId();
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-P', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      // صنف بتكلفة في بطاقته (4.00) — المسار الثالث في ترتيب التكلفة.
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${itemId}::uuid, ${owner.tenantId}::uuid, 'SKU-P1', 'سمبوسة', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 4.0000, 6.5000, false)
      `);
      // صنف بلا تكلفة في بطاقته — لا مصدر للتكلفة إلا الإدخال أو أمر التصنيع.
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${noCostItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-P2', 'كيك بلا تكلفة', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 0, 9.0000, false)
      `);
      // 🌾 الدقيق: مقيَّم بمتوسط 4.00 ورصيد يكفي كل الحالات (المتوسط لا يتغير بالصرف).
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${componentItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-P-FLOUR', 'دقيق أبيض', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 4.0000, 4.0000, false)
      `);
      // 💧 الماء: موجود في الرفّ لكن بلا قيمة — realistic case of an unpriced opening balance.
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${freeComponentItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-P-WATER', 'ماء وملح', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 0, 0, false)
      `);
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES
          (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 100000, 400000, 4.0000, 1),
          (${owner.tenantId}::uuid, ${freeComponentItemId}::uuid, ${mainWarehouseId}::uuid, 10000, 0, 0, 1)
      `);
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses scrap without a reason and posts nothing', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const beforeMaterials = await officialQty(mainWarehouseId, componentItemId);
    const response = await produce(batchOf({ scrapQty: '3' }, 'scrap-no-reason'));
    expect(response.status).toBe(422);
    expect((response.body as { code?: string }).code).toBe('VAN_PRODUCTION_SCRAP_REASON_REQUIRED');
    expect(await officialQty(mainWarehouseId, itemId)).toBe(before);
    // الرفض قبل التفويض ⇒ لم تُصرف مادة.
    expect(await officialQty(mainWarehouseId, componentItemId)).toBe(beforeMaterials);
    expect(await batchCount(itemId)).toBe(0);
  });

  it('refuses a cost that is zero, negative or not a number, before consuming any material', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const beforeMaterials = await officialQty(mainWarehouseId, componentItemId);
    for (const [index, unitCost] of ['0', '-4', 'abc'].entries()) {
      const response = await produce(batchOf({ unitCost }, `bad-cost-${index}`));
      expect(response.status, `unitCost=${unitCost}`).toBe(422);
    }
    expect(await officialQty(mainWarehouseId, itemId)).toBe(before);
    /**
     * أمر الإنتاج الرسمي يُثبَّت في معاملة مستقلة، فلو فُحصت التكلفة بعده لخرجت المواد من
     * الرفّ رسمياً ثم قيل للمستخدم «مرفوض» — وأقرب إعادة إرسال تستهلكها مرة ثانية.
     */
    expect(await officialQty(mainWarehouseId, componentItemId)).toBe(beforeMaterials);
    expect(await batchCount(itemId)).toBe(0);
  });

  it('refuses a production batch that has no source of materials', async () => {
    const before = await officialQty(mainWarehouseId, itemId);

    // لا BOM ولا مكوّنات: «مخزون من العدم» — مرفوض.
    const nothing = await produce({ producedQty: '40', unitCost: '4.00', idempotencyKey: 'no-source' });
    expect(nothing.status, JSON.stringify(nothing.body)).toBe(422);
    expect((nothing.body as { code?: string }).code).toBe('VAN_PRODUCTION_INPUT_REQUIRED');
    const message = String((nothing.body as { detail?: string }).detail ?? '');
    expect(message).toContain('BOM');
    // البديل النظامي مذكور في الرسالة: الوارد من الخارج مستند مخزني رسمي لا دفعة إنتاج.
    expect(message).toContain('إذن إدخال مخزني');

    // سطر مكوّن بلا صنف كأنه ليس موجوداً: لا يُقبل مصدراً للمواد.
    const emptyLine = await produce({
      producedQty: '40',
      unitCost: '4.00',
      components: [{ itemId: '', qty: '40' }],
      idempotencyKey: 'empty-component-line',
    });
    expect(emptyLine.status, JSON.stringify(emptyLine.body)).toBe(422);
    expect((emptyLine.body as { code?: string }).code).toBe('VAN_PRODUCTION_INPUT_REQUIRED');

    expect(await officialQty(mainWarehouseId, itemId)).toBe(before);
    expect(await batchCount(itemId)).toBe(0);
    expect(await officialMovements(itemId, 'in')).toHaveLength(0);
  });

  it('refuses production whose materials carry no value, before anything leaves the shelf', async () => {
    const beforeOutput = await officialQty(mainWarehouseId, noCostItemId);
    const beforeMaterials = await officialQty(mainWarehouseId, freeComponentItemId);
    const response = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId: noCostItemId,
        warehouseId: mainWarehouseId,
        producedQty: '25',
        components: [{ itemId: freeComponentItemId, qty: '25' }],
        idempotencyKey: 'no-cost-source',
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect((response.body as { code?: string }).code).toBe('VAN_PRODUCTION_COST_REQUIRED');
    // لا صفر صامت: لا دفعة ولا رصيد ولا حركة — ولا مادة صُرفت.
    expect(await officialQty(mainWarehouseId, noCostItemId)).toBe(beforeOutput);
    expect(await officialQty(mainWarehouseId, freeComponentItemId)).toBe(beforeMaterials);
    expect(await batchCount(noCostItemId)).toBe(0);

    /**
     * …ورقمٌ مكتوب في الشاشة لا يُصلح الحالة: الناتج سيدخل الدفتر الرسمي بقيمة صفر لأن
     * التكلفة الرسمية هي ما خرج من الرفّ، فتصير للكمية الواحدة تقييمان.
     */
    const typed = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId: noCostItemId,
        warehouseId: mainWarehouseId,
        producedQty: '25',
        unitCost: '7.50',
        components: [{ itemId: freeComponentItemId, qty: '25' }],
        idempotencyKey: 'no-cost-source-typed',
      },
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(422);
    expect((typed.body as { code?: string }).code).toBe('VAN_PRODUCTION_COST_REQUIRED');
    expect(await officialQty(mainWarehouseId, noCostItemId)).toBe(beforeOutput);
    expect(await officialQty(mainWarehouseId, freeComponentItemId)).toBe(beforeMaterials);
    expect(await batchCount(noCostItemId)).toBe(0);
  });

  it('values the batch from what actually left the shelf, and says so', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const beforeMaterials = await officialQty(mainWarehouseId, componentItemId);
    const response = await produce(
      batchOf(
        { producedQty: '30', unitCost: undefined, scrapQty: '2', scrapReason: 'قطع محترقة' },
        'shelf-cost',
      ),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const batch = (response.body.data.productionBatches as Array<Record<string, unknown>>)[0];
    // 30 كجم دقيقاً بمتوسط 4.00 ⇒ تكلفة الوحدة 4.00 من أمر الإنتاج الرسمي.
    expect(Number(batch.unitCost)).toBeCloseTo(4, 2);
    expect(batch.costBasis).toBe('manufacturing_order');
    expect(batch.productionOrderId).toBeTruthy();
    // الفاقد محسوب القيمة، وغير محمول على المنتج الجيد (الأمر يُنتج الكمية الصالحة وحدها).
    expect(Number(batch.scrapValue)).toBeCloseTo(8, 2); // 2 × 4.00
    expect(batch.scrapCostLoaded).toBe(false);
    expect(await officialQty(mainWarehouseId, itemId)).toBe(before + 30);
    expect(await officialQty(mainWarehouseId, componentItemId)).toBe(beforeMaterials - 30);
  });

  it('does not let a typed number override what the official order actually cost', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const response = await produce(
      batchOf({ producedQty: '15', unitCost: '9.99' }, 'typed-ignored'),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const batch = (response.body.data.productionBatches as Array<Record<string, unknown>>)[0];
    expect(Number(batch.unitCost)).toBeCloseTo(4, 2); // من الرفّ، لا 9.99 المكتوبة
    expect(batch.costBasis).toBe('manufacturing_order');
    expect(await officialQty(mainWarehouseId, itemId)).toBe(before + 15);
  });

  it('keeps scrap out of the saleable stock and records its quantity, reason and batch', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const response = await produce(
      batchOf({ producedQty: '20', unitCost: '5.00', scrapQty: '4', scrapReason: 'عجين لم يختمر' }, 'scrap-recorded'),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const batch = (response.body.data.productionBatches as Array<Record<string, string>>)[0];

    // المخزون الصالح = المُنتَج فقط: الفاقد لم يدخل الرصيد الرسمي.
    expect(await officialQty(mainWarehouseId, itemId)).toBe(before + 20);

    const movements = await scrapMovements(batch.batchNo);
    const scrap = movements.find((row) => row.reason.includes('عجين لم يختمر'));
    expect(scrap).toBeDefined();
    expect(Number(scrap!.qty)).toBeCloseTo(4, 4);
    // قيمته بالتكلفة الفعلية (4.00 لا 5.00 المكتوبة)، ومفصولة عن المنتج الجيد.
    expect(Number(scrap!.amount)).toBeCloseTo(16, 4); // 4 × 4.00
    expect(scrap!.reason).toContain(batch.batchNo);
    expect(scrap!.reason).toContain('غير محمّلة على تكلفة المنتج الجيد');
    // ولا ادّعاء بأن الأمر الرسمي حمّلها.
    expect(scrap!.reason).not.toContain('محمّلة على المنتج الجيد بأمر التصنيع');

    const journals = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM journal_entries
        WHERE tenant_id = ${owner.tenantId}::uuid AND description LIKE '%فاقد%'
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
    expect(journals).toBe(0);
  });

  it('replays a production submission without doubling stock, scrap or materials', async () => {
    const before = await officialQty(mainWarehouseId, itemId);
    const beforeMaterials = await officialQty(mainWarehouseId, componentItemId);
    const payload = batchOf(
      { producedQty: '10', unitCost: '4.00', scrapQty: '1', scrapReason: 'فاقد عادي' },
      'replay-key',
    );
    const first = await produce(payload);
    expect(first.status).toBe(201);
    const afterFirst = await officialQty(mainWarehouseId, itemId);
    expect(afterFirst).toBe(before + 10);
    const materialsAfterFirst = await officialQty(mainWarehouseId, componentItemId);
    expect(materialsAfterFirst).toBe(beforeMaterials - 10);

    const second = await produce(payload);
    expect(second.status).toBe(201);
    expect(await officialQty(mainWarehouseId, itemId)).toBe(afterFirst);
    // الإعادة لا تستهلك المواد مرتين.
    expect(await officialQty(mainWarehouseId, componentItemId)).toBe(materialsAfterFirst);

    const produced = await officialMovements(itemId, 'in');
    expect(produced.filter((row) => row.doc_type === 'production_order' && Number(row.qty) === 10)).toHaveLength(1);
    // الدفعة الإضافية لا تسجّل حركة ثانية لنفس الكمية.
    expect(produced.filter((row) => row.doc_type === 'factory_production_batch')).toHaveLength(0);
  });

  it('keeps the branch resolvable and refuses a non-stock item', async () => {
    expect(branchId).toMatch(/^[0-9a-f-]{36}$/i);
    const response = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId: newId(),
        warehouseId: mainWarehouseId,
        producedQty: '5',
        unitCost: '4',
        components: [{ itemId: componentItemId, qty: '5' }],
        idempotencyKey: 'unknown-item',
      },
    });
    expect(response.status).toBe(422);
  });
});
