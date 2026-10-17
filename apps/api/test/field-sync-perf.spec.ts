import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@erp/database';
import { Pool } from 'pg';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📊 خط أساس أداء مزامنة الميدان (R-13) — the load test the risk register asked for.
 *
 * «لا خط أساس لأداء حجم المزامنة (مندوب بعميلين وألف وخمسة آلاف صنف ودفعات إعادة
 * تشغيل يومية)» — هذه المواصفة تُثبت الحجم وتقيسه: 2000 عميل و5000 صنف في اللقطة،
 * دلتا بعد تحرير مئة صنف، ثم دفعتا إعادة تشغيل (40 ثم 20 فاتورة) عبر المحركات
 * الرسمية نفسها. الأرقام المقيسة تُطبع في سجلّ الاختبار فتكون هي خط الأساس؛
 * والحدود أدناه سقوفٌ كريمة (لا اتفاقية SLA) — تلتقط التراجع من رتبة كاملة
 * (استعلام N+1، تضخّم الحمولة) دون أن ترتجف على متغيّرات بيئة CI.
 *
 * ليست هذه مواصفة عقدٍ وظيفي — سلوك اللقطة والدلتا وإعادة التشغيل مُثبت في
 * `field-sync.spec.ts`؛ هنا يُقاس الحجم والزمن عند حجم إنتاجيّ فقط.
 */
const CUSTOMER_COUNT = 2000;
const FILLER_ITEM_COUNT = 4998; // + البضاعتان الحقيقيتان = 5000
const DELTA_TOUCHED_ITEMS = 100;
const BURST_ONE_INVOICES = 40;
const BURST_TWO_INVOICES = 20;

/** سقوف كريمة — قياسات الجهاز المحلي أدنى منها بعشرات الأضعاف. */
const SNAPSHOT_MAX_MS = 15_000;
const SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024;
const DELTA_MAX_MS = 15_000;
const BURST_ONE_MAX_MS = 90_000;
const BURST_TWO_MAX_MS = 60_000;

const DEVICE_ID = 'perf-rep-device-1';

describe('field-sync perf — خط أساس الحجم والزمن (R-13)', () => {
  let ctx: TestApp;
  let pool: Pool;

  let owner: Actor;
  let rep: Actor;

  let branchId = '';
  let mainWarehouseId = '';
  let vanWarehouseId = '';
  let itemId = '';
  let componentItemId = '';
  let categoryId = '';
  let baseUnitId = '';
  let paymentMethodId = '';
  let salesmanId = '';
  let loadOrderId = '';

  /** عملاء الدفعتين — يقرأها الترويسة بعد البذر فتبقى بين الاختبارات. */
  let burstCustomers: string[] = [];
  /** العلامة المائية من اللقطة — تدخلها الدلتا كما استلمتها. */
  let snapshotWatermark = '';

  const invoiceOperation = (seq: number, partyId: string) => ({
    deviceId: DEVICE_ID,
    offlineId: `perf-inv-${seq}`,
    sequenceNo: seq,
    operation: 'invoice',
    createdAt: new Date(Date.now() - (100 - seq) * 60_000).toISOString(),
    payload: {
      loadOrderId,
      partyId,
      itemId,
      invoiceMode: 'zatca_tax',
      paymentMethod: 'credit',
      soldQty: '1',
      unitPrice: '6.50',
    },
  });

  const replayBurst = async (operations: Array<Record<string, unknown>>) =>
    api(ctx.server, 'post', '/api/v1/field-sync/replay', {
      token: rep.token,
      body: { deviceId: DEVICE_ID, operations },
    });

  beforeAll(async () => {
    ctx = await createTestApp('field-sync-perf');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    owner = await createActor(ctx, {
      tenantCode: 'field-sync-perf',
      tenantName: 'مخابز خط أساس الميدان',
      email: 'owner@field-sync-perf.test',
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
    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'field-sync-perf',
      email: 'rep@field-sync-perf.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.collection.create',
      ],
      roleNames: ['Rep'],
      isOwner: false,
    });

    const defaults = await ctx.app
      .get(OrgProvisioningService)
      .provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;
    mainWarehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    vanWarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    categoryId = newId();
    baseUnitId = newId();
    paymentMethodId = newId();
    salesmanId = newId();
    const repEmployeeId = newId();
    const tenantId = owner.tenantId;

    // البذر بالجملة — سطرٌ واحد لكل ألفي عميل وألفي صنف؛ هذا اختبار حملٍ لا عدّاد حلقات.
    await pool.query(
      `INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'VAN-PERF', 'سيارة مندوب القياس', false, true)`,
      [vanWarehouseId, tenantId, branchId],
    );
    await pool.query(
      `INSERT INTO item_categories (id, tenant_id, code, name_ar)
       VALUES ($1::uuid, $2::uuid, 'CAT-PERF', 'منتجات القياس')`,
      [categoryId, tenantId],
    );
    await pool.query(
      `INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
       VALUES ($1::uuid, $2::uuid, 'KG-PERF', 'كيلوجرام', 'Kilogram')`,
      [baseUnitId, tenantId],
    );
    await pool.query(
      `INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                          purchase_price, sale_price, track_lot)
       VALUES
         ($1::uuid, $2::uuid, 'SKU-PERF-1', 'خبز القياس', $4::uuid, $5::uuid, 'stock', 6.5000, 6.5000, false),
         ($3::uuid, $2::uuid, 'SKU-PERF-F', 'دقيق القياس', $4::uuid, $5::uuid, 'stock', 4.0000, 4.0000, false)`,
      [itemId, tenantId, componentItemId, categoryId, baseUnitId],
    );
    await pool.query(
      `INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                          purchase_price, sale_price, track_lot)
       SELECT gen_random_uuid(),
              $1::uuid,
              'SKU-PF-' || gs,
              'صنف حشو للقياس ' || gs,
              $2::uuid, $3::uuid, 'stock', 1.0000, 2.0000, false
       FROM generate_series(1, $4) AS gs`,
      [tenantId, categoryId, baseUnitId, FILLER_ITEM_COUNT],
    );
    await pool.query(
      `INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 100000, 400000, 4.0000, 1)`,
      [tenantId, componentItemId, mainWarehouseId],
    );
    await pool.query(
      `INSERT INTO parties (id, tenant_id, code, kind, name, credit_limit)
       SELECT gen_random_uuid(),
              $1::uuid,
              'CUST-PF-' || gs,
              'customer',
              'عميل القياس ' || gs,
              10000
       FROM generate_series(1, $2) AS gs`,
      [tenantId, CUSTOMER_COUNT],
    );
    await pool.query(
      `INSERT INTO payment_methods (id, tenant_id, code, name_ar, kind, is_active, is_default)
       VALUES ($1::uuid, $2::uuid, 'CASH-PERF', 'نقدي', 'cash', true, true)`,
      [paymentMethodId, tenantId],
    );
    await pool.query(
      `INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
       VALUES ($1::uuid, $2::uuid, 'EMP-PERF-1', 'مندوب القياس', $3::uuid, $4::uuid, 'active')`,
      [repEmployeeId, tenantId, branchId, rep.membershipId],
    );
    await pool.query(
      `INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
       VALUES ($1::uuid, $2::uuid, 'مندوب القياس', true, $3::uuid, $4::uuid, 'أ ب ج 9999')`,
      [salesmanId, tenantId, repEmployeeId, vanWarehouseId],
    );

    // العهدة عبر المحركات الرسمية: إنتاج ← توريد ← تأكيد استلام.
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: owner.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '500',
        components: [{ itemId: componentItemId, qty: '500' }],
        unitCost: '4.00',
        idempotencyKey: 'perf-prod-1',
      },
    });
    expect(production.status, JSON.stringify(production.body)).toBe(201);
    const batchNo = production.body.data.productionBatches[0].batchNo as string;

    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: owner.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '500',
        productionBatchNo: batchNo,
        idempotencyKey: 'perf-load-1',
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    const order = supply.body.data.loadOrders.find(
      (row: { productionBatchNo: string }) => row.productionBatchNo === batchNo,
    ) as Record<string, string>;
    loadOrderId = order.id;

    const confirm = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: '500', notes: 'استلام القياس' } },
    );
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);

    // عملاء الدفعات — عشرون وستون عميلاً من الموزوعة، فاتورةٌ لكلٍّ منهم.
    const customers = await pool.query(
      `SELECT id::text FROM parties
       WHERE tenant_id = $1::uuid AND code LIKE 'CUST-PF-%'
       ORDER BY code ASC LIMIT $2`,
      [tenantId, BURST_ONE_INVOICES + BURST_TWO_INVOICES],
    );
    burstCustomers = customers.rows.map((row) => row.id as string);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('اللقطة عند حجم الإنتاج: 2000 عميل و5000 صنف — حجمٌ وزمنٌ ضمن السقف', async () => {
    const started = performance.now();
    const snapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: rep.token,
    });
    const elapsedMs = performance.now() - started;
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);

    const data = snapshot.body.data;
    expect(data.rep.salesmanId).toBe(salesmanId);
    expect(data.customers.length, 'العملاء في اللقطة').toBeGreaterThanOrEqual(CUSTOMER_COUNT);
    expect(data.items.length, 'الأصناف في اللقطة').toBeGreaterThanOrEqual(
      2 + FILLER_ITEM_COUNT,
    );
    expect(data.openLoadOrders.length, 'أمر التحميل المفتوح').toBeGreaterThanOrEqual(1);
    snapshotWatermark = data.watermark as string;

    const bytes = Buffer.byteLength(JSON.stringify(snapshot.body));
    console.log(
      `field-sync perf baseline — snapshot: customers=${data.customers.length} items=${data.items.length} ` +
        `size=${(bytes / 1024 / 1024).toFixed(2)}MB latency=${elapsedMs.toFixed(0)}ms`,
    );
    expect(bytes, 'حجم اللقطة (بايت)').toBeLessThan(SNAPSHOT_MAX_BYTES);
    expect(elapsedMs, 'زمن بناء اللقطة').toBeLessThan(SNAPSHOT_MAX_MS);
  });

  it('الدلتا بعد تحرير مئة صنف: التغيير يصل كاملاً ضمن السقف', async () => {
    const touched = await pool.query(
      `UPDATE items SET sale_price = sale_price + 0.01, updated_at = now()
       WHERE id IN (
         SELECT id FROM items
         WHERE tenant_id = $1::uuid AND sku LIKE 'SKU-PF-%'
         LIMIT $2
       )`,
      [owner.tenantId, DELTA_TOUCHED_ITEMS],
    );
    expect(touched.rowCount).toBe(DELTA_TOUCHED_ITEMS);

    const started = performance.now();
    const delta = await api(
      ctx.server,
      'get',
      `/api/v1/field-sync/delta?since=${encodeURIComponent(snapshotWatermark)}`,
      { token: rep.token },
    );
    const elapsedMs = performance.now() - started;
    expect(delta.status, JSON.stringify(delta.body)).toBe(200);

    expect(delta.body.data.changed.items.length, 'الأصناف المتغيرة في الدلتا').toBe(
      DELTA_TOUCHED_ITEMS,
    );
    console.log(
      `field-sync perf baseline — delta: changedItems=${delta.body.data.changed.items.length} ` +
        `latency=${elapsedMs.toFixed(0)}ms`,
    );
    expect(elapsedMs, 'زمن الدلتا').toBeLessThan(DELTA_MAX_MS);
  });

  it('دفعتا إعادة تشغيل يوميتان (40 ثم 20 فاتورة) عبر المحركات — الكل مُرحَّل ضمن السقف', async () => {
    const first = burstCustomers.slice(0, BURST_ONE_INVOICES);
    const second = burstCustomers.slice(BURST_ONE_INVOICES);

    const oneStarted = performance.now();
    const burstOne = await replayBurst(
      first.map((partyId, index) => invoiceOperation(index + 1, partyId)),
    );
    const oneElapsed = performance.now() - oneStarted;
    expect(burstOne.status, JSON.stringify(burstOne.body)).toBe(201);
    expect(burstOne.body.data.processed).toBe(BURST_ONE_INVOICES);
    expect(burstOne.body.data.synced, JSON.stringify(burstOne.body.data.results)).toBe(
      BURST_ONE_INVOICES,
    );
    expect(burstOne.body.data.conflicts).toBe(0);

    const twoStarted = performance.now();
    const burstTwo = await replayBurst(
      second.map((partyId, index) => invoiceOperation(BURST_ONE_INVOICES + index + 1, partyId)),
    );
    const twoElapsed = performance.now() - twoStarted;
    expect(burstTwo.status, JSON.stringify(burstTwo.body)).toBe(201);
    expect(burstTwo.body.data.processed).toBe(BURST_TWO_INVOICES);
    expect(burstTwo.body.data.synced, JSON.stringify(burstTwo.body.data.results)).toBe(
      BURST_TWO_INVOICES,
    );
    expect(burstTwo.body.data.conflicts).toBe(0);

    console.log(
      `field-sync perf baseline — replay: burst1=${BURST_ONE_INVOICES}ops/${oneElapsed.toFixed(0)}ms ` +
        `(${(oneElapsed / BURST_ONE_INVOICES).toFixed(0)}ms/op) ` +
        `burst2=${BURST_TWO_INVOICES}ops/${twoElapsed.toFixed(0)}ms ` +
        `(${(twoElapsed / BURST_TWO_INVOICES).toFixed(0)}ms/op)`,
    );
    expect(oneElapsed, 'زمن الدفعة الأولى').toBeLessThan(BURST_ONE_MAX_MS);
    expect(twoElapsed, 'زمن الدفعة الثانية').toBeLessThan(BURST_TWO_MAX_MS);
  });
});
