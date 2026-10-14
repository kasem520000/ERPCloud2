import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part five — 📒 تقارير المحاسبة: five windows, six reports.
 *
 *   `frmRptBalances.xaml`           «أرصدة الحسابات»              → account-balances
 *   `frmRptEntries.xaml`            «القيود اليومية»              → journal-entries
 *                                   «🧾 تفاصيل القيد»             → journal-entry-lines
 *   `frmRptIncomeStatement.xaml`    «أرباح وخسائر حسابات رئيسية»  → income-statement-accounts
 *   `frmRptCostCenter.xaml`         «تقرير مراكز التكلفة»         → cost-center-statement
 *   `frmTaxRptPeriod.xaml`          «إقرار ضريبي»                 → vat-return-period
 *
 * The rules the cloud has to keep:
 *   - `frmRptBalances.xaml.cs` L373-L430 — الرصيد من وجهين: `deptBlc = max(dept − credit, 0)`
 *     و`creditBlc = max(credit − dept, 0)`, then `deptFinal = deptInit + deptBlc` and a
 *     second netting that leaves exactly one side non-zero. `Entry.type = 0` is the opening
 *     (L285) and `type <> 0` the حركة (L270).
 *   - `frmRptBalances.xaml.cs` L206-L233 (`GetParent`) — a row appears only when the chosen
 *     «الحساب الرئيسي» is one of its ancestors; `accounts.path` is that walk.
 *   - `frmRptEntries.xaml.cs` L378-L379 — the register is `GlobalID, id, date, doc_no, type,
 *     state, notes` from `Entry`, ordered by `id`.
 *   - `frmRptIncomeStatement.xaml.cs` L229 — `Accounts_Index.FinalAcc = 2` (المصروفات and
 *     إيرادات, `CrystalLiteDB.txt` L2515-L2516); L250-L277 rolls a leaf account up to its
 *     parent and merges the duplicates, which is why the window is called «حسابات رئيسية».
 *   - `frmRptCostCenter.xaml.cs` L276-L282 — «تفصيلي» reports the selected centre's
 *     **children**, falling back to the centre itself when it has none; «تجميعي» (L435-L465)
 *     keeps every descendant, because `GetParent` walks the whole chain.
 *   - `frmTaxRptPeriod.xaml.cs` L345-L427 (`CalcInvoicePart`) — a line is TAXED when its
 *     `taxval <> 0` and NOTAX when `taxval = 0`; the six sales rows and the six purchase rows
 *     of `TaxRptPeriod.repx` are reproduced here line for line.
 */
describe('التقارير — frmRptBalances · frmRptEntries · frmRptIncomeStatement · frmRptCostCenter · frmTaxRptPeriod', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let warehouseId = '';

  let revenueParentId = '';
  let revenueSalesId = '';
  let revenueOtherId = '';
  let expenseParentId = '';
  let expenseSalaryId = '';
  let cashAccountId = '';
  let vatAccountId = '';

  let centreParentId = '';
  let centreSalesId = '';
  let centreStoreId = '';

  let customerId = '';
  let supplierId = '';
  let itemId = '';
  let safeId = '';
  let salesmanId = '';

  let openingNumber = '';
  let movementNumber = '';
  let saleNumber = '';

  const today = new Date();
  const year = today.getUTCFullYear();
  const iso = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const todayIso = iso(0);
  /** 📅 The manual entries live in June so the invoice fixtures of today never touch them. */
  const juneFrom = `${year}-06-01`;
  const juneTo = `${year}-06-30`;
  const juneDay = `${year}-06-10`;
  const currentMonth = String(today.getUTCMonth() + 1);

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsIn = (body: unknown): Array<Record<string, string>> =>
    (data(body as Record<string, unknown>) as { rows: Array<Record<string, string>> }).rows ?? [];
  const money = (value: unknown) => Number(value ?? 0).toFixed(2);
  const cardOf = (body: unknown, key: string): string => {
    const cards = (data(body as Record<string, unknown>) as { grandTotal: Array<{ key: string; amount: string }> })
      .grandTotal;
    return cards.find((card) => card.key === key)?.amount ?? '0';
  };
  const rowFor = (rows: Array<Record<string, string>>, code: string) => rows.find((row) => row.code === code);

  const post = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  const runReport = (key: string, query = '', token = actor.token) => get(`/reports/${key}?${query}`, token);
  const juneReport = (key: string, query = '') =>
    get(`/reports/${key}?from=${juneFrom}&to=${juneTo}${query ? `&${query}` : ''}`);
  const todayReport = (key: string, query = '') =>
    get(`/reports/${key}?from=${iso(-1)}&to=${iso(1)}${query ? `&${query}` : ''}`);

  beforeAll(async () => {
    ctx = await createTestApp('report-accounting');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-acc5',
      email: 'owner@rpt-acc5.test',
      fullName: 'مستخدم تقارير المحاسبة',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'catalog.taxgroup.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.return.create',
        'purchase.view',
        'purchase.invoice.create',
        'purchase.invoice.post',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'organization.cashlocation.manage',
        'organization.postingprofile.view',
        'hrm.manage',
        'reporting.view',
        'reporting.export.execute',
      ],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'rpt-acc5',
      email: 'viewer@rpt-acc5.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-acc5-2',
      email: 'owner@rpt-acc5-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const account = async (code: string, nameAr: string, type: string, parentId?: string) => {
      const created = await post('/accounts', { code, nameAr, type, ...(parentId ? { parentId } : {}) });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    revenueParentId = await account('9100', 'إيرادات', 'revenue');
    revenueSalesId = await account('9101', 'إيراد مبيعات', 'revenue', revenueParentId);
    revenueOtherId = await account('9102', 'إيراد آخر', 'revenue', revenueParentId);
    expenseParentId = await account('9200', 'مصروفات', 'expense');
    expenseSalaryId = await account('9201', 'رواتب', 'expense', expenseParentId);
    cashAccountId = await account('9901', 'الصندوق', 'asset');
    vatAccountId = await account('9902', 'ضريبة القيمة المضافة', 'liability');

    const taxGroup = await post('/organization/catalog/tax-groups', {
      code: 'VAT15',
      nameAr: 'ضريبة القيمة المضافة 15%',
      rate: '15',
      vatAccountId,
    });
    expect(taxGroup.status).toBe(201);

    const centre = async (code: string, nameAr: string, parentId?: string) => {
      const created = await post('/cost-centers', { code, nameAr, ...(parentId ? { parentId } : {}) });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    centreParentId = await centre('ADMIN', 'الإدارة العامة');
    centreSalesId = await centre('SALES', 'المبيعات', centreParentId);
    centreStoreId = await centre('STORE', 'المستودع', centreParentId);

    const employee = await post('/hrm/employees', { employeeNo: 'E-ACC', name: 'مندوب التقارير', branchId });
    expect(employee.status).toBe(201);
    salesmanId = data(employee.body).id as string;

    const journal = async (body: Record<string, unknown>) => {
      const created = await post('/journal-entries', { branchId, ...body });
      expect(created.status).toBe(201);
      return data(created.body) as { id: string; number: string };
    };

    // 🏁 قيد إفتتاحي — the opening the two balance windows split out with `Entry.type = 0`.
    const opening = await journal({
      date: juneDay,
      sourceType: 'opening',
      description: 'قيد إفتتاحي للحسابات',
      lines: [
        { accountId: cashAccountId, debit: '1000', credit: '0', costCenterId: centreSalesId },
        { accountId: expenseSalaryId, debit: '200', credit: '0', costCenterId: centreSalesId },
        { accountId: revenueSalesId, debit: '0', credit: '1200', costCenterId: centreSalesId },
      ],
    });
    openingNumber = opening.number;

    // 📒 قيد اليومية — a movement with a مندوب on its lines.
    const movement = await journal({
      date: juneDay,
      description: 'تحصيل إيراد',
      lines: [
        { accountId: cashAccountId, debit: '300', credit: '0', costCenterId: centreSalesId, salesmanId },
        { accountId: revenueSalesId, debit: '0', credit: '300', costCenterId: centreSalesId, salesmanId },
      ],
    });
    movementNumber = movement.number;

    // 📒 قيد اليومية — an expense booked on the other centre.
    await journal({
      date: juneDay,
      description: 'مصروف رواتب',
      lines: [
        { accountId: expenseSalaryId, debit: '120', credit: '0', costCenterId: centreStoreId },
        { accountId: cashAccountId, debit: '0', credit: '120', costCenterId: centreStoreId },
      ],
    });

    // 🧾 ضريبة — a manual VAT entry: the debit on the VAT account is the ضريبة, the rest الصافي.
    await journal({
      date: todayIso,
      isVat: true,
      description: 'قيد ضريبي يدوي',
      lines: [
        { accountId: vatAccountId, debit: '30', credit: '0' },
        { accountId: expenseSalaryId, debit: '200', credit: '0' },
        { accountId: cashAccountId, debit: '0', credit: '230' },
      ],
    });

    // ── الفواتير والسندات of the إقرار ضريبي ────────────────────────────────
    const category = await post('/organization/catalog/categories', { code: 'ACC', nameAr: 'خدمات' });
    expect(category.status).toBe(201);
    const unit = await post('/organization/catalog/units', { code: 'SVC', nameAr: 'خدمة' });
    expect(unit.status).toBe(201);
    const item = await post('/organization/catalog/items', {
      sku: 'ACC-SVC',
      nameAr: 'خدمة التقرير',
      categoryId: data(category.body).id,
      baseUnitId: data(unit.body).id,
      kind: 'service',
      salePrice: '100',
      purchasePrice: '100',
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

    const customer = await post('/parties', { kind: 'customer', name: 'عميل الإقرار' });
    expect(customer.status).toBe(201);
    customerId = data(customer.body).id as string;
    const supplier = await post('/parties', { kind: 'supplier', name: 'مورد الإقرار' });
    expect(supplier.status).toBe(201);
    supplierId = data(supplier.body).id as string;

    const postSale = async (body: Record<string, unknown>) => {
      const draft = await post('/sales/invoices', { branchId, warehouseId, ...body });
      expect(draft.status).toBe(201);
      const posted = await post(`/sales/invoices/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };
    const postPurchase = async (body: Record<string, unknown>) => {
      const draft = await post('/purchase-invoices', { branchId, warehouseId, partyId: supplierId, ...body });
      expect(draft.status).toBe(201);
      const posted = await post(`/purchase-invoices/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };

    // 🧾 مبيعات — 1000 خاضعة للضريبة + 200 معفاة.
    const sale = await postSale({
      partyId: customerId,
      lines: [
        { itemId, quantity: '10', unitPrice: '100', taxRate: '15' },
        { itemId, quantity: '2', unitPrice: '100', taxRate: '0' },
      ],
    });
    saleNumber = sale.number;
    // ↩️ مرتجع مبيعات — 100 خاضعة.
    const draftReturn = await post(`/sales/invoices/${sale.id}/return`, {
      branchId,
      warehouseId,
      lines: [{ itemId, quantity: '1', unitPrice: '100', taxRate: '15' }],
    });
    expect(draftReturn.status).toBe(201);
    const postedReturn = await post(`/sales/invoices/${data(draftReturn.body).id}/post`, {});
    expect(postedReturn.status).toBe(201);

    // 🧾 مشتريات — 500 خاضعة + 100 معفاة، ومرتجع 50 خاضع.
    const purchase = await postPurchase({
      lines: [
        { itemId, quantity: '5', unitPrice: '100', taxRate: '15' },
        { itemId, quantity: '1', unitPrice: '100', taxRate: '0' },
      ],
    });
    await postPurchase({
      kind: 'purchase_return',
      referenceInvoiceId: purchase.id,
      lines: [{ itemId, quantity: '1', unitPrice: '50', taxRate: '15' }],
    });

    // 💵 سند قبض 1000 + 150 ضريبة · سند صرف 300 + 45 ضريبة.
    const safeAccount = await post('/accounts', { code: '9903', nameAr: 'صندوق الإقرار', type: 'asset' });
    expect(safeAccount.status).toBe(201);
    const safe = await post('/cash-locations', {
      branchId,
      kind: 'safe',
      name: 'صندوق الإقرار',
      accountId: data(safeAccount.body).id,
      isDefault: true,
    });
    expect(safe.status).toBe(201);
    safeId = data(safe.body).id as string;

    const voucher = async (kind: string, gross: string, vatAmount: string, description: string) => {
      const draft = await post('/vouchers', {
        branchId,
        kind,
        subtype: kind === 'receipt' ? 'customer' : 'supplier',
        date: todayIso,
        ...(kind === 'receipt' ? { partyId: customerId } : { partyId: supplierId }),
        cashLocationId: safeId,
        method: 'cash',
        amount: gross,
        vatAmount,
        description,
      });
      expect(draft.status).toBe(201);
      const posted = await post(`/vouchers/${data(draft.body).id}/post`, {});
      expect(posted.status).toBe(201);
      return data(posted.body) as { id: string; number: string };
    };
    await voucher('receipt', '1000', '150', 'تحصيل من عميل');
    await voucher('payment', '300', '45', 'سداد لمورد');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('📚 السجل — التقارير الستة بأعمدة الديسكتوب', async () => {
    const catalog = (data((await get('/reports')).body as Record<string, unknown>) as unknown as Array<Record<string, never>>) ?? [];
    const list = (
      Array.isArray(catalog) ? catalog : ((await get('/reports')).body as Array<Record<string, never>>)
    ) as unknown as Array<{
      key: string;
      titleAr: string;
      group: string;
      params: Array<{ labelAr: string; kind: string; options?: Array<{ value: string; labelAr: string }> }>;
      columns: Array<{ labelAr: string }>;
    }>;
    const byKey = new Map(list.map((entry) => [entry.key, entry]));

    const balances = byKey.get('account-balances');
    expect(balances?.titleAr).toBe('أرصدة الحسابات');
    expect(balances?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'الحساب · اسم الحساب · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن · رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن',
    );
    expect(balances?.params.map((param) => param.labelAr).join(' · ')).toBe(
      'الحساب الرئيسي · الفرع · المندوب · من تاريخ · من وقت (HH:mm) · إلى تاريخ · إلى وقت (HH:mm)',
    );

    const entries = byKey.get('journal-entries');
    expect(entries?.titleAr).toBe('القيود اليومية');
    expect(entries?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'الرقم العام · رقم المستند · تاريخ القيد · نوع القيد · حالة القيد · البيان · رقم القيد',
    );
    // 🧾 نوع القيد — the sixteen names of `EntryTypes` (`CrystalLiteDB.txt` L3341-L3358).
    expect(entries?.params.find((param) => param.labelAr === 'نوع القيد')?.options).toHaveLength(16);

    const lines = byKey.get('journal-entry-lines');
    expect(lines?.titleAr).toBe('تفاصيل القيد');
    expect(lines?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'رقم القيد · م · مدين · دائن · كود الحساب · اسم الحساب · مركز التكلفة · البيان',
    );

    const income = byKey.get('income-statement-accounts');
    expect(income?.titleAr).toBe('أرباح وخسائر حسابات رئيسية');
    expect(income?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'الحساب · اسم الحساب · رصيد مدين · رصيد دائن',
    );

    const centres = byKey.get('cost-center-statement');
    expect(centres?.titleAr).toBe('تقرير مراكز التكلفة');
    expect(centres?.columns.map((column) => column.labelAr).join(' · ')).toBe(
      'الرمز · اسم مركز التكلفة · رصيد افتتاحي مدين · رصيد افتتاحي دائن · حركة مدين · حركة دائن · رصيد مدين · رصيد دائن · رصيد ختامي مدين · رصيد ختامي دائن · اسم الحساب · العملية · رقم العملية · التاريخ',
    );
    // 📋 نوع التقرير — «تفصيلي» · «تجميعي» (`frmRptCostCenter.xaml` L203 · L210).
    expect(centres?.params.find((param) => param.labelAr === 'نوع التقرير')?.options).toEqual([
      { value: 'summary', labelAr: 'تجميعي' },
      { value: 'detailed', labelAr: 'تفصيلي' },
    ]);

    const vat = byKey.get('vat-return-period');
    expect(vat?.titleAr).toBe('إقرار ضريبي');
    expect(vat?.columns.map((column) => column.labelAr).join(' · ')).toBe('القسم · الوصف · الصافي · الضريبة');
    expect(vat?.params.find((param) => param.labelAr === 'ربع سنة')?.options).toHaveLength(4);
    expect(vat?.params.find((param) => param.labelAr === 'شهري')?.options).toHaveLength(12);
  });

  it('📊 أرصدة الحسابات — الافتتاحي والحركة والختامي على وجهين', async () => {
    // «الحساب الرئيسي» = إيرادات → only the two children, and only what they moved.
    const rows = rowsIn((await juneReport('account-balances', `accountId=${revenueParentId}`)).body);
    expect(rows).toHaveLength(1);
    const sale = rowFor(rows, '9101');
    expect(money(sale?.opening_debit)).toBe('0.00');
    expect(money(sale?.opening_credit)).toBe('1200.00');
    expect(money(sale?.move_debit)).toBe('0.00');
    expect(money(sale?.move_credit)).toBe('300.00');
    expect(money(sale?.bal_credit)).toBe('300.00');
    // deptFinal = 0 + 0 · creditFinal = 1200 + 300 → the second netting leaves one side.
    expect(money(sale?.final_debit)).toBe('0.00');
    expect(money(sale?.final_credit)).toBe('1500.00');

    const report = await juneReport('account-balances', `accountId=${revenueParentId}`);
    expect(money(cardOf(report.body, 's_net_credit'))).toBe('1500.00');
    expect(money(cardOf(report.body, 's_net_debit'))).toBe('0.00');
    expect(Number(cardOf(report.body, 's_count'))).toBe(1);

    // بلا «حساب رئيسي» — every account that moved, and the two sides square because
    // every entry balances.
    const all = rowsIn((await juneReport('account-balances')).body);
    expect(all.map((row) => row.code).sort()).toEqual(['9101', '9201', '9901']);
    const everything = await juneReport('account-balances');
    expect(money(cardOf(everything.body, 's_net_debit'))).toBe('0.00');
    expect(money(cardOf(everything.body, 's_net_credit'))).toBe('0.00');
  });

  it('📊 أرصدة الحسابات — المندوب شريطٌ على السطور', async () => {
    const rows = rowsIn((await juneReport('account-balances', `salesmanId=${salesmanId}`)).body);
    // Only the two lines of «تحصيل إيراد» carry the مندوب: 300 مدين و300 دائن.
    expect(rows.map((row) => row.code).sort()).toEqual(['9101', '9901']);
    expect(money(rowFor(rows, '9101')?.final_credit)).toBe('300.00');
    expect(money(rowFor(rows, '9901')?.final_debit)).toBe('300.00');
  });

  it('📒 القيود اليومية — السجل ونوع القيد وحالته ورقم المستند', async () => {
    // The three manual entries live in June: an افتتاحي and two قيود يومية.
    const rows = rowsIn((await juneReport('journal-entries')).body);
    expect(rows).toHaveLength(3);
    const opening = rows.find((row) => row.entry_no === openingNumber);
    expect(opening?.entry_type).toBe('قيد إفتتاحي');
    expect(opening?.state_ar).toBe('معتمد');
    expect(opening?.doc_no).toBe('—');
    expect(opening?.entry_date).toBe(juneDay);

    const report = await juneReport('journal-entries');
    expect(Number(cardOf(report.body, 's_count'))).toBe(3);

    // 🔍 نوع القيد · 🔢 رقم القيد — two of the boxes of «البحث».
    const filtered = rowsIn((await juneReport('journal-entries', 'kind=opening')).body);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entry_no).toBe(openingNumber);

    const byNumber = rowsIn((await juneReport('journal-entries', `entryNo=${movementNumber}`)).body);
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0]?.entry_type).toBe('قيد اليومية');

    expect(rowsIn((await juneReport('journal-entries', 'status=void')).body)).toHaveLength(0);

    // 🧾 The documents of today: a posted sale leaves an entry carrying its رقم المستند, and
    // the two vouchers leave a سند قبض and a سند صرف.
    const documents = rowsIn((await todayReport('journal-entries')).body);
    const saleEntry = documents.find((row) => row.doc_no === saleNumber);
    expect(saleEntry?.entry_type).toBe('قيد مبيعات');
    expect(saleEntry?.state_ar).toBe('معتمد');
    expect(documents.some((row) => row.entry_type === 'سند قبض')).toBe(true);
    expect(documents.some((row) => row.entry_type === 'سند صرف')).toBe(true);

    const byDocument = rowsIn((await todayReport('journal-entries', `docNo=${saleNumber}`)).body);
    expect(byDocument).toHaveLength(1);
    expect(byDocument[0]?.entry_type).toBe('قيد مبيعات');
  });

  it('🧾 تفاصيل القيد — السطور وإجمالي المدين والدائن', async () => {
    const rows = rowsIn((await juneReport('journal-entry-lines')).body);
    expect(rows).toHaveLength(7);
    expect(rows[0]?.seq).toBe('1');
    expect(rows[0]?.code).toBe('9901');

    const report = await juneReport('journal-entry-lines');
    // 1000 + 200 + 1200 from the افتتاحي, 300 + 300 and 120 + 120 from the two حركة.
    expect(money(cardOf(report.body, 'debit'))).toBe('1620.00');
    expect(money(cardOf(report.body, 'credit'))).toBe('1620.00');
    expect(money(cardOf(report.body, 's_diff'))).toBe('0.00');
    expect(Number(cardOf(report.body, 's_count'))).toBe(7);

    // 📊 مركز التكلفة — only the two lines of the expense entry.
    const store = rowsIn((await juneReport('journal-entry-lines', `costCenterId=${centreStoreId}`)).body);
    expect(store).toHaveLength(2);
    expect(store.every((row) => row.cost_center === 'المستودع')).toBe(true);

    // 📒 الحساب — only the cash lines.
    const cash = rowsIn((await juneReport('journal-entry-lines', `accountId=${cashAccountId}`)).body);
    expect(cash.map((row) => Number(row.debit)).sort((left, right) => left - right)).toEqual([0, 300, 1000]);
    // «إيراد آخر» never moved, so it has no سطر at all.
    expect(rowsIn((await juneReport('journal-entry-lines', `accountId=${revenueOtherId}`)).body)).toHaveLength(0);
  });

  it('📈 أرباح وخسائر حسابات رئيسية — الحساب الرئيسي والمخزون وصافي الربح', async () => {
    const rows = rowsIn((await juneReport('income-statement-accounts')).body);
    // `FinalAcc = 2` rolled up to the parent: إيرادات and مصروفات, then the مخزون row.
    expect(rows.map((row) => row.account)).toEqual(['إيرادات', 'مصروفات', 'قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ']);
    expect(money(rows[0]?.credit_balance)).toBe('1500.00');
    expect(money(rows[0]?.debit_balance)).toBe('0.00');
    expect(money(rows[1]?.debit_balance)).toBe('320.00');
    expect(money(rows[1]?.credit_balance)).toBe('0.00');

    const report = await juneReport('income-statement-accounts');
    expect(money(cardOf(report.body, 'debit_balance'))).toBe('320.00');
    expect(money(cardOf(report.body, 'credit_balance'))).toBe('1500.00');
    // صافي أرباح العام = 1500 − 320 + 0 (no stock has moved in this tenant).
    expect(money(cardOf(report.body, 's_profit'))).toBe('1180.00');
    expect(Number(cardOf(report.body, 's_count'))).toBe(2);
  });

  it('📂 تقرير مراكز التكلفة — تجميعي: الأبناء بسطر لكل حساب', async () => {
    const rows = rowsIn(
      (await juneReport('cost-center-statement', `costCenterId=${centreParentId}&kind=summary`)).body,
    );
    expect(rows).toHaveLength(5);
    const cash = rows.find((row) => row.cost_center === 'المبيعات' && row.account_name === 'الصندوق');
    // 1000 افتتاحي + 300 حركة − 0.
    expect(money(cash?.opening_debit)).toBe('1000.00');
    expect(money(cash?.move_debit)).toBe('300.00');
    expect(money(cash?.final_debit)).toBe('1300.00');
    const revenue = rows.find((row) => row.cost_center === 'المبيعات' && row.account_name === 'إيراد مبيعات');
    expect(money(revenue?.opening_credit)).toBe('1200.00');
    expect(money(revenue?.final_credit)).toBe('1500.00');
    // «تجميعي» leaves العملية ورقم العملية والتاريخ empty — one grid, two modes.
    expect(rows.every((row) => row.operation === '' && row.operation_no === '')).toBe(true);

    const report = await juneReport('cost-center-statement', `costCenterId=${centreParentId}&kind=summary`);
    expect(Number(cardOf(report.body, 's_count'))).toBe(5);

    // A leaf has no descendants, and `GetParent` walks up from a row's own parent: «تجميعي»
    // on a leaf therefore reports nothing, exactly as the desktop does.
    expect(rowsIn((await juneReport('cost-center-statement', `costCenterId=${centreSalesId}&kind=summary`)).body)).toHaveLength(
      0,
    );
  });

  it('📂 تقرير مراكز التكلفة — تفصيلي: الأبناء سطراً بسطر، أو المركز نفسه بلا أبناء', async () => {
    const rows = rowsIn(
      (await juneReport('cost-center-statement', `costCenterId=${centreParentId}&kind=detailed`)).body,
    );
    // 3 lines of the افتتاحي + 2 of the حركة on المبيعات, 2 of the مصروف on المستودع.
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.operation !== '' && row.operation_no !== '')).toBe(true);
    expect(rows.every((row) => row.entry_date === juneDay)).toBe(true);
    const revenue = rows.find((row) => row.account_name === 'إيراد مبيعات');
    // The first سطر of «إيراد مبيعات» is the افتتاحي line itself, and the افتتاحي of the
    // centre is repeated on every one of its rows — exactly as `DetailedResults` does.
    expect(revenue?.operation).toBe('قيد إفتتاحي');
    expect(money(revenue?.opening_debit)).toBe('1200.00');
    expect(money(revenue?.opening_credit)).toBe('1200.00');
    expect(money(revenue?.final_credit)).toBe('1200.00');

    // A leaf with no children falls back to itself (`DetailedResults`, L276-L282).
    const leaf = rowsIn(
      (await juneReport('cost-center-statement', `costCenterId=${centreStoreId}&kind=detailed`)).body,
    );
    expect(leaf).toHaveLength(2);
    expect(leaf.every((row) => row.cost_center === 'المستودع')).toBe(true);
  });

  it('🧾 الإقرار الضريبي — البنود الستة على الوجهين وصافي الضريبة', async () => {
    const rows = rowsIn((await todayReport('vat-return-period')).body);
    expect(rows).toHaveLength(13);
    const value = (line: string) => rows.find((row) => row.line === line);

    // المبيعات — 1000 خاضعة − 100 مرتجع، و200 معفاة، وسند قبض 1000 + 150.
    expect(money(value('المبيعات الخاضعة للنسبة الأساسية')?.net)).toBe('900.00');
    expect(money(value('المبيعات الخاضعة للنسبة الأساسية')?.vat)).toBe('135.00');
    expect(money(value('سندات القبض')?.net)).toBe('1000.00');
    expect(money(value('سندات القبض')?.vat)).toBe('150.00');
    expect(money(value('المبيعات المعفاة')?.net)).toBe('200.00');
    expect(money(value('المبيعات المعفاة')?.vat)).toBe('0.00');
    expect(money(value('المبيعات المحلية الخاضعة للنسبة الصفرية')?.net)).toBe('0.00');
    expect(money(value('صافي المبيعات')?.net)).toBe('1900.00');
    expect(money(value('صافي المبيعات')?.vat)).toBe('285.00');

    // المشتريات — 500 − 50 خاضعة، و100 معفاة، وسند صرف 300 + 45 والقيد الضريبي 200 + 30.
    expect(money(value('المشتريات الخاضعة للنسبة الأساسية')?.net)).toBe('450.00');
    expect(money(value('المشتريات الخاضعة للنسبة الأساسية')?.vat)).toBe('67.50');
    expect(money(value('سندات الصرف')?.net)).toBe('500.00');
    expect(money(value('سندات الصرف')?.vat)).toBe('75.00');
    expect(money(value('المشتريات المعفاة')?.net)).toBe('100.00');
    expect(money(value('صافي المشتريات')?.net)).toBe('950.00');
    expect(money(value('صافي المشتريات')?.vat)).toBe('142.50');

    // صافي ضريبة القيمة المضافة = 285 − 142.50.
    const net = rows[12];
    expect(net?.section).toBe('صافي ضريبة القيمة المضافة');
    expect(net?.line).toBe('مستحق الدفع للهيئة');
    expect(money(net?.vat)).toBe('142.50');

    const report = await todayReport('vat-return-period');
    expect(money(cardOf(report.body, 's_net_vat'))).toBe('142.50');
  });

  it('🧾 الإقرار الضريبي — «ربع سنة» و«شهري» يكتبان الفترة', async () => {
    // The presets overwrite the date boxes (`SetDate`), so a quarter that holds nothing
    // prints thirteen zeroes and «غير مستحق».
    const first = rowsIn((await runReport('vat-return-period', `quarter=1`)).body);
    expect(first).toHaveLength(13);
    expect(first.every((row) => money(row.vat) === '0.00')).toBe(true);
    expect(first[12]?.line).toBe('غير مستحق');

    // The current month holds the invoices.
    const month = rowsIn((await runReport('vat-return-period', `month=${currentMonth}`)).body);
    expect(money(month[12]?.vat)).toBe('142.50');
  });

  it('📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر', async () => {
    const empty = await runReport('account-balances', 'from=2000-01-01&to=2000-01-02');
    expect(rowsIn(empty.body)).toHaveLength(0);
    expect(money(cardOf(empty.body, 's_net_debit'))).toBe('0.00');
    expect(Number(cardOf(empty.body, 's_count'))).toBe(0);

    const lines = await runReport('journal-entry-lines', 'from=2000-01-01&to=2000-01-02');
    expect(rowsIn(lines.body)).toHaveLength(0);
    expect(money(cardOf(lines.body, 'debit'))).toBe('0.00');

    const income = await runReport('income-statement-accounts', 'from=2000-01-01&to=2000-01-02');
    expect(rowsIn(income.body)).toHaveLength(1); // the مخزون row is always printed
    expect(money(cardOf(income.body, 's_profit'))).toBe('0.00');
  });

  it('🔒 عزلٌ بين المستأجرين و👁️ صلاحية «reporting.view»', async () => {
    const theirs = await runReport('account-balances', `from=${juneFrom}&to=${juneTo}`, stranger.token);
    expect(rowsIn(theirs.body)).toHaveLength(0);

    const theirEntries = await runReport('journal-entries', `from=${juneFrom}&to=${juneTo}`, stranger.token);
    expect(rowsIn(theirEntries.body)).toHaveLength(0);

    // 👁️ The read-only viewer sees exactly what the owner sees.
    const mine = await runReport('account-balances', `from=${juneFrom}&to=${juneTo}`, viewer.token);
    expect(rowsIn(mine.body).length).toBeGreaterThan(0);

    const forbidden = await api(ctx.server, 'get', `/api/v1/reports/account-balances?from=${juneFrom}&to=${juneTo}`, {
      token: (
        await createActor(ctx, {
          tenantCode: 'rpt-acc5',
          email: 'intruder@rpt-acc5.test',
          permissions: [...ALL_PLATFORM_PERMISSIONS],
        })
      ).token,
    });
    expect(forbidden.status).toBe(403);
  });
});
