import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 08 part five — 📈 حركات الموظف (`Form_WPF/frmEmpInvs.xaml` «مبيعات ومشتريات
 * موظف خلال الفترة»).
 *
 * `InitializeProcessTypes` (L102) fills «🔄 نوع الحركة» with `مبيعات` · `مرتجع`, and
 * `ShowResult` (L226) reads `Inv ⋈ Inv_Sub` on `Inv.sales_emp` — the employee who made
 * the sale — over `date >= @date1 AND date <= @date2`, with `@date2` = `txtDateTo
 * .AddHours(24)` so the last day is inside the period, keeping `Inv.IS_Deleted=0`, and
 * printing one row per **line**: `نوع الحركة · 📅 التاريخ · رقم الفاتورة · 📦 الصنف ·
 * الكمية · 💵 السعر · إضافات · 💰 الإجمالي`, under a `💰 الإجمالي` footer (`txtSum`).
 *
 * The cloud had no way to ask «ماذا باع هذا الموظف؟»: `sales_invoices.salesman_id`
 * existed and nothing read it. This is the screen that reads it — the same field the
 * accounting journal lines point at `employees.id`.
 *
 * One deviation is deliberate and tested: the desktop's `_Sum += tot_net` runs per line,
 * so a three-line invoice counts its total three times. Here each invoice is counted
 * once, sales positive and مرتجع negative.
 */
describe('حركات الموظف — frmEmpInvs', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let employeeId = '';
  let secondEmployeeId = '';
  let otherBranchId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : (((body as { data?: unknown }).data as unknown[]) ?? [])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  const today = () => new Date().toISOString().slice(0, 10);
  const movements = (query: string) => get(`/hrm/employee-movements?${query}`);
  const linesOf = async (query: string) => rowsOf(data((await movements(query)).body).rows);

  /** A posted invoice is the only one the window counts — drafts and voided ones are not. */
  const invoice = async (body: Record<string, unknown>) => {
    const created = await post('/sales/invoices', { cashCustomerName: 'عميل نقدي', ...body });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string };
    const posted = await post(`/sales/invoices/${draft.id}/post`, {});
    expect(posted.status).toBe(201);
    return data(posted.body) as { id: string; number: string; total: string; kind: string };
  };

  beforeAll(async () => {
    ctx = await createTestApp('employee-movements');
    actor = await createActor(ctx, {
      tenantCode: 'emp-mov',
      email: 'owner@emp-mov.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'hrm.view',
        'hrm.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.return.create',
        'sales.invoice.void',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.account.view',
        'accounting.reports.view',
        'accounting.period.view',
        'accounting.period.close',
        'organization.branch.manage',
        'organization.postingprofile.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'emp-mov-2',
      email: 'owner@emp-mov-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const category = await post('/organization/catalog/categories', { code: 'GEN', nameAr: 'عام' });
    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    const item = await post('/organization/catalog/items', {
      sku: 'SKU-MOV',
      nameAr: 'صنف المندوب',
      categoryId: data(category.body).id,
      baseUnitId: data(unit.body).id,
      salePrice: '100.0000',
    });
    itemId = data(item.body).id as string;

    const receipt = await post('/inventory/ledger/record', {
      lines: [{ itemId, warehouseId, qty: '1000', unitCost: '40', direction: 'in', docType: 'opening', docId: '00000000-0000-0000-0000-000000000001' }],
    });
    expect(receipt.status).toBe(201);

    // 👤 «الموظف» — `LoadEmployees` L146: every employee, not only the ones with an
    // account; the window sells by whoever made the sale.
    const employee = await post('/hrm/employees', { employeeNo: 'SM-1', name: 'سالم أحمد', branchId });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;

    const second = await post('/hrm/employees', { employeeNo: 'SM-2', name: 'محمد علي', branchId });
    expect(second.status).toBe(201);
    secondEmployeeId = data(second.body).id as string;

    const otherBranch = await post('/branches', { code: 'BR2', nameAr: 'فرع بلا حركات' });
    expect(otherBranch.status).toBe(201);
    otherBranchId = data(otherBranch.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('اختر موظف — بلا موظف أو بموظف غير موجود', async () => {
    const none = await movements('');
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'EMPLOYEE_MOVEMENTS_EMPLOYEE_REQUIRED', detail: 'اختر موظف' });

    const missing = await movements('employee_id=00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'EMPLOYEE_MOVEMENTS_EMPLOYEE_REQUIRED' });
  });

  it('كشفٌ فارغ قبل أي حركة', async () => {
    const shown = data((await movements(`employee_id=${employeeId}`)).body);
    expect(rowsOf(shown.rows)).toHaveLength(0);
    expect(shown.summary).toMatchObject({ total: '0.0000', salesTotal: '0.0000', returnsTotal: '0.0000', invoices: 0, lines: 0 });
    // «من تاريخ»/«إلى تاريخ» open on today (`FrmEmpInvs_Loaded` L72).
    expect(shown.from).toBe(today());
    expect(shown.to).toBe(today());
  });

  it('فاتورة بيع بسطرين — سطرٌ لكل سطر قيد، و«💰 الإجمالي» يجمع الفاتورة مرّة واحدة', async () => {
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId: employeeId,
      lines: [
        { itemId, quantity: '3', unitPrice: '100', taxRate: '0' },
        { itemId, quantity: '2', unitPrice: '50', taxRate: '0' },
      ],
    });

    const lines = await linesOf(`employee_id=${employeeId}`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      seq: 1,
      movementType: 'فاتورة بيع',
      invoiceId: sold.id,
      number: sold.number,
      itemName: 'صنف المندوب',
      quantity: '3.0000',
      unitPrice: '100.0000',
      additions: '0.0000',
      lineTotal: '300.0000',
      branchName: 'الفرع الرئيسي',
      isReturn: false,
    });
    // «💰 الإجمالي» — `val * exchange_price` (L347), and the footer is the invoice's، لا مجموعَ الأسطر مضروباً بعددها.
    expect(lines[1]).toMatchObject({ quantity: '2.0000', unitPrice: '50.0000', lineTotal: '100.0000' });

    const shown = data((await movements(`employee_id=${employeeId}`)).body);
    expect(shown.summary).toMatchObject({
      total: '400.0000',
      salesTotal: '400.0000',
      returnsTotal: '0.0000',
      invoices: 1,
      lines: 2,
    });
  });

  it('مرتجع بيع يُطرح من «💰 الإجمالي»', async () => {
    const draft = await invoice({
      branchId,
      warehouseId,
      salesmanId: employeeId,
      lines: [{ itemId, quantity: '4', unitPrice: '100', taxRate: '0' }],
    });

    const returnDraft = await post(`/sales/invoices/${draft.id}/return`, {
      branchId,
      warehouseId,
      salesmanId: employeeId,
      cashCustomerName: 'عميل نقدي',
      lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '0' }],
    });
    expect(returnDraft.status).toBe(201);
    const returned = data(returnDraft.body) as { id: string };
    const postedReturn = await post(`/sales/invoices/${returned.id}/post`, {});
    expect(postedReturn.status).toBe(201);

    const lines = await linesOf(`employee_id=${employeeId}`);
    const returnLine = lines.find((row) => row.isReturn === true);
    expect(returnLine?.movementType).toBe('فاتورة مرتجع بيع');

    const shown = data((await movements(`employee_id=${employeeId}`)).body);
    // 400 + 400 − 100.
    expect(shown.summary).toMatchObject({ total: '700.0000', salesTotal: '800.0000', returnsTotal: '100.0000', invoices: 3 });
  });

  it('🔄 نوع الحركة — «مبيعات» · «مرتجع» · «الكل»', async () => {
    const sales = await linesOf(`employee_id=${employeeId}&movement_type=sales`);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((row) => row.isReturn === false)).toBe(true);

    const returns = await linesOf(`employee_id=${employeeId}&movement_type=returns`);
    expect(returns).toHaveLength(1);
    expect(returns[0]?.movementType).toBe('فاتورة مرتجع بيع');

    // «الكل» is the checked default (`ckAllproc` L220) and the API default too.
    const all = await linesOf(`employee_id=${employeeId}`);
    expect(all).toHaveLength(sales.length + returns.length);
    expect(data((await movements(`employee_id=${employeeId}`)).body).movementType).toBe('all');
  });

  it('فاتورة نقطة بيع — «فاتورة نقطة بيع» لا «فاتورة بيع»', async () => {
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId: employeeId,
      // نقطة البيع in the cloud is an invoice with an `orderType`/shift — the desktop's
      // `inv_type` 2 against 3.
      orderType: 'pos',
      lines: [{ itemId, quantity: '5', unitPrice: '100', taxRate: '0' }],
    });
    expect(sold.kind).toBe('sale');

    const lines = await linesOf(`employee_id=${employeeId}&movement_type=sales`);
    const pos = lines.find((row) => row.invoiceId === sold.id);
    expect(pos?.movementType).toBe('فاتورة نقطة بيع');
  });

  it('📅 من تاريخ / إلى تاريخ — اليوم الأخير داخل الفترة', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const outside = await movements(`employee_id=${employeeId}&from=${yesterday}&to=${yesterday}`);
    expect(rowsOf(data(outside.body).rows)).toHaveLength(0);

    const inside = await movements(`employee_id=${employeeId}&from=${today()}&to=${today()}`);
    expect(rowsOf(data(inside.body).rows).length).toBeGreaterThan(0);
  });

  it('الكل — كل الموظفين الذين لهم حركات', async () => {
    await invoice({
      branchId,
      warehouseId,
      salesmanId: secondEmployeeId,
      lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '0' }],
    });

    const all = data((await movements('all_employees=1')).body);
    expect(rowsOf(all.rows).length).toBeGreaterThan(0);
    // 400 + 400 + 500 − 100 + 200.
    expect(all.summary).toMatchObject({ total: '1400.0000', salesTotal: '1500.0000', returnsTotal: '100.0000' });

    const one = data((await movements(`employee_id=${secondEmployeeId}`)).body);
    expect(rowsOf(one.rows)).toHaveLength(1);
    expect(one.summary).toMatchObject({ total: '200.0000', invoices: 1 });
  });

  it('🏢 الفرع — فرعٌ بلا حركات', async () => {
    const onBranch = await movements(`employee_id=${employeeId}&branch_id=${branchId}`);
    expect(rowsOf(data(onBranch.body).rows).length).toBeGreaterThan(0);

    const elsewhere = await movements(`employee_id=${employeeId}&branch_id=${otherBranchId}`);
    expect(rowsOf(data(elsewhere.body).rows)).toHaveLength(0);
  });

  it('فاتورةٌ مُلغاة لا تُحسب', async () => {
    // `Inv.IS_Deleted=0` in the window's own query — a voided invoice is not a movement.
    const sold = await invoice({
      branchId,
      warehouseId,
      salesmanId: employeeId,
      lines: [{ itemId, quantity: '1', unitPrice: '999', taxRate: '0' }],
    });

    const before = data((await movements(`employee_id=${employeeId}`)).body).summary as { total: string };
    expect(rowsOf(data((await movements(`employee_id=${employeeId}`)).body).rows).some((row) => row.invoiceId === sold.id)).toBe(true);

    const voided = await post(`/sales/invoices/${sold.id}/void`, { reason: 'إلغاء اختبار' });
    expect([200, 201]).toContain(voided.status);

    const after = data((await movements(`employee_id=${employeeId}`)).body);
    expect(rowsOf(after.rows).some((row) => row.invoiceId === sold.id)).toBe(false);
    expect(Number((after.summary as { total: string }).total)).toBe(Number(before.total) - Number(sold.total));
  });

  it('مستأجر آخر لا يرى حركات الموظف', async () => {
    const foreign = await api(ctx.server, 'get', `/api/v1/hrm/employee-movements?employee_id=${employeeId}`, { token: stranger.token });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ code: 'EMPLOYEE_MOVEMENTS_EMPLOYEE_REQUIRED' });

    const all = await api(ctx.server, 'get', '/api/v1/hrm/employee-movements?all_employees=1', { token: stranger.token });
    expect(all.status).toBe(200);
    expect(rowsOf(data(all.body).rows)).toHaveLength(0);
  });
});
