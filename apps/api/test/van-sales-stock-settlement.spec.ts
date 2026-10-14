import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🧮 تسوية المخزون والعهدة — the audit suite for the four separations a van closing has to keep
 * apart:
 *
 *   1. **الكمية في المخزون** — the official van balance must end equal to the physical count.
 *   2. **إثبات العجز وقيمته** — recorded on the official count document and on the load order.
 *   3. **من يتحمّل القيمة** — never decided here: no salary, no employee receivable, no invented
 *      account. The only accounts used are the tenant's own posting-profile accounts.
 *   4. **الاعتماد** — the quantity settlement posts only on an explicit authorisation.
 *
 * It also covers the exception paths the audit asked for: surplus, damage, good returns, a short
 * receipt, a rejected supply, a cancelled supply, a failure in the middle of the saga, and replay
 * of every request. Every assertion reads the official ledger (`stock_balances`,
 * `inventory_transactions`, `stock_adjustments`, `journal_entries/lines`, `stock_transfers`).
 */
describe('Van Sales — stock & custody settlement against the official ledger', () => {
  let ctx: TestApp;
  let owner: Actor;
  let accountant: Actor;
  let rep: Actor;
  let otherRep: Actor;

  let branchId: string;
  let mainWarehouseId: string;
  let vanWarehouseId: string;
  /** مستودع سيارة مستقل لكل اختبار — الأرصدة المطلقة لا تتسرّب بين الحالات. */
  const vanWarehouseIds: Record<string, string> = {};
  let otherVanWarehouseId: string;
  let itemId: string;
  /** 🌾 مكوّن الإنتاج — (ب) تشترط مصدراً للمواد: لا دفعة إنتاج بلا مكوّنات ولا BOM. */
  let componentItemId: string;
  let partyId: string;
  let salesmanId: string;
  let otherSalesmanId: string;
  let profile: Record<string, string>;

  function vanFor(key: string): string {
    const id = vanWarehouseIds[key];
    if (!id) throw new Error(`لا يوجد مستودع سيارة للاختبار ${key}`);
    return id;
  }

  /** الكمية الرسمية — `stock_balances`, the same row the stock screen reads. */
  async function officialQty(warehouseId: string): Promise<number> {
    return Number((await balanceRow(warehouseId)).qty);
  }

  /** قيمة الرصيد الرسمي — a quantity can come back while its value does not. */
  async function balanceValue(warehouseId: string): Promise<number> {
    return Number((await balanceRow(warehouseId)).val);
  }

  async function balanceRow(warehouseId: string): Promise<{ qty: string; val: string }> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(quantity, 0)::text AS qty, COALESCE(value, 0)::text AS val
        FROM stock_balances
        WHERE tenant_id = ${owner.tenantId}::uuid
          AND item_id = ${itemId}::uuid
          AND warehouse_id = ${warehouseId}::uuid
      `);
      const row = (rows as { rows: Array<{ qty: string; val: string }> }).rows[0];
      return row ?? { qty: '0', val: '0' };
    });
  }

  /**
   * صافي حساب (مدين − دائن) من القيود الرسمية كلها — used to prove a failed supply leaves no
   * value behind in the inventory or in-transit accounts, not just no quantity.
   */
  async function accountNet(accountId: string, postedOnly = false): Promise<number> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS net
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.tenant_id = ${owner.tenantId}::uuid
          AND l.account_id = ${accountId}::uuid
          ${postedOnly ? sql`AND e.status = 'posted'` : sql``}
      `);
      return Number((rows as { rows: Array<{ net: string }> }).rows[0]?.net ?? '0');
    });
  }

  async function loadOrderRow(loadOrderId: string): Promise<Record<string, string | null>> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT status, stock_settlement_status, stock_settlement_note, remaining_action,
               stock_adjustment_id::text, shortage_qty::text, shortage_value::text,
               shortage_policy_status, actual_remaining_qty::text, received_qty::text,
               returned_qty::text, damaged_qty::text, damage_journal_entry_id::text,
               remaining_inventory_tx_id::text, settled_at
        FROM van_load_orders
        WHERE id = ${loadOrderId}::uuid AND tenant_id = ${owner.tenantId}::uuid
      `);
      return (rows as { rows: Array<Record<string, string | null>> }).rows[0]!;
    });
  }

  async function adjustmentRow(adjustmentId: string): Promise<Record<string, string | null>> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT a.number, a.status, a.reason, a.journal_entry_id::text,
               l.expected_qty::text, l.counted_qty::text, l.variance_qty::text, l.variance_value::text
        FROM stock_adjustments a
        JOIN stock_adjustment_lines l ON l.adjustment_id = a.id
        WHERE a.id = ${adjustmentId}::uuid AND a.tenant_id = ${owner.tenantId}::uuid
      `);
      return (rows as { rows: Array<Record<string, string | null>> }).rows[0]!;
    });
  }

  async function journalLines(sourceType: string, sourceId: string) {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT e.id::text AS entry_id, e.number, l.account_id::text, l.debit::text, l.credit::text,
               a.code AS account_code, a.name_ar AS account_name
        FROM journal_entries e
        JOIN journal_entry_lines l ON l.entry_id = e.id
        JOIN accounts a ON a.id = l.account_id
        WHERE e.tenant_id = ${owner.tenantId}::uuid
          AND e.source_type = ${sourceType}
          AND e.source_id = ${sourceId}::uuid
        ORDER BY a.code ASC
      `);
      return (rows as { rows: Array<Record<string, string>> }).rows;
    });
  }

  async function transferRow(transferId: string): Promise<Record<string, string | null>> {
    return withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT status, closure_mode, sent_journal_entry_id::text, closed_journal_entry_id::text
        FROM stock_transfers
        WHERE id = ${transferId}::uuid AND tenant_id = ${owner.tenantId}::uuid
      `);
      return (rows as { rows: Array<Record<string, string | null>> }).rows[0]!;
    });
  }

  /** دورة كاملة جاهزة للاختبار: إنتاج ← توريد ← استلام ← بيع. */
  async function newCustody(key: string, produced = '50', supplied = '20', received = supplied) {
    const production = await api(ctx.server, 'post', '/api/v1/van-sales/production-batches', {
      token: accountant.token,
      body: {
        itemId,
        warehouseId: mainWarehouseId,
        producedQty: produced,
        // مصدر المواد رسمي: مكوّن يصرف 1:1 بمتوسط 4.00 ⇒ تكلفة الوحدة 4.00 من أمر الإنتاج.
        components: [{ itemId: componentItemId, qty: produced }],
        unitCost: '4.00',
        idempotencyKey: `${key}-prod`,
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
        vanWarehouseId: vanFor(key),
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

    const confirm = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${order.id}/confirm-receipt`,
      { token: rep.token, body: { receivedQty: received, notes: 'استلام' } },
    );
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);

    return { batchNo, loadOrderId: order.id, stockTransferId: order.stockTransferId };
  }

  async function sell(loadOrderId: string, key: string, soldQty: string, bonusQty = '0') {
    const sale = await api(ctx.server, 'post', '/api/v1/van-sales/documents', {
      token: rep.token,
      body: {
        loadOrderId,
        partyId,
        itemId,
        invoiceMode: 'zatca_tax',
        paymentMethod: 'credit',
        soldQty,
        bonusQty,
        bonusReason: bonusQty === '0' ? undefined : 'ترويجي',
        unitPrice: '6.50',
        idempotencyKey: key,
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    return sale;
  }

  beforeAll(async () => {
    ctx = await createTestApp('van-sales-settlement');
    owner = await createActor(ctx, {
      tenantCode: 'settle-bakery',
      tenantName: 'مخابز التسوية',
      email: 'owner@settle-bakery.test',
      permissions: [
        ...ALL_TENANT_PERMISSIONS,
        'sales.view',
        'sales.invoice.create',
        'sales.salesman.manage',
        'inventory.adjust',
        'inventory.view',
        'accounting.period.close',
        'van_sales.view',
        'van_sales.production.manage',
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
      tenantCode: 'settle-bakery',
      email: 'accountant@settle-bakery.test',
      permissions: [
        'van_sales.view',
        'van_sales.production.manage',
        'van_sales.load.manage',
        'van_sales.closing.approve',
        'sales.view',
        'sales.invoice.create',
      ],
      roleNames: ['Accountant'],
      isOwner: false,
    });
    rep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'settle-bakery',
      email: 'rep1@settle-bakery.test',
      permissions: ['van_sales.view', 'van_sales.invoice.create', 'van_sales.closing.submit'],
      roleNames: ['Rep1'],
      isOwner: false,
    });
    otherRep = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'settle-bakery',
      email: 'rep2@settle-bakery.test',
      permissions: ['van_sales.view', 'van_sales.closing.submit'],
      roleNames: ['Rep2'],
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

    vanWarehouseId = newId();
    otherVanWarehouseId = newId();
    itemId = newId();
    componentItemId = newId();
    partyId = newId();
    salesmanId = newId();
    otherSalesmanId = newId();
    const repEmployeeId = newId();
    const otherRepEmployeeId = newId();
    const baseUnitId = newId();
    const categoryId = newId();

    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
        VALUES
          (${vanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'WH-VAN-S1', 'سيارة المندوب الأول', false, true),
          (${otherVanWarehouseId}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid, 'WH-VAN-S2', 'سيارة المندوب الثاني', false, true)
      `);

    // Every case gets its own van warehouse, so "the official van balance equals the count"
    // can be asserted as an absolute number without another test's leftovers.
    for (const key of ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10']) {
      vanWarehouseIds[key] = newId();
    }
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      for (const key of Object.keys(vanWarehouseIds)) {
        await tx.execute(sql`
          INSERT INTO warehouses (id, tenant_id, branch_id, code, name, is_default, is_active)
          VALUES (${vanWarehouseIds[key]}::uuid, ${owner.tenantId}::uuid, ${branchId}::uuid,
                  'WH-VAN-' || ${key}, 'سيارة حالة ' || ${key}, false, true)
        `);
      }
    });
      await tx.execute(sql`
        INSERT INTO item_categories (id, tenant_id, code, name_ar)
        VALUES (${categoryId}::uuid, ${owner.tenantId}::uuid, 'CAT-S', 'منتجات المخبز')
      `);
      await tx.execute(sql`
        INSERT INTO units_of_measure (id, tenant_id, code, name_ar, name_en)
        VALUES (${baseUnitId}::uuid, ${owner.tenantId}::uuid, 'KG', 'كيلوجرام', 'Kilogram')
      `);
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${itemId}::uuid, ${owner.tenantId}::uuid, 'SKU-S', 'سمبوسة بلدي', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 4.0000, 6.5000, false)
      `);
      // 🌾 المكوّن ورصيده الرسمي — every production batch here consumes 1:1 from a real shelf at a
      // moving average of exactly 4.00, so the output still enters at 4.00 and every number this
      // suite asserts (قيم العجز، التسوية، العهدة) stays what it was.
      await tx.execute(sql`
        INSERT INTO items (id, tenant_id, sku, name_ar, category_id, base_unit_id, kind, purchase_price, sale_price, track_lot)
        VALUES (${componentItemId}::uuid, ${owner.tenantId}::uuid, 'SKU-S-FLOUR', 'دقيق أبيض', ${categoryId}::uuid, ${baseUnitId}::uuid, 'stock', 4.0000, 4.0000, false)
      `);
      await tx.execute(sql`
        INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value, average_cost, version)
        VALUES (${owner.tenantId}::uuid, ${componentItemId}::uuid, ${mainWarehouseId}::uuid, 1000000, 4000000, 4.0000, 1)
      `);
      await tx.execute(sql`
        INSERT INTO parties (id, tenant_id, code, kind, name, tax_no, credit_limit)
        VALUES (${partyId}::uuid, ${owner.tenantId}::uuid, 'CUST-S1', 'customer', 'تموينات التسوية', '300000000000003', 5000)
      `);
      await tx.execute(sql`
        INSERT INTO employees (id, tenant_id, employee_no, name, branch_id, membership_id, status)
        VALUES
          (${repEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-S1', 'المندوب الأول', ${branchId}::uuid, ${rep.membershipId}::uuid, 'active'),
          (${otherRepEmployeeId}::uuid, ${owner.tenantId}::uuid, 'EMP-S2', 'المندوب الثاني', ${branchId}::uuid, ${otherRep.membershipId}::uuid, 'active')
      `);
      await tx.execute(sql`
        INSERT INTO salesmen (id, tenant_id, name, active, employee_id, warehouse_id, vehicle_plate)
        VALUES
          (${salesmanId}::uuid, ${owner.tenantId}::uuid, 'المندوب الأول', true, ${repEmployeeId}::uuid, ${vanWarehouseId}::uuid, 'أ ب ج 1234'),
          (${otherSalesmanId}::uuid, ${owner.tenantId}::uuid, 'المندوب الثاني', true, ${otherRepEmployeeId}::uuid, ${otherVanWarehouseId}::uuid, 'د هـ و 5678')
      `);
      const profileRows = await tx.execute(sql`
        SELECT mapping::text FROM branch_posting_profiles
        WHERE tenant_id = ${owner.tenantId}::uuid AND doc_type = '*'
        LIMIT 1
      `);
      profile = JSON.parse(
        (profileRows as { rows: Array<{ mapping: string }> }).rows[0]?.mapping ?? '{}',
      ) as Record<string, string>;
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses to close a custody while the official van balance disagrees with the count', async () => {
    const { loadOrderId } = await newCustody('s1', '50', '20', '20');
    await sell(loadOrderId, 's1-sale', '12', '1');

    const before = { main: await officialQty(mainWarehouseId), van: await officialQty(vanFor('s1')) };
    expect(before.van).toBe(7); // 20 received − 12 sold − 1 bonus

    // Rep: 5 kg good return, 1 kg damaged, and only 0.5 kg physically left in the van.
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
          collectedCash: '0',
          actualRemainingQty: '0.5',
        },
      },
    );
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);

    // Approving the quantities without authorising the stock settlement must NOT close the day.
    const approve = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: {
          returnedQty: '5',
          damagedQty: '1',
          damageInspected: true,
          actualRemainingQty: '0.5',
          remainingAction: 'carry_over',
        },
      },
    );
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);

    const row = await loadOrderRow(loadOrderId);
    expect(row.status).toBe('pending_stock_settlement');
    expect(row.stock_settlement_status).toBe('pending_count_decision');
    expect(row.settled_at).toBeNull();
    expect(row.remaining_action).toBe('carry_over');

    // 2) إثبات العجز وقيمته — on the official count document and on the load order.
    expect(row.shortage_qty).toBe('0.5000');
    expect(row.shortage_policy_status).toBe('pending_policy_approval');
    const adjustment = await adjustmentRow(row.stock_adjustment_id!);
    expect(adjustment.status).toBe('draft');
    expect(Number(adjustment.counted_qty)).toBeCloseTo(0.5, 4);
    // ⚠️ المحرك الرسمي يكتب `expected_qty` لحظة الترحيل لا لحظة الإنشاء (`createAdjustment`
    //    يضع expectedQty: '0'): فالمسودة تحمل العدّ وحده، ودليل الفرق قبل التفويض يبقى على
    //    أمر التحميل وفي سبب المستند — وهذا ما يُظهره التقرير للمحاسب قبل أن يفوّض.
    expect(Number(adjustment.expected_qty)).toBe(0);
    expect(adjustment.variance_qty === null || Number(adjustment.variance_qty) === 0).toBe(true);
    expect(adjustment.reason).toContain('المتوقع 1.00 مقابل الفعلي 0.50');

    // 1) الكمية لم تُسوَّ بعد: رصيد السيارة ما زال 1 كجم (0.5 موجود + 0.5 مفقود).
    expect(await officialQty(vanFor('s1'))).toBe(1);
    expect(await officialQty(mainWarehouseId)).toBe(before.main + 5); // the good return only

    // 3+4) لا قيد مالي للتسوية قبل التفويض، ولا شيء على راتب المندوب أو ذمته.
    expect(await journalLines('stock_adjustment', row.stock_adjustment_id!)).toHaveLength(0);
    const employeeEntries = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM journal_entry_lines l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.tenant_id = ${owner.tenantId}::uuid
          AND (a.code LIKE '21%' OR a.name_ar LIKE '%موظف%' OR a.name_ar LIKE '%رواتب%'
               OR a.name_ar LIKE '%عهدة%')
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
    expect(employeeEntries).toBe(0);

    // 💵 ما تعرضه الشاشة: قيمة فرق الجرد على أساس التكلفة (0.5 × 4.00)، مع بيان أن مستند
    //    الجرد لم يُرحَّل بعد — ورقم «العجز على المندوب» المرجعي يبقى تقدير مراجعة لا ديناً.
    const shown = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: accountant.token,
    });
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    const shownOrder = (
      (shown.body.data as {
        loadOrders: Array<Record<string, unknown>>;
      }).loadOrders.find((order) => order.id === loadOrderId) ?? {}
    ) as Record<string, unknown>;
    expect(Number(shownOrder.countVarianceCostValue)).toBeCloseTo(2, 2);
    expect(shownOrder.countDocumentVarianceValue).toBeNull();
    expect(shownOrder.awaitingStockSettlement).toBe(true);
    // الملاحظة تُسمّي سبب المنع: مستند الجرد ما زال مسودة ويلزم تفويض بترحيله.
    expect(String(shownOrder.stockSettlementNote)).toContain('بانتظار تسوية المخزون');
    expect(String(shownOrder.stockSettlementNote)).toContain('يلزم تفويض');

    // The damage write-off is the one financial leg that IS authorised by the inspection itself.
    expect(row.damage_journal_entry_id).toBeTruthy();
    const damageLines = await journalLines('van_load_order', loadOrderId);
    expect(damageLines).toHaveLength(2);
    expect(damageLines.map((line) => line.account_id).sort()).toEqual(
      [profile.inventoryAccountId, profile.inventoryAdjustmentAccountId].sort(),
    );
  });

  it('settles the quantity on explicit authorisation without touching salary or receivables', async () => {
    const { loadOrderId } = await newCustody('s2', '40', '10', '10');
    await sell(loadOrderId, 's2-sale', '4', '0');

    await api(ctx.server, 'post', `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`, {
      token: rep.token,
      body: { returnedQty: '0', damagedQty: '0', collectedCash: '0', actualRemainingQty: '5' },
    });
    const before = { main: await officialQty(mainWarehouseId), van: await officialQty(vanFor('s2')) };
    expect(before.van).toBe(6); // 10 − 4 sold; the rep counted 5 ⇒ 1 kg missing

    // Approve + authorise the official count settlement in one act, remainder carried over.
    const approve = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: {
          returnedQty: '0',
          damagedQty: '0',
          actualRemainingQty: '5',
          remainingAction: 'carry_over',
          settleStockAdjustment: true,
        },
      },
    );
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);

    const row = await loadOrderRow(loadOrderId);
    expect(row.status).toBe('settled');
    expect(row.settled_at).toBeTruthy();
    expect(row.stock_settlement_status).toBe('settled_officially');

    // 1) رصيد السيارة الرسمي = الجرد الفعلي تماماً.
    expect(await officialQty(vanFor('s2'))).toBe(5);
    expect(await officialQty(mainWarehouseId)).toBe(before.main);

    const adjustment = await adjustmentRow(row.stock_adjustment_id!);
    expect(adjustment.status).toBe('posted');
    expect(adjustment.journal_entry_id).toBeTruthy();
    // At posting the engine writes the book quantity it settled from, and the value of the gap.
    expect(Number(adjustment.expected_qty)).toBeCloseTo(6, 4);
    expect(Number(adjustment.counted_qty)).toBeCloseTo(5, 4);
    expect(Number(adjustment.variance_qty)).toBeCloseTo(-1, 4);
    expect(Number(adjustment.variance_value)).toBeCloseTo(4, 2); // 1 kg × cost 4.00

    // The official journal is Dr تسوية الجرد / Cr المخزون — the tenant's own accounts only.
    const lines = await journalLines('stock_adjustment', row.stock_adjustment_id!);
    expect(lines).toHaveLength(2);
    const debit = lines.find((line) => Number(line.debit) > 0)!;
    const credit = lines.find((line) => Number(line.credit) > 0)!;
    expect(debit.account_id).toBe(profile.inventoryAdjustmentAccountId);
    expect(credit.account_id).toBe(profile.inventoryAccountId);
    expect(Number(debit.debit)).toBeCloseTo(Number(credit.credit), 4);
    expect(Number(debit.debit)).toBeCloseTo(4, 2);

    // 3) المسؤولية المالية ما زالت معلّقة: لا قيد على راتب أو ذمة موظف.
    expect(row.shortage_policy_status).toBe('pending_policy_approval');
    const employeeLines = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM journal_entry_lines l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.tenant_id = ${owner.tenantId}::uuid
          AND (a.name_ar LIKE '%موظف%' OR a.name_ar LIKE '%رواتب%' OR a.name_ar LIKE '%ذمم الموظفين%')
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
    expect(employeeLines).toBe(0);

    // Replaying the approval changes nothing and moves nothing twice.
    const replay = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      { token: accountant.token, body: { damageInspected: true, settleStockAdjustment: true } },
    );
    expect(replay.status).toBe(409);
    expect(await officialQty(vanFor('s2'))).toBe(5);

    const replaySettle = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(replaySettle.status).toBe(409);
    expect(await officialQty(vanFor('s2'))).toBe(5);
  });

  it('returns the counted remainder to the main warehouse when the accountant decides so', async () => {
    const { loadOrderId } = await newCustody('s3', '30', '10', '10');
    await sell(loadOrderId, 's3-sale', '4', '0');

    await api(ctx.server, 'post', `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`, {
      token: rep.token,
      body: { returnedQty: '0', damagedQty: '0', collectedCash: '0', actualRemainingQty: '6' },
    });

    // A count that matches the books needs no adjustment — but the 6 kg need a destination.
    const noDecision = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      { token: accountant.token, body: { actualRemainingQty: '6' } },
    );
    expect(noDecision.status).toBe(422);
    expect(
      (noDecision.body as { code?: string; error?: { code?: string } }).code ??
        (noDecision.body as { error?: { code?: string } }).error?.code,
    ).toBe('VAN_CLOSING_REMAINING_ACTION_REQUIRED');

    const before = { main: await officialQty(mainWarehouseId), van: await officialQty(vanFor('s3')) };
    expect(before.van).toBe(6);

    const approve = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: {
          actualRemainingQty: '6',
          remainingAction: 'return_to_main',
          settleStockAdjustment: true,
        },
      },
    );
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);

    const row = await loadOrderRow(loadOrderId);
    expect(row.status).toBe('settled');
    expect(row.remaining_action).toBe('return_to_main');
    expect(row.remaining_inventory_tx_id).toBeTruthy();
    // السيارة صفر: لا عهدة معلّقة ولا رصيد بلا مالك.
    expect(await officialQty(vanFor('s3'))).toBe(0);
    expect(await officialQty(mainWarehouseId)).toBe(before.main + 6);
  });

  it('settles a surplus count through the same official document, in the other direction', async () => {
    const { loadOrderId } = await newCustody('s4', '30', '10', '10');
    await sell(loadOrderId, 's4-sale', '3', '0');

    // Books say 7 kg must be in the van; the count says 8 kg. Without an explicit
    // acknowledgement the extra kilogram is refused as a typing mistake.
    const unacknowledged = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: { actualRemainingQty: '8', remainingAction: 'carry_over' },
      },
    );
    expect(unacknowledged.status).toBe(422);
    expect((unacknowledged.body as { code?: string }).code).toBe('VAN_CLOSING_SURPLUS_ACK_REQUIRED');
    expect(await officialQty(vanFor('s4'))).toBe(7); // nothing moved on a refused approval

    const approve = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: {
          returnedQty: '0',
          damagedQty: '0',
          actualRemainingQty: '8',
          remainingAction: 'carry_over',
          surplusAcknowledged: true,
          settleStockAdjustment: true,
        },
      },
    );
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);

    const row = await loadOrderRow(loadOrderId);
    expect(row.status).toBe('settled');
    expect(Number(row.shortage_qty)).toBe(0); // a surplus is never charged as a shortage
    expect(await officialQty(vanFor('s4'))).toBe(8);

    const adjustment = await adjustmentRow(row.stock_adjustment_id!);
    expect(adjustment.status).toBe('posted');
    expect(Number(adjustment.expected_qty)).toBeCloseTo(7, 4);
    expect(Number(adjustment.counted_qty)).toBeCloseTo(8, 4);
    expect(Number(adjustment.variance_qty)).toBeCloseTo(1, 4);
    const lines = await journalLines('stock_adjustment', row.stock_adjustment_id!);
    const debit = lines.find((line) => Number(line.debit) > 0)!;
    const credit = lines.find((line) => Number(line.credit) > 0)!;
    // A surplus is Dr المخزون / Cr تسوية الجرد — the mirror of a shortage.
    expect(debit.account_id).toBe(profile.inventoryAccountId);
    expect(credit.account_id).toBe(profile.inventoryAdjustmentAccountId);
  });

  it('keeps a short receipt in transit until an authorised decision, then closes it officially', async () => {
    const { loadOrderId, stockTransferId } = await newCustody('s5', '50', '20', '18');
    const row0 = await loadOrderRow(loadOrderId);
    expect(row0.received_qty).toBe('18.0000');
    expect(row0.stock_settlement_status).toBe('pending_transit_decision');

    // The 2 kg nobody received are still officially in transit — not a loss, not a custody.
    expect(await officialQty(vanFor('s5'))).toBe(18);
    const inTransit = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: accountant.token,
    });
    const transitSummary = (inTransit.body.data as {
      summary: Record<string, unknown>;
    }).summary;
    expect(Number(transitSummary.inTransitKg)).toBeCloseTo(2, 2);
    expect(Number(transitSummary.inTransitValueSar)).toBeGreaterThan(0);
    expect(Number(transitSummary.pendingTransitDecisionsCount)).toBe(1);
    const transfer0 = await transferRow(stockTransferId);
    expect(transfer0.status).toBe('partially_received');
    expect(await journalLines('stock_transfer_shortage', stockTransferId)).toHaveLength(0);

    // A rep cannot take the decision, and neither can a stranger to the module.
    const forbidden = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/close-transit-difference`,
      { token: rep.token, body: { mode: 'shortage' } },
    );
    expect(forbidden.status).toBe(403);

    const mainBefore = await officialQty(mainWarehouseId);
    const decision = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/close-transit-difference`,
      { token: accountant.token, body: { mode: 'return', reason: 'الكمية لم تُشحَن أصلاً' } },
    );
    expect(decision.status, JSON.stringify(decision.body)).toBe(201);

    // `return` puts the 2 kg back into the source warehouse at the cost they left at.
    expect(await officialQty(mainWarehouseId)).toBe(mainBefore + 2);
    expect(await officialQty(vanFor('s5'))).toBe(18);
    const transfer1 = await transferRow(stockTransferId);
    expect(transfer1.status).toBe('closed');
    expect(transfer1.closure_mode).toBe('return');
    const returnLines = await journalLines('stock_transfer_return', stockTransferId);
    expect(returnLines.length).toBeGreaterThan(0);
    const debits = returnLines.reduce((sum, line) => sum + Number(line.debit), 0);
    const credits = returnLines.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(Math.abs(debits - credits)).toBeLessThan(0.0001);

    const row1 = await loadOrderRow(loadOrderId);
    expect(row1.stock_settlement_status).toBe('settled_officially');

    // القرار أُخذ: لم يبقَ شيء على الطريق.
    const afterDecision = await api(ctx.server, 'get', '/api/v1/van-sales/dashboard', {
      token: accountant.token,
    });
    expect(
      Number((afterDecision.body.data as { summary: Record<string, unknown> }).summary.inTransitKg),
    ).toBeCloseTo(0, 2);

    // Deciding twice is refused, and the balance does not move again.
    const twice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/close-transit-difference`,
      { token: accountant.token, body: { mode: 'return' } },
    );
    expect(twice.status).toBe(409);
    expect(await officialQty(mainWarehouseId)).toBe(mainBefore + 2);

    // Without an explicit mode the system does not choose for the accountant.
    const noMode = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/close-transit-difference`,
      { token: accountant.token, body: {} },
    );
    expect(noMode.status).toBe(422);
  });

  it('lets the rep refuse a supply and puts every kilogram back officially', async () => {
    const { loadOrderId, stockTransferId, batchNo } = await newCustody('s6', '40', '12', '12');
    // A second supply on the same day, which the rep will refuse.
    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s6'),
        itemId,
        loadedQty: '8',
        productionBatchNo: batchNo,
        idempotencyKey: 's6-load-2',
      },
    });
    expect(supply.status, JSON.stringify(supply.body)).toBe(201);
    const refusedId = supply.body.data.loadOrders.find(
      (row: { status: string }) => row.status === 'pending_receipt',
    ).id as string;

    const before = { main: await officialQty(mainWarehouseId), van: await officialQty(vanFor('s6')) };

    // Another rep may not refuse somebody else's supply.
    const crossRep = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${refusedId}/reject-receipt`,
      { token: otherRep.token, body: { reason: 'محاولة غير مخوّلة' } },
    );
    expect(crossRep.status).toBe(403);

    const reject = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${refusedId}/reject-receipt`,
      { token: rep.token, body: { reason: 'الكمية تالفة ولا تصلح للتوزيع' } },
    );
    expect(reject.status, JSON.stringify(reject.body)).toBe(201);

    const row = await loadOrderRow(refusedId);
    expect(row.status).toBe('rejected');
    expect(row.received_qty).toBe('0.0000');
    // Everything is back in the source warehouse; the van never held it.
    expect(await officialQty(mainWarehouseId)).toBe(before.main + 8);
    expect(await officialQty(vanFor('s6'))).toBe(before.van);

    const refusedOrder = supply.body.data.loadOrders.find(
      (order: { id: string }) => order.id === refusedId,
    ) as Record<string, string>;
    const refusedTransfer = await transferRow(refusedOrder.stockTransferId);
    expect(refusedTransfer.status).toBe('closed');
    expect(refusedTransfer.closure_mode).toBe('return');
    // The first supply's transfer is untouched by the refusal.
    expect((await transferRow(stockTransferId)).status).toBe('received');

    // Refusing twice is refused.
    const twice = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${refusedId}/reject-receipt`,
      { token: rep.token, body: { reason: 'مرة أخرى' } },
    );
    expect(twice.status).toBe(409);
    expect(await officialQty(mainWarehouseId)).toBe(before.main + 8);

    // The first custody is untouched by the refusal.
    expect(await loadOrderRow(loadOrderId)).toMatchObject({ status: 'loaded' });
  });

  it('cancels a sent supply through the official cancellation, reversing stock and journal', async () => {
    const { batchNo } = await newCustody('s7', '30', '5', '5');
    const supply = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s7'),
        itemId,
        loadedQty: '7',
        productionBatchNo: batchNo,
        idempotencyKey: 's7-load-2',
      },
    });
    const cancelled = supply.body.data.loadOrders.find(
      (row: { status: string }) => row.status === 'pending_receipt',
    ) as Record<string, string>;

    const before = { main: await officialQty(mainWarehouseId), van: await officialQty(vanFor('s7')) };

    const repDenied = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${cancelled.id}/cancel`,
      { token: rep.token, body: { reason: 'إلغاء' } },
    );
    expect(repDenied.status).toBe(403);

    const cancel = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${cancelled.id}/cancel`,
      { token: accountant.token, body: { reason: 'أُدخل بالخطأ' } },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);

    const row = await loadOrderRow(cancelled.id);
    expect(row.status).toBe('canceled');
    expect(await officialQty(mainWarehouseId)).toBe(before.main + 7);
    expect(await officialQty(vanFor('s7'))).toBe(before.van);

    const transfer = await transferRow(cancelled.stockTransferId);
    expect(transfer.status).toBe('cancelled');

    // Cancelling a supply that was already received is refused: the goods are in the rep's hands.
    const afterReceipt = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${cancelled.id}/cancel`,
      { token: accountant.token, body: { reason: 'محاولة متأخرة' } },
    );
    expect(afterReceipt.status).toBe(409);
  });

  it('compensates a supply that fails in the middle and never leaves stock half-moved', async () => {
    const before = {
      main: await officialQty(mainWarehouseId),
      mainValue: await balanceValue(mainWarehouseId),
      van: await officialQty(vanFor('s8')),
      inventoryNet: await accountNet(profile.inventoryAccountId),
      transitNet: await accountNet(profile.stockInTransitAccountId),
      postedInventoryNet: await accountNet(profile.inventoryAccountId, true),
      postedTransitNet: await accountNet(profile.stockInTransitAccountId, true),
    };

    // (a) Refused before anything is written: more than the official balance can give.
    const tooMuch = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s8'),
        itemId,
        loadedQty: '100000',
        idempotencyKey: 's8-load-too-much',
      },
    });
    expect(tooMuch.status).toBe(422);
    expect(await officialQty(mainWarehouseId)).toBe(before.main);
    expect(await officialQty(vanFor('s8'))).toBe(before.van);

    // (b) Fails **after** the goods moved. The supply saga cannot share one transaction — the
    //     official transfer API opens its own — so step 3 is made to collide with an existing
    //     movement key, exactly like a duplicate write or a dropped connection would.
    await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO van_stock_movements (id, tenant_id, movement_type, qty, idempotency_key, reason)
        VALUES (${newId()}::uuid, ${owner.tenantId}::uuid, 'van_load', 0, 'load-move:s8-collide',
                'سطر مزروع لإجبار الخطوة الثالثة على الفشل بعد تحرك البضاعة')
      `);
    });

    const midFlight = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s8'),
        itemId,
        loadedQty: '5',
        idempotencyKey: 's8-collide',
      },
    });
    expect(midFlight.status).toBeGreaterThanOrEqual(400);

    // Nothing moved and nothing is owed: the quantity **and its value** are back in the source
    // warehouse, and every entry the attempt wrote cancels out.
    expect(await officialQty(mainWarehouseId)).toBe(before.main);
    expect(await balanceValue(mainWarehouseId)).toBeCloseTo(before.mainValue, 4);
    expect(await officialQty(vanFor('s8'))).toBe(before.van);
    expect(await accountNet(profile.inventoryAccountId)).toBeCloseTo(before.inventoryNet, 4);
    expect(await accountNet(profile.stockInTransitAccountId)).toBeCloseTo(before.transitNet, 4);

    /**
     * ✅ منظور «المرحَّل فقط» — وهو ما تجمعه كل التقارير المحاسبية — يعود صافياً أيضاً.
     * كان هذا المكان يثبت عيباً: `reversalEntry` تُرحِّل المرآة وتُبطل الأصل معاً، فيسقط
     * الأصل من كل ميزان وتبقى مرآته (انحراف بمقدار قيمة التوريد). صار العكس مرآةً وحدها
     * والأصل يبقى `posted` (اصطلاح `0047` و`report-catalog.entryStateScope`)، فالأصل
     * ومرآته صفر في الميزان وفي الأستاذ وفي رصيد الحساب.
     */
    expect(
      (await accountNet(profile.inventoryAccountId, true)) - before.postedInventoryNet,
    ).toBeCloseTo(0, 4);
    expect(
      (await accountNet(profile.stockInTransitAccountId, true)) - before.postedTransitNet,
    ).toBeCloseTo(0, 4);

    // No orphan transfer left on the road, and the half-written order is cancelled with a reason.
    const leftovers = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM stock_transfers
             WHERE tenant_id = ${owner.tenantId}::uuid AND status IN ('draft', 'in_transit')) AS open_transfers,
          (SELECT COUNT(*)::int FROM van_load_orders
             WHERE tenant_id = ${owner.tenantId}::uuid AND status IN ('draft', 'pending_receipt')) AS open_orders,
          (SELECT COALESCE(string_agg(COALESCE(stock_settlement_note, ''), ' | '), '')
             FROM van_load_orders
             WHERE tenant_id = ${owner.tenantId}::uuid AND status = 'canceled'
               AND idempotency_key = 's8-collide') AS note
      `);
      return (rows as { rows: Array<Record<string, unknown>> }).rows[0]!;
    });
    expect(leftovers.open_transfers).toBe(0);
    expect(leftovers.open_orders).toBe(0);
    expect(String(leftovers.note)).toContain('فشل تنفيذ التوريد');

    // A retry with a clean key succeeds — the compensation left nothing blocking the way.
    const retry = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s8'),
        itemId,
        loadedQty: '5',
        idempotencyKey: 's8-load-retry',
      },
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(await officialQty(mainWarehouseId)).toBe(before.main - 5);
    expect(await officialQty(vanFor('s8'))).toBe(0); // still in transit until the rep confirms
  });

  it('resumes a stock settlement that stopped half-way, without moving anything twice', async () => {
    const { loadOrderId } = await newCustody('s9', '30', '10', '10');
    await sell(loadOrderId, 's9-sale', '4', '0');

    await api(ctx.server, 'post', `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`, {
      token: rep.token,
      body: { returnedQty: '0', damagedQty: '0', collectedCash: '0', actualRemainingQty: '4' },
    });

    // First approval: quantities accepted, no authorisation to settle stock ⇒ still open.
    const first = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: { actualRemainingQty: '4', remainingAction: 'carry_over' },
      },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await loadOrderRow(loadOrderId)).status).toBe('pending_stock_settlement');
    const adjustmentAfterFirst = (await loadOrderRow(loadOrderId)).stock_adjustment_id!;
    expect(await officialQty(vanFor('s9'))).toBe(6);

    // 🔒 التسوية اعتمادٌ لا عرض: المندوب يملك `van_sales.view` و`closing.submit` فقط.
    const repDenied = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: rep.token, body: { settleStockAdjustment: true } },
    );
    expect(repDenied.status).toBe(403);
    expect(await officialQty(vanFor('s9'))).toBe(6);

    // The resume endpoint completes it — and must not create a second count document.
    const resume = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(resume.status, JSON.stringify(resume.body)).toBe(201);

    const row = await loadOrderRow(loadOrderId);
    expect(row.status).toBe('settled');
    expect(row.stock_adjustment_id).toBe(adjustmentAfterFirst);
    expect(await officialQty(vanFor('s9'))).toBe(4);

    const counts = await withTenantTx(ctx.handle.db, owner.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS adjustments,
               (SELECT COUNT(*)::int FROM inventory_transactions
                 WHERE tenant_id = ${owner.tenantId}::uuid AND doc_type = 'stock_adjustment'
                   AND doc_id = ${adjustmentAfterFirst}::uuid) AS movements,
               (SELECT COUNT(*)::int FROM journal_entries
                 WHERE tenant_id = ${owner.tenantId}::uuid AND source_type = 'stock_adjustment'
                   AND source_id = ${adjustmentAfterFirst}::uuid) AS entries
        FROM stock_adjustments
        WHERE tenant_id = ${owner.tenantId}::uuid AND id = ${adjustmentAfterFirst}::uuid
      `);
      return (rows as { rows: Array<Record<string, number>> }).rows[0]!;
    });
    expect(counts.adjustments).toBe(1);
    expect(counts.movements).toBe(1);
    expect(counts.entries).toBe(1);

    // Resuming again is a no-op refusal, not a second movement.
    const again = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(again.status).toBe(409);
    expect(await officialQty(vanFor('s9'))).toBe(4);
  });

  it('freezes the van while a count is pending and releases it once settled', async () => {
    const { loadOrderId, batchNo } = await newCustody('s10', '40', '10', '10');
    await sell(loadOrderId, 's10-sale', '4', '0');

    await api(ctx.server, 'post', `/api/v1/van-sales/load-orders/${loadOrderId}/submit-closing`, {
      token: rep.token,
      body: { returnedQty: '0', damagedQty: '0', collectedCash: '0', actualRemainingQty: '5' },
    });
    const approved = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/approve-closing`,
      {
        token: accountant.token,
        body: { actualRemainingQty: '5', remainingAction: 'carry_over' },
      },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect((await loadOrderRow(loadOrderId)).status).toBe('pending_stock_settlement');

    /**
     * 🧊 سيارةٌ قيد تسوية الجرد مجمَّدة — a supply landing now would be absorbed into the
     * count document as if it were a difference the accountant approved.
     */
    const mainBefore = await officialQty(mainWarehouseId);
    const vanBefore = await officialQty(vanFor('s10'));
    const blocked = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s10'),
        itemId,
        loadedQty: '6',
        productionBatchNo: batchNo,
        idempotencyKey: 's10-supply-blocked',
      },
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect((blocked.body as { code?: string }).code).toBe('VAN_WAREHOUSE_UNDER_SETTLEMENT');
    expect(await officialQty(mainWarehouseId)).toBe(mainBefore);
    expect(await officialQty(vanFor('s10'))).toBe(vanBefore);

    // إتمام التسوية يفتح السيارة من جديد — التجميد حالة، لا عطل دائم.
    const settled = await api(
      ctx.server,
      'post',
      `/api/v1/van-sales/load-orders/${loadOrderId}/settle-stock`,
      { token: accountant.token, body: { settleStockAdjustment: true } },
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect(await officialQty(vanFor('s10'))).toBe(5);

    const released = await api(ctx.server, 'post', '/api/v1/van-sales/load-orders', {
      token: accountant.token,
      body: {
        salesmanId,
        branchId,
        warehouseId: mainWarehouseId,
        vanWarehouseId: vanFor('s10'),
        itemId,
        loadedQty: '6',
        productionBatchNo: batchNo,
        idempotencyKey: 's10-supply-released',
      },
    });
    expect(released.status, JSON.stringify(released.body)).toBe(201);
    expect(await officialQty(mainWarehouseId)).toBe(mainBefore - 6);
  });
});
