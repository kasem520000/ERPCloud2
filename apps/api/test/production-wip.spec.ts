import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🏭 M6.2 — مرحلة «تحت التشغيل» (WIP) لأمر الإنتاج: الصرف والإكمال خطوتان.
 *
 * حتى 0129 كان الصرف والإكمال يقعان في معاملة واحدة، فلم توجد لحظةٌ تكون فيها قيمة
 * المكوّنات خارج الرفّ ولم تدخل منتجاً تاماً — ولهذا كان `wipAccountId` غائبًا عن قاموس
 * الربط «عن قصد». هذه الحزمة هي إثبات أن الفصل الزمني صار موجودًا وسليمًا:
 *
 *   1. **الصرف محايد افتراضيًا** — `issue` يحرّك المخوّن (خروج المكوّنات بالمتوسط
 *      المتحرك، status = in_progress) ولا يقيد شيئًا ما لم تربط المنشأة حساباتها؛
 *   2. **الإكمال يستلم الناتج بتكلفة ما صُرف** — لا استهلاك مزدوج: القيمة مجتمعة على
 *      الأمر نفسه، و`unitCost = componentCost ÷ outputQty` كما كان؛
 *   3. **الربط الكامل يمرّ عبر تحت التشغيل ويصفّيه** — الصرف «تحت التشغيل ← مواد خام»،
 *      والإكمال «منتج تام ← تحت التشغيل»، وصافي تحت التشغيل يعود صفرًا؛
 *   4. **نصف خريطة مرفوض** — طرف واحد ⇒ 422 `PRODUCTION_ACCOUNTS_INCOMPLETE` يسمّي
 *      الناقص، ويعود كل شيء: لا حركة ولا قيد؛
 *   5. **تغيير الربط بين الخطوتين مرفوض لا مُدار** — صرفٌ مرَّ تحت التشغيل ثم فُكّ
 *      الحساب قبل الإكمال ⇒ 422 `PRODUCTION_WIP_MAPPING_CHANGED`: لا تُخصم المواد مرتين؛
 *   6. **مسار الـdraft الموروث كما هو** — إكمال مباشر بلا صرف = قيد واحد
 *      «منتج تام ← مواد خام» (لا انكسار لمنشأة قائمة)؛
 *   7. **الإلغاء للمسودة فقط** — الأمر المصروف حرّك مكوّناته إلى الأرضية ويجب أن يُستكمل؛
 *   8. **الصرف قرينة مالية** — له صلاحية الإكمال (inventory.production.complete)، لا
 *      صلاحية كتابة الوصفات.
 */
describe('Production WIP — issuing components and completing are two steps', () => {
  let ctx: TestApp;
  let owner: Actor;
  let viewer: Actor;

  let warehouseId: string;
  let rawMaterialsAccountId: string;
  let finishedGoodsAccountId: string;
  let wipAccountId: string;
  let breadId: string;
  let flourId: string;

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

  /** صافي حساب (مدين − دائن) من القيود المُرحَّلة — قراءة المحاسب نفسها للدفتر. */
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

  async function productionEntries() {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT e.id::text AS entry_id, e.idempotency_key, l.account_id::text, l.debit::text, l.credit::text
        FROM journal_entries e
        JOIN journal_entry_lines l ON l.entry_id = e.id
        WHERE e.tenant_id = ${owner.tenantId}::uuid AND e.source_type = 'production_order'
        ORDER BY e.created_at ASC, l.account_id ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
  }

  /** الربط المحاسبي من الشاشة نفسها (استبدال كامل لخريطة النوع). */
  async function mapProduction(mapping: Record<string, string | number>) {
    const response = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: owner.token,
      body: { docType: 'production_order', mapping: { version: 1, ...mapping } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  /** أمر إنتاج رسمي: 100 خبز من 50 دقيقًا. */
  async function createOrder(): Promise<string> {
    const order = await api(ctx.server, 'post', '/api/v1/inventory/production-orders', {
      token: owner.token,
      body: {
        warehouseId,
        outputItemId: breadId,
        outputQty: '100',
        components: [{ itemId: flourId, qty: '50' }],
      },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    return (order.body.data as { id: string }).id;
  }

  async function issue(orderId: string) {
    return api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/issue`, {
      token: owner.token,
      body: {},
    });
  }

  async function complete(orderId: string) {
    return api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/complete`, {
      token: owner.token,
      body: {},
    });
  }

  async function cancel(orderId: string) {
    return api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/cancel`, {
      token: owner.token,
      body: {},
    });
  }

  const dataOf = (body: Record<string, unknown>) => (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('production-wip');
    owner = await createActor(ctx, {
      tenantCode: 'prod-wip',
      tenantName: 'مخابز تحت التشغيل',
      email: 'owner@prod-wip.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
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
    viewer = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'prod-wip',
      email: 'viewer@prod-wip.test',
      permissions: ['inventory.view'],
      isOwner: false,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    // الحسابات الثلاثة — ينشئها محاسب المنشأة عبر نقطة النهاية الرسمية، لا المحرّك.
    const account = async (code: string, nameAr: string) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', {
        token: owner.token,
        body: { code, nameAr, type: 'asset' },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return dataOf(created.body).id as string;
    };
    rawMaterialsAccountId = await account('1272001', 'مخزون المواد الخام — WIP');
    finishedGoodsAccountId = await account('1272002', 'مخزون المنتج التام — WIP');
    wipAccountId = await account('1272003', 'إنتاج تحت التشغيل — WIP');

    breadId = newId();
    flourId = newId();
    const baseUnitId = newId();
    const categoryId = newId();
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-WIP', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      for (const [id, sku, name, priceText] of [
        [breadId, 'SKU-WIP-BREAD', 'خبز بلدي', '2.5000'],
        [flourId, 'SKU-WIP-FLOUR', 'دقيق أبيض', '5.0000'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                             purchase_price, sale_price, track_lot)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${sku}, ${name}, ${categoryId}::uuid,
                  ${baseUnitId}::uuid, 'stock', ${priceText}::numeric, ${priceText}::numeric, false)
        `);
      }
      // الدقيق مقيَّم بمتوسط 5.00 — 50 كجمًا تخرج بقيمة 250.
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${flourId}::uuid, ${warehouseId}::uuid, 1000, 5000, 5.0000, 1)
      `);
    });
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('issues to the floor stock-only and neutral while nothing is mapped', async () => {
    const orderId = await createOrder();
    const flourBefore = await stockQty(flourId);
    const breadBefore = await stockQty(breadId);

    const issued = await issue(orderId);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const issuedData = dataOf(issued.body);
    expect(issuedData.status).toBe('in_progress');
    expect(issuedData.wipPosted).toBe(false);
    expect(issuedData.postingBasis).toBe('ledger_neutral');
    expect(issuedData.journalEntryId).toBeNull();
    // 50 كجم دقيق خرجت بقيمة 250 — والخبز لم يُستلم بعد.
    expect(issuedData.componentCost).toBe('250.0000');
    expect(issuedData.unitCost).toBe('0.0000');
    expect(issuedData.issuedAt).toBeTruthy();
    expect(await stockQty(flourId)).toBe(flourBefore - 50);
    expect(await stockQty(breadId)).toBe(breadBefore);
    expect(await productionEntries()).toHaveLength(0);

    // الصرف مرة واحدة — والتكرار رفض صريح.
    const again = await issue(orderId);
    expect(again.status).toBe(409);
  });

  it('completes an issued order at exactly the issued cost, consuming nothing twice', async () => {
    const orderId = await createOrder();
    const issued = await issue(orderId);
    expect(issued.status).toBe(201);
    const flourAtIssue = await stockQty(flourId);
    const breadBefore = await stockQty(breadId);

    const completed = await complete(orderId);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    const done = dataOf(completed.body);
    expect(done.status).toBe('completed');
    // لا استهلاك ثانٍ: الدقيق كما كان لحظة الصرف، والخبز دخل بتكلفة ما صُرف (250 ÷ 100).
    expect(await stockQty(flourId)).toBe(flourAtIssue);
    expect(await stockQty(breadId)).toBe(breadBefore + 100);
    expect(done.componentCost).toBe('250.0000');
    expect(done.unitCost).toBe('2.5000');
    expect(done.postingBasis).toBe('ledger_neutral');

    // الإكمال مرة واحدة، والصرف بعد الإكمال مرفوض.
    expect((await complete(orderId)).status).toBe(409);
    expect((await issue(orderId)).status).toBe(409);
  });

  it('passes the value through the WIP account and clears it', async () => {
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId, wipAccountId });
    const orderId = await createOrder();

    const issued = await issue(orderId);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const issuedData = dataOf(issued.body);
    expect(issuedData.postingBasis).toBe('accounts_mapped');
    expect(issuedData.journalEntryId).toBeTruthy();
    expect(issuedData.wipPosted).toBe(true);
    // الصرف: «تحت التشغيل ← مواد خام» بقيمة ما خرج.
    expect(await accountNet(wipAccountId)).toBe(250);
    expect(await accountNet(rawMaterialsAccountId)).toBe(-250);

    const completed = await complete(orderId);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    expect(dataOf(completed.body).postingBasis).toBe('accounts_mapped');
    // الإكمال: «منتج تام ← تحت التشغيل» — والحساب يُصفّى إلى صفر.
    expect(await accountNet(wipAccountId)).toBe(0);
    expect(await accountNet(finishedGoodsAccountId)).toBe(250);
    expect(await accountNet(rawMaterialsAccountId)).toBe(-250);

    // قيدان مختلفان بمفتاحَي خطوة مختلفين — فهرس (tenant, idempotency_key) لا يصطدم.
    const entries = await productionEntries();
    expect(entries).toHaveLength(4); // قيدان × سطران.
    const keys = new Set(entries.map((row) => row.idempotency_key));
    expect(keys.size).toBe(2);
    expect(keys.has(`production_order-journal:${orderId}:issue`)).toBe(true);
    expect(keys.has(`production_order-journal:${orderId}:complete`)).toBe(true);
  });

  it('refuses half a map at issue and rolls the stock back', async () => {
    await mapProduction({ wipAccountId });
    const orderId = await createOrder();
    const flourBefore = await stockQty(flourId);

    const refused = await issue(orderId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect((refused.body as { code?: string }).code).toBe('PRODUCTION_ACCOUNTS_INCOMPLETE');
    expect(((refused.body as { errors?: Array<{ field?: string }> }).errors ?? [])[0]?.field).toBe('rawMaterialsAccountId');
    // لا حركة ولا قيد — المعاملة كلها عادت.
    expect(await stockQty(flourId)).toBe(flourBefore);
    const order = await api(ctx.server, 'get', `/api/v1/inventory/production-orders/${orderId}`, { token: owner.token });
    expect(dataOf(order.body).status).toBe('draft');
  });

  it('refuses to complete through a map that no longer opens the WIP account', async () => {
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId, wipAccountId });
    const orderId = await createOrder();
    expect((await issue(orderId)).status).toBe(201);
    const wipAfterIssue = await accountNet(wipAccountId);
    expect(wipAfterIssue).toBe(250);

    // فُكّ حساب تحت التشغيل بين الخطوتين — الإكمال «منتج تام ← مواد خام» كان سيخصم
    // المواد مرتين، فالرفض هو السلوك الوحيد السليم.
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId });
    const refused = await complete(orderId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect((refused.body as { code?: string }).code).toBe('PRODUCTION_WIP_MAPPING_CHANGED');
    // القيمة ما تزال جالسة في تحت التشغيل كما صُرفت.
    expect(await accountNet(wipAccountId)).toBe(250);

    // إعادة فتح الحساب تكمل المسار: «منتج تام ← تحت التشغيل» ويُصفّى.
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId, wipAccountId });
    const completed = await complete(orderId);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    expect(await accountNet(wipAccountId)).toBe(0);
  });

  it('keeps the legacy draft path exactly as it was', async () => {
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId });
    const fgBefore = await accountNet(finishedGoodsAccountId);
    const rmBefore = await accountNet(rawMaterialsAccountId);
    const wipBefore = await accountNet(wipAccountId);

    const orderId = await createOrder();
    const completed = await complete(orderId);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    const done = dataOf(completed.body);
    expect(done.status).toBe('completed');
    expect(done.postingBasis).toBe('accounts_mapped');
    // قيد واحد «منتج تام ← مواد خام» — لا تحت تشغيل في المسار المباشر.
    expect(await accountNet(finishedGoodsAccountId)).toBe(fgBefore + 250);
    expect(await accountNet(rawMaterialsAccountId)).toBe(rmBefore - 250);
    expect(await accountNet(wipAccountId)).toBe(wipBefore);
    const keys = (await productionEntries()).map((row) => row.idempotency_key);
    expect(keys).toContain(`production_order-journal:${orderId}:complete`);
    expect(keys).not.toContain(`production_order-journal:${orderId}:issue`);
  });

  it('lets a legacy mapping (materials + finished goods, no WIP) use the two-stage flow', async () => {
    // الربط كما كان قبل WIP — والمنشأة تريد الصرف والإكمال خطوتين مع ذلك.
    await mapProduction({ rawMaterialsAccountId, finishedGoodsAccountId });
    const fgBefore = await accountNet(finishedGoodsAccountId);
    const rmBefore = await accountNet(rawMaterialsAccountId);
    const wipBefore = await accountNet(wipAccountId);

    const orderId = await createOrder();
    const issued = await issue(orderId);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const issuedData = dataOf(issued.body);
    // الصرف محايد: لا حساب تحت تشغيل مفتوح — والإكمال سيغطّي القيمة كاملة.
    expect(issuedData.postingBasis).toBe('ledger_neutral');
    expect(issuedData.wipPosted).toBe(false);
    expect(await accountNet(wipAccountId)).toBe(wipBefore);

    const completed = await complete(orderId);
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    // قيد واحد كامل «منتج تام ← مواد خام» عند الإكمال — الأثر نفسه للمسار المباشر.
    expect(await accountNet(finishedGoodsAccountId)).toBe(fgBefore + 250);
    expect(await accountNet(rawMaterialsAccountId)).toBe(rmBefore - 250);
    expect(await accountNet(wipAccountId)).toBe(wipBefore);
    const keys = (await productionEntries()).map((row) => row.idempotency_key);
    expect(keys).not.toContain(`production_order-journal:${orderId}:issue`);
    expect(keys).toContain(`production_order-journal:${orderId}:complete`);
  });

  it('cancels a draft but never an issued order', async () => {
    const draftId = await createOrder();
    expect((await cancel(draftId)).status).toBe(201);

    const issuedId = await createOrder();
    expect((await issue(issuedId)).status).toBe(201);
    const refused = await cancel(issuedId);
    expect(refused.status).toBe(409);
    expect((refused.body as { code?: string }).code).toBe('PRODUCTION_ORDER_INVALID_STATUS');
  });

  it('treats issuing as the complete permission, not the recipe-writing one', async () => {
    const orderId = await createOrder();
    const refused = await api(ctx.server, 'post', `/api/v1/inventory/production-orders/${orderId}/issue`, {
      token: viewer.token,
      body: {},
    });
    expect(refused.status).toBe(403);
    // والمسودة ما تزال مسودة — لم يمسّ المخزون شيء.
    const order = await api(ctx.server, 'get', `/api/v1/inventory/production-orders/${orderId}`, { token: owner.token });
    expect(dataOf(order.body).status).toBe('draft');
  });
});
