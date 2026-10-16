import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📱 يوم المندوب من التطبيق (M5) — اختبار قبول يعيد تشغيل الحمولات التي يرسلها
 * `apps/rep-app` حرفيًا كما تُثبّتها `apps/rep-app/tests/offline.spec.ts`:
 *
 *   1. لقطة (سحب التطبيق الأول) → علامة مائية وأوامر مفتوحة؛
 *   2. دفعة واحدة بترتيب التسلسل — استلام أمر التحميل، بيعة ببونص، تحصيل على فاتورة
 *      نفس الجهاز (`sourceOfflineId`)، ومرتجع عليها — كلها بالصيغة النصية العشرية
 *      التي يبنيها التطبيق (`toFixed(4)` للكميات، `toFixed(2)` للمبالغ)؛
 *   3. الدلتا بعد المزامنة ترصد أثر الدفعة (الأمر في المسار، الفاتورة بمتبقٍّها)؛
 *   4. الإغلاق بجسد التطبيق الحرفي: جرد فعلي مقابل متوقع، والعجز يظهر صراحةً
 *      (`pending_policy_approval`) ولا يُسوَّى بصمتًا أبدًا (D-008)؛
 *   5. قراءة اليوم تجمع المستندات والتحصيلات كما تعرضها شاشة «اليوم».
 *
 * هذا هو معيار خروج M5: «اختبارات قبول تعيد تشغيل الحمولات التي يرسلها التطبيق» —
 * إن انزلق العقد في أي طرف، يفشل هنا قبل أن يصل إلى جهاز مندوب.
 */
const DEVICE = 'rep-app1-a7';
const offlineId = (sequenceNo: number) => `OFFLINE-${DEVICE}-${sequenceNo}-x${sequenceNo}`;

describe('rep-app day — the app\u2019s exact payloads, end to end', () => {
  let ctx: TestApp;
  let pool: Pool;

  let owner: Actor;
  let accountant: Actor;
  let rep: Actor;

  let branchId = '';
  let mainWarehouseId = '';
  let cashLocationId = '';
  let vanWarehouseId = '';
  let itemId = '';
  let componentItemId = '';
  let partyId = '';
  let salesmanId = '';
  let paymentMethodId = '';
  let loadOrderId = '';

  /** تُملأ من نتيجة الدفعة — تعتمد عليها اختبارات الدلتا والإغلاق واليوم. */
  let invoiceDocumentId = '';
  let invoiceDocumentNumber = '';
  let watermark = '';

  const vanQty = async (): Promise<string> => {
    const result = await pool.query(
      `SELECT COALESCE(quantity, 0)::text AS qty FROM stock_balances
       WHERE tenant_id = $1 AND item_id = $2 AND warehouse_id = $3`,
      [rep.tenantId, itemId, vanWarehouseId],
    );
    return (result.rows[0] as { qty: string } | undefined)?.qty ?? '0';
  };

  beforeAll(async () => {
    ctx = await createTestApp('rep-app-day');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    owner = await createActor(ctx, {
      tenantCode: 'rep-app-day',
      tenantName: 'مخابز يوم التطبيق',
      email: 'owner@rep-app-day.test',
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
      tenantCode: 'rep-app-day',
      email: 'accountant@rep-app-day.test',
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
      tenantCode: 'rep-app-day',
      email: 'rep@rep-app-day.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.collection.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['Rep'],
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
    itemId = newId();
    componentItemId = newId();
    partyId = newId();
    salesmanId = newId();
    paymentMethodId = newId();
    const repEmployeeId = newId();
    const baseUnitId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
        VALUES (${vanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'VAN-APP-1', 'سيارة تطبيق المندوب', false, true)
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG-APP', 'كيلوجرام', 'Kilogram')
      `);
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${newId()}::uuid, ${owner.tenantId}::uuid, 'CAT-APP', 'منتجات التطبيق')
      `);
      for (const [id, sku, name, cardPrice] of [
        [itemId, 'SKU-APP-1', 'خبز التطبيق', '6.5000'],
        [componentItemId, 'SKU-APP-F', 'دقيق التطبيق', '4.0000'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
                             purchase_price, sale_price, track_lot)
          VALUES (${id}::uuid, ${owner.tenantId}::uuid, ${sku}, ${name},
                  (SELECT id FROM item_categories WHERE tenant_id = ${owner.tenantId}::uuid LIMIT 1)::uuid,
                  ${baseUnitId}::uuid, 'stock', ${cardPrice}::numeric, ${cardPrice}::numeric, false)
        `);
      }
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 100000, 400000, 4.0000, 1)
      `);
      await tx.execute(sql`
        INSERT INTO parties (id, tenant_id, code, kind, name, tax_no, credit_limit)
        VALUES (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-APP-1', 'customer', 'بقالة التطبيق', '300000000000003', 10000)
      `);
      await tx.execute(sql`
        INSERT INTO payment_methods (id, tenant_id, code, name_ar, kind, is_active, is_default)
        VALUES (${paymentMethodId}::uuid, ${owner.tenantId}::uuid, 'CASH-APP', 'نقدي', 'cash', true, true)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-APP-1', 'مندوب التطبيق', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب التطبيق', true, ${repEmployeeId}::uuid, ${vanWarehouseId}::uuid, 'أ ب ج 4444')
      `);
    });

    // سعر عميل مقفول — كما تعرضه شاشة العملاء ويعتمده نموذج البيعة.
    const priceRow = await api(ctx.server, 'post', '/api/v1/van-sales/customer-prices', {
      token: accountant.token,
      body: {
        partyId,
        itemId,
        unitPrice: '6.50',
        maxBonusPct: '20',
        maxBonusKgPerInvoice: '5',
        creditLimit: '10000',
        changeReason: 'أسعار التطبيق',
      },
    });
    expect(priceRow.status, JSON.stringify(priceRow.body)).toBe(201);

    // عهدة واحدة غير مؤكدة الاستلام — أول عملية يبنيها التطبيق هي الاستلام.
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '500',
        components: [{ itemId: componentItemId, qty: '500' }],
        unitCost: '4.00',
        idempotencyKey: 'app-day-prod',
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
        loadedQty: '60',
        productionBatchNo: batchNo,
        idempotencyKey: 'app-day-load',
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    loadOrderId = supply.body.data.loadOrders[0].id as string;
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  // ── 1) السحب الأول ──────────────────────────────────────────────────────────

  it('serves the app\u2019s first pull: a snapshot with the open order and the locked price', async () => {
    const snapshot = await api(ctx.server, 'get', '/api/v1/field-sync/snapshot', {
      token: rep.token,
    });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
    const data = snapshot.body.data;

    expect(data.rep).toMatchObject({ salesmanId, warehouseId: vanWarehouseId, vehiclePlate: 'أ ب ج 4444' });
    expect(data.openLoadOrders.map((row: { id: string }) => row.id)).toContain(loadOrderId);
    expect(
      data.customerPrices.find((row: { partyId: string }) => row.partyId === partyId),
    ).toMatchObject({ itemId, unitPrice: '6.5000', lockPrice: true, maxBonusPct: '20.0000', maxBonusKgPerInvoice: '5.0000' });
    expect(data.paymentMethods.map((row: { id: string }) => row.id)).toContain(paymentMethodId);

    watermark = data.watermark as string;
    expect(watermark).toBeTruthy();
  });

  // ── 2) دفعة التطبيق الواحدة ─────────────────────────────────────────────────

  it('replays the app\u2019s single sequence-ordered batch: receipt → invoice → collection → return', async () => {
    const batch = [
      {
        offlineId: offlineId(1),
        deviceId: DEVICE,
        sequenceNo: 1,
        operation: 'receipt',
        createdAt: new Date().toISOString(),
        payload: { loadOrderId, receivedQty: '60.0000', notes: 'استلمت كامل الكمية' },
      },
      {
        offlineId: offlineId(2),
        deviceId: DEVICE,
        sequenceNo: 2,
        operation: 'invoice',
        createdAt: new Date().toISOString(),
        payload: {
          loadOrderId,
          partyId,
          itemId,
          invoiceMode: 'zatca_tax',
          paymentMethod: 'credit',
          soldQty: '15.0000',
          bonusQty: '2.0000',
          bonusReason: 'اتفاقية الأسبوع',
          unitPrice: '6.5000',
          notes: 'زيارة صباحية',
        },
      },
      {
        offlineId: offlineId(3),
        deviceId: DEVICE,
        sequenceNo: 3,
        operation: 'collection',
        createdAt: new Date().toISOString(),
        payload: { sourceOfflineId: offlineId(2), collectedAmount: '50.00', cashLocationId, notes: 'دفعة أولى' },
      },
      {
        offlineId: offlineId(4),
        deviceId: DEVICE,
        sequenceNo: 4,
        operation: 'return',
        createdAt: new Date().toISOString(),
        payload: { sourceOfflineId: offlineId(2), returnedQty: '3.0000', reason: 'قرب انتهاء الصلاحية', notes: 'بحالة جيدة' },
      },
    ];

    const replay = await api(ctx.server, 'post', '/api/v1/field-sync/replay', {
      token: rep.token,
      body: { deviceId: DEVICE, operations: batch },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    const data = replay.body.data;
    expect(data).toMatchObject({ processed: 4, synced: 4, conflicts: 0 });

    const [receipt, invoice, collection, returned] = data.results;

    // الاستلام: الأمر صار جاهزًا للبيع بالكمية المحمّلة نفسها.
    expect(receipt).toMatchObject({ status: 'synced', operation: 'receipt', loadOrderStatus: 'loaded', receivedQty: '60.0000' });

    // البيعة: مستند رسمي برقم VTX، وفاتورة مرحّلة من محرك المبيعات.
    expect(invoice).toMatchObject({ status: 'synced', operation: 'invoice' });
    expect(invoice.documentNumber).toMatch(/^VTX-/);
    expect(invoice.salesInvoiceId).toBeTruthy();
    invoiceDocumentId = invoice.documentId as string;
    invoiceDocumentNumber = invoice.documentNumber as string;

    // التحصيل على فاتورة نفس الجهاز: سند قبض مرحّل.
    expect(collection).toMatchObject({ status: 'synced', operation: 'collection' });
    expect(collection.voucherId).toBeTruthy();
    expect(collection.voucherNumber).toMatch(/^RV-/);

    // المرتجع عليها: مستند VRT يعيد الكمية للسيارة.
    expect(returned).toMatchObject({ status: 'synced', operation: 'return' });
    expect(returned.documentNumber).toMatch(/^VRT-/);

    // المخزون الرسمي: 60 مستلمة − 15 مباعة − 2 بونص + 3 مرتجعة = 46.
    expect(await vanQty()).toBe('46.0000');

    // التحصيل انعكس على المستند (المسار المختلط عبر sourceOfflineId).
    const paid = await pool.query(
      `SELECT paid_amount::text AS paid FROM van_sales_documents
       WHERE tenant_id = $1 AND id = $2`,
      [rep.tenantId, invoiceDocumentId],
    );
    expect(paid.rows[0]).toMatchObject({ paid: '50.0000' });

    // وسجل الخادم يعرض الصفوف كما تقرأها شاشة الطابور.
    const queue = await api(ctx.server, 'get', '/api/v1/field-sync/queue', { token: rep.token });
    expect(queue.status).toBe(200);
    const queueRows = queue.body.data as Array<{ offlineId: string; status: string }>;
    expect(queueRows.filter((row) => row.status === 'synced').map((row) => row.offlineId)).toEqual(
      expect.arrayContaining([offlineId(1), offlineId(2), offlineId(3), offlineId(4)]),
    );
  });

  it('is idempotent when the phone retries the whole batch after a crash', async () => {
    const batch = [
      { offlineId: offlineId(1), deviceId: DEVICE, sequenceNo: 1, operation: 'receipt', payload: { loadOrderId, receivedQty: '60.0000' } },
      {
        offlineId: offlineId(2),
        deviceId: DEVICE,
        sequenceNo: 2,
        operation: 'invoice',
        payload: { loadOrderId, partyId, itemId, invoiceMode: 'zatca_tax', paymentMethod: 'credit', soldQty: '15.0000', bonusQty: '2.0000', unitPrice: '6.5000' },
      },
      { offlineId: offlineId(3), deviceId: DEVICE, sequenceNo: 3, operation: 'collection', payload: { sourceOfflineId: offlineId(2), collectedAmount: '50.00', cashLocationId } },
      { offlineId: offlineId(4), deviceId: DEVICE, sequenceNo: 4, operation: 'return', payload: { sourceOfflineId: offlineId(2), returnedQty: '3.0000' } },
    ];
    const replay = await api(ctx.server, 'post', '/api/v1/field-sync/replay', {
      token: rep.token,
      body: { deviceId: DEVICE, operations: batch },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toMatchObject({ processed: 4, synced: 4, conflicts: 0 });
    for (const row of replay.body.data.results) {
      expect(row.resolution).toMatchObject({ action: 'remove-local-copy' });
    }
    // لم يتحرك شيء: لا مستند ثانٍ ولا مخزون إضافي.
    expect(await vanQty()).toBe('46.0000');
    const documents = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM van_sales_documents WHERE tenant_id = $1 AND idempotency_key = $2`,
      [rep.tenantId, `field-sync:${offlineId(2)}`],
    );
    expect((documents.rows[0] as { cnt: number }).cnt).toBe(1);
  });

  // ── 3) الدلتا بعد المزامنة ──────────────────────────────────────────────────

  it('shows the batch\u2019s effect to the app\u2019s next delta pull', async () => {
    const delta = await api(
      ctx.server,
      'get',
      `/api/v1/field-sync/delta?since=${encodeURIComponent(watermark)}`,
      { token: rep.token },
    );
    expect(delta.status, JSON.stringify(delta.body)).toBe(200);
    const data = delta.body.data;

    // الأمر في المسار، وأثر البيعة والبونص والمرتجع ظاهر في صفّه.
    const order = data.full.openLoadOrders.find((row: { id: string }) => row.id === loadOrderId);
    expect(order).toMatchObject({
      status: 'in_route',
      receivedQty: '60.0000',
      soldQty: '15.0000',
      bonusQty: '2.0000',
      returnedQty: '3.0000',
    });

    // والفاتورة في مستندات الائتمان المفتوحة بمتبقٍّها (112.125 − 50).
    const credit = data.full.openCreditDocuments.find((row: { id: string }) => row.id === invoiceDocumentId);
    expect(credit).toMatchObject({ number: invoiceDocumentNumber, paidAmount: '50.0000' });
    expect(Number(credit.outstanding)).toBeCloseTo(62.125, 3);
  });

  // ── 4) الإغلاق بجسد التطبيق ─────────────────────────────────────────────────

  it('accepts the app\u2019s closing body and surfaces the counted-vs-expected difference — never silently', async () => {
    // جسد شاشة الإغلاق حرفيًا: المرتجع السليم للمستودع 3 (مرتجع العميل)، والجرد
    // الفعلي 40 — الحساب: 60 − 15 مبيعًا − 2 بونص − 3 مرتجعًا = 40 متوقعًا = الجرد.
    const clean = await api(ctx.server, 'post', '/api/v1/rep-workspace/closing', {
      token: rep.token,
      body: {
        loadOrderId,
        returnedQty: '3.0000',
        damagedQty: '0.0000',
        collectedCash: '50.00',
        actualRemainingQty: '40.0000',
        closingNotes: 'إغلاق من التطبيق — الجرد مطابق',
      },
    });
    expect(clean.status, JSON.stringify(clean.body)).toBe(201);
    const orderRow = await pool.query(
      `SELECT status, actual_remaining_qty::text AS remaining, shortage_qty::text AS shortage,
              shortage_policy_status
       FROM van_load_orders WHERE id = $1 AND tenant_id = $2`,
      [loadOrderId, rep.tenantId],
    );
    expect(orderRow.rows[0]).toMatchObject({
      status: 'pending_closing',
      remaining: '40.0000',
      shortage: '0.0000',
    });

    // الجرد المعلن محفوظ كما أرسله التطبيق — المحاسب يرى الرقمين جنبًا إلى جنب.
    const closingNotes = await pool.query(
      `SELECT closing_notes, returned_qty::text AS returned FROM van_load_orders
       WHERE id = $1 AND tenant_id = $2`,
      [loadOrderId, rep.tenantId],
    );
    expect(closingNotes.rows[0]).toMatchObject({ closing_notes: 'إغلاق من التطبيق — الجرد مطابق', returned: '3.0000' });
  });

  it('refuses to settle a shortage silently: the count gap goes to the accountant (D-008)', async () => {
    // عهدة ثانية: 20 كجم، لا مبيعات — المتوقع 20، والجرد 18 → عجز 2 معلن.
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '50',
        components: [{ itemId: componentItemId, qty: '50' }],
        unitCost: '4.00',
        idempotencyKey: 'app-day-shortage-prod',
      },
    });
    expect(production.status).toBe(201);
    const batchNo = production.body.data.productionBatches[0].batchNo as string;
    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '20',
        productionBatchNo: batchNo,
        idempotencyKey: 'app-day-shortage-load',
      },
    });
    expect(supply.status).toBe(201);
    const shortageOrderId = supply.body.data.loadOrders[0].id as string;

    const confirm = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${shortageOrderId}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: '20', notes: 'استلام' } },
    );
    expect(confirm.status).toBe(201);

    const closing = await api(ctx.server, 'post', '/api/v1/rep-workspace/closing', {
      token: rep.token,
      body: {
        loadOrderId: shortageOrderId,
        returnedQty: '0.0000',
        damagedQty: '0.0000',
        collectedCash: '0.00',
        actualRemainingQty: '18.0000',
        closingNotes: 'الجرد أقل من المتوقع — للعرض على المحاسب',
      },
    });
    expect(closing.status, JSON.stringify(closing.body)).toBe(201);

    const orderRow = await pool.query(
      `SELECT status, actual_remaining_qty::text AS remaining, shortage_qty::text AS shortage,
              shortage_policy_status
       FROM van_load_orders WHERE id = $1 AND tenant_id = $2`,
      [shortageOrderId, rep.tenantId],
    );
    // العجز مسجّل (2) وسياسته معلّقة لقرار المحاسب — لا تسوية صامتة أبدًا.
    expect(orderRow.rows[0]).toMatchObject({
      status: 'pending_closing',
      remaining: '18.0000',
      shortage: '2.0000',
      shortage_policy_status: 'pending_policy_approval',
    });
  });

  // ── 5) قراءة اليوم ──────────────────────────────────────────────────────────

  it('aggregates the app\u2019s day for the home screen', async () => {
    const day = await api(ctx.server, 'get', '/api/v1/rep-workspace/day', { token: rep.token });
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    const data = day.body.data;

    expect(data.salesmanId).toBe(salesmanId);
    expect(data.documents.map((row: { number: string }) => row.number)).toEqual(
      expect.arrayContaining([invoiceDocumentNumber]),
    );
    expect(data.collections.map((row: { amount: string }) => row.amount)).toContain('50.00');
    expect(data.totals.documents).toBeGreaterThanOrEqual(1);
  });
});
