import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('Factory, Bakery & Van Sales 10-pillar workflow & 6-Phase Core Integration', () => {
  let ctx: TestApp;
  let owner: Actor;
  let repActor: Actor;
  let accountantActor: Actor;
  let tenantBActor: Actor;
  let salesmanId: string;
  let repEmployeeId: string;
  let partyId: string;
  let branchId: string;
  let mainWarehouseId: string;
  let vanWarehouseId: string;
  let itemId: string;
  /** 🌾 مكوّن الإنتاج — دفعة الإنتاج تحتاج مصدراً للمواد (BOM أو مكوّنات). */
  let componentItemId: string;

  beforeAll(async () => {
    ctx = await createTestApp('van-sales-factory');
    owner = await createActor(ctx, {
      tenantCode: 'bakery-a',
      tenantName: 'مصنع ومخابز الأصالة',
      email: 'owner@bakery-a.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'sales.view',
        'sales.invoice.create',
        'accounting.period.close',
        /**
         * 🚐 صلاحيات التوزيع صريحةً — since the `permissionGrants` narrowing (§5), a sales
         * permission no longer implies the approval/management codes of the distribution module
         * (`van_sales.production.manage`, `pricing.manage`, `load.manage`, `closing.approve`,
         * `override.approve`), and declaring any explicit `van_sales.*` code also switches the
         * operational inference off — so the owner of this fixture is granted the distribution
         * codes outright, exactly what migration `0126` writes for real roles and what a manager
         * sees and can revoke in the roles screen.
         */
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

    repActor = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'bakery-a',
      email: 'rep@bakery-a.test',
      permissions: [
        'van_sales.view',
        'van_sales.invoice.create',
        'van_sales.closing.submit',
      ],
      roleNames: ['VanSalesRep'],
      isOwner: false,
    });

    accountantActor = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'bakery-a',
      email: 'accountant@bakery-a.test',
      permissions: [
        'van_sales.view',
        'van_sales.closing.approve',
        'van_sales.collection.create',
        'van_sales.pricing.manage',
        'van_sales.override.approve',
      ],
      roleNames: ['VanSalesAccountant'],
      isOwner: false,
    });

    tenantBActor = await createActor(ctx, {
      tenantCode: 'bakery-b',
      tenantName: 'مخابز المستأجر الثاني',
      email: 'owner@bakery-b.test',
      permissions: [...ALL_TENANT_PERMISSIONS, 'van_sales.view'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    /**
     * منشأة مُهيّأة رسميًا — the same provisioning seam every real tenant goes through:
     * chart of accounts, tenant-wide posting profile, main branch, main warehouse, main safe.
     * Distribution now posts through the official sales/transfer/voucher engines, and those
     * need a posting profile to resolve — an unprovisioned tenant is refused with a clear
     * `ACCOUNT_PROFILE_MISSING` rather than half-working.
     */
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;
    mainWarehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    salesmanId = newId();
    partyId = newId();
    vanWarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    repEmployeeId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
        VALUES
          (${vanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'WH-VAN-01', 'مستودع سيارة المندوب 1', false, true)
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
        INSERT INTO items (
          id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
          purchase_price, sale_price, track_lot
        ) VALUES (
          ${itemId}::uuid, ${owner.tenantId}::uuid, 'SKU-SAMBOSA-01',
          'رقائق سمبوسة بلدي طازجة', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock',
          3.8000, 6.5000, true
        )
      `);
      // 🌾 المكوّن ورصيده الرسمي بمتوسط 3.80 ⇒ أمر الإنتاج يكلّف الوحدة 3.80 نفسها.
      await tx.execute(sql`
        INSERT INTO items (
          id, tenant_id, sku, name_ar, category_id, base_unit_id, kind,
          purchase_price, sale_price, track_lot
        ) VALUES (
          ${componentItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-FLOUR-01',
          'دقيق أبيض', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock',
          3.8000, 3.8000, false
        )
      `);
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 100000, 380000, 3.8000, 1)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-VAN-1', 'مندوب التوزيع الأول',
                ${branchId}::uuid, ${repActor.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'مندوب التوزيع الأول', true,
                ${repEmployeeId}::uuid, ${vanWarehouseId}::uuid, 'أ ب ج 4521')
      `);
      await tx.execute(sql`
        INSERT INTO parties (id, tenant_id, code, kind, name, tax_no, credit_limit)
        VALUES (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-01', 'customer', 'تموينات النور', '300000000000003', 5000)
      `);
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('runs the full 10-pillar Factory, Van Custody, Invoicing & Pending Closing workflow linked to official ERP tables', async () => {
    // 1. Initial dashboard succeeds
    const dash0 = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: owner.token,
    });
    expect(dash0.status, JSON.stringify(dash0.body)).toBe(200);

    // 2. Record daily factory production batch (500 kg @ 3.80 SAR/kg) linked to official warehouse & lot-tracked item
    const prodRes = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: owner.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        itemName: 'رقائق سمبوسة بلدي طازجة',
        producedQty: '500',
        scrapQty: '5',
        scrapReason: 'فاقد خبز يومي — قطع محترقة',
        // 🌾 المصدر الرسمي للمواد: أمر إنتاج يصرف 500 كجم دقيقاً بمتوسط 3.80 ويستلم الناتج
        // في الدفعة (اللوت) نفسها — والصنف يُتتبَّع بالدفعات.
        components: [{ itemId: componentItemId, qty: '500' }],
        unitCost: '3.80',
        supervisorName: 'مشرف الإنتاج',
        idempotencyKey: 'prod-batch-day1-001',
      },
    });
    expect(prodRes.status, JSON.stringify(prodRes.body)).toBe(201);
    const prodData = prodRes.body.data as {
      summary: { totalProducedKg: string; totalScrapKg: string; mainWarehouseBalanceKg: string };
      productionBatches: Array<{
        id: string;
        batchNo: string;
        lotId: string | null;
        inventoryTransactionId: string | null;
      }>;
    };
    expect(prodData.summary.totalProducedKg).toBe('500.00');
    expect(prodData.summary.totalScrapKg).toBe('5.00');
    expect(prodData.summary.mainWarehouseBalanceKg).toBe('500.00');
    const firstBatch = prodData.productionBatches[0]!;
    expect(firstBatch.lotId).toBeTruthy();
    expect(firstBatch.inventoryTransactionId).toBeTruthy();
    const batchNo = firstBatch.batchNo;

    // Phase 3 Idempotency: repeating the same production batch request with identical idempotencyKey does not duplicate
    const prodRetryRes = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: owner.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: '500',
        components: [{ itemId: componentItemId, qty: '500' }],
        unitCost: '3.80',
        idempotencyKey: 'prod-batch-day1-001',
      },
    });
    expect(prodRetryRes.status).toBe(201);
    expect(
      (prodRetryRes.body.data as { summary: { totalProducedKg: string } }).summary.totalProducedKg,
    ).toBe('500.00');

    // 3. Configure custom price tier for customer (6.50 SAR/kg, locked) and verify price audit history
    const priceRes = await api(ctx.server, 'post', '/api/v1/van-sales/customer-prices', {
      token: accountantActor.token,
      body: {
        partyId,
        itemId,
        priceTierLabel: 'شريحة جملة المخابز — 6.50 ريال',
        unitPrice: '6.50',
        maxBonusPct: '20',
        maxBonusKgPerInvoice: '20',
        creditLimit: '5000',
        paymentTermsDays: 15,
        lockPrice: true,
        maxDiscountPct: '0',
        preferredInvoiceMode: 'zatca_tax',
        changeReason: 'اعتماد شريحة أسعار الجملة السنوية',
      },
    });
    expect(priceRes.status, JSON.stringify(priceRes.body)).toBe(201);
    const priceData = priceRes.body.data as {
      customerPriceHistory: Array<{ newUnitPrice: string; changeReason: string }>;
    };
    expect(priceData.customerPriceHistory.length).toBeGreaterThanOrEqual(1);
    expect(priceData.customerPriceHistory[0]!.newUnitPrice).toBe('6.50');

    // 4. Issue 150 kg Van Load Order to Sales Rep from production batch, creating official stock_transfers
    const loadRes = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: owner.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId,
        itemId,
        productionBatchNo: batchNo,
        vehiclePlate: 'أ ب ج 4521',
        loadedQty: '150',
        maxBonusQty: '20',
        maxBonusPct: '20',
        idempotencyKey: 'load-order-day1-001',
      },
    });
    expect(loadRes.status, JSON.stringify(loadRes.body)).toBe(201);
    const loadData = loadRes.body.data as {
      summary: { mainWarehouseBalanceKg: string; totalLoadedKg: string; pendingReceiptsCount: number };
      loadOrders: Array<{
        id: string;
        status: string;
        remainingQty: string;
        receivedQty: string;
        awaitingReceipt: boolean;
        stockTransferId: string | null;
      }>;
    };
    /**
     * الرصيد الرسمي بعد الصرف — the main warehouse really lost the 150 kg (they are in
     * transit on the official transfer), and the van has **nothing yet**: custody only
     * appears when the rep confirms receipt.
     */
    expect(loadData.summary.mainWarehouseBalanceKg).toBe('350.00');
    expect(loadData.summary.totalLoadedKg).toBe('150.00');
    expect(loadData.summary.pendingReceiptsCount).toBe(1);
    const loadOrderId = loadData.loadOrders[0]!.id;
    expect(loadData.loadOrders[0]!.status).toBe('pending_receipt');
    expect(loadData.loadOrders[0]!.awaitingReceipt).toBe(true);
    expect(loadData.loadOrders[0]!.stockTransferId).toBeTruthy();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const balances = (
        await tx.execute(sql`
          SELECT warehouse_id::text, quantity::numeric::text AS qty
          FROM stock_balances
          WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${itemId}::uuid
        `)
      ).rows as Array<{ warehouse_id: string; qty: string }>;
      const mainBal = balances.find((b) => b.warehouse_id === mainWarehouseId);
      const vanBal = balances.find((b) => b.warehouse_id === vanWarehouseId);
      expect(Number(mainBal?.qty)).toBe(350);
      expect(Number(vanBal?.qty ?? 0)).toBe(0);
      const transfer = (
        await tx.execute(sql`
          SELECT status FROM stock_transfers
          WHERE tenant_id = ${owner.tenantId}::uuid
            AND id = ${loadData.loadOrders[0]!.stockTransferId}::uuid
        `)
      ).rows as Array<{ status: string }>;
      expect(transfer[0]!.status).toBe('in_transit');
    });

    // 4b. The rep sees the pending supply in his own workspace and confirms the 150 kg
    const repMeBefore = await api(ctx.server, 'get', '/api/v1/van-sales/me', {
      token: repActor.token,
    });
    expect(repMeBefore.status, JSON.stringify(repMeBefore.body)).toBe(200);
    expect(repMeBefore.body.data.isRep).toBe(true);
    expect(repMeBefore.body.data.salesmanId).toBe(salesmanId);
    expect((repMeBefore.body.data.pendingReceipts as unknown[]).length).toBe(1);

    const confirmRes = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: repActor.token, body: { receivedQty: '150', notes: 'تم الاستلام كاملًا' } },
    );
    expect(confirmRes.status, JSON.stringify(confirmRes.body)).toBe(201);
    const confirmedOrder = (
      confirmRes.body.data as {
        loadOrders: Array<{ id: string; status: string; receivedQty: string; remainingQty: string }>;
      }
    ).loadOrders.find((l) => l.id === loadOrderId)!;
    expect(confirmedOrder.status).toBe('loaded');
    expect(Number(confirmedOrder.receivedQty)).toBe(150);
    expect(Number(confirmedOrder.remainingQty)).toBe(150);

    // The confirmed quantity is now in the van's official balance, and the transfer closed
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const balances = (
        await tx.execute(sql`
          SELECT warehouse_id::text, quantity::numeric::text AS qty
          FROM stock_balances
          WHERE tenant_id = ${owner.tenantId}::uuid AND item_id = ${itemId}::uuid
        `)
      ).rows as Array<{ warehouse_id: string; qty: string }>;
      expect(Number(balances.find((b) => b.warehouse_id === mainWarehouseId)?.qty)).toBe(350);
      expect(Number(balances.find((b) => b.warehouse_id === vanWarehouseId)?.qty)).toBe(150);
      const transfer = (
        await tx.execute(sql`
          SELECT status FROM stock_transfers
          WHERE tenant_id = ${owner.tenantId}::uuid
            AND id = ${loadData.loadOrders[0]!.stockTransferId}::uuid
        `)
      ).rows as Array<{ status: string }>;
      expect(transfer[0]!.status).toBe('received');
    });

    // Confirming twice is refused and moves nothing
    const confirmTwice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/confirm-receipt`,
      { token: repActor.token, body: { receivedQty: '150' } },
    );
    expect(confirmTwice.status).toBe(409);
    expect(confirmTwice.body.code).toBe('VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT');

    // 5. Phase 5 Guard: internal_delivery mode is rejected by default when tax policy is not enabled
    const internalBlockedRes = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: repActor.token,
      body: {
        loadOrderId,
        partyId,
        invoiceMode: 'internal_delivery',
        paymentMethod: 'cash',
        soldQty: '10',
        unitPrice: '6.50',
      },
    });
    expect(internalBlockedRes.status).toBe(422);
    expect(internalBlockedRes.body.code).toBe('VAN_SALES_INTERNAL_DELIVERY_POLICY_REQUIRED');

    // 6. Phase 4 Guard: Rep cannot bypass locked price using allowPriceDiscountOverride without van_sales.override.approve
    const unauthorizedOverrideRes = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: repActor.token,
      body: {
        loadOrderId,
        partyId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'cash',
        soldQty: '10',
        unitPrice: '5.00',
        allowPriceDiscountOverride: true,
      },
    });
    expect(unauthorizedOverrideRes.status).toBe(403);

    // 7. Issue Van Sales Document: 100 kg sold + 20 kg bonus -> creates official sales_invoices & sales_invoice_lines
    const docRes = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: repActor.token,
      body: {
        loadOrderId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'cash',
        soldQty: '100',
        bonusQty: '20',
        bonusReason: 'بونص ترويجي متفق عليه مع العميل',
        unitPrice: '6.50',
        customerBonusConfirmed: true,
        idempotencyKey: 'van-doc-day1-001',
      },
    });
    expect(docRes.status, JSON.stringify(docRes.body)).toBe(201);
    const createdDoc = (
      docRes.body.data as {
        documents: Array<{ id: string; salesInvoiceId: string | null; total: string }>;
      }
    ).documents[0]!;
    expect(createdDoc.salesInvoiceId).toBeTruthy();

    // Verify official sales_invoice_lines metadata contains bonus reason
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const lines = (
        await tx.execute(sql`
          SELECT quantity::numeric::text AS qty, unit_price::numeric::text AS price, metadata
          FROM sales_invoice_lines
          WHERE tenant_id = ${owner.tenantId}::uuid AND invoice_id = ${createdDoc.salesInvoiceId}::uuid
          ORDER BY line_no ASC
        `)
      ).rows as Array<{ qty: string; price: string; metadata: Record<string, unknown> }>;
      expect(lines.length).toBe(2);
      expect(lines[1]!.metadata.isBonus).toBe(true);
      expect(lines[1]!.metadata.bonusReason).toBe('بونص ترويجي متفق عليه مع العميل');
    });

    // 8. Stage 1: Rep submits end-of-day shift closing with 25 kg damaged -> 5 kg shortage (32.50 SAR)
    const submitClosingRes = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`,
      {
        token: repActor.token,
        body: {
          returnedQty: '0',
          damagedQty: '25',
          damageReason: 'تلف أثناء النقل والحرارة — خاضع للفحص الفعلي',
          collectedCash: '747.50',
        },
      },
    );
    expect(submitClosingRes.status, JSON.stringify(submitClosingRes.body)).toBe(201);
    const pendingOrder = (
      submitClosingRes.body.data as {
        loadOrders: Array<{
          id: string;
          status: string;
          shortageQty: string;
          shortageValue: string;
        }>;
      }
    ).loadOrders.find((l) => l.id === loadOrderId)!;
    expect(pendingOrder.status).toBe('pending_closing');
    expect(Number(pendingOrder.shortageQty)).toBe(5);
    expect(Number(pendingOrder.shortageValue)).toBe(32.5);

    // 9. Phase 4 RBAC & Segregation of Duties: Rep cannot call approve-closing (403 Forbidden)
    const repApproveDenied = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: repActor.token,
        body: {
          damageInspected: true,
          salaryDeductionApproved: true,
        },
      },
    );
    expect(repApproveDenied.status).toBe(403);

    // 10. Phase 4 Damage Inspection Guard: Accountant cannot approve closing with damagedQty > 0 unless damageInspected === true
    const uninspectedDenied = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountantActor.token,
        body: {
          returnedQty: '0',
          damagedQty: '25',
          collectedCash: '747.50',
          damageInspected: false,
        },
      },
    );
    expect(uninspectedDenied.status).toBe(422);

    // 11. Stage 2: Accountant inspects damaged goods, approves salary deduction & zeroes out custody
    const approveClosingRes = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountantActor.token,
        body: {
          returnedQty: '0',
          damagedQty: '25',
          collectedCash: '747.50',
          damageInspected: true,
          salaryDeductionApproved: true,
        },
      },
    );
    expect(approveClosingRes.status, JSON.stringify(approveClosingRes.body)).toBe(201);
    type LoadOrderShape = {
      id: string;
      status: string;
      remainingQty: string;
      damageInspected: boolean;
      salaryDeductionApproved: boolean;
      stockSettlementStatus: string;
      stockAdjustmentId: string | null;
    };
    const approvedOrder = (
      approveClosingRes.body.data as { loadOrders: LoadOrderShape[] }
    ).loadOrders.find((l) => l.id === loadOrderId)!;
    /**
     * 🧮 الاعتماد لم يعد يُغلق العهدة وحده — the quantities are approved, but 5 kg the documents
     * expect and the count cannot show are still on the official van balance, so the custody
     * stays open until the count document settles it. This is the reconciliation guarantee.
     */
    expect(approvedOrder.status).toBe('pending_stock_settlement');
    expect(approvedOrder.stockSettlementStatus).toBe('pending_count_decision');
    expect(approvedOrder.stockAdjustmentId).toBeTruthy(); // official count document, still a draft
    expect(Number(approvedOrder.remainingQty)).toBe(0);
    expect(approvedOrder.damageInspected).toBe(true);
    expect(approvedOrder.salaryDeductionApproved).toBe(true);

    // 11b. The authorised approver settles the count: the official van balance becomes the count.
    const settleStockRes = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountantActor.token, body: { settleStockAdjustment: true } },
    );
    expect(settleStockRes.status, JSON.stringify(settleStockRes.body)).toBe(201);
    const settledOrder = (
      settleStockRes.body.data as { loadOrders: LoadOrderShape[] }
    ).loadOrders.find((l) => l.id === loadOrderId)!;
    expect(settledOrder.status).toBe('settled');
    expect(settledOrder.stockSettlementStatus).toBe('settled_officially');
    expect(settledOrder.stockAdjustmentId).toBe(approvedOrder.stockAdjustmentId);

    // 12. Phase 3 Idempotency Guard: Re-approving an already settled load order returns 409 Conflict
    const duplicateApproveRes = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountantActor.token,
        body: {
          damageInspected: true,
          salaryDeductionApproved: true,
        },
      },
    );
    expect(duplicateApproveRes.status).toBe(409);
    expect(duplicateApproveRes.body.code).toBe('VAN_LOAD_ORDER_ALREADY_SETTLED');

    // 13. Phase 1 & 4 Multi-Tenant RLS Isolation: Tenant B sees zero batches, load orders, or documents from Tenant A
    const tenantBDash = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: tenantBActor.token,
    });
    expect(tenantBDash.status).toBe(200);
    const tenantBData = tenantBDash.body.data as {
      productionBatches: unknown[];
      loadOrders: unknown[];
      documents: unknown[];
    };
    expect(tenantBData.productionBatches).toHaveLength(0);
    expect(tenantBData.loadOrders).toHaveLength(0);
    expect(tenantBData.documents).toHaveLength(0);

    // 14. Phase 5 Reports & Phase 6 Dry-Run Legacy Reconciliation
    const reportsRes = await api(ctx.server, 'get', '/api/v1/van-sales/reports', {
      token: owner.token,
    });
    expect(reportsRes.status).toBe(200);
    expect(
      (reportsRes.body.data as { repCustodyReport: unknown[] }).repCustodyReport.length,
    ).toBeGreaterThanOrEqual(1);

    const reconDryRun = await api(ctx.server, 'post', '/api/v1/van-sales/legacy-reconciliation', {
      token: accountantActor.token,
      body: { mode: 'dry_run' },
    });
    expect(reconDryRun.status, JSON.stringify(reconDryRun.body)).toBe(201);
    const reconData = reconDryRun.body.data as {
      mode: string;
      counts: { totalDocuments: number; linkedDocuments: number };
    };
    expect(reconData.mode).toBe('dry_run');
    expect(reconData.counts.totalDocuments).toBe(1);
    expect(reconData.counts.linkedDocuments).toBe(1);
  });
});
