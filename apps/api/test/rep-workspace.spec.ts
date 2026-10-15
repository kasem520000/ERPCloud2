import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🚐 مساحة عمل المندوب (M4) — تنسيق رفيع فوق ما هو قائم: اليوم، العهدة، الإغلاق.
 *
 * كل رقم هنا يُقرأ من نفس الجداول التي تقرأها شاشات الفان سيلز، واليوم نفسه مبنيٌّ
 * من مستنداتٍ خرجت من محرك المبيعات عبر إعادة تشغيل الطابور — لا بيانات مُختلقة:
 *   1. ملخص اليوم: الإيراد صافي المرتجعات، التحصيل بسنده، والزيارات مجمّعة لكل عميل؛
 *   2. ملخص العهدة: الرصيد الرسمي للمستودع + المتوقع مقابل الفعلي لكل أمر مفتوح؛
 *   3. الإغلاق: من صاحب العهدة وحده (المسار الخلفي للمحاسب موجود في واجهة الفان سيلز).
 */
describe('rep-workspace — day, custody and closing orchestration', () => {
  let ctx: TestApp;
  let pool: Pool;

  let owner: Actor;
  let accountant: Actor;
  let rep: Actor;
  let otherRep: Actor;
  let clerk: Actor;

  let branchId = '';
  let mainWarehouseId = '';
  let cashLocationId = '';
  let vanWarehouseId = '';
  let itemId = '';
  let componentItemId = '';
  let partyId = '';
  let salesmanId = '';
  let loadOrderId = '';

  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await createTestApp('rep-workspace');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    owner = await createActor(ctx, {
      tenantCode: 'rep-ws',
      tenantName: 'مخابز مساحة المندوب',
      email: 'owner@rep-ws.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'accounting.period.close',
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
        'van_sales.closing.approve',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });
    accountant = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'rep-ws',
      email: 'accountant@rep-ws.test',
      permissions: ['van_sales.view', 'van_sales.production.manage', 'van_sales.load.manage'],
      roleNames: ['Accountant'],
      isOwner: false,
    });
    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'rep-ws',
      email: 'rep@rep-ws.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.collection.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['Rep'],
      isOwner: false,
    });
    otherRep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'rep-ws',
      email: 'other@rep-ws.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['Rep2'],
      isOwner: false,
    });
    clerk = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'rep-ws',
      email: 'clerk@rep-ws.test',
      permissions: ['van_sales.view'],
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

    vanWarehouseId = newId();
    const otherVanWarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    partyId = newId();
    salesmanId = newId();
    const otherSalesmanId = newId();
    const repEmployeeId = newId();
    const otherRepEmployeeId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      for (const [id, code, name] of [
        [vanWarehouseId, 'VAN-WS', 'سيارة مساحة العمل'],
        [otherVanWarehouseId, 'VAN-WS-2', 'سيارة المندوب الثاني'],
      ] as Array<[string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, ${code}, ${name}, false, true)
        `);
      }
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-WS', 'منتجات المساحة')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      for (const [id, sku, name, cardPrice] of [
        [itemId, 'SKU-WS-1', 'خبز المساحة', '6.0000'],
        [componentItemId, 'SKU-WS-F', 'دقيق المساحة', '4.0000'],
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
        VALUES (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-WS-1', 'customer', 'تموينات المساحة', '300000000000003', 10000)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES
          (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-WS-1', 'مندوب المساحة', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active'),
          (${otherRepEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-WS-2', 'المندوب الثاني', ${branchId}::uuid, ${otherRep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES
          (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب المساحة', true, ${repEmployeeId}::uuid, ${vanWarehouseId}::uuid, 'هـ و ي 7777'),
          (${otherSalesmanId}::uuid, ${owner.tenantId}::uuid, 'المندوب الثاني', true, ${otherRepEmployeeId}::uuid, ${otherVanWarehouseId}::uuid, 'ز ح ت 8888')
      `);
    });

    // إنتاج ← توريد ← استلام ← بيع آجل ← مرتجع ← تحصيل — كلها عبر المحركات الرسمية.
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '200',
        components: [{ itemId: componentItemId, qty: '200' }],
        unitCost: '4.00',
        idempotencyKey: 'ws-prod',
      },
    });
    expect(production.status, JSON.stringify(production.body)).toBe(201);
    const batchNo = production.body.data.productionBatches[0].batchNo as string;

    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '100',
        productionBatchNo: batchNo,
        idempotencyKey: 'ws-load',
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    loadOrderId = supply.body.data.loadOrders.find(
      (row: { productionBatchNo: string }) => row.productionBatchNo === batchNo,
    ).id as string;

    const confirm = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: '100', notes: 'استلام' } },
    );
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);

    // بيع آجل 20 كجم ثم مرتجع 3 ثم تحصيل 50 — عبر إعادة تشغيل الطابور كما يفعل التطبيق.
    const replay = await api(ctx.server, 'post', '/api/v1/field-sync/replay', {
      token: rep.token,
      body: {
        deviceId: 'ws-device',
        operations: [
          {
            offlineId: 'ws-invoice',
            sequenceNo: 1,
            operation: 'invoice',
            payload: {
              loadOrderId,
              partyId,
              itemId,
              invoiceMode: 'zatca_tax',
              paymentMethod: 'credit',
              soldQty: '20',
              unitPrice: '6.00',
            },
          },
          {
            offlineId: 'ws-return',
            sequenceNo: 2,
            operation: 'return',
            payload: { sourceOfflineId: 'ws-invoice', returnedQty: '3', reason: 'متقصف' },
          },
          {
            offlineId: 'ws-collection',
            sequenceNo: 3,
            operation: 'collection',
            payload: { sourceOfflineId: 'ws-invoice', collectedAmount: '50.00', cashLocationId },
          },
        ],
      },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toMatchObject({ processed: 3, synced: 3, conflicts: 0 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('summarises the rep day from engine documents: net revenue, collections, visits', async () => {
    const day = await api(ctx.server, 'get', '/api/v1/rep-workspace/day', { token: rep.token });
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    const data = day.body.data;

    expect(data.date).toBe(today());
    expect(data.documents).toHaveLength(2);

    const sale = data.documents.find((row: { documentKind: string }) => row.documentKind === 'sale');
    const returnDoc = data.documents.find(
      (row: { documentKind: string }) => row.documentKind === 'return',
    );
    expect(sale).toBeTruthy();
    expect(returnDoc).toBeTruthy();
    // 20 كجم بـ 6.00 = 120.00 قبل الضريبة؛ الإجمالي بالضريبة 138.00.
    expect(sale).toMatchObject({ soldQty: '20.0000', total: '138.00' });
    expect(returnDoc).toMatchObject({ soldQty: '3.0000' });

    // المرتجع 3 × 6.00 = 18.00 (بلا ضريبة في مستند المرتجع) — الإيراد صافي المرتجعات.
    expect(data.totals.revenue).toBe('120.00');
    expect(data.totals.documents).toBe(1);
    expect(data.totals.returns).toBe(1);
    expect(data.totals.collections).toBe('50.00');

    expect(data.collections).toHaveLength(1);
    expect(data.collections[0]).toMatchObject({ amount: '50.00' });
    expect(data.collections[0].voucherNumber).toBeTruthy();

    // زيارة واحدة لعميل واحد: اشترى وأرجع ودفّع في اليوم نفسه.
    expect(data.visits).toHaveLength(1);
    expect(data.visits[0]).toMatchObject({
      customerName: 'تموينات المساحة',
      documents: 1,
      returns: 1,
    });
  });

  it('refuses an invalid date and an empty day stays honest', async () => {
    const invalid = await api(ctx.server, 'get', '/api/v1/rep-workspace/day?date=2026-13-45', {
      token: rep.token,
    });
    expect(invalid.status).toBe(422);

    const empty = await api(ctx.server, 'get', '/api/v1/rep-workspace/day?date=2020-01-01', {
      token: rep.token,
    });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data.documents).toHaveLength(0);
    expect(empty.body.data.totals.revenue).toBe('0.00');
  });

  it('summarises custody: official balance and expected-vs-actual per open order', async () => {
    const custody = await api(ctx.server, 'get', '/api/v1/rep-workspace/custody', {
      token: rep.token,
    });
    expect(custody.status, JSON.stringify(custody.body)).toBe(200);
    const data = custody.body.data;

    expect(data.warehouseId).toBe(vanWarehouseId);
    // 100 مستلمة − 20 مباعة + 3 مرتجعة = 83 كجم رسمياً في السيارة.
    expect(data.balances).toHaveLength(1);
    expect(data.balances[0]).toMatchObject({ itemId, quantity: '83.0000' });
    expect(data.custodyKg).toBe('83.0000');

    const order = data.openLoadOrders.find((row: { id: string }) => row.id === loadOrderId);
    expect(order).toBeTruthy();
    expect(order).toMatchObject({
      status: 'in_route',
      receivedQty: '100.0000',
      soldQty: '20.0000',
      returnedQty: '3.0000',
      expectedRemainingQty: '77.0000',
      actualRemainingQty: '0.0000',
    });
  });

  it('lets the owning rep submit his closing and refuses everyone else', async () => {
    // الموظف الخلفي بلا بطاقة مندوب — لا مساحة عمل له أصلاً.
    const clerkDay = await api(ctx.server, 'get', '/api/v1/rep-workspace/custody', {
      token: clerk.token,
    });
    expect(clerkDay.status).toBe(403);
    expect((clerkDay.body as { code?: string }).code).toBe('FIELD_SYNC_NOT_A_REP');

    // إغلاق بلا أمر تحميل — رفض صريح لا 500.
    const missing = await api(ctx.server, 'post', '/api/v1/rep-workspace/closing', {
      token: rep.token,
      body: { returnedQty: '10', collectedCash: '50' },
    });
    expect(missing.status).toBe(422);

    // صاحب العهدة يقدّم إغلاقه: جرد فعلي 70 (عجز 7 عن المتوقع 77).
    const closing = await api(ctx.server, 'post', '/api/v1/rep-workspace/closing', {
      token: rep.token,
      body: {
        loadOrderId,
        returnedQty: '10',
        damagedQty: '0',
        collectedCash: '50',
        actualRemainingQty: '67',
        closingNotes: 'جرد نهاية اليوم',
      },
    });
    expect(closing.status, JSON.stringify(closing.body)).toBe(201);

    const orderRow = await pool.query(
      `SELECT status, actual_remaining_qty::text AS remaining FROM van_load_orders
       WHERE id = $1 AND tenant_id = $2`,
      [loadOrderId, rep.tenantId],
    );
    expect(orderRow.rows[0]).toMatchObject({ status: 'pending_closing', remaining: '67.0000' });

    // مندوب آخر يحاول إغلاق عهدة غيره — 403، فإخفاء الزر ليس ضبط وصول.
    const foreign = await api(ctx.server, 'post', '/api/v1/rep-workspace/closing', {
      token: otherRep.token,
      body: { loadOrderId, returnedQty: '1' },
    });
    expect(foreign.status).toBe(403);

    // والقاعدة نفسها على القراءة: مندوب آخر لا يرى يوم المندوب الأول.
    const otherDay = await api(ctx.server, 'get', '/api/v1/rep-workspace/day', {
      token: otherRep.token,
    });
    expect(otherDay.status, JSON.stringify(otherDay.body)).toBe(200);
    expect(otherDay.body.data.documents).toHaveLength(0);
  });
});
