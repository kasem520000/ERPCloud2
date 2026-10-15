import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔄 مزامنة الميدان (M4) — العقد الكامل لواجهات `field-sync` عبر HTTP الحقيقي.
 *
 * يُختبر على قاعدة معزولة، بالمسار نفسه الذي سيسلكه تطبيق المندوب:
 *   1. اللقطة مقصورة على مندوب واحد: عهدة مستودع سيارته وحده، وأوامره المفتوحة وحدها؛
 *   2. الدلتا صادقة مع العلامة المائية: متغيّر بعدَها يظهر، والمحذوف يُبلَّغ، والحيّ
 *      (الأرصدة والأوامر) يُقرأ كاملاً؛
 *   3. إعادة التشغيل تمرّ بالمحركات الرسمية: فاتورة + مرتجع + تحصيل في دفعة واحدة،
 *      والقيد وسند القبض وحركة المخزون كلها من المحركات لا من الوحدة؛
 *   4. إعادة الإرسال غير مُضاعِفة: نفس الدفعة مرتين تعطي نفس المستندات؛
 *   5. مصفوفة الرفض السلبية (D-004): ليس مندوباً، بلا نطاق مستودع، عهدة مندوب آخر،
 *      جهاز مندوب آخر، صلاحية ناقصة، تسلسل قديم/مكرر/متناقض، مصدر لم يُرحَّل؛
 *   6. نفاد العهدة تعارضُ صفٍّ لا فشلُ دفعة، والتسلسل على نفس العهدة يُرتِّب المتزامنَ.
 */
const DEVICE_REP = 'rep1-field-device';
const DEVICE_OTHER = 'rep2-field-device';

describe('field-sync — rep offline sync contract', () => {
  let ctx: TestApp;
  let pool: Pool;

  let owner: Actor;
  let accountant: Actor;
  /** المندوب صاحب العهدة — كل المسارات السعيدة له. */
  let rep: Actor;
  /** مندوب آخر ببطاقة ونطاق — لاختبارات الملكية والجهاز والصلاحية. */
  let otherRep: Actor;
  /** مندوب بلا أي صفوف نطاق (AUD-03) — التصفية في الواجهة ليست ضبط وصول. */
  let noScopeRep: Actor;
  /** مستخدم خلفي بلا بطاقة مندوب — واجهات الميدان ليست له. */
  let clerk: Actor;

  let branchId = '';
  let mainWarehouseId = '';
  let cashLocationId = '';
  let van1WarehouseId = '';
  let van2WarehouseId = '';
  let van3WarehouseId = '';
  let itemId = '';
  let componentItemId = '';
  let partyId = '';
  let doomedPartyId = '';
  let deltaPartyId = '';
  let salesmanId = '';
  let otherSalesmanId = '';
  let paymentMethodId = '';

  let loadOrderAId = '';
  let loadOrderBId = '';

  const seqCounter = { value: 1000 };
  const nextSeq = () => ++seqCounter.value;

  const replay = (actor: Actor, operations: Array<Record<string, unknown>>, deviceId?: string) =>
    api(ctx.server, 'post', '/api/v1/field-sync/replay', {
      token: actor.token,
      body: { deviceId, operations },
    });

  const invoicePayload = (loadOrderId: string, overrides: Record<string, unknown> = {}) => ({
    loadOrderId,
    partyId,
    itemId,
    invoiceMode: 'zatca_tax',
    paymentMethod: 'credit',
    soldQty: '10',
    unitPrice: '6.50',
    ...overrides,
  });

  /** إنتاج ← توريد ← (تأكيد اختياري) — دورة جاهزة كما في أجنحة التسوية. */
  async function newCustody(key: string, supplied: string, confirm: boolean, actorSalesmanId = salesmanId) {
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '500',
        components: [{ itemId: componentItemId, qty: '500' }],
        unitCost: '4.00',
        idempotencyKey: `${key}-prod`,
      },
    });
    expect(production.status, JSON.stringify(production.body)).toBe(201);
    const batchNo = production.body.data.productionBatches[0].batchNo as string;

    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId: actorSalesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: van1WarehouseId,
        itemId,
        loadedQty: supplied,
        productionBatchNo: batchNo,
        idempotencyKey: `${key}-load`,
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    const order = supply.body.data.loadOrders.find(
      (row: { productionBatchNo: string }) => row.productionBatchNo === batchNo,
    ) as Record<string, string>;

    if (confirm) {
      const confirmRes = await api(
        ctx.server,
        'post',
        `/api/v1/van-sales/load-orders/${order.id}/confirm-receipt`,
        { token: rep.token, body: { receivedQty: supplied, notes: 'استلام' } },
      );
      expect(confirmRes.status, JSON.stringify(confirmRes.body)).toBe(201);
    }
    return order.id as string;
  }

  const van1Qty = async (): Promise<string> => {
    const result = await pool.query(
      `SELECT COALESCE(quantity, 0)::text AS qty FROM stock_balances
       WHERE tenant_id = $1 AND item_id = $2 AND warehouse_id = $3`,
      [rep.tenantId, itemId, van1WarehouseId],
    );
    return (result.rows[0] as { qty: string } | undefined)?.qty ?? '0';
  };

  const documentsByEngineKey = async (key: string): Promise<number> => {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM van_sales_documents WHERE tenant_id = $1 AND idempotency_key = $2`,
      [rep.tenantId, key],
    );
    return (result.rows[0] as { cnt: number }).cnt;
  };

  beforeAll(async () => {
    ctx = await createTestApp('field-sync');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    owner = await createActor(ctx, {
      tenantCode: 'field-sync',
      tenantName: 'مخابز مزامنة الميدان',
      email: 'owner@field-sync.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'accounting.period.close',
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
        'van_sales.pricing.manage',
        'van_sales.invoice.create',
        'van_sales.collection.create',
        'van_sales.closing.approve',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });
    accountant = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync',
      email: 'accountant@field-sync.test',
      permissions: [
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
        'van_sales.pricing.manage',
      ],
      roleNames: ['Accountant'],
      isOwner: false,
    });
    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync',
      email: 'rep1@field-sync.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.collection.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['Rep1'],
      isOwner: false,
    });
    otherRep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync',
      email: 'rep2@field-sync.test',
      permissions: ['van_sales.view', 'van_sales.invoice.create'],
      roleNames: ['Rep2'],
      isOwner: false,
    });
    noScopeRep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync',
      email: 'noscope@field-sync.test',
      permissions: ['van_sales.view', 'van_sales.invoice.create'],
      roleNames: ['RepNoScope'],
      isOwner: false,
      unconfiguredScopes: true,
    });
    clerk = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync',
      email: 'clerk@field-sync.test',
      permissions: ['van_sales.view', 'sales.view'],
      roleNames: ['Clerk'],
      isOwner: false,
    });

    const defaults = await ctx.app
      .get(OrgProvisioningService)
      .provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;
    mainWarehouseId = defaults.warehouseId;
    cashLocationId = defaults.cashLocationId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    van1WarehouseId = newId();
    van2WarehouseId = newId();
    van3WarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    partyId = newId();
    doomedPartyId = newId();
    deltaPartyId = newId();
    paymentMethodId = newId();
    salesmanId = newId();
    otherSalesmanId = newId();
    const noScopeSalesmanId = newId();
    const repEmployeeId = newId();
    const otherRepEmployeeId = newId();
    const noScopeEmployeeId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      for (const [id, code, name] of [
        [van1WarehouseId, 'VAN-FS-1', 'سيارة المندوب الأول'],
        [van2WarehouseId, 'VAN-FS-2', 'سيارة المندوب الثاني'],
        [van3WarehouseId, 'VAN-FS-3', 'سيارة المندوب بلا نطاق'],
      ] as Array<[string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, ${code}, ${name}, false, true)
        `);
      }
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-FS', 'منتجات الميدان')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      for (const [id, sku, name, cardPrice] of [
        [itemId, 'SKU-FS-1', 'خبز الميدان', '6.5000'],
        [componentItemId, 'SKU-FS-F', 'دقيق الميدان', '4.0000'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                             purchase_price, sale_price, track_lot)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${sku}, ${name}, ${categoryId}::uuid,
                  ${baseUnitId}::uuid, 'stock', ${cardPrice}::numeric, ${cardPrice}::numeric, false)
        `);
      }
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 100000, 400000, 4.0000, 1)
      `);
      await tx.execute(sql`
        INSERT INTO parties (id, tenant_id, code, kind, name, tax_no, credit_limit)
        VALUES
          (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-FS-1', 'customer', 'تموينات الميدان', '300000000000003', 10000),
          (${doomedPartyId}::uuid, ${owner.tenantId}::uuid, 'CUST-FS-DOOM', 'customer', 'عميل يُحذف', '300000000000004', 1000),
          (${deltaPartyId}::uuid, ${owner.tenantId}::uuid, 'CUST-FS-DELTA', 'customer', 'عميل الدلتا', '300000000000005', 1000)
      `);
      await tx.execute(sql`
        INSERT INTO payment_methods (id, tenant_id, code, name_ar, kind, is_active, is_default)
        VALUES (${paymentMethodId}::uuid, ${owner.tenantId}::uuid, 'CASH-FS', 'نقدي', 'cash', true, true)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES
          (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-FS-1', 'مندوب الميدان الأول', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active'),
          (${otherRepEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-FS-2', 'مندوب الميدان الثاني', ${branchId}::uuid, ${otherRep.membershipId}::uuid, 'active'),
          (${noScopeEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-FS-3', 'مندوب بلا نطاق', ${branchId}::uuid, ${noScopeRep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES
          (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب الميدان الأول', true, ${repEmployeeId}::uuid, ${van1WarehouseId}::uuid, 'أ ب ج 1111'),
          (${otherSalesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب الميدان الثاني', true, ${otherRepEmployeeId}::uuid, ${van2WarehouseId}::uuid, 'د هـ و 2222'),
          (${noScopeSalesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب بلا نطاق', true, ${noScopeEmployeeId}::uuid, ${van3WarehouseId}::uuid, 'ص ع ق 3333')
      `);
    });

    // سعر عميل خاص — يظهر في اللقطة ويتغيّر في الدلتا.
    const priceRow = await api(ctx.server, 'post', '/api/v1/van-sales/customer-prices', {
      token: accountant.token,
      body: {
        partyId,
        itemId,
        unitPrice: '6.50',
        maxBonusKgPerInvoice: '2',
        creditLimit: '10000',
        changeReason: 'أسعار الميدان',
      },
    });
    expect(priceRow.status, JSON.stringify(priceRow.body)).toBe(201);

    // عهدتان: A مؤكدة للبيع (100 كجم)، B بانتظار تأكيد الاستلام (لتجربة operation=receipt).
    loadOrderAId = await newCustody('fs-a', '100', true);
    loadOrderBId = await newCustody('fs-b', '30', false);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  // ── 1) اللقطة ────────────────────────────────────────────────────────────────

  it('scopes the snapshot to the rep: his van stock, his open orders, the shared catalog', async () => {
    const snapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: rep.token,
    });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    const data = snapshot.body.data;

    expect(data.rep.salesmanId).toBe(salesmanId);
    expect(data.rep.warehouseId).toBe(van1WarehouseId);
    expect(data.rep.vehiclePlate).toBe('أ ب ج 1111');

    // العهدة: مستودع سيارته وحده — لا مستودع الفرع ولا سيارة مندوب آخر.
    expect(data.stock).toHaveLength(1);
    expect(data.stock[0]).toMatchObject({
      itemId,
      warehouseId: van1WarehouseId,
      quantity: '100.0000',
    });

    // الكتالوج المشترك: العملاء وأسعارهم والأصناف وطرق الدفع.
    expect(data.customers.map((row: { id: string }) => row.id)).toContain(partyId);
    expect(
      data.customerPrices.find((row: { partyId: string }) => row.partyId === partyId),
    ).toMatchObject({ itemId, unitPrice: '6.5000', lockPrice: true });
    expect(data.items.map((row: { id: string }) => row.id)).toContain(itemId);
    expect(data.paymentMethods.map((row: { id: string }) => row.id)).toContain(paymentMethodId);

    // أوامره المفتوحة: المؤكدة للبيع، والبانتظة تأكيد استلامه.
    const orderIds = data.openLoadOrders.map((row: { id: string }) => row.id);
    expect(orderIds).toContain(loadOrderAId);
    expect(orderIds).toContain(loadOrderBId);

    expect(data.watermark).toBeTruthy();
    expect(Number.isNaN(Date.parse(data.watermark))).toBe(false);
  });

  it('keeps every other van, card and back-office user out of the snapshot', async () => {
    // مندوب آخر: بطاقة سليمة ونطاق سليم — لكن لقطة عهدته فارغة (لا أرصدة ولا أوامر له).
    const otherSnapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: otherRep.token,
    });
    expect(otherSnapshot.status, JSON.stringify(otherSnapshot.body)).toBe(200);
    expect(otherSnapshot.body.data.stock).toHaveLength(0);
    expect(otherSnapshot.body.data.openLoadOrders).toHaveLength(0);
    expect(otherSnapshot.body.data.rep.warehouseId).toBe(van2WarehouseId);

    // مستخدم خلفي بلا بطاقة مندوب — واجهات الميدان ليست له (D-004).
    const clerkSnapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: clerk.token,
    });
    expect(clerkSnapshot.status).toBe(403);
    expect((clerkSnapshot.body as { code?: string }).code).toBe('FIELD_SYNC_NOT_A_REP');

    // مندوب بلا أي صفوف نطاط مستودع: التصفية في الواجهة ليست ضبط وصول (AUD-03).
    const noScopeSnapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: noScopeRep.token,
    });
    expect(noScopeSnapshot.status).toBe(403);
    expect((noScopeSnapshot.body as { code?: string }).code).toBe('FORBIDDEN');
  });

  // ── 2) الدلتا ────────────────────────────────────────────────────────────────

  it('returns changed and deleted rows against the watermark, and full live state', async () => {
    const snapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: rep.token,
    });
    const since = snapshot.body.data.watermark as string;

    // تغييرات بعد العلامة المائية: سعر عميل الدلتا (إنشاء ثم تعديل)، صنف جديد، وحذف عميل.
    // عميل اليوم الرئيسي يبقى على 6.50 المقفولة — اختبار الدلتا لا يعطّل اختبارات اليوم.
    for (const unitPrice of ['5.00', '7.00']) {
      const priceChange = await api(ctx.server, 'post', '/api/v1/van-sales/customer-prices', {
        token: accountant.token,
        body: {
          partyId: deltaPartyId,
          itemId,
          unitPrice,
          creditLimit: '1000',
          changeReason: `سعر الدلتا ${unitPrice}`,
        },
      });
      expect(priceChange.status, JSON.stringify(priceChange.body)).toBe(201);
    }
    const freshItemId = newId();
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                           purchase_price, sale_price, track_lot)
        VALUES (${freshItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-FS-NEW', 'صنف جديد',
                (SELECT id FROM item_categories WHERE tenant_id = ${owner.tenantId}::uuid LIMIT 1)::uuid,
                (SELECT base_unit_id FROM items WHERE id = ${itemId}::uuid)::uuid,
                'stock', 3.0000, 5.0000, false)
      `);
      await tx.execute(sql`
        UPDATE parties SET deleted_at = now(), updated_at = now()
        WHERE id = ${doomedPartyId}::uuid AND tenant_id = ${owner.tenantId}::uuid
      `);
    });

    const delta = await api(
      ctx.server,
      'get',
      `/api/v1/field-sync/delta?since=${encodeURIComponent(since)}`,
      { token: rep.token },
    );
    expect(delta.status, JSON.stringify(delta.body)).toBe(200);
    const data = delta.body.data;

    expect(data.since).toBe(since);
    expect(data.watermark).toBeTruthy();

    // المتغيّر يظهر، والسعر بأحدث قيمة — وعميل اليوم لم يُرسل لأن سعره لم يتغير.
    expect(data.changed.customerPrices).toHaveLength(1);
    expect(data.changed.customerPrices[0]).toMatchObject({ partyId: deltaPartyId, unitPrice: '7.0000' });
    expect(data.changed.items.map((row: { id: string }) => row.id)).toContain(freshItemId);

    // المحذوف يُبلَّغ بالمعرّف ليحذفه الجهاز من مخزنه.
    expect(data.deleted.customers).toContain(doomedPartyId);
    // والعميل الحيّ لم يُرسل لأن شيئاً لم يتغير فيه.
    expect(data.changed.customers.map((row: { id: string }) => row.id)).not.toContain(partyId);

    // الحيّ يُقرأ كاملاً: الأرصدة والأوامر المفتوحة ووحدات الصنف.
    expect(data.full.stock.every((row: { warehouseId: string }) => row.warehouseId === van1WarehouseId)).toBe(true);
    expect(data.full.openLoadOrders.map((row: { id: string }) => row.id)).toContain(loadOrderAId);
    expect(data.full.itemUnits.length).toBeGreaterThanOrEqual(0);

    // علامة مائية غير صالحة تُرفض صراحةً.
    const badDelta = await api(ctx.server, 'get', '/api/v1/field-sync/delta?since=not-a-date', {
      token: rep.token,
    });
    expect(badDelta.status).toBe(422);
  });

  // ── 3) الإعادة عبر المحركات ──────────────────────────────────────────────────

  it('replays an offline day — invoice, return and collection — through the official engines', async () => {
    const batch = [
      {
        offlineId: 'fs-day-invoice',
        sequenceNo: nextSeq(),
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '10', paymentMethod: 'credit' }),
      },
      {
        offlineId: 'fs-day-return',
        sequenceNo: nextSeq(),
        operation: 'return',
        payload: { sourceOfflineId: 'fs-day-invoice', returnedQty: '2', reason: 'خبز يابس' },
      },
      {
        offlineId: 'fs-day-collection',
        sequenceNo: nextSeq(),
        operation: 'collection',
        payload: { sourceOfflineId: 'fs-day-invoice', collectedAmount: '25.00', cashLocationId },
      },
    ];
    const response = await replay(rep, batch, DEVICE_REP);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({ processed: 3, synced: 3, conflicts: 0 });

    const invoice = data.results[0];
    const returnDoc = data.results[1];
    const collection = data.results[2];

    expect(invoice).toMatchObject({ status: 'synced', operation: 'invoice' });
    expect(invoice.documentNumber).toMatch(/^VTX-/);
    expect(invoice.invoiceNumber).toBeTruthy();
    expect(invoice.salesInvoiceId).toBeTruthy();

    /** المحرك لا الوحدة: الفاتورة الرسمية مرحّلة وبها قيد مزدوج. */
    const invoiceRow = await pool.query(
      `SELECT si.status, (SELECT COUNT(*)::int FROM journal_entries e
                          WHERE e.tenant_id = $1 AND e.source_type = 'sales_invoice' AND e.source_id = si.id) AS entries
       FROM sales_invoices si WHERE si.id = $2`,
      [rep.tenantId, invoice.salesInvoiceId],
    );
    expect(invoiceRow.rows[0]).toMatchObject({ status: 'posted', entries: 1 });

    /** المخزون الرسمي: 100 مستلمة − 10 مباعة + 2 مرتجعة = 92. */
    expect(await van1Qty()).toBe('92.0000');

    expect(returnDoc).toMatchObject({ status: 'synced', operation: 'return' });
    expect(returnDoc.documentNumber).toMatch(/^VRT-/);

    expect(collection).toMatchObject({ status: 'synced', operation: 'collection' });
    expect(collection.voucherId).toBeTruthy();
    expect(collection.voucherNumber).toBeTruthy();

    /** سند القبض من محرك الخزينة: مرحّل ومرتبط بحركة التحصيل. */
    const voucherRow = await pool.query(
      `SELECT v.status FROM vouchers v WHERE v.id = $1 AND v.tenant_id = $2`,
      [collection.voucherId, rep.tenantId],
    );
    expect(voucherRow.rows[0]).toMatchObject({ status: 'posted' });

    /** الدفعة مختلطة عبر sourceOfflineId: التحصيل على فاتورةٍ صنعها نفس الجهاز. */
    const paid = await pool.query(
      `SELECT paid_amount::text AS paid FROM van_sales_documents
       WHERE tenant_id = $1 AND id = $2`,
      [rep.tenantId, invoice.documentId],
    );
    expect(paid.rows[0]).toMatchObject({ paid: '25.0000' });
  });

  it('is idempotent when the device retries the whole batch', async () => {
    const batch = [
      {
        offlineId: 'fs-day-invoice',
        sequenceNo: 1001,
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '10', paymentMethod: 'credit' }),
      },
      {
        offlineId: 'fs-day-return',
        sequenceNo: 1002,
        operation: 'return',
        payload: { sourceOfflineId: 'fs-day-invoice', returnedQty: '2', reason: 'خبز يابس' },
      },
      {
        offlineId: 'fs-day-collection',
        sequenceNo: 1003,
        operation: 'collection',
        payload: { sourceOfflineId: 'fs-day-invoice', collectedAmount: '25.00', cashLocationId },
      },
    ];
    const response = await replay(rep, batch, DEVICE_REP);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({ processed: 3, synced: 3, conflicts: 0 });
    for (const row of data.results) {
      expect(row.resolution).toMatchObject({ action: 'remove-local-copy' });
    }

    // لا مستند ثانٍ لأي عملية: المحركات لم تُستدعَ أصلاً.
    expect(await documentsByEngineKey('field-sync:fs-day-invoice')).toBe(1);
    expect(await documentsByEngineKey('field-sync:fs-day-return')).toBe(1);
    const movements = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM van_stock_movements
       WHERE tenant_id = $1 AND idempotency_key = 'field-sync:fs-day-collection'`,
      [rep.tenantId],
    );
    expect((movements.rows[0] as { cnt: number }).cnt).toBe(1);
    // والمخزون لم يتحرك ثانيةً.
    expect(await van1Qty()).toBe('92.0000');
  });

  // ── 4) نفاد العهدة والتعارضات ───────────────────────────────────────────────

  it('turns stock exhaustion into a row conflict without failing the batch', async () => {
    const batch = [
      {
        offlineId: 'fs-exhaust-1',
        sequenceNo: nextSeq(),
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, {
          soldQty: '50',
          paymentMethod: 'cash',
          cashLocationId,
        }),
      },
      {
        offlineId: 'fs-exhaust-2',
        sequenceNo: nextSeq(),
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, {
          soldQty: '50',
          paymentMethod: 'cash',
          cashLocationId,
        }),
      },
    ];
    const response = await replay(rep, batch, DEVICE_REP);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const data = response.body.data;
    expect(data.synced).toBe(1);
    expect(data.conflicts).toBe(1);
    expect(data.results[0].status).toBe('synced');
    expect(data.results[1]).toMatchObject({ status: 'conflict', errorCode: 'VALIDATION_FAILED' });
    expect(data.results[1].resolution).toMatchObject({ action: 'edit-quantity-or-refresh-stock' });

    // المتبقي 92 − 50 = 42: الثانية رُفضت لأن 50 > 42.
    expect(await van1Qty()).toBe('42.0000');
  });

  it('refuses old, duplicate and mismatched sequences and unknown operations', async () => {
    const old = await replay(rep, [
      {
        offlineId: 'fs-seq-old',
        sequenceNo: 1,
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
    ], DEVICE_REP);
    expect(old.status).toBe(201);
    expect(old.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_SEQUENCE_OLD',
    });

    const duplicateSeq = nextSeq();
    const duplicate = await replay(rep, [
      {
        offlineId: 'fs-seq-dup-a',
        sequenceNo: duplicateSeq,
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
      {
        offlineId: 'fs-seq-dup-b',
        sequenceNo: duplicateSeq,
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
    ], DEVICE_REP);
    expect(duplicate.body.data.results[0]).toMatchObject({ status: 'synced' });
    expect(duplicate.body.data.results[1]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_SEQUENCE_DUPLICATE',
    });

    const mismatch = await replay(rep, [
      {
        offlineId: 'fs-day-invoice',
        sequenceNo: 88888,
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
    ], DEVICE_REP);
    expect(mismatch.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_ID_SEQUENCE_MISMATCH',
    });

    const unknown = await replay(rep, [
      {
        offlineId: 'fs-unknown-op',
        sequenceNo: nextSeq(),
        operation: 'delivery',
        payload: {},
      },
    ], DEVICE_REP);
    expect(unknown.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_OPERATION_UNKNOWN',
    });

    const empty = await replay(rep, []);
    expect(empty.status).toBe(422);
  });

  it('enforces the D-004 negative matrix on replay: ownership, device, permission, source', async () => {
    // مندوب آخر يبيع من عهدة المندوب الأول — تعارض ملكية لا خطأ 500.
    const foreign = await replay(otherRep, [
      {
        offlineId: 'fs-foreign-invoice',
        sequenceNo: nextSeq(),
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
    ], DEVICE_OTHER);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    expect(foreign.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_SCOPE_VIOLATION',
    });

    // جهاز مسجّل على مندوب آخر — لا تختلط عهدتان على جهاز واحد.
    const boundDevice = await replay(otherRep, [
      {
        offlineId: 'fs-bound-device',
        sequenceNo: nextSeq(),
        operation: 'invoice',
        payload: invoicePayload(loadOrderAId, { soldQty: '1' }),
      },
    ], DEVICE_REP);
    expect(boundDevice.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_DEVICE_BOUND',
    });

    // صلاحية ناقصة: مندوب بلا تحصيل يحاول التحصيل عبر الطابور.
    const noPermission = await replay(otherRep, [
      {
        offlineId: 'fs-no-permission',
        sequenceNo: nextSeq(),
        operation: 'collection',
        payload: { documentId: newId(), collectedAmount: '1.00', cashLocationId },
      },
    ], DEVICE_OTHER);
    expect(noPermission.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_PERMISSION_MISSING',
    });

    // مصدر لم يُرحَّل: تحصيل على فاتورة لم يعرفها الخادم.
    const badSource = await replay(rep, [
      {
        offlineId: 'fs-bad-source',
        sequenceNo: nextSeq(),
        operation: 'collection',
        payload: { sourceOfflineId: 'never-existed-offline-id', collectedAmount: '1.00', cashLocationId },
      },
    ], DEVICE_REP);
    expect(badSource.body.data.results[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'FIELD_SYNC_SOURCE_NOT_SYNCED',
    });

    // ليس مندوباً أصلاً — ولا مندوباً بلا نطاق.
    const clerkReplay = await replay(clerk, [
      { offlineId: 'fs-clerk', sequenceNo: 1, operation: 'invoice', payload: {} },
    ]);
    expect(clerkReplay.status).toBe(403);
    expect((clerkReplay.body as { code?: string }).code).toBe('FIELD_SYNC_NOT_A_REP');
    const noScopeReplay = await replay(noScopeRep, [
      { offlineId: 'fs-noscope', sequenceNo: 1, operation: 'invoice', payload: {} },
    ]);
    expect(noScopeReplay.status).toBe(403);
    expect((noScopeReplay.body as { code?: string }).code).toBe('FORBIDDEN');
  });

  it('shows the conflict inbox to its owner only', async () => {
    // صف للمندوب الآخر مباشرة في الجدول — لا يراه المندوب الأول في صندوقه.
    await pool.query(
      `INSERT INTO field_sync_queue (id, tenant_id, device_id, salesman_id, offline_id, sequence_no, operation, status, payload, error_code, error_detail)
       VALUES ($1, $2, $3, $4, 'other-rep-row', 1, 'invoice', 'conflict', '{}'::jsonb, 'FIELD_SYNC_PERMISSION_MISSING', 'اختبار العزل')`,
      [newId(), rep.tenantId, DEVICE_OTHER, otherSalesmanId],
    );

    const inbox = await api(ctx.server, 'get', '/api/v1/field-sync/queue', { token: rep.token });
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const rows = inbox.body.data as Array<{ offlineId: string; salesmanId?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.offlineId !== 'other-rep-row')).toBe(true);
    const syncedOnly = await api(ctx.server, 'get', '/api/v1/field-sync/queue?status=synced', {
      token: rep.token,
    });
    expect(
      (syncedOnly.body.data as Array<{ status: string }>).every((row) => row.status === 'synced'),
    ).toBe(true);
  });

  it('confirms a pending receipt offline and recovers the crash window honestly', async () => {
    const receipt = await replay(rep, [
      {
        offlineId: 'fs-receipt-ok',
        sequenceNo: nextSeq(),
        operation: 'receipt',
        payload: { loadOrderId: loadOrderBId, receivedQty: '30', notes: 'استلام دون اتصال' },
      },
    ], DEVICE_REP);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(receipt.body.data).toMatchObject({ processed: 1, synced: 1, conflicts: 0 });
    expect(receipt.body.data.results[0]).toMatchObject({
      loadOrderStatus: 'loaded',
      receivedQty: '30.0000',
    });

    /**
     * نافذة الانهيار — الاستلام تمّ (عبر واجهة الفان سيلز مباشرةً) لكن تحديث السجل لم
     * يحدث: إعادة الإرسال بمعرّف جديد ترى «الأمر لا ينتظر استلاماً» وتسجّل الواقع، لا
     * تعارضاً كاذباً.
     */
    const orderC = await newCustody('fs-c', '25', false);
    const direct = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${orderC}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: '25', notes: 'استلام مباشر' } },
    );
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);

    const crashWindow = await replay(rep, [
      {
        offlineId: 'fs-receipt-crash',
        sequenceNo: nextSeq(),
        operation: 'receipt',
        payload: { loadOrderId: orderC, receivedQty: '25', notes: 'إعادة بعد انهيار' },
      },
    ], DEVICE_REP);
    expect(crashWindow.status, JSON.stringify(crashWindow.body)).toBe(201);
    expect(crashWindow.body.data.results[0]).toMatchObject({
      status: 'synced',
      loadOrderStatus: 'loaded',
      receivedQty: '25.0000',
    });
  });

  it('serialises concurrent replays on the same van stock: exactly one winner', async () => {
    /**
     * الاختبار ذاتيّ الحساب: كلتا الفاتورتين المتسابقتين بمقدار «متبقي أمر التحميل − 1»
     * كجم (القيد الحاكم في `createDocument`، لا رصيد المخزن الذي يزيد بالمرتجع)، فأيًّا
     * منهما التزمت أولاً تركت للثانية كيلوجراماً واحداً فقط — يفوز واحد حتماً ويرفض
     * الآخر، ويبقى في أمر التحميل كيلوجرام واحد أياً كان الفائز.
     */
    const remainingResult = await pool.query(
      `SELECT (COALESCE(NULLIF(received_qty, 0), loaded_qty) - sold_qty - bonus_qty - returned_qty - damaged_qty)::text AS remaining
       FROM van_load_orders WHERE id = $1 AND tenant_id = $2`,
      [loadOrderAId, rep.tenantId],
    );
    const remaining = Number((remainingResult.rows[0] as { remaining: string }).remaining);
    expect(remaining).toBeGreaterThan(2);
    const contestedQty = (remaining - 1).toFixed(4);

    const [first, second] = await Promise.all([
      replay(rep, [
        {
          offlineId: 'fs-race-1',
          sequenceNo: nextSeq(),
          operation: 'invoice',
          payload: invoicePayload(loadOrderAId, {
            soldQty: contestedQty,
            paymentMethod: 'cash',
            cashLocationId,
          }),
        },
      ], DEVICE_REP),
      replay(rep, [
        {
          offlineId: 'fs-race-2',
          sequenceNo: nextSeq(),
          operation: 'invoice',
          payload: invoicePayload(loadOrderAId, {
            soldQty: contestedQty,
            paymentMethod: 'cash',
            cashLocationId,
          }),
        },
      ], DEVICE_REP),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const statuses = [first.body.data, second.body.data];
    const synced = statuses.reduce((sum, row) => sum + row.synced, 0);
    const conflicts = statuses.reduce((sum, row) => sum + row.conflicts, 0);
    // واحد يمر والآخر يُرفض — لا بيعٌ فوق العهدة ولا فشل دفعة، والباقي كيلوجرام واحد.
    expect(synced).toBe(1);
    expect(conflicts).toBe(1);
    const afterResult = await pool.query(
      `SELECT (COALESCE(NULLIF(received_qty, 0), loaded_qty) - sold_qty - bonus_qty - returned_qty - damaged_qty)::text AS remaining
       FROM van_load_orders WHERE id = $1 AND tenant_id = $2`,
      [loadOrderAId, rep.tenantId],
    );
    expect((afterResult.rows[0] as { remaining: string }).remaining).toBe('1.0000');
  });
});
