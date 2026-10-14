import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part one — 📋 طباعة فواتير مندوب وعمولاتهم
 * (`Form_WPF/frmInvBySalesMen.xaml` «مبيعات مندوب خلال فترة»).
 *
 * The window reads three ledgers and prints one row per document:
 *
 *   • `ShowInvoiceResults` L196 — `Inv` with `salesman > 0`, `IS_Deleted=0`,
 *     `inv_type IN (2,3)` and `proc_type IN (1,2)`. `ProcessInvoiceRow` L254 sums
 *     `val1 × exchange_price`, takes VAT out when prices include it, then `minus` and
 *     the lines' discounts (L307) to reach `netForComm` — the cloud's `subtotal`.
 *   • `LoadCreditNotes` L351 — `Notes WHERE Doc_Type=2 AND Inv_No=…`, one «إشعار مدين»
 *     per debit note hanging off a **sale** invoice.
 *   • `LoadReceiptsByType` L411 — «سند قبض عميل» (`ReceiptType=5`) and «سند قبض» (7).
 *
 * and three commissions a row (L330–L341):
 *
 *   عمولة المبيعات  = comm        % × netForComm
 *   عمولة التحصيل   = Colle_Comm  % × netForComm  — only when `pay_type` is set (L331)
 *   عمولة الربح     = Profit_Comm % × (netForComm − AvrgCost), only when that base is +
 *
 * «كم يستحق هذا المندوب؟» had no answer in the cloud at all: `sales_invoices.salesman_id`
 * existed and nothing read it, and the three percentages had nowhere to live.
 */
describe('عمولات المندوبين — frmInvBySalesMen', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let otherBranchId = '';
  let warehouseId = '';
  let itemId = '';
  let employeeId = '';
  let salesmanId = '';
  let plainSalesmanId = '';
  let cashLocationId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;

  const post = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  const today = () => new Date().toISOString().slice(0, 10);
  const report = (query: string) => get(`/sales/salesmen/commissions?${query}`);
  const shown = async (query: string) => data((await report(query)).body);
  const linesOf = async (query: string) => rowsOf((await shown(query)).rows);

  /** A posted فاتورة is the only one the window counts — drafts and voided ones are not. */
  const invoice = async (body: Record<string, unknown>) => {
    const created = await post('/sales/invoices', { cashCustomerName: 'عميل نقدي', ...body });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string };
    const posted = await post(`/sales/invoices/${draft.id}/post`, {});
    expect(posted.status).toBe(201);
    return data(posted.body) as { id: string; number: string; subtotal: string };
  };

  beforeAll(async () => {
    ctx = await createTestApp('salesman-commissions');
    actor = await createActor(ctx, {
      tenantCode: 'smn-com',
      email: 'owner@smn-com.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'sales.view',
        'sales.salesman.manage',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.invoice.void',
        'sales.invoice.pay',
        'sales.return.create',
        'sales.adjustment.create',
        'hrm.view',
        'hrm.manage',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'organization.branch.manage',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.postingprofile.view',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.reports.view',
        'accounting.period.view',
        'accounting.period.close',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'smn-com-2',
      email: 'owner@smn-com-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view', 'sales.salesman.manage', 'hrm.manage'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', {
      name: `FY${year}`,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    });
    expect(fiscal.status).toBe(201);

    // The branch and its warehouse come from provisioning, which is also what installs
    // the posting profiles a فاتورة cannot be posted without.
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const other = await post('/branches', { code: 'BR2', nameAr: 'فرع بلا حركات' });
    expect(other.status).toBe(201);
    otherBranchId = data(other.body).id as string;

    const category = await post('/organization/catalog/categories', { code: 'GEN', nameAr: 'عام' });
    expect(category.status).toBe(201);
    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    expect(unit.status).toBe(201);
    const item = await post('/organization/catalog/items', {
      sku: 'SKU-COM',
      nameAr: 'صنف المندوب',
      categoryId: data(category.body).id,
      baseUnitId: data(unit.body).id,
      salePrice: '100.0000',
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

    // بضاعة أول المدة — a فاتورة cannot be posted out of an empty warehouse, and the
    // 40 a unit is the cost the «عمولة الربح» is measured against.
    const receipt = await post('/inventory/ledger/record', {
      lines: [
        {
          itemId,
          warehouseId,
          qty: '1000',
          unitCost: '40',
          direction: 'in',
          docType: 'opening',
          docId: '00000000-0000-0000-0000-000000000001',
        },
      ],
    });
    expect(receipt.status).toBe(201);

    const employee = await post('/hrm/employees', { employeeNo: 'SM-1', name: 'سالم أحمد', branchId });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;

    // 🧑‍💼 عمولة المبيعات 10% · عمولة التحصيل 5% · عمولة الربح 20%
    const salesman = await post('/sales/salesmen', {
      name: 'مندوب أول',
      employeeId,
      commissionRate: '10',
      collectionCommissionRate: '5',
      profitCommissionRate: '20',
    });
    expect(salesman.status).toBe(201);
    salesmanId = data(salesman.body).id as string;

    // A مندوب with no rates and no employee card: his فواتير count, his commissions are 0.
    const plain = await post('/sales/salesmen', { name: 'مندوب بلا عمولة' });
    expect(plain.status).toBe(201);
    plainSalesmanId = data(plain.body).id as string;

    // الصندوق — provisioned with the branch, and it is where the سندات القبض land.
    cashLocationId = defaults.cashLocationId;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('تقريرٌ فارغ قبل أي حركة — و«كل الفترة» و«الكل» مفعّلان', async () => {
    const empty = await shown('');
    expect(rowsOf(empty.rows)).toHaveLength(0);
    expect(empty).toMatchObject({ allSalesmen: true, allPeriod: true, from: today(), to: today() });
    // 💰 إجمالي القيمة · 📈 ع. المبيعات · 💳 ع. التحصيل · 📊 ع. الربح
    expect(empty.summary).toMatchObject({
      totalValue: '0.0000',
      salesCommission: '0.0000',
      collectionCommission: '0.0000',
      profitCommission: '0.0000',
      rows: 0,
    });
  });

  it('فاتورة بيع محصَّلة — العمولات الثلاث', async () => {
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId,
      // نقدي — `pay_type` is set, so «عمولة التحصيل» is earned (L331).
      lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '0' }],
    });
    const paid = await post(`/sales/invoices/${sold.id}/payments`, {
      method: 'cash',
      amount: '200',
      idempotencyKey: 'comm-paid-1',
      cashLocationId,
    });
    expect(paid.status).toBe(201);

    const rows = await linesOf('');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      movementType: 'فاتورة بيع',
      date: today(),
      documentId: sold.id,
      number: sold.number,
      salesmanName: 'مندوب أول',
      branchName: 'الفرع الرئيسي',
      value: '200.0000',
      // 10% of 200 · 5% of 200 · 20% of (200 − 80)
      salesCommission: '20.0000',
      collectionCommission: '10.0000',
      profitCommission: '24.0000',
      isPlus: 1,
    });
  });

  it('فاتورة آجلة — لا عمولة تحصيل بلا تحصيل', async () => {
    await invoice({
      branchId,
      warehouseId,
      salesmanId,
      lines: [{ itemId, quantity: '3', unitPrice: '100', taxRate: '0' }],
    });

    const rows = await linesOf(`salesman_id=${salesmanId}`);
    const last = rows[rows.length - 1] as Record<string, unknown>;
    expect(last).toMatchObject({
      movementType: 'فاتورة بيع',
      value: '300.0000',
      salesCommission: '30.0000',
      // «عمولة التحصيل فقط إذا كان نوع الدفع موجودًا» — nothing was collected yet.
      collectionCommission: '0.0000',
      profitCommission: '36.0000',
    });
  });

  it('مرتجع بيع — علامةٌ سالبة في الإجمالي', async () => {
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId,
      lines: [{ itemId, quantity: '4', unitPrice: '100', taxRate: '0' }],
    });
    const draft = await post(`/sales/invoices/${sold.id}/return`, {
      branchId,
      warehouseId,
      salesmanId,
      cashCustomerName: 'عميل نقدي',
      lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '0' }],
    });
    expect(draft.status).toBe(201);
    const returned = await post(`/sales/invoices/${data(draft.body).id}/post`, {});
    expect(returned.status).toBe(201);

    const rows = await linesOf(`salesman_id=${salesmanId}`);
    const ret = rows.find((row) => row.movementType === 'فاتورة مرتجع بيع') as Record<
      string,
      unknown
    >;
    expect(ret).toMatchObject({
      value: '100.0000',
      salesCommission: '10.0000',
      collectionCommission: '0.0000',
      profitCommission: '12.0000',
      isPlus: -1,
    });

    /**
     * `RecalculateSummary` L482 adds `Value` **without** `isPlus`, so a مرتجع raises the
     * desktop's «💰 إجمالي القيمة». The cloud's total is signed — a report that grows
     * when the goods come back would pay commission on a refund.
     */
    const summary = (await shown(`salesman_id=${salesmanId}`)).summary as Record<string, unknown>;
    const invoiceRows = rows.filter((row) => String(row.movementType).startsWith('فاتورة'));
    const signed = invoiceRows.reduce(
      (sum, row) => sum + Number(row.value) * Number(row.isPlus),
      0,
    );
    expect(summary.totalValue).toBe(signed.toFixed(4));
  });

  it('إشعار مدين — يستردّ بعض العمولة', async () => {
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId,
      lines: [{ itemId, quantity: '5', unitPrice: '100', taxRate: '0' }],
    });
    const note = await post(`/sales/invoices/${sold.id}/adjustment-notes`, {
      branchId,
      kind: 'debit',
      reason: 'فرق سعر',
      amount: '50',
    });
    expect(note.status).toBe(201);
    const postedNote = await post(`/sales/adjustment-notes/${data(note.body).id}/post`, {});
    expect(postedNote.status).toBe(201);

    const rows = await linesOf(`salesman_id=${salesmanId}`);
    const debit = rows.find((row) => row.movementType === 'إشعار مدين') as Record<string, unknown>;
    expect(debit).toMatchObject({
      value: '50.0000',
      // L378–L379 — the note gives back a sales and a collection commission, never a profit one.
      salesCommission: '5.0000',
      collectionCommission: '2.5000',
      profitCommission: '0.0000',
      isPlus: -1,
      refNumber: sold.number,
    });
  });

  it('سند قبض عميل — عمولة التحصيل على ما قُبض', async () => {
    const created = await post('/vouchers', {
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: today(),
      cashLocationId,
      method: 'cash',
      amount: '1150',
      vatAmount: '150',
      netAmount: '1000',
      salesmanId: employeeId,
    });
    expect(created.status).toBe(201);
    const posted = await post(`/vouchers/${data(created.body).id}/post`, {});
    expect(posted.status).toBe(201);

    const rows = await linesOf(`salesman_id=${salesmanId}`);
    const receipt = rows.find((row) => row.movementType === 'سند قبض عميل') as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({
      // `baseVal = NetVal × 100 / 115` L452 — the cloud's سند carries its VAT as a field.
      value: '1000.0000',
      salesCommission: '0.0000',
      // L453 — the commission is on what was received: 5% of 1150.
      collectionCommission: '57.5000',
      profitCommission: '0.0000',
      isPlus: 1,
    });

    // A سند written against an employee with no مندوب card is nobody's commission —
    // and a مندوب with no employee card has no سندات at all.
    const plainRows = await linesOf(`salesman_id=${plainSalesmanId}`);
    expect(plainRows.some((row) => String(row.movementType).startsWith('سند'))).toBe(false);
  });

  it('📅 الفترة الزمنية — الفواتير وحدها تخرج منها، والسندات مقيدة بالتاريخين دائماً', async () => {
    const outside = await shown(`all_period=0&from=2000-01-01&to=2000-01-31`);
    const summary = outside.summary as Record<string, unknown>;
    // «كل الفترة» lifted from the invoices: none of them is inside January 2000.
    expect(summary.invoices).toBe(0);
    /**
     * `LoadReceiptsByType` L426 — the receipts are inside the two dates **always**;
     * «كل الفترة» lifts the filter from the invoices only. Ported as it stands: a
     * سند from today does not belong to January 2000, so it is not here either.
     */
    expect(summary.receipts).toBe(0);
    expect(summary.rows).toBe(0);

    const inside = await shown(`all_period=0&from=${today()}&to=${today()}`);
    expect((inside.summary as Record<string, unknown>).rows).toBeGreaterThan(0);
  });

  it('الفرع و«المندوب» — تضييقٌ بلا تأثيرٍ على بقية الحركات', async () => {
    // «مندوب بلا عمولة» sells too: his فواتير are counted, his commissions are zero.
    await invoice({
      branchId,
      warehouseId,
      salesmanId: plainSalesmanId,
      lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '0' }],
    });

    const everything = (await shown('')).summary as Record<string, unknown>;
    expect(everything.invoices).toBeGreaterThan(1);

    // فرعٌ بلا حركات — `MainClass.BranchNo` narrows the invoices (L193) and nothing else.
    const inOtherBody = await shown(`branch_id=${otherBranchId}`);
    const inOther = inOtherBody.summary as Record<string, unknown>;
    expect(inOther.invoices).toBe(0);
    /**
     * `MainClass.BranchNo` narrows the invoices (L193) and nothing else: the desktop's
     * `LoadReceiptsByType` never mentions a branch even though `Receipts` has one, so a
     * سند shows under every فرع. Ported as it stands — this assertion is here so nobody
     * "fixes" it silently and so the divergence stays written down.
     */
    expect(rowsOf(inOtherBody.rows).map((row) => row.movementType)).toEqual(['سند قبض عميل']);
    const inMain = (await shown(`branch_id=${branchId}`)).summary as Record<string, unknown>;
    expect(inMain.invoices).toBe(everything.invoices);

    // With «🌐 الكل» off and nothing picked the desktop filters nothing at all (L187).
    const nonePicked = (await shown('all_salesmen=0')).summary as Record<string, unknown>;
    expect(nonePicked.invoices).toBe(everything.invoices);

    // One مندوب sees his own documents only.
    const oneSalesman = await shown(`salesman_id=${salesmanId}`);
    expect(oneSalesman.salesmanName).toBe('مندوب أول');
    expect(oneSalesman.salesmanId).toBe(salesmanId);
    const oneSummary = oneSalesman.summary as Record<string, unknown>;
    expect(oneSummary.rows).toBeGreaterThan(0);
    expect(oneSummary.rows).toBeLessThan(everything.rows as number);
  });

  it('عزل المستأجرين — لا عمولة تُحصى من مؤسسةٍ أخرى', async () => {
    const mine = (await shown('')).summary as Record<string, unknown>;
    expect(mine.rows).toBeGreaterThan(0);

    const theirs = await api(ctx.server, 'get', '/api/v1/sales/salesmen/commissions', {
      token: stranger.token,
    });
    expect(theirs.status).toBe(200);
    expect((data(theirs.body).summary as Record<string, unknown>).rows).toBe(0);

    // A مندوب of another tenant is not selectable here either: it simply matches nothing.
    const foreign = await shown(`salesman_id=${plainSalesmanId}&all_salesmen=0`);
    expect(foreign.salesmanName).toBe('مندوب بلا عمولة');
  });
});
