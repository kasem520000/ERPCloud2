import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * اختبارات القبول المتكاملة لدورة المصنع → التوريد → البيع → التحصيل → إغلاق العهدة.
 *
 * Every assertion reads the **official** ledger (`stock_balances`, `inventory_transactions`,
 * `sales_invoices`, `vouchers`, `invoice_payments`) — never the add-on table — because the
 * acceptance criterion is that the unified ERP balances move, not that a parallel table got
 * a row. Balances are printed before and after each step.
 */
describe('Van Sales end-to-end acceptance on official stock & accounting ledgers', () => {
  let ctx: TestApp;
  let owner: Actor;
  let accountant: Actor;
  let rep: Actor;
  let otherRep: Actor;

  let branchId: string;
  let mainWarehouseId: string;
  let vanWarehouseId: string;
  let otherVanWarehouseId: string;
  let itemId: string;
  /** 🌾 مكوّن الإنتاج — (ب): لا دفعة إنتاج بلا مصدر مواد (BOM أو مكوّنات). */
  let componentItemId: string;
  let partyId: string;
  let cashLocationId: string;
  let repEmployeeId: string;
  let otherRepEmployeeId: string;
  let salesmanId: string;
  let otherSalesmanId: string;

  /** Official balance of `itemId` in `warehouseId`, read from `stock_balances`. */
  async function officialBalance(warehouseId: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(quantity, 0)::text AS qty
        FROM stock_balances
        WHERE tenant_id = ${owner.tenantId}::uuid
          AND item_id = ${itemId}::uuid
          AND warehouse_id = ${warehouseId}::uuid
      `);
      const row = (rows as { rows: Array<{ qty: string }> }).rows[0];
      return row ? Number(row.qty) : 0;
    });
  }

  /**
   * حركات الإدخال الرسمية للصنف المنتج في مستودع — «كم مرة دخلت الكمية إلى الدفتر فعلاً».
   * الدفعة لم تعد تسجّل الحركة بنفسها حين يستلمها أمر إنتاج رسمي، فالعدد يُقاس قبل وبعد
   * (لا مطلقاً) لأن مستودعات هذا الملف مشتركة بين حالاته.
   */
  async function officialInMovements(warehouseId: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM inventory_transactions
        WHERE tenant_id = ${owner.tenantId}::uuid
          AND item_id = ${itemId}::uuid
          AND warehouse_id = ${warehouseId}::uuid
          AND direction = 'in'
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
  }

  async function officialTxCount(docType: string): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM inventory_transactions
        WHERE tenant_id = ${owner.tenantId}::uuid AND doc_type = ${docType}
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp('van-sales-acceptance');
    owner = await createActor(ctx, {
      tenantCode: 'accept-bakery',
      tenantName: 'مخابز القبول',
      email: 'owner@accept-bakery.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'sales.view',
        'sales.invoice.create',
        'sales.salesman.manage',
        'accounting.period.close',
        'accounting.reports.view',
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.pricing.manage',
        'van_sales.load.manage',
        'van_sales.invoice.create',
        'van_sales.collection.create',
        'van_sales.closing.submit',
        'van_sales.closing.approve',
        'van_sales.override.approve',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });

    accountant = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'accept-bakery',
      email: 'accountant@accept-bakery.test',
      permissions: [
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
        'van_sales.collection.create',
        'van_sales.closing.approve',
        'van_sales.override.approve',
        'sales.view',
        'sales.invoice.create',
      ],
      roleNames: ['Accountant'],
      isOwner: false,
    });

    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'accept-bakery',
      email: 'rep1@accept-bakery.test',
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
      tenantCode: 'accept-bakery',
      email: 'rep2@accept-bakery.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['Rep2'],
      isOwner: false,
    });

    /**
     * منشأة مُهيّأة بالكامل — `OrgProvisioningService.provisionOrgDefaults` is the same
     * official seam the platform uses for every real tenant: it creates the chart of
     * accounts, the tenant-wide posting profile, the main branch, the main warehouse and the
     * main safe. Without it no official document can post, and the point of this suite is to
     * prove the *official* ledger moves — so the tenant is configured the way production is.
     */
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
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
    otherVanWarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    partyId = newId();
    repEmployeeId = newId();
    otherRepEmployeeId = newId();
    salesmanId = newId();
    otherSalesmanId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO company_profiles (tenant_id, name_ar, tax_no)
        VALUES (${owner.tenantId}::uuid, 'مخابز القبول', '300000000000003')
        ON CONFLICT (tenant_id) DO UPDATE SET name_ar = EXCLUDED.name_ar, tax_no = EXCLUDED.tax_no
      `);
      await tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
        VALUES
          (${vanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'WH-VAN-1', 'سيارة المندوب الأول', false, true),
          (${otherVanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'WH-VAN-2', 'سيارة المندوب الثاني', false, true)
      `);
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-BAKERY', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${itemId}::uuid, ${owner.tenantId}::uuid, 'SKU-SAMBOSA', 'سمبوسة بلدي', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 3.8000, 6.5000, false)
      `);
      // 🌾 مكوّن الإنتاج ورصيده الرسمي بمتوسط 3.80 — every batch here consumes 1:1, so the
      // official order charges exactly the cost this suite always asserted.
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${componentItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-FLOUR', 'دقيق أبيض', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 3.8000, 3.8000, false)
      `);
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 1000000, 3800000, 3.8000, 1)
      `);
      await tx.execute(sql`
        INSERT INTO parties (id, tenant_id, code, kind, name, tax_no, credit_limit)
        VALUES (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-01', 'customer', 'تموينات النور', '300000000000003', 5000)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-001', 'المندوب الأول', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES (${otherRepEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-002', 'المندوب الثاني', ${branchId}::uuid, ${otherRep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES
          (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'المندوب الأول', true, ${repEmployeeId}::uuid, ${vanWarehouseId}::uuid, 'أ ب ج 1234'),
          (${otherSalesmanId}::uuid, ${owner.tenantId}::uuid, 'المندوب الثاني', true, ${otherRepEmployeeId}::uuid, ${otherVanWarehouseId}::uuid, 'د هـ و 5678')
      `);
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('moves official stock through production → transfer → sale → collection → closing', async () => {
    // ── Step 0: opening balances ─────────────────────────────────────────────
    const mainBefore = await officialBalance(mainWarehouseId);
    const vanBefore = await officialBalance(vanWarehouseId);
    expect(mainBefore).toBe(0);
    expect(vanBefore).toBe(0);

    // ── Step 1: produce 50 kg of saleable product ───────────────────────────
    // The UI sends only what the operator typed; the service must still land the
    // quantity in the official main-warehouse balance (acceptance criterion).
    const inBefore = await officialInMovements(mainWarehouseId);
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '50',
        scrapQty: '2',
        // 🗑️ الفاقد لا يُرحَّل بلا سبب: كميته وسببه ودفعته تُسجَّل معاً.
        scrapReason: 'عجين زائد احترق في الفرن الأول',
        // 🌾 مصدر المواد رسمي: أمر إنتاج يستهلك 50 كجم دقيقاً بمتوسط 3.80.
        components: [{ itemId: componentItemId, qty: '50' }],
        unitCost: '3.80',
        supervisorName: 'مشرف الإنتاج',
        notes: 'دفعة القبول',
        idempotencyKey: 'acc-prod-1',
      },
    });
    expect(production.status, JSON.stringify(production.body)).toBe(201);

    const mainAfterProduction = await officialBalance(mainWarehouseId);
    expect(mainAfterProduction).toBe(50);
    // الحركة الرسمية واحدة وسجّلها أمر الإنتاج، والدفعة تشير إليها ولا تكررها.
    expect(await officialInMovements(mainWarehouseId) - inBefore).toBe(1);
    expect(await officialTxCount('factory_production_batch')).toBe(0);
    expect(production.body.data.productionBatches[0].inventoryTransactionId).toBeTruthy();

    // ── Step 2: replaying the same production must not double-count ─────────
    const replay = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '50',
        scrapQty: '2',
        scrapReason: 'عجين زائد احترق في الفرن الأول',
        components: [{ itemId: componentItemId, qty: '50' }],
        unitCost: '3.80',
        idempotencyKey: 'acc-prod-1',
      },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(await officialBalance(mainWarehouseId)).toBe(50);
    // الإعادة لم تُدخل الكمية مرة ثانية.
    expect(await officialInMovements(mainWarehouseId) - inBefore).toBe(1);
    expect(await officialTxCount('factory_production_batch')).toBe(0);

    // ── Step 3: supply 20 kg to the rep's van warehouse ─────────────────────
    const loadOrder = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '20',
        productionBatchNo: production.body.data.productionBatches[0].batchNo,
        notes: 'توريد عهدة المندوب الأول',
        idempotencyKey: 'acc-load-1',
      },
    });
    expect(loadOrder.status, JSON.stringify(loadOrder.body)).toBe(201);
    const loadOrderId: string = loadOrder.body.data.loadOrders[0].id;

    // Sent but not yet received: custody must NOT appear on the van before the rep confirms.
    expect(loadOrder.body.data.loadOrders[0].status).toBe('pending_receipt');
    expect(await officialBalance(mainWarehouseId)).toBe(30);
    expect(await officialBalance(vanWarehouseId)).toBe(0);

    // Replaying the supply must not create a second transfer.
    const loadReplay = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '20',
        productionBatchNo: production.body.data.productionBatches[0].batchNo,
        idempotencyKey: 'acc-load-1',
      },
    });
    expect(loadReplay.status, JSON.stringify(loadReplay.body)).toBe(201);
    expect(await officialBalance(mainWarehouseId)).toBe(30);

    // No custody ⇒ no sale: the goods are officially still in transit, so the rep cannot
    // invoice from a load order he has not confirmed receiving.
    const saleBeforeReceipt = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: rep.token,
      body: {
        loadOrderId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'credit',
        soldQty: '1',
        unitPrice: '6.50',
        idempotencyKey: 'acc-sale-too-early',
      },
    });
    expect(saleBeforeReceipt.status, JSON.stringify(saleBeforeReceipt.body)).toBe(409);
    const refusal = saleBeforeReceipt.body as { code?: string; error?: { code?: string } };
    expect(refusal.code ?? refusal.error?.code).toBe('VAN_LOAD_ORDER_NOT_RECEIVED');
    expect(await officialBalance(vanWarehouseId)).toBe(0);

    // ── Step 4: the rep sees the pending supply and confirms 20 kg ──────────
    const meBefore = await api(ctx.server, 'get', '/api/v1/van-sales/me', { token: rep.token });
    expect(meBefore.status, JSON.stringify(meBefore.body)).toBe(200);
    expect(meBefore.body.data.salesmanId).toBe(salesmanId);
    expect(meBefore.body.data.pendingReceipts).toHaveLength(1);
    expect(Number(meBefore.body.data.custodyKg)).toBe(0);

    const confirm = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      {
        token: rep.token,
        body: { receivedQty: '20', notes: 'تم الاستلام كاملاً' },
      },
    );
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);

    expect(await officialBalance(vanWarehouseId)).toBe(20);
    expect(await officialBalance(mainWarehouseId)).toBe(30);

    // Confirming twice must be refused and must not move stock again.
    const confirmTwice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: '20' } },
    );
    expect(confirmTwice.status).toBe(409);
    expect(await officialBalance(vanWarehouseId)).toBe(20);

    // A rep may never touch another rep's load order.
    const crossRep = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: otherRep.token, body: { receivedQty: '20' } },
    );
    expect(crossRep.status).toBe(403);

    // ── Step 5: sell 12 kg + 1 kg free bonus ────────────────────────────────
    const sale = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: rep.token,
      body: {
        loadOrderId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'credit',
        soldQty: '12',
        bonusQty: '1',
        bonusReason: 'ترويجي',
        unitPrice: '6.50',
        idempotencyKey: 'acc-sale-1',
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);

    // Both the sold and the free quantity leave the van's official balance.
    expect(await officialBalance(vanWarehouseId)).toBe(7);

    const document = sale.body.data.documents[0];
    expect(document.salesInvoiceId, 'the document must be linked to an official sales invoice').toBeTruthy();
    expect(document.invoiceNumber, 'the official invoice must be numbered on posting').toBeTruthy();
    // 12 × 6.50 = 78.00 + 15% VAT = 89.70
    expect(document.subtotal).toBe('78.00');
    expect(document.taxTotal).toBe('11.70');
    expect(document.total).toBe('89.70');

    // Replaying the sale must not issue a second invoice nor deduct stock twice.
    const saleReplay = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: rep.token,
      body: {
        loadOrderId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'credit',
        soldQty: '12',
        bonusQty: '1',
        unitPrice: '6.50',
        idempotencyKey: 'acc-sale-1',
      },
    });
    expect(saleReplay.status, JSON.stringify(saleReplay.body)).toBe(201);
    expect(await officialBalance(vanWarehouseId)).toBe(7);

    const invoices = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id::text, number, status, total::text, paid_total::text, payment_status
        FROM sales_invoices
        WHERE tenant_id = ${owner.tenantId}::uuid
        ORDER BY created_at ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('posted');
    expect(invoices[0].total).toBe('89.7000');

    // ── Step 6: printable document view (two copies of ONE invoice) ─────────
    const printView = await api(
      ctx.server,
      'get',
      `/api/v1/van-sales/documents/${document.id}/print-view`,
      { token: rep.token },
    );
    expect(printView.status, JSON.stringify(printView.body)).toBe(200);
    expect(printView.body.data.copies).toHaveLength(2);
    expect(printView.body.data.copies[0].kind).toBe('customer');
    expect(printView.body.data.copies[1].kind).toBe('rep');
    expect(printView.body.data.copies[1].requiresCustomerSignature).toBe(true);
    expect(printView.body.data.printedAt).toBeTruthy();
    expect(printView.body.data.companyName).toBe('مخابز القبول');

    // ── Step 7: collect part of the debt through an official receipt voucher ─
    const collection = await api(ctx.server, 'post', '/api/v1/van-sales/collections', {
      token: rep.token,
      body: {
        documentId: document.id,
        collectedAmount: '40.00',
        cashLocationId,
        notes: 'دفعة أولى',
        idempotencyKey: 'acc-collect-1',
      },
    });
    expect(collection.status, JSON.stringify(collection.body)).toBe(201);

    const vouchers = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id::text, kind, amount::text, status FROM vouchers
        WHERE tenant_id = ${owner.tenantId}::uuid ORDER BY created_at ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].kind).toBe('receipt');
    expect(vouchers[0].amount).toBe('40.0000');

    const invoiceAfterCollection = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT paid_total::text, payment_status FROM sales_invoices
        WHERE tenant_id = ${owner.tenantId}::uuid LIMIT 1
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows[0];
    });
    expect(invoiceAfterCollection.paid_total).toBe('40.0000');
    expect(invoiceAfterCollection.payment_status).toBe('partial');

    // Replaying the collection must not double-post.
    const collectionReplay = await api(ctx.server, 'post', '/api/v1/van-sales/collections', {
      token: rep.token,
      body: {
        documentId: document.id,
        collectedAmount: '40.00',
        cashLocationId,
        idempotencyKey: 'acc-collect-1',
      },
    });
    expect(collectionReplay.status, JSON.stringify(collectionReplay.body)).toBe(201);
    expect(
      await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
        const rows = await tx.execute(sql`
          SELECT COUNT(*)::int AS cnt FROM vouchers WHERE tenant_id = ${owner.tenantId}::uuid
        `);
        return (rows as { rows: Array<{ cnt: number }> }).rows[0].cnt;
      }),
    ).toBe(1);

    // A rep cannot read another rep's workspace: the second rep is a real rep with his own
    // card and van, and his workspace is empty while the first one's is full.
    const otherMe = await api(ctx.server, 'get', '/api/v1/van-sales/me', { token: otherRep.token });
    expect(otherMe.status, JSON.stringify(otherMe.body)).toBe(200);
    expect(otherMe.body.data.isRep).toBe(true);
    expect(otherMe.body.data.salesmanId).toBe(otherSalesmanId);
    expect(Number(otherMe.body.data.custodyKg)).toBe(0);
    expect(otherMe.body.data.documents).toHaveLength(0);
    expect(otherMe.body.data.loadOrders).toHaveLength(0);
    expect(otherMe.body.data.collections).toHaveLength(0);

    // ── Step 8: the rep submits the shift closing ───────────────────────────
    const submit = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`,
      {
        token: rep.token,
        body: {
          returnedQty: '5',
          damagedQty: '1',
          damageReason: 'تلف أثناء النقل',
          collectedCash: '40.00',
          // 🧮 الجرد الفعلي: بقي في السيارة نصف كيلو فقط بينما تقول المستندات إنه يجب أن يبقى كيلو.
          actualRemainingQty: '0.5',
          closingNotes: 'جرد نهاية الوردية',
        },
      },
    );
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    expect(submit.body.data.loadOrders[0].status).toBe('pending_closing');

    // Expected (documents) vs. actual (physical count) is computed by the server, and the
    // half kilogram the rep cannot show is the shortage the accountant has to review.
    const pending = submit.body.data.loadOrders[0] as Record<string, string>;
    expect(pending.expectedRemainingQty).toBe('1.00');
    expect(pending.actualRemainingQty).toBe('0.50');
    expect(pending.countVarianceQty).toBe('0.50');
    expect(pending.shortageQty).toBe('0.50');
    // The financial treatment of a shortage is an undecided policy: it is recorded, never posted.
    expect(pending.shortagePolicyStatus).toBe('pending_policy_approval');

    // ── Step 9: the accountant cannot approve without damage inspection ─────
    const rejectWithoutInspection = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      { token: accountant.token, body: { returnedQty: '5', damagedQty: '1' } },
    );
    expect(rejectWithoutInspection.status).toBe(422);

    // 🧮 A count that leaves kilograms in the van needs an explicit decision about them: the
    // custody may not be closed while 0.5 kg sit in the vehicle with no destination.
    const approveWithoutDecision = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: { returnedQty: '5', damagedQty: '1', damageInspected: true },
      },
    );
    expect(approveWithoutDecision.status).toBe(422);
    expect(
      (approveWithoutDecision.body as { code?: string }).code,
    ).toBe('VAN_CLOSING_REMAINING_ACTION_REQUIRED');

    const approve = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: {
          returnedQty: '5',
          damagedQty: '1',
          collectedCash: '40.00',
          damageInspected: true,
          salaryDeductionApproved: false,
          notes: 'تم الفحص والاعتماد',
          // نصف الكيلو الذي عاد مع المندوب يبقى عهدة الوردية التالية — قرار صريح لا افتراض.
          remainingAction: 'carry_over',
        },
      },
    );
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);

    // Good stock is back in the main warehouse, damaged stock left the van.
    expect(await officialBalance(mainWarehouseId)).toBe(35);
    /**
     * ⚠️ الرصيد الرسمي ما زال 1 كجم بينما الجرد الفعلي 0.5 — وهذا سبب وجود الحالة الجديدة:
     * الاعتماد وحده لم يعد يُغلق العهدة، لأن نصف كيلو ما زال في دفتر المخزون بلا تسوية.
     */
    expect(await officialBalance(vanWarehouseId)).toBe(1);
    const approvedOrder = (
      approve.body.data as {
        loadOrders: Array<{
          id: string;
          status: string;
          stockSettlementStatus: string;
          stockAdjustmentId: string | null;
          awaitingStockSettlement: boolean;
        }>;
      }
    ).loadOrders.find((row) => row.id === loadOrderId)!;
    expect(approvedOrder.status).toBe('pending_stock_settlement');
    expect(approvedOrder.awaitingStockSettlement).toBe(true);
    expect(approvedOrder.stockSettlementStatus).toBe('pending_count_decision');
    expect(approvedOrder.stockAdjustmentId).toBeTruthy();

    // مستند الجرد الرسمي مسودة: يحمل العدّ، ولا يرحّل شيئاً قبل التفويض.
    const draftCount = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT a.status, a.reason, l.counted_qty::text, l.expected_qty::text
        FROM stock_adjustments a
        JOIN stock_adjustment_lines l ON l.adjustment_id = a.id
        WHERE a.id = ${approvedOrder.stockAdjustmentId}::uuid
          AND a.tenant_id = ${owner.tenantId}::uuid
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows[0]!;
    });
    expect(draftCount.status).toBe('draft');
    expect(Number(draftCount.counted_qty)).toBeCloseTo(0.5, 4);
    expect(draftCount.reason).toContain('المتوقع 1.00 مقابل الفعلي 0.50');
    expect(await officialTxCount('stock_adjustment')).toBe(0);

    // ── Step 9b: the damage write-off is one official balanced journal, the shortage is none ──
    const closingAccounting = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const profileRows = await tx.execute(sql`
        SELECT mapping::text FROM branch_posting_profiles
        WHERE tenant_id = ${owner.tenantId}::uuid AND doc_type = '*'
        LIMIT 1
      `);
      const mapping = JSON.parse(
        (profileRows as { rows: Array<{ mapping: string }> }).rows[0]?.mapping ?? '{}',
      ) as Record<string, string>;
      const entryRows = await tx.execute(sql`
        SELECT e.id::text, e.number, l.account_id::text, l.debit::text, l.credit::text
        FROM journal_entries e
        JOIN journal_entry_lines l ON l.entry_id = e.id
        WHERE e.tenant_id = ${owner.tenantId}::uuid
          AND e.source_type = 'van_load_order'
          AND e.source_id = ${loadOrderId}::uuid
      `);
      const damageTx = await tx.execute(sql`
        SELECT total_cost::text FROM inventory_transactions
        WHERE tenant_id = ${owner.tenantId}::uuid
          AND doc_type = 'van_damage_writeoff'
          AND doc_id = ${loadOrderId}::uuid
        LIMIT 1
      `);
      return {
        mapping,
        lines: (entryRows as { rows: Array<Record<string, string>> }).rows,
        damageCost:
          (damageTx as { rows: Array<{ total_cost: string }> }).rows[0]?.total_cost ?? null,
      };
    });

    // One entry, two lines, balanced, and equal to what the stock ledger actually cost.
    expect(closingAccounting.damageCost).not.toBeNull();
    expect(closingAccounting.lines).toHaveLength(2);
    const debitLine = closingAccounting.lines.find((line) => Number(line.debit) > 0)!;
    const creditLine = closingAccounting.lines.find((line) => Number(line.credit) > 0)!;
    expect(Number(debitLine.debit)).toBeCloseTo(Number(closingAccounting.damageCost), 4);
    expect(Number(creditLine.credit)).toBeCloseTo(Number(closingAccounting.damageCost), 4);
    // Dr تسوية المخزون / Cr المخزون — both accounts come from the tenant's own posting profile.
    expect(debitLine.account_id).toBe(closingAccounting.mapping.inventoryAdjustmentAccountId);
    expect(creditLine.account_id).toBe(closingAccounting.mapping.inventoryAccountId);

    // ── Step 9c: the authorised approver settles the count officially ────────
    // This is the guarantee the audit asked for: at the completion of the settlement the
    // official van balance equals the physical count, while the financial responsibility for
    // the missing half kilogram stays exactly where it was — pending, on nobody's salary.
    const settle = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(settle.status, JSON.stringify(settle.body)).toBe(201);
    const settled = (
      settle.body.data as {
        loadOrders: Array<{
          id: string;
          status: string;
          stockSettlementStatus: string;
          shortagePolicyStatus: string;
          shortageQty: string;
        }>;
      }
    ).loadOrders.find((row) => row.id === loadOrderId)!;
    expect(settled.status).toBe('settled');
    expect(settled.stockSettlementStatus).toBe('settled_officially');

    // 1) الكمية: رصيد السيارة الرسمي = الجرد الفعلي (0.5) لا رصيد المستندات (1).
    expect(await officialBalance(vanWarehouseId)).toBe(0.5);
    expect(await officialBalance(mainWarehouseId)).toBe(35);
    expect(await officialTxCount('stock_adjustment')).toBe(1);

    // 2) الإثبات والقيمة على المستند الرسمي، 3) المسؤولية ما زالت معلّقة.
    expect(settled.shortageQty).toBe('0.50');
    expect(settled.shortagePolicyStatus).toBe('pending_policy_approval');
    const postedCount = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT a.status, a.journal_entry_id::text, l.expected_qty::text, l.counted_qty::text,
               l.variance_qty::text, l.variance_value::text
        FROM stock_adjustments a
        JOIN stock_adjustment_lines l ON l.adjustment_id = a.id
        WHERE a.id = ${approvedOrder.stockAdjustmentId}::uuid
          AND a.tenant_id = ${owner.tenantId}::uuid
      `);
      const lineRows = (rows as { rows: Array<Record<string, string>> }).rows[0]!;
      const entryRows = await tx.execute(sql`
        SELECT l.account_id::text, l.debit::text, l.credit::text
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.tenant_id = ${owner.tenantId}::uuid
          AND e.source_type = 'stock_adjustment'
          AND e.source_id = ${approvedOrder.stockAdjustmentId}::uuid
      `);
      const payrollRows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM journal_entry_lines l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.tenant_id = ${owner.tenantId}::uuid
          AND (a.name_ar LIKE '%رواتب%' OR a.name_ar LIKE '%موظف%' OR a.name_ar LIKE '%عهدة%')
      `);
      return {
        adjustment: lineRows,
        lines: (entryRows as { rows: Array<Record<string, string>> }).rows,
        payrollLines:
          (payrollRows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0,
        mapping: closingAccounting.mapping,
      };
    });
    expect(postedCount.adjustment.status).toBe('posted');
    expect(postedCount.adjustment.journal_entry_id).toBeTruthy();
    expect(Number(postedCount.adjustment.expected_qty)).toBeCloseTo(1, 4);
    expect(Number(postedCount.adjustment.counted_qty)).toBeCloseTo(0.5, 4);
    expect(Number(postedCount.adjustment.variance_qty)).toBeCloseTo(-0.5, 4);
    expect(Number(postedCount.adjustment.variance_value)).toBeGreaterThan(0);
    // 4) الاعتماد: قيد واحد متوازن على حسابي ملف الترحيل — ولا سطر واحد على راتب أو ذمة موظف.
    expect(postedCount.lines).toHaveLength(2);
    const countDebit = postedCount.lines.find((line) => Number(line.debit) > 0)!;
    const countCredit = postedCount.lines.find((line) => Number(line.credit) > 0)!;
    expect(countDebit.account_id).toBe(postedCount.mapping.inventoryAdjustmentAccountId);
    expect(countCredit.account_id).toBe(postedCount.mapping.inventoryAccountId);
    expect(Number(countDebit.debit)).toBeCloseTo(
      Number(postedCount.adjustment.variance_value),
      4,
    );
    expect(postedCount.payrollLines).toBe(0);

    // ── Step 10: the closing cannot be approved twice, nor settled twice ─────
    const approveTwice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      { token: accountant.token, body: { damageInspected: true } },
    );
    expect(approveTwice.status).toBe(409);
    const settleTwice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(settleTwice.status).toBe(409);
    expect(await officialBalance(vanWarehouseId)).toBe(0.5);
    expect(await officialBalance(mainWarehouseId)).toBe(35);
    expect(await officialTxCount('stock_adjustment')).toBe(1);

    // ── Step 11: the official ledger balances ───────────────────────────────
    const ledger = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT doc_type, direction, COUNT(*)::int AS cnt, SUM(qty)::text AS qty
        FROM inventory_transactions
        WHERE tenant_id = ${owner.tenantId}::uuid
        GROUP BY doc_type, direction
        ORDER BY doc_type, direction
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
    /**
     * الإنتاج صار له مصدر مواد رسمي: الدفعة تمرّ عبر أمر إنتاج رسمي يصرف المكوّن ويستلم
     * الناتج، فالحركتان في الدفتر باسم `production_order` — والدفعة الإضافية لا تسجّل
     * حركةً ثانية لنفس الكمية (تسجيلها مرتين يضاعف الرصيد).
     */
    const produced = ledger.find(
      (row) => row.doc_type === 'production_order' && row.direction === 'in',
    );
    expect(produced?.qty).toBe('50.0000');
    const materials = ledger.find(
      (row) => row.doc_type === 'production_order' && row.direction === 'out',
    );
    expect(materials?.qty).toBe('50.0000');
    expect(ledger.find((row) => row.doc_type === 'factory_production_batch')).toBeUndefined();
    const consumed = ledger
      .filter((row) => row.doc_type === 'sales_invoice')
      .reduce((sum, row) => sum + Number(row.qty), 0);
    expect(consumed).toBe(13);
  });

  /**
   * 🔁 إعادة إنتاج العطل المبلَّغ — the screen used to post production with no warehouse and
   * no item link, and the batch row was written while `stock_balances` never moved. This is
   * the payload the UI actually sent, and the balance must grow by exactly the produced
   * quantity, resolved into the tenant's official default warehouse.
   */
  it('lands production in the official balance even when the screen names no warehouse', async () => {
    const before = await officialBalance(mainWarehouseId);

    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        producedQty: '30',
        scrapQty: '1.5',
        scrapReason: 'قطع مكسورة أثناء التشكيل',
        components: [{ itemId: componentItemId, qty: '30' }],
        supervisorName: 'مشرف الإنتاج',
        idempotencyKey: 'acc-prod-no-warehouse',
      },
    });
    expect(production.status, JSON.stringify(production.body)).toBe(201);

    const after = await officialBalance(mainWarehouseId);
    expect(after - before).toBe(30);

    // The batch itself carries the resolved warehouse and the official movement id.
    const batch = production.body.data.productionBatches[0];
    expect(batch.warehouseId).toBe(mainWarehouseId);
    expect(batch.inventoryTransactionId).toBeTruthy();
    expect(batch.scrapQty).toBe('1.50');
    // The dashboard's headline balance is the official one, not a derived figure.
    expect(production.body.data.summary.mainWarehouseBalanceKg).toBe(after.toFixed(2));
    expect(production.body.data.officialStock.length).toBeGreaterThan(0);

    // A production batch with no registered item is refused, not silently accepted.
    const noItem = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: { itemName: 'صنف غير مسجل', producedQty: '10' },
    });
    expect(noItem.status).toBe(422);
    expect(await officialBalance(mainWarehouseId)).toBe(after);
  });

  it('manages distribution reps: card, employee link, login account and van scope', async () => {
    // The rep screen reads the official salesmen card with its employee, login and custody.
    const list = await api(ctx.server, 'get', '/api/v1/van-sales/salesmen', { token: owner.token });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const reps = list.body.data as Array<{
      id: string;
      name: string;
      employeeId: string | null;
      membershipId: string | null;
      warehouseId: string | null;
      vehiclePlate: string | null;
      custody: { openLoadOrders: number; custodyQty: string };
      readiness: Record<string, boolean>;
    }>;
    const first = reps.find((row) => row.id === salesmanId)!;
    expect(first.employeeId).toBe(repEmployeeId);
    expect(first.membershipId).toBe(rep.membershipId);
    expect(first.warehouseId).toBe(vanWarehouseId);
    expect(first.vehiclePlate).toBe('أ ب ج 1234');
    expect(first.readiness.hasEmployee).toBe(true);
    expect(first.readiness.hasLoginAccount).toBe(true);
    expect(first.readiness.hasVanWarehouse).toBe(true);

    // The second rep has no login yet: linking creates the official user + membership,
    // puts it on the rep role and scopes it to his own van warehouse.
    const second = reps.find((row) => row.id === otherSalesmanId)!;
    expect(second.membershipId).toBe(otherRep.membershipId);

    const link = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/salesmen/${otherSalesmanId}/account`,
      {
        token: owner.token,
        body: {
          email: 'rep2.login@accept-bakery.test',
          fullName: 'المندوب الثاني',
          restrictToVanWarehouse: true,
        },
      },
    );
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body.data.roleName).toBe('مندوب توزيع');
    expect(link.body.data.scopedToVanWarehouse).toBe(true);
    /**
     * حساب واحد للشخص الواحد — the employee card already owned a membership, so that login is
     * reused (role + van scope applied to it) rather than a second account being invented.
     */
    expect(link.body.data.reusedExistingAccount).toBe(true);
    expect(link.body.data.email).toBe('rep2@accept-bakery.test');
    expect(link.body.data.membershipId).toBe(otherRep.membershipId);

    // The link went through the platform's own writers: a membership + role + warehouse scope.
    const stored = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT m.id::text AS membership_id, m.status, u.email,
               (SELECT count(*)::int FROM membership_roles mr WHERE mr.membership_id = m.id) AS roles,
               (SELECT count(*)::int FROM membership_role_scopes mrs
                 WHERE mrs.membership_id = m.id AND mrs.scope_type = 'warehouse'
                   AND mrs.scope_id = ${otherVanWarehouseId}::uuid) AS van_scopes
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.id = ${link.body.data.membershipId}::uuid
      `);
      return (rows as { rows: Array<Record<string, unknown>> }).rows[0];
    });
    expect(stored.email).toBe('rep2@accept-bakery.test');
    expect(Number(stored.roles)).toBeGreaterThanOrEqual(1);
    expect(Number(stored.van_scopes)).toBe(1);

    // A rep may not link accounts — that is back-office work.
    const forbidden = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/salesmen/${salesmanId}/account`,
      { token: rep.token, body: { email: 'hijack@accept-bakery.test' } },
    );
    expect(forbidden.status).toBe(403);
  });

  it('returns goods through an official sale_return and puts them back in the van balance', async () => {
    // Supply and confirm a fresh custody so the return has stock to come back into.
    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        loadedQty: '10',
        idempotencyKey: 'acc-load-return',
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    const supplyId: string = supply.body.data.loadOrders[0].id;
    await api(ctx.server, 'post', `/api/v1/van-sales/load-orders/${supplyId}/confirm-receipt`, {
      token: rep.token,
      body: { receivedQty: '10' },
    });

    const sale = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: rep.token,
      body: {
        loadOrderId: supplyId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'cash',
        cashLocationId,
        soldQty: '6',
        unitPrice: '6.50',
        idempotencyKey: 'acc-sale-return-source',
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const document = sale.body.data.documents[0];
    const vanBeforeReturn = await officialBalance(vanWarehouseId);

    const returned = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/documents/${document.id}/returns`,
      {
        token: rep.token,
        body: { returnedQty: '2', reason: 'عميل أرجع الكمية', idempotencyKey: 'acc-return-1' },
      },
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    // The two kilos are physically back in the van's official balance.
    expect(await officialBalance(vanWarehouseId) - vanBeforeReturn).toBe(2);

    // An official `sale_return` invoice exists, referencing the original sale.
    const invoices = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT kind, status, reference_invoice_id::text, total::text
        FROM sales_invoices
        WHERE tenant_id = ${owner.tenantId}::uuid AND kind = 'sale_return'
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    expect(invoices[0].reference_invoice_id).toBe(document.salesInvoiceId);

    // Returning more than was sold is refused, and a replay changes nothing.
    const tooMuch = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/documents/${document.id}/returns`,
      { token: rep.token, body: { returnedQty: '50' } },
    );
    expect(tooMuch.status).toBe(422);

    const replay = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/documents/${document.id}/returns`,
      { token: rep.token, body: { returnedQty: '2', idempotencyKey: 'acc-return-1' } },
    );
    expect(replay.status).toBe(201);
    expect(await officialBalance(vanWarehouseId) - vanBeforeReturn).toBe(2);
  });

  it('posts the revenue, VAT, cost and receivable legs of a van sale in the official journal', async () => {
    const entries = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT je.id::text, je.source_type, jel.debit::text, jel.credit::text, a.code, a.name_ar
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.entry_id = je.id
        JOIN accounts a ON a.id = jel.account_id
        WHERE je.tenant_id = ${owner.tenantId}::uuid
          AND je.source_type IN ('sales_invoice', 'stock_transfer', 'stock_transfer_receipt', 'receipt_voucher')
        ORDER BY je.created_at ASC, a.code ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });

    // Every official document the van flow touched left a balanced journal behind.
    for (const sourceType of ['sales_invoice', 'stock_transfer', 'stock_transfer_receipt']) {
      const legs = entries.filter((row) => row.source_type === sourceType);
      expect(legs.length, `expected journal legs for ${sourceType}`).toBeGreaterThan(0);
      const debits = legs.reduce((sum, row) => sum + Number(row.debit), 0);
      const credits = legs.reduce((sum, row) => sum + Number(row.credit), 0);
      expect(Math.abs(debits - credits), `${sourceType} must balance`).toBeLessThan(0.0001);
    }

    // The cash collection produced a posted receipt voucher, not a draft promise.
    const voucher = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT number, status, amount::text, journal_entry_id::text
        FROM vouchers WHERE tenant_id = ${owner.tenantId}::uuid AND kind = 'receipt'
        ORDER BY created_at ASC LIMIT 1
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows[0];
    });
    expect(voucher.status).toBe('posted');
    expect(voucher.journal_entry_id).toBeTruthy();

    // Output VAT really was recognised on the sale (15% of 78.00 = 11.70).
    const vatLegs = entries.filter(
      (row) => Number(row.credit) > 0 && Number(row.credit) < 12 && Number(row.credit) > 11,
    );
    expect(vatLegs.length).toBeGreaterThan(0);
  });
});
