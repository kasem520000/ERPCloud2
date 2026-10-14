import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🏭 ترحيل الإنتاج الاختياري (أ) — production is **ledger-neutral by default** and becomes a real
 * entry only when the tenant says so in «الإعدادات ← الربط المحاسبي». This suite is the proof of
 * the four rules the posting-profile keys `rawMaterialsAccountId` / `finishedGoodsAccountId` and
 * the document types `manufacturing_order` / `production_order` were added for:
 *
 *   1. **لا ربط ⇒ لا قيد** — the stock still moves (that is the inventory engine's job), and no
 *      tenant that never opened the mapping screen suddenly fails to produce.
 *   2. **الطرفان مربوطان ⇒ قيد واحد متوازن** — «م. منتج تام ← م. مواد خام» بقيمة ما استُهلك
 *      فعلاً، وهي القيمة نفسها التي دخل بها الناتج (`unitCost = المستهلك ÷ المُنتَج`): لا رقم
 *      مُخترع ولا قيمة مُعدمة.
 *   3. **طرف واحد ⇒ رفض** 422 `PRODUCTION_ACCOUNTS_INCOMPLETE` يسمّي الطرف الناقص، ويتراجع معه
 *      كل شيء: لا حركة مخزون ولا قيد بنصف خريطة.
 *   4. **قيمة مستهلَكة صفرية ⇒ لا قيد** (`zero_consumed_value`) — سطر بمبلغ صفر يرفضه دفتر
 *      القيود أصلاً، ولا معنى له عند المحاسب.
 *
 * ويُختبر المساران الرسميان معاً (أمر تصنيع بقائمة مواد، وأمر إنتاج بمكوّنات) لأن المساعد
 * `production-posting.ts` واحدٌ للاثنين — وهذا هو سبب وجوده: ألا ينحرف مسار عن الآخر.
 */
describe('Production posting — optional separation of raw materials and finished goods', () => {
  let ctx: TestApp;
  let owner: Actor;

  let branchId: string;
  let warehouseId: string;
  let rawMaterialsAccountId: string;
  let finishedGoodsAccountId: string;
  let breadId: string;
  let flourId: string;
  let cakeId: string;
  let waterId: string;
  let bomId: string;

  async function stockQty(item: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(quantity, 0)::text AS qty
        FROM stock_balances
        WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${item}::uuid
          AND warehouse_id = ${warehouseId}::uuid
      `);
      return Number((rows as { rows: Array<{ qty: string }> }).rows[0]?.qty ?? '0');
    });
  }

  /** صافي حساب (مدين − دائن) من القيود المُرحَّلة — the accountant's own reading of the ledger. */
  async function accountNet(accountId: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS net
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.tenant_id = ${owner.tenantId}::uuid
          AND l.account_id = ${accountId}::uuid
          AND e.status = 'posted'
      `);
      return Number((rows as { rows: Array<{ net: string }> }).rows[0]?.net ?? '0');
    });
  }

  /** كل ما كتبه الإنتاج في الدفتر لنوع مستند معيّن — القيود وسطورها ومفاتيحها. */
  async function productionEntries(sourceType: string) {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT e.id::text AS entry_id, e.number, e.status, e.source_id::text, e.branch_id::text,
               e.idempotency_key, e.description,
               l.account_id::text, l.debit::text, l.credit::text
        FROM journal_entries e
        JOIN journal_entry_lines l ON l.entry_id = e.id
        WHERE e.tenant_id = ${owner.tenantId}::uuid AND e.source_type = ${sourceType}
        ORDER BY e.created_at ASC, l.account_id ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
  }

  /** الربط المحاسبي من الشاشة نفسها التي يستعملها المحاسب (استبدال كامل لخريطة النوع). */
  async function mapProduction(docType: string, mapping: Record<string, string | number>) {
    const response = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: owner.token,
      body: { docType, mapping: { version: 1, ...mapping } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response;
  }

  const bothSides = () => ({
    rawMaterialsAccountId: rawMaterialsAccountId,
    finishedGoodsAccountId: finishedGoodsAccountId,
  });

  /** أمر تصنيع رسمي بقائمة مواد ثم إنتاجه — the BOM engine (`WmsBomService.produce`). */
  async function produceByBom(qty: string) {
    const order = await api(ctx.server, 'post', '/api/v1/manufacturing/orders', {
      token: owner.token,
      body: { bomId, warehouseId, qty },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = (order.body.data as { id: string }).id;
    const produced = await api(ctx.server, 'post', `/api/v1/manufacturing/orders/${orderId}/produce`, {
      token: owner.token,
      body: { qty },
    });
    return { orderId, status: produced.status, body: produced.body };
  }

  /** أمر إنتاج رسمي بمكوّنات ثم إكماله — the components engine (`ProductionOrdersService`). */
  async function completeProductionOrder(outputItemId: string, outputQty: string, componentItemId: string) {
    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: owner.token,
      body: {
        warehouseId,
        outputItemId,
        outputQty,
        components: [{ itemId: componentItemId, qty: outputQty }],
      },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = (order.body.data as { id: string }).id;
    const completed = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/complete`, {
      token: owner.token,
      body: {},
    });
    return { orderId, status: completed.status, body: completed.body };
  }

  const dataOf = (body: Record<string, unknown>) => (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('production-posting');
    owner = await createActor(ctx, {
      tenantCode: 'prod-posting',
      tenantName: 'مخابز الربط المحاسبي',
      email: 'owner@prod-posting.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'manufacturing.view',
        'manufacturing.manage',
        'manufacturing.produce',
        'inventory.view',
        'inventory.production.manage',
        'inventory.production.complete',
        'organization.postingprofile.view',
        'organization.postingprofile.manage',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.reports.view',
        'accounting.period.view',
        'accounting.period.close',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    // حسابا الفصل — created by the tenant's own accountant through the official endpoint, never
    // by the engine: mapping is a decision, and a decision needs accounts to point at.
    const account = async (code: string, nameAr: string) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', {
        token: owner.token,
        body: { code, nameAr, type: 'asset' },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return dataOf(created.body).id as string;
    };
    rawMaterialsAccountId = await account('1271001', 'مخزون المواد الخام');
    finishedGoodsAccountId = await account('1271002', 'مخزون المنتج التام');

    breadId = newId();
    flourId = newId();
    cakeId = newId();
    waterId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-PP', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      // الأسعار نصوصاً: المال في هذا المشروع `decimal.js`/نصّ، لا `number`.
      for (const [id, sku, name, cardPrice] of [
        [breadId, 'SKU-PP-BREAD', 'خبز بلدي', '2.5000'],
        [flourId, 'SKU-PP-FLOUR', 'دقيق أبيض', '5.0000'],
        [cakeId, 'SKU-PP-CAKE', 'كيك', '9.0000'],
        [waterId, 'SKU-PP-WATER', 'ماء وملح', '0'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                             purchase_price, sale_price, track_lot)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${sku}, ${name}, ${categoryId}::uuid,
                  ${baseUnitId}::uuid, 'stock', ${cardPrice}::numeric, ${cardPrice}::numeric, false)
        `);
      }
      // الدقيق مقيَّم بمتوسط 5.00، والماء في الرفّ بلا قيمة — realistic unpriced opening balance.
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES
          (${owner.tenantId}::uuid, ${flourId}::uuid, ${warehouseId}::uuid, 1000, 5000, 5.0000, 1),
          (${owner.tenantId}::uuid, ${waterId}::uuid, ${warehouseId}::uuid, 500, 0, 0, 1)
      `);
    });

    // نصف كيلو دقيق لكل كيلو خبز.
    const bom = await api(ctx.server, 'post', '/api/v1/manufacturing/boms', {
      token: owner.token,
      body: {
        productItemId: breadId,
        name: 'وصفة الخبز البلدي',
        lines: [{ componentItemId: flourId, qty: '0.5' }],
      },
    });
    expect(bom.status, JSON.stringify(bom.body)).toBe(201);
    bomId = dataOf(bom.body).id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps production ledger-neutral while the accounts are not mapped, and still moves the stock', async () => {
    const flourBefore = await stockQty(flourId);
    const breadBefore = await stockQty(breadId);

    const { orderId, status, body } = await produceByBom('100');
    expect(status, JSON.stringify(body)).toBe(201);
    expect(dataOf(body).postingBasis).toBe('ledger_neutral');
    expect(dataOf(body).journalEntryId).toBeNull();

    // المخزون تحرك فعلاً: 50 كجم دقيقاً خرجت و100 كجم خبز دخلت.
    expect(await stockQty(flourId)).toBe(flourBefore - 50);
    expect(await stockQty(breadId)).toBe(breadBefore + 100);
    // ولا قيد: المنشأة لم تفتح شاشة الربط، والإنتاج لا يتوقف لذلك.
    expect(await productionEntries('manufacturing_order')).toHaveLength(0);
    expect(await accountNet(finishedGoodsAccountId)).toBe(0);
    expect(await accountNet(rawMaterialsAccountId)).toBe(0);
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('posts one balanced entry for the value actually consumed once both accounts are mapped', async () => {
    await mapProduction('manufacturing_order', bothSides());

    const flourBefore = await stockQty(flourId);
    const { orderId, status, body } = await produceByBom('100');
    expect(status, JSON.stringify(body)).toBe(201);
    expect(dataOf(body).postingBasis).toBe('accounts_mapped');
    const entryId = dataOf(body).journalEntryId as string;
    expect(entryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await stockQty(flourId)).toBe(flourBefore - 50);

    const lines = (await productionEntries('manufacturing_order')).filter(
      (row) => row.entry_id === entryId,
    );
    expect(lines).toHaveLength(2);
    // 50 كجم × 5.00 = 250.00 — ما خرج من الرفّ، وهو ما دخل به الخبز (2.50 × 100).
    const debit = lines.find((row) => row.account_id === finishedGoodsAccountId);
    const credit = lines.find((row) => row.account_id === rawMaterialsAccountId);
    expect(Number(debit?.debit)).toBeCloseTo(250, 2);
    expect(Number(debit?.credit)).toBeCloseTo(0, 2);
    expect(Number(credit?.credit)).toBeCloseTo(250, 2);
    expect(Number(credit?.debit)).toBeCloseTo(0, 2);

    // القيد مُرحَّل، ومنسوب إلى فرع المستودع، ومصدره الأمر نفسه — لا قيد يدوي بلا أصل.
    expect(lines.every((row) => row.status === 'posted')).toBe(true);
    expect(lines.every((row) => row.branch_id === branchId)).toBe(true);
    expect(lines.every((row) => row.source_id === orderId)).toBe(true);
    expect(lines[0]!.description).toContain('إنتاج');
    expect(lines[0]!.idempotency_key).toBe(`manufacturing_order-journal:${orderId}:0.0000_100.0000`);

    expect(await accountNet(finishedGoodsAccountId)).toBeCloseTo(250, 2);
    expect(await accountNet(rawMaterialsAccountId)).toBeCloseTo(-250, 2);
  });

  it('refuses a half-mapped profile and rolls the whole run back', async () => {
    await mapProduction('manufacturing_order', { finishedGoodsAccountId: finishedGoodsAccountId });

    const flourBefore = await stockQty(flourId);
    const breadBefore = await stockQty(breadId);
    const entriesBefore = (await productionEntries('manufacturing_order')).length;

    const { status, body } = await produceByBom('40');
    expect(status, JSON.stringify(body)).toBe(422);
    expect((body as { code?: string }).code).toBe('PRODUCTION_ACCOUNTS_INCOMPLETE');
    // الرسالة تسمّي الطرف الناقص حتى يعرف المحاسب ما يُكمل.
    expect(String((body as { detail?: string }).detail ?? '')).toContain('rawMaterialsAccountId');

    // لا حركة مخزون ولا قيد بنصف خريطة: الأمر كله تراجع.
    expect(await stockQty(flourId)).toBe(flourBefore);
    expect(await stockQty(breadId)).toBe(breadBefore);
    expect(await productionEntries('manufacturing_order')).toHaveLength(entriesBefore);
    expect(await accountNet(finishedGoodsAccountId)).toBeCloseTo(250, 2);
  });

  it('posts one entry per production step, so a partial run twice is two entries and no collision', async () => {
    await mapProduction('manufacturing_order', bothSides());

    const order = await api(ctx.server, 'post', '/api/v1/manufacturing/orders', {
      token: owner.token,
      body: { bomId, warehouseId, qty: '200' },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = dataOf(order.body).id as string;

    for (const step of ['60', '40']) {
      const produced = await api(
        ctx.server,
        'post',
        `/api/v1/manufacturing/orders/${orderId}/produce`,
        { token: owner.token, body: { qty: step } },
      );
      expect(produced.status, JSON.stringify(produced.body)).toBe(201);
      expect(dataOf(produced.body).postingBasis).toBe('accounts_mapped');
      const entryId = dataOf(produced.body).journalEntryId as string;
      const lines = (await productionEntries('manufacturing_order')).filter(
        (row) => row.entry_id === entryId,
      );
      // 60 × 0.5 × 5.00 = 150 ثم 40 × 0.5 × 5.00 = 100.
      const expected = step === '60' ? 150 : 100;
      expect(Number(lines.find((row) => row.account_id === finishedGoodsAccountId)?.debit)).toBeCloseTo(
        expected,
        2,
      );
    }

    const entries = await productionEntries('manufacturing_order');
    const ofThisOrder = entries.filter((row) => row.source_id === orderId);
    expect(new Set(ofThisOrder.map((row) => row.entry_id)).size).toBe(2);
    // مفتاحا عدم التكرار مختلفان: فهرس `(tenant_id, idempotency_key)` الفريد لا يصطدم.
    expect(new Set(ofThisOrder.map((row) => row.idempotency_key)).size).toBe(2);
  });

  it('posts the same entry from the components engine, under its own document type', async () => {
    await mapProduction('production_order', bothSides());

    const flourBefore = await stockQty(flourId);
    const { orderId, status, body } = await completeProductionOrder(breadId, '20', flourId);
    expect(status, JSON.stringify(body)).toBe(201);
    expect(dataOf(body).postingBasis).toBe('accounts_mapped');
    expect(dataOf(body).journalEntryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await stockQty(flourId)).toBe(flourBefore - 20);

    const lines = (await productionEntries('production_order')).filter(
      (row) => row.source_id === orderId,
    );
    expect(lines).toHaveLength(2);
    // 20 كجم دقيقاً × 5.00 = 100.00.
    expect(Number(lines.find((row) => row.account_id === finishedGoodsAccountId)?.debit)).toBeCloseTo(100, 2);
    expect(Number(lines.find((row) => row.account_id === rawMaterialsAccountId)?.credit)).toBeCloseTo(100, 2);
    // أمر الإنتاج يُكمل مرة واحدة، فمفتاحه ثابت ولا يتكرر.
    expect(lines[0]!.idempotency_key).toBe(`production_order-journal:${orderId}:complete`);
  });

  it('posts nothing when the consumed value is zero, and says why', async () => {
    await mapProduction('production_order', bothSides());

    const cakeBefore = await stockQty(cakeId);
    const waterBefore = await stockQty(waterId);
    const entriesBefore = (await productionEntries('production_order')).length;

    const { status, body } = await completeProductionOrder(cakeId, '10', waterId);
    expect(status, JSON.stringify(body)).toBe(201);
    expect(dataOf(body).postingBasis).toBe('zero_consumed_value');
    expect(dataOf(body).journalEntryId).toBeNull();

    // المخزون تحرك (مواد بلا قيمة صُرفت وناتج بلا قيمة دخل) — لكن لا سطر بمبلغ صفر في الدفتر.
    expect(await stockQty(waterId)).toBe(waterBefore - 10);
    expect(await stockQty(cakeId)).toBe(cakeBefore + 10);
    expect(await productionEntries('production_order')).toHaveLength(entriesBefore);
  });

  it('leaves the trial balance balanced after every production entry', async () => {
    const trial = await api(ctx.server, 'get', '/api/v1/statements/trial-balance', {
      token: owner.token,
    });
    expect(trial.status, JSON.stringify(trial.body)).toBe(200);
    const totals = (trial.body as { totals?: Record<string, unknown> }).totals ?? {};
    expect(totals.balanced).toBe(true);
    expect(Number(totals.debit)).toBeCloseTo(Number(totals.credit), 2);

    // الفصل لا يخترق قيمة: ما خرج من المواد الخام هو ما دخل في المنتج التام.
    const rawMaterials = await accountNet(rawMaterialsAccountId);
    const finishedGoods = await accountNet(finishedGoodsAccountId);
    expect(finishedGoods).toBeCloseTo(-rawMaterials, 2);
    expect(finishedGoods).toBeGreaterThan(0);
  });
});
