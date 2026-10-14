import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part seven — 🖨️ إعدادات الطباعة: the `SettingPrint` table of `Desktop_ERP`.
 *
 *   `frmSettings.xaml` «خيارات الطباعة» — the window that writes the row. Its radios
 *   «🧩 تفعيل إعدادات الطباعة» (`ckAll` · `ckPurchInv` · `ckSaleInv` · `ckPOSInv` ·
 *   `ckRentInv` · `ckContracts` · `ckReports`) are `SettingPrint.Inv_Id` 0 · 1 · 2 · 3 ·
 *   4 · 5 · 6 (`frmSettings.xaml.cs` L2095-L2116), and its fields are
 *   «طابعة الكاشير» · «طابعة المطبخ» · «عدد النسخ» · «اسم التقرير» · «مسار التقرير» ·
 *   «ملاحظات التقرير» · «طباعة ترويسة الفاتورة» · «طباعة تذييل الفاتورة» · «طباعة الختم» ·
 *   «طباعة تفاصيل الأصناف» · «طباعة make pay» · «طباعة مكونات الأصناف المركبة بشكل منفرد»
 *   plus the three images «الترويـسة» · «التـذيـيـل» · «الخـتـم».
 *   `frmInvRptType.xaml` «🖨️ افتراضي طباعة الفواتير» — «📄 ورقة A4» · «🧾 ورق صغير».
 *   `Class/Print.cs` L54-L64 — the defaults when no row exists: `PrintType=2`,
 *   `PrintHeader=true`, `PrintFooter=false`, `PrintNo=1`, `PrintItemType=1`; L201-L206
 *   loops `Print()` `PrintNo` times; `Printing()` injects `header.repx` / `footer.repx`
 *   into the `headerRpt` / `footerRpt` subreports.
 *
 * The rules the cloud has to keep:
 *   - one row per scope per tenant, RLS-isolated, and an unknown scope is a 404 rather
 *     than a silent row that prints nothing;
 *   - `printNo` 1..50, `printType` 1|2, and images are URLs (no byte store);
 *   - the printed sheet honours the row: نسخ · ورق · ترويسة · تذييل · ختم · ملاحظة, and
 *     the query string (`?copies=` · `?paper=`) may override it for one print;
 *   - reading is `reporting.view`, writing is `reporting.layout.manage`.
 */
describe('إعدادات الطباعة — frmSettings «خيارات الطباعة» · frmInvRptType · Print.cs', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const envelope = (value: unknown): Record<string, unknown> =>
    data(((value as { body?: unknown } | undefined)?.body ?? value) as Record<string, unknown>);

  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });
  const put = (path: string, body: Record<string, unknown>, token = actor.token) =>
    api(ctx.server, 'put', `/api/v1${path}`, { token, body });
  const del = (path: string, token = actor.token) => api(ctx.server, 'delete', `/api/v1${path}`, { token });
  const scope = (name: string) => `/reports/print-settings/${encodeURIComponent(name)}`;

  beforeAll(async () => {
    ctx = await createTestApp('print-settings');
    actor = await createActor(ctx, {
      tenantCode: 'prn-set',
      email: 'owner@prn-set.test',
      fullName: 'مالك إعدادات الطباعة',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view', 'reporting.layout.manage', 'reporting.export.execute'],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'prn-set',
      email: 'viewer@prn-set.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'prn-set-2',
      email: 'owner@prn-set-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'reporting.view', 'reporting.layout.manage'],
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('answers every scope with the defaults of Print.cs before anything is saved', async () => {
    const response = await get('/reports/print-settings');
    expect(response.status).toBe(200);
    const scopes = (response.body.data as Array<Record<string, unknown>>) ?? [];
    // 🧩 تفعيل إعدادات الطباعة — the seven radios, in the order of frmSettings.xaml.
    expect(scopes.map((row) => row.scope)).toEqual(['default', 'purchases', 'sales', 'pos', 'rental', 'contracts', 'reports']);
    for (const row of scopes) {
      expect(row.saved).toBe(false);
      expect(row.printHeader).toBe(true);
      expect(row.printFooter).toBe(false);
      expect(row.printStamp).toBe(true);
      expect(row.printNo).toBe(1);
      expect(row.printType).toBe(1);
      expect(row.printItemType).toBe(1);
      expect(row.note).toBe('');
    }
  });

  it('saves a scope and reads it back field by field', async () => {
    const saved = await put(scope('sales'), {
      printType: 2,
      printHeader: false,
      printFooter: true,
      printStamp: false,
      printNo: 3,
      printItemDetails: true,
      printItemGroups: true,
      printComponentsIndividually: true,
      printMakePay: true,
      casherPrinter: 'HP-LaserJet',
      kitchenPrinter: 'EPSON-Kitchen',
      rptName: 'RptSalesInPeriod1.repx',
      rptUrl: 'C:\\SmartAuditERP\\Reports',
      note: 'نسخة للعميل',
      headerImageUrl: 'https://cdn.test/header.png',
      footerImageUrl: 'https://cdn.test/footer.png',
      stampImageUrl: 'https://cdn.test/stamp.png',
    });
    expect(saved.status).toBe(200);
    expect(data(saved.body)).toMatchObject({
      scope: 'sales',
      printType: 2,
      printHeader: false,
      printFooter: true,
      printStamp: false,
      printNo: 3,
      printItemDetails: true,
      printItemGroups: true,
      printComponentsIndividually: true,
      printMakePay: true,
      casherPrinter: 'HP-LaserJet',
      kitchenPrinter: 'EPSON-Kitchen',
      rptName: 'RptSalesInPeriod1.repx',
      rptUrl: 'C:\\SmartAuditERP\\Reports',
      note: 'نسخة للعميل',
      headerImageUrl: 'https://cdn.test/header.png',
      footerImageUrl: 'https://cdn.test/footer.png',
      stampImageUrl: 'https://cdn.test/stamp.png',
      saved: true,
    });

    const read = await get(scope('sales'));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ scope: 'sales', printNo: 3, note: 'نسخة للعميل', saved: true });
  });

  it('keeps unsent fields when a scope is saved twice', async () => {
    await put(scope('pos'), { printNo: 4, note: 'نقطة البيع' });
    const second = await put(scope('pos'), { casherPrinter: 'POS-80mm' });
    expect(data(second.body)).toMatchObject({ printNo: 4, note: 'نقطة البيع', casherPrinter: 'POS-80mm' });
  });

  it('carries a report its own settings under report:<key> ويرفض تقريراً غير مسجّل', async () => {
    const ok = await put(scope('report:customer-balances'), { printNo: 2, note: 'أرصدة العملاء' });
    expect(ok.status).toBe(200);
    expect(data(ok.body)).toMatchObject({ scope: 'report:customer-balances', printNo: 2 });

    const unknown = await put(scope('report:not-a-report'), { printNo: 2 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('REPORT_NOT_FOUND');
  });

  it('يرفض نطاقاً مجهولاً بالقراءة والكتابة معاً', async () => {
    for (const response of [await get(scope('nonsense')), await put(scope('nonsense'), { printNo: 2 })]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('PRINT_SCOPE_INVALID');
    }
  });

  it('يتحقق من عدد النسخ ونوع الورق والروابط', async () => {
    const zero = await put(scope('sales'), { printNo: 0 });
    expect(zero.status).toBe(400);
    const many = await put(scope('sales'), { printNo: 51 });
    expect(many.status).toBe(400);
    const paper = await put(scope('sales'), { printType: 3 });
    expect(paper.status).toBe(400);
    const badUrl = await put(scope('sales'), { stampImageUrl: 'file:///etc/passwd' });
    expect(badUrl.status).toBe(400);
    expect(String(JSON.stringify(badUrl.body))).toContain('stampImageUrl');
  });

  it('يعيد الحذف إلى إعدادات الديسكتوب الافتراضية', async () => {
    await put(scope('rental'), { printNo: 7, note: 'تأجير' });
    const removed = await del(scope('rental'));
    expect(removed.status).toBe(200);
    expect(data(removed.body)).toMatchObject({ scope: 'rental', printNo: 1, note: '', saved: false });
    const read = await get(scope('rental'));
    expect(read.body.saved).toBe(false);
  });

  it('يعزل الإعدادات بين المستأجرين', async () => {
    await put(scope('sales'), { printNo: 5, note: 'سري' });
    const other = await get(scope('sales'), stranger.token);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ scope: 'sales', saved: false, printNo: 1, note: '' });
    const list = await get('/reports/print-settings', stranger.token);
    const sales = (list.body.data as Array<Record<string, unknown>>).find((row) => row.scope === 'sales');
    expect(sales?.note).toBe('');
  });

  it('يطبع الورقة كما تقول الإعدادات: النسخ · الورق · الترويسة · التذييل · الختم · الملاحظة', async () => {
    await put(scope('report:customer-balances'), {
      printNo: 3,
      printType: 2,
      printFooter: true,
      note: 'ملاحظة على الورقة',
      stampImageUrl: 'https://cdn.test/stamp.png',
      headerImageUrl: 'https://cdn.test/header.png',
      casherPrinter: 'HP-101',
      kitchenPrinter: 'Kitchen-9',
    });
    const response = await get('/reports/print/customer-balances');
    expect(response.status).toBe(200);
    const html = String(response.body.html ?? '');
    // 🔢 عدد النسخ — Printing() loops PrintNo times (Print.cs L201-L206).
    expect((html.match(/class="copy"/g) ?? []).length).toBe(3);
    expect(html).toContain('عدد النسخ: 3');
    // 🧾 ورق صغير — printType 2, the second radio of frmInvRptType.
    expect(html).toContain('size: 80mm auto');
    // 🏛️ الترويسة والتذييل — header.repx / footer.repx.
    expect(html).toContain('https://cdn.test/header.png');
    expect(html).toContain('class="doc-foot"');
    // 🔖 الختم — the stamp image under the signatures.
    expect(html).toContain('https://cdn.test/stamp.png');
    // 📝 ملاحظات التقرير — txtNote.
    expect(html).toContain('ملاحظات التقرير');
    expect(html).toContain('ملاحظة على الورقة');
    // 🖨️ الطابعات — shown to the operator, never on the paper itself.
    expect(html).toContain('HP-101');
    expect(html).toContain('Kitchen-9');
  });

  it('يطبع بلا ترويسة ولا ختم حين تُطفأ', async () => {
    await put(scope('report:customer-balances'), { printNo: 1, printHeader: false, printStamp: false, printFooter: false, note: '' });
    const response = await get('/reports/print/customer-balances');
    const html = String(response.body.html ?? '');
    expect(html).not.toContain('class="company"');
    expect(html).not.toContain('cdn.test/stamp.png');
    expect(html).not.toContain('class="doc-foot"');
    // The title and the report itself are still there: a sheet with no letterhead is a sheet.
    expect(html).toContain('class="doc-title"');
  });

  it('يطبع «طباعة / PDF» الورقة نفسها التي يطبعها «👁️ معاينة الطباعة»', async () => {
    await put(scope('report:customer-balances'), { printNo: 2, printType: 2, note: 'نسخة للتصدير' });
    const exported = await api(ctx.server, 'post', '/api/v1/reports/customer-balances/export', {
      token: actor.token,
      body: { format: 'pdf' },
    });
    expect(exported.status).toBe(201);
    const html = String(exported.body.content ?? '');
    expect((html.match(/class="copy"/g) ?? []).length).toBe(2);
    expect(html).toContain('نسخة للتصدير');
    expect(html).toContain('size: 80mm auto');
  });

  it('يقبل تجاوزاً لمرة واحدة من سطر الاستعلام', async () => {
    await put(scope('report:customer-balances'), { printNo: 3, printType: 2 });
    const response = await get('/reports/print/customer-balances?copies=1&paper=a4');
    const html = String(response.body.html ?? '');
    expect((html.match(/class="copy"/g) ?? []).length).toBe(0);
    expect(html).toContain('size: A4 landscape');
    expect(html).not.toContain('size: 80mm auto');
  });

  it('يستخدم إعدادات «تقارير» ثم «الإفتراضي» حين لا يحمل التقرير إعداداته', async () => {
    await del(scope('report:customer-balances'));
    await put(scope('reports'), { printNo: 2, note: 'كل التقارير', printFooter: true });
    const fromReports = await get('/reports/print/customer-balances');
    expect(String(fromReports.body.html ?? '')).toContain('كل التقارير');
    expect((String(fromReports.body.html ?? '').match(/class="copy"/g) ?? []).length).toBe(2);

    await del(scope('reports'));
    await put(scope('default'), { printNo: 4, note: 'الإفتراضي للجميع' });
    const fromDefault = await get('/reports/print/customer-balances');
    expect(String(fromDefault.body.html ?? '')).toContain('الإفتراضي للجميع');
    expect((String(fromDefault.body.html ?? '').match(/class="copy"/g) ?? []).length).toBe(4);
  });

  it('يقرأ العارض ولا يكتب — 403 على الحفظ', async () => {
    const read = await get(scope('sales'), viewer.token);
    expect(read.status).toBe(200);
    const write = await put(scope('sales'), { printNo: 2 }, viewer.token);
    expect(write.status).toBe(403);
    const remove = await del(scope('sales'), viewer.token);
    expect(remove.status).toBe(403);
    const strangerWrite = await put(scope('sales'), { printNo: 2 }, stranger.token);
    expect(strangerWrite.status).toBe(200);
    // The stranger wrote into their own tenant, not into ours.
    expect((await get(scope('sales'))).body.saved).toBe(true);
  });

  it('يمنع مستخدمًا بلا صلاحية التقارير من قراءة الإعدادات', async () => {
    const blind = await createActor(ctx, {
      tenantCode: 'prn-set',
      email: 'blind@prn-set.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS],
    });
    const read = await get('/reports/print-settings', blind.token);
    expect(read.status).toBe(403);
    expect(envelope(read).saved).toBeUndefined();
  });
});
