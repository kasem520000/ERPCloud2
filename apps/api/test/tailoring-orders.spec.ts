import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';


/**
 * Phase 09 part two — 🧵 طلب التفصيل.
 *
 * `Form_WPF/frmOrders.xaml` («إدارة طلبات التفصيل») is the grid:
 * `رقم الطلب · 👤 العميل · 📞 الجوال · القياس · نوع التفصيل · ⚙️ الحالة · 📅 تاريخ الطلب ·
 * 📅 موعد التسليم · 💰 السعر · 💵 المدفوع · ⌛ المتبقي`, filtered by `cmbStatus` (with
 * «الكل» = 0), من / إلى and one search box that matches رقم الطلب or اسم العميل
 * (`LoadOrders` L73–L104). Its buttons are `➕ إضافة طلب جديد` · `✏️ تعديل` · `🗑️ حذف` ·
 * `🔄 تغيير الحالة`.
 *
 * `Form_WPF/frmOrderDetails.xaml` («إضافة طلب تفصيل») is the card, and
 * `btnSave_Click` L318 is where the refusals live:
 *
 *   • «الرجاء اختيار عميل» — no customer selected,
 *   • «الرجاء اختيار نوع التفصيل» — no type selected,
 *   • «الرجاء إدخال السعر» — `price <= 0`.
 *
 * ⌛ المتبقي is 💰 السعر − 💵 المدفوع (`CalculateRemaining` L290) and a negative المتبقي
 * is allowed — the desktop paints it green instead of red rather than refusing.
 *
 * `Form_WPF/frmOptions.xaml` («⚙️ إدارة الخيارات الجاهزة») is the catalogue: one value
 * per category (`selectedOptions[catId] = valId`, `OptionButton_Click` L176), and
 * `⭐ تعيين افتراضي` clears the category before setting the new default (L323/L330).
 *
 * The cloud's `tailoring` module answered «ما قياس هذا العميل؟» and nothing else. There
 * was no طلب, no حالة, no موعد تسليم, no سعر — nothing a tailor could look up.
 */
describe('طلب التفصيل — frmOrders · frmOrderDetails · frmOptions', () => {
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
  let otherPartyId = '';
  let typeId = '';
  let statusReceived = '';
  let statusSewing = '';
  let statusDelivered = '';
  let measurementId = '';
  let orderId = '';
  let orderNumber = '';

  beforeAll(async () => {
    ctx = await createTestApp('tailoring-orders');
    actor = await createActor(ctx, {
      tenantCode: 'tlr-orders',
      email: 'owner@tlr-orders.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'tailoring.view', 'tailoring.manage', 'parties.manage'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tlr-orders-2',
      email: 'owner@tlr-orders-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tailoring.view', 'tailoring.manage', 'parties.manage'],
    });

    // The four ⚙️ حالات are seeded by migration `0053` for tenants that already existed
    // and by `OrgProvisioningService` for every tenant created after it — `frmOrders`
    // cannot filter by حالة without them.
    const provisioning = ctx.app.get(OrgProvisioningService);
    await provisioning.provisionOrgDefaults(actor.tenantId, { actorUserId: actor.userId });
    await provisioning.provisionOrgDefaults(stranger.tenantId, { actorUserId: stranger.userId });

    const customer = await post('/parties', { kind: 'customer', name: 'محمد علي', phone: '0551234567' });
    expect(customer.status).toBe(201);
    partyId = data(customer.body).id as string;

    const other = await post('/parties', { kind: 'customer', name: 'سالم أحمد', phone: '0557654321' });
    expect(other.status).toBe(201);
    otherPartyId = data(other.body).id as string;

    const type = await post('/tailoring/types', { nameAr: 'ثوب', defaultPrice: '350' });
    expect(type.status).toBe(201);
    typeId = data(type.body).id as string;

    const statuses = rowsOf((await get('/tailoring/order-statuses')).body);
    const byCode = (code: string) => statuses.find((row) => row.code === code) as { id: string; nameAr: string };
    statusReceived = byCode('received').id;
    statusSewing = byCode('sewing').id;
    statusDelivered = byCode('delivered').id;

    const measurement = await post('/tailoring/measurements', {
      partyId,
      measurements: { height: '170', shoulder: '46' },
    });
    expect(measurement.status).toBe(201);
    measurementId = data(measurement.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('⚙️ الحالة — مستلم · في الخياطة · جاهز · تم التسليم، بترتيب العرض', async () => {
    const statuses = rowsOf((await get('/tailoring/order-statuses')).body);
    expect(statuses.map((row) => row.nameAr)).toEqual(['مستلم', 'في الخياطة', 'جاهز', 'تم التسليم']);
    expect(statuses.map((row) => row.displayOrder)).toEqual([1, 2, 3, 4]);
    // `is_final` is what makes ⌛ متأخّر stop being true — «تم التسليم» and only it.
    expect(statuses.map((row) => row.isFinal)).toEqual([false, false, false, true]);
  });

  it('🧵 نوع التفصيل — اسمه وسعره الافتراضي، واسمٌ مكرر مرفوض', async () => {
    const listed = rowsOf((await get('/tailoring/types')).body);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ nameAr: 'ثوب', defaultPrice: '350.0000', active: true });

    const clash = await post('/tailoring/types', { nameAr: 'ثوب', defaultPrice: '400' });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'TAILORING_TYPE_NAME_TAKEN', detail: 'نوع التفصيل موجود مسبقاً' });

    const nameless = await post('/tailoring/types', { nameAr: '   ' });
    expect(nameless.status).toBe(422);
    expect(nameless.body).toMatchObject({ code: 'TAILORING_TYPE_NAME_REQUIRED' });
  });

  it('🔧 الخيارات الجاهزة — تصنيف وخياراته، و⭐ تعيين افتراضي يُسقط ما عداه', async () => {
    const category = await post('/tailoring/option-categories', { nameAr: 'نوع الياقة' });
    expect(category.status).toBe(201);
    const categoryId = data(category.body).id as string;

    const first = await post('/tailoring/option-values', { categoryId, nameAr: 'ياقة عادية' });
    expect(first.status).toBe(201);
    const second = await post('/tailoring/option-values', { categoryId, nameAr: 'ياقة صينية' });
    expect(second.status).toBe(201);
    const secondId = data(second.body).id as string;

    const promoted = await post(`/tailoring/option-values/${secondId}/default`, {});
    expect(promoted.status).toBe(201);
    expect(data(promoted.body)).toMatchObject({ id: secondId, isDefault: true });

    const [shown] = rowsOf((await get('/tailoring/option-categories')).body) as Array<{
      nameAr: string;
      values: Array<{ nameAr: string; isDefault: boolean }>;
    }>;
    expect(shown.nameAr).toBe('نوع الياقة');
    // ⭐ واحد فقط في التصنيف — `UPDATE OptionValues SET IsDefault=0 WHERE CategoryID=@CatID`.
    expect(shown.values.filter((value) => value.isDefault).map((value) => value.nameAr)).toEqual([
      'ياقة صينية',
    ]);

    // A value outside its own tenant's catalogue does not exist here.
    const strangerCategory = await asStranger('post', '/tailoring/option-categories', { nameAr: 'تصنيف مؤسسة أخرى' });
    expect(strangerCategory.status).toBe(201);
    const foreign = await post('/tailoring/option-values', {
      categoryId: data(strangerCategory.body).id as string,
      nameAr: 'خيار دخيل',
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: 'TAILORING_CATEGORY_NOT_FOUND' });
  });

  it('🧾 حفظ الطلب — البطاقة كاملة برقمها ومتبقيها', async () => {
    const categories = rowsOf((await get('/tailoring/option-categories')).body) as Array<{
      id: string;
      values: Array<{ id: string }>;
    }>;
    const created = await post('/tailoring/orders', {
      partyId,
      typeId,
      statusId: statusReceived,
      measurementId,
      orderDate: '2026-01-15',
      deliveryDate: '2026-01-22',
      quantity: '2',
      price: '700',
      paidAmount: '200',
      fabricType: 'قطن',
      fabricColor: 'أبيض',
      designNotes: 'ياقة صينية وجيب جانبي',
      generalNotes: 'تسليم للفرع',
      options: [{ categoryId: categories[0].id, valueId: categories[0].values[0].id }],
    });
    expect(created.status).toBe(201);
    const order = data(created.body);
    orderId = order.id as string;
    orderNumber = order.number as string;

    expect(order).toMatchObject({
      // رقم الطلب — allocated from the tenant sequence with the `TO-` prefix.
      number: expect.stringMatching(/^TO-\d{6}$/),
      customerName: 'محمد علي',
      customerPhone: '0551234567',
      measurementName: expect.stringContaining('قياس بتاريخ'),
      typeName: 'ثوب',
      statusName: 'مستلم',
      orderDate: '2026-01-15',
      deliveryDate: '2026-01-22',
      quantity: '2.0000',
      price: '700.0000',
      paidAmount: '200.0000',
      // ⌛ المتبقي = 💰 السعر − 💵 المدفوع (`CalculateRemaining` L290).
      remainingAmount: '500.0000',
      // ⌛ متأخّر — موعد التسليم (2026-01-22) مضى والحالة ليست نهائية؛ الصف يُلوَّن أحمر.
      isDelayed: true,
      fabricType: 'قطن',
      fabricColor: 'أبيض',
      designNotes: 'ياقة صينية وجيب جانبي',
      generalNotes: 'تسليم للفرع',
    });
    expect(order.options).toEqual([
      {
        categoryId: categories[0].id,
        categoryName: 'نوع الياقة',
        valueId: categories[0].values[0].id,
        valueName: expect.any(String),
      },
    ]);
  });

  it('الرفوض الثلاثة — «الرجاء اختيار عميل» · «الرجاء اختيار نوع التفصيل» · «الرجاء إدخال السعر»', async () => {
    const noCustomer = await post('/tailoring/orders', { typeId, price: '100' });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body).toMatchObject({ code: 'TAILORING_CUSTOMER_REQUIRED', detail: 'الرجاء اختيار عميل' });

    const noType = await post('/tailoring/orders', { partyId, price: '100' });
    expect(noType.status).toBe(422);
    expect(noType.body).toMatchObject({ code: 'TAILORING_TYPE_REQUIRED', detail: 'الرجاء اختيار نوع التفصيل' });

    const noPrice = await post('/tailoring/orders', { partyId, typeId });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body).toMatchObject({ code: 'TAILORING_PRICE_REQUIRED', detail: 'الرجاء إدخال السعر' });

    // `price <= 0` — the desktop's own test, in its own words (L339).
    const zeroPrice = await post('/tailoring/orders', { partyId, typeId, price: '0' });
    expect(zeroPrice.status).toBe(422);
    expect(zeroPrice.body).toMatchObject({ code: 'TAILORING_PRICE_REQUIRED' });
  });

  it('القياس — قياس عميلٍ آخر ليس قياس هذا الطلب', async () => {
    const foreignMeasurement = await post('/tailoring/measurements', {
      partyId: otherPartyId,
      measurements: { height: '180' },
    });
    expect(foreignMeasurement.status).toBe(201);

    const mismatch = await post('/tailoring/orders', {
      partyId,
      typeId,
      price: '100',
      measurementId: data(foreignMeasurement.body).id as string,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_PARTY_MISMATCH',
      detail: 'القياس لا يتبع هذا العميل',
    });

    const unknown = await post('/tailoring/orders', {
      partyId,
      typeId,
      price: '100',
      measurementId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'TAILORING_MEASUREMENT_NOT_FOUND' });
  });

  it('⌛ المتبقي السالب مسموح — الديسكتوب يلوّنه أخضر ولا يرفضه', async () => {
    const overpaid = await post('/tailoring/orders', { partyId, typeId, price: '100', paidAmount: '150' });
    expect(overpaid.status).toBe(201);
    expect(data(overpaid.body)).toMatchObject({ price: '100.0000', paidAmount: '150.0000', remainingAmount: '-50.0000' });
    await del(`/tailoring/orders/${data(overpaid.body).id as string}`);
  });

  it('🔄 تغيير الحالة — من «مستلم» إلى «في الخياطة» إلى «تم التسليم»', async () => {
    const sewing = await post(`/tailoring/orders/${orderId}/status`, { statusId: statusSewing });
    expect(sewing.status).toBe(201);
    expect(data(sewing.body)).toMatchObject({ statusId: statusSewing, statusName: 'في الخياطة' });

    const unknown = await post(`/tailoring/orders/${orderId}/status`, {
      statusId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'TAILORING_STATUS_NOT_FOUND' });

    // ⌛ متأخّر — موعد التسليم مضى (2026-01-22) والحالة ليست نهائية.
    const delayed = await get(`/tailoring/orders/${orderId}`);
    expect(data(delayed.body).isDelayed).toBe(true);

    const delivered = await post(`/tailoring/orders/${orderId}/status`, { statusId: statusDelivered });
    expect(delivered.status).toBe(201);
    // «تم التسليم» ends the delay — the red row paint goes away (`IsDelayed`).
    expect(data(delivered.body)).toMatchObject({ statusName: 'تم التسليم', isDelayed: false });
  });

  it('📋 قائمة الطلبات — الحالة والبحث برقم الطلب وباسم العميل', async () => {
    const second = await post('/tailoring/orders', {
      partyId: otherPartyId,
      typeId,
      statusId: statusSewing,
      orderDate: '2026-02-01',
      deliveryDate: '2026-03-01',
      price: '450',
    });
    expect(second.status).toBe(201);
    const secondNumber = data(second.body).number as string;

    const all = rowsOf((await get('/tailoring/orders')).body);
    expect(all.length).toBeGreaterThanOrEqual(2);
    // `ORDER BY OrderDate DESC` (`LoadOrders` L104) — the newest is first.
    expect(all[0].orderDate).toBe('2026-02-01');

    const byStatus = rowsOf((await get(`/tailoring/orders?statusId=${statusDelivered}`)).body);
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0]).toMatchObject({ number: orderNumber, statusName: 'تم التسليم' });

    // «الكل» is StatusID 0 — no filter at all — so the plain list is the widest one.
    const bySearchNumber = rowsOf((await get(`/tailoring/orders?search=${encodeURIComponent(secondNumber)}`)).body);
    expect(bySearchNumber.map((row) => row.number)).toEqual([secondNumber]);

    const bySearchName = rowsOf((await get('/tailoring/orders?search=' + encodeURIComponent('سالم'))).body);
    expect(bySearchName.map((row) => row.customerName)).toEqual(['سالم أحمد']);

    const byDate = rowsOf((await get('/tailoring/orders?from=2026-02-01&to=2026-02-28')).body);
    expect(byDate).toHaveLength(1);
    expect(byDate[0].number).toBe(secondNumber);

    const byCustomer = rowsOf((await get(`/tailoring/orders?partyId=${partyId}`)).body);
    expect(byCustomer.every((row) => row.customerName === 'محمد علي')).toBe(true);

    await del(`/tailoring/orders/${data(second.body).id as string}`);
  });

  it('✏️ تعديل — ما أُرسل وحده يتغيّر، ونسخةٌ قديمة تُرفض', async () => {
    const stale = await patch(`/tailoring/orders/${orderId}`, { version: 1, designNotes: 'تعديل قديم' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const current = data((await get(`/tailoring/orders/${orderId}`)).body);
    const updated = await patch(`/tailoring/orders/${orderId}`, {
      version: current.version as number,
      price: '800',
      paidAmount: '300',
      fabricColor: 'بيج',
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({
      price: '800.0000',
      paidAmount: '300.0000',
      remainingAmount: '500.0000',
      fabricColor: 'بيج',
      // What was not sent keeps its value — including 🧵 تفاصيل القماش والتصميم.
      fabricType: 'قطن',
      designNotes: 'ياقة صينية وجيب جانبي',
      customerName: 'محمد علي',
    });
    expect(data(updated.body).version).toBe((current.version as number) + 1);

    // 👤 العميل cannot be swapped out from under the order.
    const swap = await patch(`/tailoring/orders/${orderId}`, { partyId: otherPartyId });
    expect(swap.status).toBe(422);
    expect(swap.body).toMatchObject({ code: 'TAILORING_CUSTOMER_IMMUTABLE' });
  });

  it('🗑️ حذف — الطلب يغيب عن القائمة، وطلب مؤسسة أخرى ليس هنا', async () => {
    const doomed = await post('/tailoring/orders', { partyId, typeId, price: '120' });
    expect(doomed.status).toBe(201);
    const doomedId = data(doomed.body).id as string;

    const removed = await del(`/tailoring/orders/${doomedId}`);
    expect(removed.status).toBe(200);
    const gone = await get(`/tailoring/orders/${doomedId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'TAILORING_ORDER_NOT_FOUND' });
    expect(rowsOf((await get('/tailoring/orders')).body).map((row) => row.id)).not.toContain(doomedId);

    // عزل المؤسسات — a second tenant sees nothing of this one's orders.
    const strangerRead = await asStranger('get', `/tailoring/orders/${orderId}`);
    expect(strangerRead.status).toBe(404);
    const strangerList = rowsOf((await asStranger('get', '/tailoring/orders')).body);
    expect(strangerList).toHaveLength(0);
    const strangerDelete = await asStranger('delete', `/tailoring/orders/${orderId}`);
    expect(strangerDelete.status).toBe(404);
    const strangerTypes = rowsOf((await asStranger('get', '/tailoring/types')).body);
    expect(strangerTypes).toHaveLength(0);
  });
});
