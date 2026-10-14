import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 06 part five — 👤 عميل نقدي (`frmCashCustomer`).
 *
 * `Form_WPF/frmCashCustomer.xaml` is the till's answer to a walk-in: `🏷️ الاسم:`،
 * `📱 رقم الجوال:`، `✅ إدراج` / `🚪 خروج`، و`🔍` بحث بالجوال أو بالاسم على شبكة
 * أعمدتها `👤 الاسم` · `📱 الجوال` · `اختيار`.
 *
 * The decisive thing is in the code-behind: `SearchCustomers` does **not** open a
 * customer table. It runs
 *
 *   SELECT CashCustomerName, CashCustomerMobile FROM inv
 *    WHERE (CashCustomerMobile = @Mobile) AND CashCustomerName <> ''
 *      — or —
 *   SELECT CashCustomerName, CashCustomerMobile FROM inv
 *    WHERE CashCustomerName LIKE '%' + @Name + '%' AND CashCustomerName <> ''
 *
 * A cash customer is a name and a mobile **written on the invoice** (`inv.CashCustomerName` /
 * `inv.CashCustomerMobile`), and "find the customer" means "find a name this shop has
 * already served". No party is created, no ledger account is opened, and an empty name
 * is not a customer at all.
 *
 * The cloud has had the two columns since the sales engine; what it never had was the
 * search — so a till could write a name and never find it again.
 */
describe('Sales cash customers — 👤 عميل نقدي', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';
  let safeId = '';
  let customerId = '';
  let itemId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  /** 👤 عميل نقدي — `GET /sales/cash-customers`, the desktop's `SELECT … FROM inv`. */
  const search = (query = '') =>
    api(ctx.server, 'get', `/api/v1/sales/cash-customers${query ? `?${query}` : ''}`, { token: actor.token });

  const sell = async (body: Record<string, unknown>) => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
        payment: { method: 'cash', cashLocationId: safeId },
        ...body,
      },
    });
    expect(checkout.status).toBe(201);
    return data(checkout.body);
  };

  beforeAll(async () => {
    ctx = await createTestApp('sales-cash-customer');
    actor = await createActor(ctx, {
      tenantCode: 'sal-cash',
      email: 'owner@sal-cash.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'pos.view',
        'pos.operate',
        'pos.config.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'organization.warehouse.manage',
        'organization.postingprofile.view',
        'parties.manage',
        'parties.view',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
        'inventory.view',
        'inventory.adjust',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'sal-cash-2',
      email: 'owner@sal-cash-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH1', name: 'المستودع الرئيسي', isDefault: true },
    });
    expect(warehouse.status).toBe(201);
    warehouseId = data(warehouse.body).id as string;

    const safeAccountId = await account({ code: '1211', nameAr: 'الصندوق', type: 'asset' });
    const receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    const revenueAccountId = await account({ code: '4110', nameAr: 'المبيعات', type: 'revenue' });
    const cashAccountId = await account({ code: '1221', nameAr: 'النقدية', type: 'asset' });
    const taxAccountId = await account({ code: '2310', nameAr: 'ضريبة القيمة المضافة', type: 'liability' });
    const cogsAccountId = await account({ code: '5110', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' });
    const inventoryAccountId = await account({ code: '1130', nameAr: 'المخزون', type: 'asset' });

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'الصندوق الرئيسي', accountId: safeAccountId, isDefault: true },
    });
    safeId = data(safe.body).id as string;

    const customer = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { code: 'C-1', kind: 'customer', name: 'عميل بحساب', receivableAccountId },
    });
    customerId = data(customer.body).id as string;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'CAT1', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'قطعة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'ITM-CASH',
        nameAr: 'صنف للعميل النقدي',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100',
        costPrice: '60',
      },
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

    const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '100',
            unitCost: '60',
            direction: 'in',
            docType: 'opening',
            docId: '00000000-0000-0000-0000-000000000001',
          },
        ],
      },
    });
    expect(receipt.status).toBeLessThan(300);

    for (const [docType, mapping] of [
      [
        'sales_invoice',
        {
          salesAccountId: revenueAccountId,
          vatOutputAccountId: taxAccountId,
          cashAccountId,
          receivableAccountId,
          cogsAccountId,
          inventoryAccountId,
        },
      ],
      ['receipt_voucher', { cashAccountId }],
      ['payment_voucher', { cashAccountId }],
    ] as const) {
      const profile = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
        token: actor.token,
        body: { branchId, docType, mapping: { version: 1, ...mapping } },
      });
      expect(profile.status).toBeLessThan(300);
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('الاسم والجوال يُكتبان على الفاتورة نفسها', async () => {
    const receipt = await sell({ cashCustomerName: 'محمد العلي', cashCustomerMobile: '0551234567' });
    const invoice = await api(ctx.server, 'get', `/api/v1/sales/invoices/${receipt.invoiceId}`, {
      token: actor.token,
    });
    const body = data(invoice.body);
    expect(body.cashCustomerName).toBe('محمد العلي');
    expect(body.cashCustomerMobile).toBe('0551234567');
  });

  it('🔍 البحث بالجوال يجده بعينه — تطابق تام لا تقريب', async () => {
    await sell({ cashCustomerName: 'محمد العلي', cashCustomerMobile: '0551234567' });
    await sell({ cashCustomerName: 'سالم الغامدي', cashCustomerMobile: '0509876543' });

    const response = await search('mobile=0551234567');
    expect(response.status).toBe(200);
    const rows = list(response.body);
    // `WHERE (CashCustomerMobile = @Mobile)` — one number, one customer.
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('محمد العلي');
    expect(rows[0].mobile).toBe('0551234567');
  });

  it('🔍 البحث بالاسم يبحث في وسط الاسم', async () => {
    await sell({ cashCustomerName: 'عبدالله الحربي', cashCustomerMobile: '0530000001' });

    const response = await search(`name=${encodeURIComponent('عبدالله')}`);
    expect(response.status).toBe(200);
    const names = list(response.body).map((row) => row.name);
    // `LIKE '%' + @Name + '%'` — a fragment is enough, the desktop never demanded the
    // full name from a cashier mid-sale.
    expect(names).toContain('عبدالله الحربي');
    expect(names).not.toContain('سالم الغامدي');
  });

  it('الاسم يُجمَّع لا يُكرَّر: زيارتان عميلٌ واحد', async () => {
    await sell({ cashCustomerName: 'زيارتان', cashCustomerMobile: '0540000002' });
    await sell({ cashCustomerName: 'زيارتان', cashCustomerMobile: '0540000002' });
    await sell({ cashCustomerName: 'زيارتان', cashCustomerMobile: '0540000002' });

    const rows = list((await search(`name=${encodeURIComponent('زيارتان')}`)).body);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].invoices)).toBe(3);
  });

  it('الاسم الفارغ ليس عميلاً، وصاحب الحساب ليس عميلاً نقدياً', async () => {
    await sell({ partyId: customerId });
    const invoiceParty = await api(ctx.server, 'get', '/api/v1/sales/invoices', { token: actor.token });
    expect(invoiceParty.status).toBe(200);

    const rows = list((await search()).body);
    const names = rows.map((row) => String(row.name ?? ''));
    // `CashCustomerName <> ''` — the desktop's own filter, kept verbatim.
    expect(names.every((nameValue) => nameValue.trim().length > 0)).toBe(true);
    // A sale on a ledger account writes no cash-customer name, so it cannot appear here.
    expect(names).not.toContain('عميل بحساب');
  });

  it('بلا كلمة بحث يردّ آخر الأسماء خدمةً لا شبكة فارغة', async () => {
    await sell({ cashCustomerName: 'أحدث عميل', cashCustomerMobile: '0560000003' });
    const rows = list((await search()).body);
    // One justified difference from the desktop: its grid starts empty and fills only on
    // a keystroke, and a list screen that opens empty looks broken.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe('أحدث عميل');
  });

  it('مستأجر آخر لا يرى عملاءنا النقديين', async () => {
    const theirs = await api(ctx.server, 'get', '/api/v1/sales/cash-customers', { token: stranger.token });
    expect(theirs.status).toBe(200);
    expect(list(theirs.body).length).toBe(0);
  });
});
