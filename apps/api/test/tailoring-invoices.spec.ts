import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part three — 🧾 فاتورة التفصيل.
 *
 * `Form_WPF/frmViewOrders.xaml` («عرض الطلبات - ViewOrders») reads **`Inv_Tailor`** — a
 * different document from the `TailoringOrders` of part two. Its grid is
 * `📋 رقم الفاتورة · 👤 الاسم · 📱 الجوال · 📅 التاريخ · 💰 الإجمالي · ✅ المدفوع ·
 * ⏳ الباقي · 📌 الحالة · 👁️ عرض`, filtered by one box «🔍 الهاتف أو اسم العميل...»
 * (`phone_num LIKE @search OR name LIKE @search`, L64) and counted by «النتائج: {n}».
 *
 * The arithmetic is the desktop's, and none of it is stored:
 *
 *   • 💰 الإجمالي = `sale_price + sale_price * 5.0 / 100.0` (L88) — the same 5% that
 *     `AddNewSizes.CreateInvoice` L419 hands to the point of sale as `txtTotVAT`.
 *   • ✅ المدفوع = `SELECT paid FROM Inv_Sub_Tailor WHERE inv_code=@code` (L130).
 *   • ⏳ الباقي = الإجمالي بالضريبة − المدفوع (L90).
 *   • 📌 الحالة = `GetStateText` L119 (`0 مستلم · 1 في الخياطة · 2 جاهز · default تم التسليم`),
 *     which is where part two's four seeded statuses came from.
 *
 * `Form_WPF/AddNewSizes.xaml` («إضافة مقاس جديد») writes it: «📋 البيانات الأساسية»
 * (`👤 اسم العميل · 📞 رقم الجوال · 👔 نوع الثوب · 🔢 العدد · 💰 السعر · 💵 الإجمالي ·
 * ✅ الحالة`), «📐 المقاسات» و«📏 مقاسات إضافية» — the 39 columns of `Inv_Sub_Tailor` —
 * and «⚙️ لوحة التحكم» with `جديد · حفظ · مكرر · فاتورة · طباعه · إستلام دفعة`.
 *
 * `btnSave_Click` L191 refuses in the window's own words: «برجاء اختيار العميل» و
 * «يرجي إدخال السعر», and `CalculateTotalPrice` L860 is
 * `الإجمالي = السعر × العدد`.
 */
describe('فاتورة التفصيل — frmViewOrders · AddNewSizes', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;

  const post = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const asStranger = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: stranger.token, body });

  let partyId = '';
  let garmentTypeId = '';
  let statusReceived = '';
  let statusReady = '';
  let statusDelivered = '';
  let branchId = '';
  let cashLocationId = '';
  let invoiceId = '';
  let invoiceNumber = '';

  beforeAll(async () => {
    ctx = await createTestApp('tailoring-invoices');
    actor = await createActor(ctx, {
      tenantCode: 'tlr-invoices',
      email: 'owner@tlr-invoices.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'tailoring.view',
        'tailoring.manage',
        'parties.manage',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tlr-invoices-2',
      email: 'owner@tlr-invoices-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tailoring.view', 'tailoring.manage', 'parties.manage'],
    });

    // The four ⚙️ حالات and the four 👔 أنواع الثوب are seeded by migrations `0053`/`0054`
    // for tenants that already existed and by `OrgProvisioningService` for the rest.
    const provisioning = ctx.app.get(OrgProvisioningService);
    const defaults = await provisioning.provisionOrgDefaults(actor.tenantId, { actorUserId: actor.userId });
    await provisioning.provisionOrgDefaults(stranger.tenantId, { actorUserId: stranger.userId });
    branchId = defaults.branchId;
    cashLocationId = (defaults as unknown as { cashLocationId?: string }).cashLocationId ?? '';

    const customer = await post('/parties', { kind: 'customer', name: 'محمد علي', phone: '0551234567' });
    expect(customer.status).toBe(201);
    partyId = data(customer.body).id as string;

    const garments = rowsOf((await get('/tailoring/garment-types')).body);
    garmentTypeId = (garments.find((row) => row.code === 'saudi') as { id: string }).id;

    const statuses = rowsOf((await get('/tailoring/order-statuses')).body);
    const byCode = (code: string) => (statuses.find((row) => row.code === code) as { id: string }).id;
    statusReceived = byCode('received');
    statusReady = byCode('ready');
    statusDelivered = byCode('delivered');
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('👔 نوع الثوب — سعودي · بحريني · اماراتي · كويتي بترتيب القائمة', async () => {
    const garments = rowsOf((await get('/tailoring/garment-types')).body);
    expect(garments.map((row) => row.nameAr)).toEqual(['سعودي', 'بحريني', 'اماراتي', 'كويتي']);
    expect(garments.map((row) => row.displayOrder)).toEqual([1, 2, 3, 4]);
  });

  it('📐 المقاسات — سجلّ الحقول بأسماء `Inv_Sub_Tailor` وتسميات `AddNewSizes`', async () => {
    const fields = rowsOf((await get('/tailoring/measurement-fields')).body);
    const byKey = (key: string) => fields.find((field) => field.key === key) as Record<string, unknown>;
    expect(byKey('height1').label).toBe('الطول (س)');
    expect(byKey('shoulder').label).toBe('الكتف');
    expect(byKey('handShape').kind).toBe('select');
    expect(byKey('handShape').options).toEqual([
      'يد ساده',
      'يد ساده مثل الكبك',
      'كبك قلاب',
      'كبك مربع',
      'كبك مشتول',
      'كبك مدور',
    ]);
    expect(byKey('down').label).toBe('أسفل');
    expect(byKey('title')).toBeUndefined(); // ملاحظات is a column of its own, not a قياس
    // Three groups, as the window has them: 📐 المقاسات · ✨ الأشكال والتفاصيل · 📏 مقاسات إضافية.
    expect(new Set(fields.map((field) => field.group))).toEqual(new Set(['measurements', 'shapes', 'extra']));
    expect(fields).toHaveLength(39);
  });

  it('🧾 حفظ الفاتورة — البطاقة كاملة برقمها وإجماليها', async () => {
    const created = await post('/tailoring/invoices', {
      partyId,
      customerName: 'محمد علي',
      phone: '0551234567',
      invoiceDate: '2026-03-01',
      quantity: '2',
      unitPrice: '500',
      statusId: statusReceived,
      garmentTypeId,
      measurements: { height1: '170', shoulder: '46', handShape: 'كبك مربع', trangle: 'true' },
      notes: 'ياقة صينية',
    });
    expect(created.status).toBe(201);
    const invoice = data(created.body);
    invoiceId = invoice.id as string;
    invoiceNumber = invoice.number as string;

    expect(invoice).toMatchObject({
      // 📋 رقم الفاتورة — allocated from the tenant sequence with the `TI-` prefix.
      number: expect.stringMatching(/^TI-\d{6}$/),
      customerName: 'محمد علي',
      phone: '0551234567',
      invoiceDate: '2026-03-01',
      quantity: '2.0000',
      unitPrice: '500.0000',
      // 💵 الإجمالي = 💰 السعر × 🔢 العدد (`CalculateTotalPrice` L860).
      total: '1000.0000',
      statusName: 'مستلم',
      garmentTypeName: 'سعودي',
      billed: false,
      notes: 'ياقة صينية',
    });
    expect(invoice.measurements).toMatchObject({ height1: '170', shoulder: '46', handShape: 'كبك مربع' });

    // 💰 الإجمالي في `frmViewOrders` = sale_price × 1.05 (L88).
    expect(Number(invoice.totalWithTax)).toBeCloseTo(1050, 4);
    // ⏳ الباقي = الإجمالي بالضريبة − المدفوع (L90) — nothing paid yet.
    expect(Number(invoice.remainingAmount)).toBeCloseTo(1050, 4);
    expect(invoice.payments).toEqual([]);
  });

  it('الرفضان — «برجاء اختيار العميل» و«يرجي إدخال السعر»', async () => {
    const noCustomer = await post('/tailoring/invoices', { customerName: '   ', unitPrice: '100' });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body).toMatchObject({
      code: 'TAILORING_INVOICE_CUSTOMER_REQUIRED',
      detail: 'برجاء اختيار العميل',
    });

    const noPrice = await post('/tailoring/invoices', { customerName: 'محمد علي' });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body).toMatchObject({
      code: 'TAILORING_INVOICE_PRICE_REQUIRED',
      detail: 'يرجي إدخال السعر',
    });

    // The desktop compares الإجمالي to the string "0" — a zero quantity is a zero total.
    const zeroQuantity = await post('/tailoring/invoices', { customerName: 'محمد علي', unitPrice: '100', quantity: '0' });
    expect(zeroQuantity.status).toBe(422);
    expect(zeroQuantity.body).toMatchObject({ code: 'TAILORING_INVOICE_PRICE_REQUIRED' });
  });

  it('📐 قياسٌ مجهول اسمه لا يُحفظ — شاشة لا تعرضه قياسٌ ضائع', async () => {
    const unknown = await post('/tailoring/invoices', {
      customerName: 'محمد علي',
      unitPrice: '100',
      measurements: { height9: '1' },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_FIELD_UNKNOWN',
      detail: 'قياس غير معروف: height9',
    });
  });

  it('📌 الحالة — تغييرها من «مستلم» إلى «جاهز» إلى «تم التسليم»', async () => {
    const ready = await post(`/tailoring/invoices/${invoiceId}/status`, { statusId: statusReady });
    expect(ready.status).toBe(201);
    expect(data(ready.body)).toMatchObject({ statusName: 'جاهز' });

    const unknown = await post(`/tailoring/invoices/${invoiceId}/status`, {
      statusId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'TAILORING_STATUS_NOT_FOUND' });

    const delivered = await post(`/tailoring/invoices/${invoiceId}/status`, { statusId: statusDelivered });
    expect(delivered.status).toBe(201);
    expect(data(delivered.body)).toMatchObject({ statusName: 'تم التسليم' });
  });

  it('💵 إستلام دفعة — بلا صندوق: المدفوع يكبر والباقي ينقص', async () => {
    const paid = await post(`/tailoring/invoices/${invoiceId}/payments`, { amount: '400', date: '2026-03-05' });
    expect(paid.status).toBe(201);
    expect(Number(data(paid.body).paidAmount)).toBeCloseTo(400, 4);
    // ⏳ الباقي = 1050 − 400
    expect(Number(data(paid.body).remainingAmount)).toBeCloseTo(650, 4);
    const payments = data(paid.body).payments as Array<Record<string, unknown>>;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount: '400.0000',
      paidAt: '2026-03-05',
      // «تم استلام دفعة من عملية رقم {code}» (`AddNewSizes` L683).
      note: `تم استلام دفعة من عملية رقم ${invoiceNumber}`,
      voucherId: null,
    });

    const refused = await post(`/tailoring/invoices/${invoiceId}/payments`, { amount: '0' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'TAILORING_PAYMENT_AMOUNT_INVALID' });
  });

  it('💵 إستلام دفعة — بصندوق: سند قبض في الخزينة مربوط بالفاتورة', async () => {
    expect(cashLocationId).not.toBe('');
    const paid = await post(`/tailoring/invoices/${invoiceId}/payments`, {
      amount: '250',
      date: '2026-03-06',
      cashLocationId,
      branchId,
      method: 'cash',
      note: 'دفعة نقدية',
    });
    expect(paid.status).toBe(201);
    const payments = data(paid.body).payments as Array<Record<string, unknown>>;
    expect(payments).toHaveLength(2);
    const linked = payments.find((row) => row.note === 'دفعة نقدية') as Record<string, unknown>;
    expect(linked.voucherId).toBeTruthy();
    // ✅ المدفوع = 400 + 250 — `Inv_Sub_Tailor.paid` is a running total, so is this.
    expect(Number(data(paid.body).paidAmount)).toBeCloseTo(650, 4);
    expect(Number(data(paid.body).remainingAmount)).toBeCloseTo(400, 4);
  });

  it('📋 عرض الطلبات — البحث بالجوال وبالاسم، و«النتائج»', async () => {
    const second = await post('/tailoring/invoices', {
      customerName: 'سالم أحمد',
      phone: '0557654321',
      quantity: '1',
      unitPrice: '300',
      statusId: statusReceived,
    });
    expect(second.status).toBe(201);
    const secondNumber = data(second.body).number as string;

    const all = rowsOf((await get('/tailoring/invoices')).body);
    expect(all).toHaveLength(2);

    const byPhone = rowsOf((await get('/tailoring/invoices?search=0557654321')).body);
    expect(byPhone.map((row) => row.number)).toEqual([secondNumber]);

    const byName = rowsOf((await get('/tailoring/invoices?search=' + encodeURIComponent('محمد'))).body);
    expect(byName.map((row) => row.number)).toEqual([invoiceNumber]);

    const byStatus = rowsOf((await get(`/tailoring/invoices?statusId=${statusDelivered}`)).body);
    expect(byStatus.map((row) => row.number)).toEqual([invoiceNumber]);

    // 💰 الإجمالي معروض بضريبته في كل صف، كما في الشبكة (L88).
    expect(Number(byName[0].totalWithTax)).toBeCloseTo(1050, 4);

    await del(`/tailoring/invoices/${data(second.body).id as string}`);
  });

  it('✏️ تعديل — ما أُرسل وحده يتغيّر، ونسخةٌ قديمة تُرفض', async () => {
    const current = data((await get(`/tailoring/invoices/${invoiceId}`)).body);
    const stale = await patch(`/tailoring/invoices/${invoiceId}`, { version: 1, notes: 'تعديل قديم' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await patch(`/tailoring/invoices/${invoiceId}`, {
      version: current.version as number,
      unitPrice: '600',
      quantity: '3',
      notes: 'تعديل لاحق',
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({
      unitPrice: '600.0000',
      quantity: '3.0000',
      // 💵 الإجمالي يُعاد حسابه: 600 × 3
      total: '1800.0000',
      notes: 'تعديل لاحق',
      phone: '0551234567',
      garmentTypeName: 'سعودي',
    });
    // ⏳ الباقي = 1800 × 1.05 − 650
    expect(Number(data(updated.body).remainingAmount)).toBeCloseTo(1890 - 650, 4);
  });

  it('🗑️ حذف — الفاتورة تغيب، و⏳ الباقي يبقى محسوباً', async () => {
    const doomed = await post('/tailoring/invoices', { customerName: 'زبون مؤقت', unitPrice: '50' });
    expect(doomed.status).toBe(201);
    const doomedId = data(doomed.body).id as string;

    const removed = await del(`/tailoring/invoices/${doomedId}`);
    expect(removed.status).toBe(200);
    const gone = await get(`/tailoring/invoices/${doomedId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'TAILORING_INVOICE_NOT_FOUND' });

    // عزل المؤسسات — a second tenant sees none of this one's فواتير.
    const strangerRead = await asStranger('get', `/tailoring/invoices/${invoiceId}`);
    expect(strangerRead.status).toBe(404);
    const strangerList = rowsOf((await asStranger('get', '/tailoring/invoices')).body);
    expect(strangerList).toHaveLength(0);
    const strangerPayment = await asStranger('post', `/tailoring/invoices/${invoiceId}/payments`, { amount: '10' });
    expect(strangerPayment.status).toBe(404);
    const strangerGarments = rowsOf((await asStranger('get', '/tailoring/garment-types')).body);
    expect(strangerGarments.map((row) => row.nameAr)).toEqual(['سعودي', 'بحريني', 'اماراتي', 'كويتي']);
  });
});
