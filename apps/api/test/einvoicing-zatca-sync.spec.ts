import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📊 حالة المزامنة — the port of `Form_WPF/frmInvsSyncStatusZatca.xaml` (559) and
 * `.xaml.cs` (1165).
 *
 * The window answers one question the cashier asks at the end of the day: which of these
 * invoices did ZATCA take? Everything it shows is proved here, in the order the window
 * computes it:
 *
 * 1. the grid is every posted فاتورة and its مرتجع — never a مسوَّدة, never an invoice the
 *    tenant voided — newest first, numbered from 1;
 * 2. «نوع الفاتورة» is `InvoiceOper.GetInvoiceTypeAr` (L346-L378): a customer with a tax
 *    number makes it ضريبية, a cash sale makes it مبسّطة, and a مرتجع is an إشعار دائن;
 * 3. «حالة المزامنة» is ✅ مرسل / ❌ لم يُرسل, and 🔵 الكل · ✅ مرسل · ❌ غير مرسل filter it;
 * 4. «الرسالة» is the authority's own answer — including why a filing never left;
 * 5. 💰 «الصافي» is `sum - sum1` of `RecalculateNetSummary` (L329-L345), i.e. المبيعات
 *    ناقص المردودات;
 * 6. 🔄 مزامنة ZATCA files what the clerk ticked, one by one, and says what happened to
 *    each — an empty selection, a مسوَّدة, an invoice the authority already has and a
 *    paused link are all *reported*, not silently dropped.
 *
 * Every filing goes through the 🧪 simulation gateway, so the suite never dials the
 * authority.
 */
describe('zatca sync status — 📊 حالة المزامنة', () => {
  let ctx: TestApp;
  let actor: Actor;
  let readonly: Actor;
  let other: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, any>;
  const call = (method: 'get' | 'post' | 'put', path: string, options: { token: string; body?: unknown } = { token: '' }) => api(ctx.server, method, `/api/v1${path}`, options);

  const report = (query = '', token = actor.token) => call('get', `/reports/einvoice-sync-status${query ? `?${query}` : ''}`, { token });
  const sync = (ids: string[], token = actor.token) => call('post', '/einvoice/sync', { token, body: { ids } });

  async function newInvoice(options: { partyId?: string; quantity?: string; cashCustomer?: string } = {}) {
    const created = await call('post', '/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: options.partyId,
        cashCustomerName: options.cashCustomer,
        lines: [{ itemId, quantity: options.quantity ?? '2', unitPrice: '27.5', taxRate: '15' }],
      },
    });
    return String(body(created).id);
  }

  async function postedInvoice(options: { partyId?: string; quantity?: string; cashCustomer?: string } = {}) {
    const id = await newInvoice(options);
    const posted = await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    if (posted.status >= 300) throw new Error(`post invoice: ${posted.status} ${JSON.stringify(posted.body)}`);
    return id;
  }

  /** إشعار دائن — `inv_type = 21`, the notice of the desktop, filed as a 381. */
  async function creditNote(invoiceId: string) {
    const created = await call('post', '/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        kind: 'credit_note',
        referenceInvoiceId: invoiceId,
        lines: [{ itemId, quantity: '1', unitPrice: '27.5', taxRate: '15' }],
      },
    });
    if (created.status >= 300) throw new Error(`credit note: ${created.status} ${JSON.stringify(created.body)}`);
    const id = String(body(created).id);
    const posted = await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    if (posted.status >= 300) throw new Error(`post credit note: ${posted.status} ${JSON.stringify(posted.body)}`);
    return id;
  }

  async function returned(invoiceId: string, quantity = '1') {
    const created = await call('post', `/sales/invoices/${invoiceId}/return`, {
      token: actor.token,
      body: { branchId, warehouseId, lines: [{ itemId, quantity, unitPrice: '27.5', taxRate: '15' }] },
    });
    if (created.status >= 300) throw new Error(`return: ${created.status} ${JSON.stringify(created.body)}`);
    const id = String(body(created).id);
    await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestApp('zatca-sync');
    const permissions = [
      ...ALL_PLATFORM_PERMISSIONS,
      ...ALL_ORGANIZATION_PERMISSIONS,
      'catalog.item.view',
      'catalog.item.manage',
      'catalog.unit.manage',
      'catalog.category.manage',
      'inventory.view',
      'inventory.adjust',
      'parties.view',
      'parties.manage',
      'sales.view',
      'sales.invoice.create',
      'sales.invoice.post',
      'sales.return.create',
      'accounting.period.close',
      'reporting.view',
      'einvoice.view',
      'einvoice.manage',
      'einvoice.submit',
      'einvoice.credentials.manage',
    ];
    actor = await createActor(ctx, { tenantCode: 'zatcasyn', email: 'owner@zatcasyn.test', permissions });
    readonly = await createActor(ctx, { tenantCode: 'zatcasyn', email: 'viewer@zatcasyn.test', permissions: ['reporting.view', 'einvoice.view'] });
    other = await createActor(ctx, { tenantCode: 'zatcasyn2', email: 'owner@zatcasyn2.test', permissions });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    const year = new Date().getUTCFullYear();
    await call('post', '/fiscal-years', { token: actor.token, body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` } });
    warehouseId = body(await call('post', '/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع' } })).id;
    const unitId = body(await call('post', '/organization/catalog/units', { token: actor.token, body: { code: 'PCE', nameAr: 'حبة' } })).id;
    const categoryId = body(await call('post', '/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } })).id;
    itemId = body(await call('post', '/organization/catalog/items', { token: actor.token, body: { sku: 'RICE-5', nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' } })).id;
    partyId = body(await call('post', '/parties', { token: actor.token, body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012' } })).id;

    const profile = await call('put', '/company-profile', {
      token: actor.token,
      body: { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000', address: { street: 'طريق الملك فهد', building: '1234', district: 'العليا', city: 'الرياض', postal: '12345' } },
    });
    if (profile.status >= 300) throw new Error(`company profile: ${profile.status} ${JSON.stringify(profile.body)}`);
    await call('post', '/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000021' }] },
    });

    const ladder: Array<[string, { status: number; body: Record<string, unknown> }]> = [];
    ladder.push(['settings', await call('put', '/einvoice/settings', { token: actor.token, body: { simulation: true, active: true, environment: 'compliance' } })]);
    ladder.push(['fill', await call('post', '/einvoice/settings/fill-from-company', { token: actor.token, body: {} })]);
    ladder.push(['industry', await call('put', '/einvoice/settings', { token: actor.token, body: { csr: { industry: 'تجارة التجزئة' } } })]);
    ladder.push(['csr', await call('post', '/einvoice/csr/generate', { token: actor.token, body: {} })]);
    ladder.push(['compliance', await call('post', '/einvoice/onboarding/compliance-csid', { token: actor.token, body: { otp: '311222' } })]);
    ladder.push(['production', await call('post', '/einvoice/onboarding/production-csid', { token: actor.token, body: {} })]);
    for (const [step, response] of ladder) {
      if (response.status >= 300) throw new Error(`onboarding ${step}: ${response.status} ${JSON.stringify(response.body)}`);
    }
  }, 240_000);

  afterAll(async () => ctx.close());

  it('registers the window in the report catalogue with the desktop’s own columns', async () => {
    const catalog = body(await call('get', '/reports', { token: actor.token }));
    const entry = (catalog as any[]).find((row) => row.key === 'einvoice-sync-status');
    expect(entry).toBeDefined();
    expect(entry.titleAr).toBe('مزامنة الفواتير - ZATCA');
    expect(entry.group).toBe('zatca');
    // م · ID · الفرع · نوع الفاتورة · رقم الفاتورة · التاريخ · العميل · المستخدم ·
    // الصافي · الرسالة · حالة المزامنة — and nothing the window does not draw.
    expect(entry.columns.map((column: any) => column.labelAr)).toEqual([
      'م',
      'ID',
      'الفرع',
      'نوع الفاتورة',
      'رقم الفاتورة',
      'التاريخ',
      'العميل',
      'المستخدم',
      'الصافي',
      'الرسالة',
      'حالة المزامنة',
    ]);
    // 💰 «الصافي» is `NetTotal` of `rptInvSumByClient.repx` — المبيعات ناقص المردودات.
    expect(entry.grandTotal).toEqual(['إجمالي الفواتير', 'إجمالي المرتجعات والإشعارات', 'الصافي']);
    // 🔍 خيارات البحث — the three blocks down the right-hand side, in the window's order.
    expect(entry.params.map((param: any) => param.labelAr)).toEqual(['حالة المزامنة ZATCA', 'نوع الفاتورة', 'من', 'إلى', 'الفرع']);
    const kind = entry.params.find((param: any) => param.name === 'kind');
    expect(kind.options.map((option: any) => option.labelAr)).toEqual(['مبيعات', 'نقطة بيع', 'إشعار', 'مقاولات', 'أندرويد']);
  });

  it('lists every posted فاتورة and مرتجع — and never a مسوَّدة', async () => {
    const draft = await newInvoice({ cashCustomer: 'عميل نقدي' });
    const sale = await postedInvoice({ partyId });
    const cash = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const credit = await returned(sale);

    const grid = body(await report());
    const ids = grid.rows.map((row: any) => row.invoice_id);
    expect(ids).toContain(sale);
    expect(ids).toContain(cash);
    expect(ids).toContain(credit);
    // `IS_Deleted=0` plus the cloud's own «مُلغى»: a draft is not a document yet.
    expect(ids).not.toContain(draft);
    // «م» — numbered from 1 in the order shown, which is `ORDER BY date DESC`.
    expect(grid.rows.map((row: any) => row.seq)).toEqual(grid.rows.map((_: unknown, index: number) => String(index + 1)));
    const days = grid.rows.map((row: any) => Date.parse(row.issued_at.replace(' ', 'T') + 'Z'));
    expect([...days].sort((a, b) => b - a)).toEqual(days);
  });

  it('names the type the way `InvoiceOper.GetInvoiceTypeAr` does', async () => {
    const standard = await postedInvoice({ partyId });
    const simplified = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const credit = await returned(standard);

    const byId = new Map<string, any>(body(await report()).rows.map((row: any) => [row.invoice_id, row]));
    // `GetCustomerTaxType` (L302): a customer with a tax number is `0100000`.
    expect(byId.get(standard).kind_name).toBe('فاتورة ضريبية');
    expect(byId.get(simplified).kind_name).toBe('فاتورة ضريبية مبسطة');
    expect(byId.get(credit).kind_name).toBe('إشعار دائن للفاتورة الضريبية');
    // The window's own fields, filled from the joins `ShowInvs` does row by row.
    expect(byId.get(standard).party_name).toBe('مؤسسة النخبة');
    expect(byId.get(simplified).party_name).toBe('عميل نقدي');
    expect(byId.get(standard).branch_name).toBeTruthy();
    expect(byId.get(standard).user_name).toBeTruthy();
  });

  it('paints ✅ مرسل / ❌ لم يُرسل, and the three radios filter it', async () => {
    const unsent = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const sent = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const filed = body(await call('post', `/sales-invoices/${sent}/einvoice/submit`, { token: actor.token, body: {} }));
    expect(filed.status).toBe('reported');

    const all = new Map<string, any>(body(await report()).rows.map((row: any) => [row.invoice_id, row]));
    expect(all.get(sent).sync_status).toBe('✅ مرسل');
    expect(all.get(unsent).sync_status).toBe('❌ لم يُرسل');

    const sentOnly = body(await report('status=sent')).rows.map((row: any) => row.invoice_id);
    expect(sentOnly).toContain(sent);
    expect(sentOnly).not.toContain(unsent);

    const unsentOnly = body(await report('status=unsent')).rows.map((row: any) => row.invoice_id);
    expect(unsentOnly).toContain(unsent);
    expect(unsentOnly).not.toContain(sent);
  });

  it('filters by 📋 نوع الفاتورة — إشعار is the notes, مبيعات keeps the returns', async () => {
    const sale = await postedInvoice({ partyId });
    const returnedSale = await returned(sale);
    const note = await creditNote(sale);

    const notices = body(await report('kind=notice')).rows.map((row: any) => row.invoice_id);
    expect(notices).toContain(note);
    // `proc_type = 2` of `inv_type = 2` is a مرتجع مبيعات, which the desktop files under
    // «مبيعات» — the window's «إشعار» is `inv_type = 21`.
    expect(notices).not.toContain(returnedSale);
    expect(notices).not.toContain(sale);

    const sales = body(await report('kind=sale')).rows.map((row: any) => row.invoice_id);
    expect(sales).toContain(sale);
    expect(sales).toContain(returnedSale);
    expect(sales).not.toContain(note);
  });

  it('filters by 📅 الفترة الزمنية, and «📌 كل الفترة» ignores the boxes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const inside = body(await report(`from=${today}&to=${today}`));
    for (const row of inside.rows) expect(row.issued_at.startsWith(today)).toBe(true);

    const outside = body(await report(`from=${yesterday}&to=${yesterday}`));
    expect(outside.rowCount).toBe(0);
    expect(outside.rows).toEqual([]);

    const everything = body(await report());
    expect(everything.rowCount).toBeGreaterThan(0);
  });

  it('totals 💰 «الصافي» as المبيعات ناقص المردودات', async () => {
    const sale = await postedInvoice({ partyId, quantity: '2' });
    await returned(sale, '1');
    await postedInvoice({ cashCustomer: 'عميل نقدي', quantity: '1' });

    const grid = body(await report());
    const card = (key: string) => Number(grid.grandTotal.find((row: any) => row.key === key).amount);
    const rows = grid.rows as any[];
    const sales = rows.reduce((sum, row) => sum + Number(row.net_sale), 0);
    const returns = rows.reduce((sum, row) => sum + Number(row.net_return), 0);
    expect(card('net_sale')).toBeCloseTo(sales, 2);
    expect(card('net_return')).toBeCloseTo(returns, 2);
    // `NetTotal` of `BuildReportDataSet` (L1058) — `sum - sum1`.
    expect(card('net_signed')).toBeCloseTo(sales - returns, 2);
    expect(card('net_signed')).toBeLessThan(card('net_sale'));
  });

  it('prints «الرسالة» as the authority’s own words, including why a filing stopped', async () => {
    const paused = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
    const filing = body(await call('post', `/sales-invoices/${paused}/einvoice/submit`, { token: actor.token, body: {} }));
    expect(filing.status).toBe('signed');
    const row = body(await report()).rows.find((candidate: any) => candidate.invoice_id === paused);
    expect(row.message).toContain('الربط موقوف');
    expect(row.sync_status).toBe('❌ لم يُرسل');
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
  });

  it('keeps one tenant’s invoices out of another tenant’s grid', async () => {
    const mine = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const theirs = body(await report('', other.token));
    expect(theirs.rows.map((row: any) => row.invoice_id)).not.toContain(mine);
    expect(theirs.rowCount).toBe(0);
  });

  // ── 🔄 مزامنة ZATCA ──────────────────────────────────────────────────────────────────

  it('refuses an empty selection with the window’s own words', async () => {
    const response = await sync([]);
    expect(response.status).toBe(422);
    expect((response.body as any).code).toBe('EINVOICE_SYNC_EMPTY');
    expect((response.body as any).detail).toBe('لا توجد صفوف محددة.');
  });

  it('refuses a batch bigger than the cap instead of filing it', async () => {
    const response = await sync(Array.from({ length: 201 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    expect(response.status).toBe(422);
    expect((response.body as any).code).toBe('EINVOICE_SYNC_TOO_MANY');
  });

  it('files what the clerk ticked and answers «تمت العملية بنجاح ✅»', async () => {
    const first = await postedInvoice({ partyId });
    const second = await postedInvoice({ cashCustomer: 'عميل نقدي' });

    const outcome = body(await sync([first, second]));
    expect(outcome.requested).toBe(2);
    expect(outcome.sent).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(outcome.message).toBe('تمت العملية بنجاح ✅');
    expect(outcome.results.map((row: any) => row.outcome)).toEqual(['sent', 'sent']);
    // `0100000` clears, `0200000` reports — the switch `CallReportingAPI` hides.
    expect(outcome.results[0].status).toBe('cleared');
    expect(outcome.results[1].status).toBe('reported');

    const grid = new Map<string, any>(body(await report()).rows.map((row: any) => [row.invoice_id, row]));
    expect(grid.get(first).sync_status).toBe('✅ مرسل');
    expect(grid.get(second).sync_status).toBe('✅ مرسل');
  });

  it('reports a مسوَّدة and an already-filed invoice per row instead of failing the batch', async () => {
    const draft = await newInvoice({ cashCustomer: 'عميل نقدي' });
    const filed = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    await sync([filed]);

    const outcome = body(await sync([draft, filed]));
    expect(outcome.sent).toBe(0);
    expect(outcome.skipped).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.results[0].message).toContain('غير مرحَّلة');
    expect(outcome.results[1].message).toContain('تم إرسال هذه الفاتورة مسبقاً');
  });

  it('says the link is paused instead of silently doing nothing', async () => {
    const target = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });

    const outcome = body(await sync([target]));
    expect(outcome.sent).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.results[0].message).toContain('الربط موقوف');
    // Nothing was filed, so nothing was stored: the invoice is still where it was.
    const row = body(await report()).rows.find((candidate: any) => candidate.invoice_id === target);
    expect(row.sync_status).toBe('❌ لم يُرسل');
    expect(row.message).toBe('');

    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
  });

  it('lets 🔄 مزامنة ZATCA finish what ⏸ إيقاف الربط held back', async () => {
    const target = await postedInvoice({ partyId });
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });
    await sync([target]);
    await call('post', '/einvoice/link/toggle', { token: actor.token, body: {} });

    const outcome = body(await sync([target]));
    expect(outcome.sent).toBe(1);
    expect(outcome.results[0].status).toBe('cleared');
  });

  it('needs `einvoice.submit` — reading the grid is not filing it', async () => {
    const target = await postedInvoice({ cashCustomer: 'عميل نقدي' });
    const refused = await sync([target], readonly.token);
    expect(refused.status).toBe(403);
    const read = await report('', readonly.token);
    expect(read.status).toBe(200);
  });
});
