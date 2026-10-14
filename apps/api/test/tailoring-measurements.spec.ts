import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part four — 📏 القياسات.
 *
 * `Form_WPF/frmMeasurements.xaml` («إدارة قياسات العملاء») is a search box over one
 * grid. «البحث برقم الجوال أو الاسم:» with the watermark «🔍 الجوال أو الاسم...» and
 * «🔍 بحث» resolves a **عميل** (`SELECT TOP 10 id, name, mobile FROM Customers WHERE
 * mobile LIKE @Search OR name LIKE @Search ORDER BY name`, and the first row wins),
 * shows «العميل: …» «الجوال: …» and lists that عميل's قياسات. With no عميل the grid is
 * `LoadAllMeasurements` — every active قياس with its customer, newest التاريخ first.
 *
 * The grid is «📋 قياسات العميل»: `👤 اسم صاحب القياس · 📅 التاريخ · 📝 الملاحظات ·
 * 📐 عدد المقاسات · العميل`, and a double-click is «✏️ تعديل القياس». The buttons are
 * `➕ إضافة قياس جديد · ✏️ تعديل القياس · 🗑️ حذف القياس · ✖ إغلاق`, and four refusals
 * are the window's own sentences: «الرجاء إدخال رقم الجوال أو اسم العميل» ·
 * «لم يتم العثور على عميل» · «الرجاء البحث عن عميل أولًا» · «الرجاء اختيار قياس
 * للتعديل»/«للحذف».
 *
 * `Form_WPF/frmMeasurementDetails.xaml` («📏 بيانات القياس») is the card: «👤 اسم صاحب
 * القياس *», «📐 قيم القياسات» — a row per **active** خاصية, built at runtime from
 * `MeasurementAttributes`, each with the unit «سم» — and «📝 ملاحظات». Its save refuses
 * twice, «الرجاء إدخال اسم صاحب القياس» و«الرجاء إدخال قياس واحد على الأقل», writes the
 * قياس in one transaction, and on update DELETEs every value before re-inserting the
 * ones greater than zero.
 *
 * `Form_WPF/frmMeasurementAttributes.xaml` («📏 إدارة خصائص القياسات») is the
 * definitions window: `📝 اسم الخاصية · 🔢 الترتيب · ⚙️ الحالة` (`نشط`/`معطل`) with
 * `➕ إضافة · ✏️ تعديل · 🔕 تعطيل · ▲ تحريك للأعلى · ▼ تحريك للأسفل · ✖ إغلاق`. A new
 * خاصية takes `ISNULL(MAX(DisplayOrder), 0) + 1`; تعطيل is `IsActive = 0`, never a
 * delete; and ▲▼ **swap** الترتيب with the neighbour.
 */
describe('القياسات — frmMeasurements · frmMeasurementDetails · frmMeasurementAttributes', () => {
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

  let customerId = '';
  let otherCustomerId = '';
  let lengthId = '';
  let widthId = '';
  let sleeveId = '';
  let measurementId = '';

  beforeAll(async () => {
    ctx = await createTestApp('tailoring-measurements');
    actor = await createActor(ctx, {
      tenantCode: 'tlr-measure',
      email: 'owner@tlr-measure.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'tailoring.view',
        'tailoring.manage',
        'parties.manage',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tlr-measure-2',
      email: 'owner@tlr-measure-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tailoring.view', 'tailoring.manage', 'parties.manage'],
    });

    // 📏 الخصائص الثلاث تُبَذَّر بالترحيل `0055` لكل مؤسسة قائمة، وبـ
    // `OrgProvisioningService` لكل مؤسسة تُخلق بعده.
    const provisioning = ctx.app.get(OrgProvisioningService);
    await provisioning.provisionOrgDefaults(actor.tenantId, { actorUserId: actor.userId });
    await provisioning.provisionOrgDefaults(stranger.tenantId, { actorUserId: stranger.userId });

    const customer = await post('/parties', { kind: 'customer', name: 'محمد علي', phone: '0551234567' });
    expect(customer.status).toBe(201);
    customerId = data(customer.body).id as string;

    const other = await post('/parties', { kind: 'customer', name: 'سالم أحمد', phone: '0557654321' });
    expect(other.status).toBe(201);
    otherCustomerId = data(other.body).id as string;

    const attributes = rowsOf((await get('/tailoring/measurement-attributes')).body);
    lengthId = (attributes.find((row) => row.nameAr === 'الطول') as { id: string }).id;
    widthId = (attributes.find((row) => row.nameAr === 'العرض') as { id: string }).id;
    sleeveId = (attributes.find((row) => row.nameAr === 'الكم') as { id: string }).id;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('📏 خصائص القياسات — الطول · العرض · الكم بترتيبها، و⚙️ الحالة «نشط»', async () => {
    const attributes = rowsOf((await get('/tailoring/measurement-attributes')).body);
    expect(attributes.map((row) => row.nameAr)).toEqual(['الطول', 'العرض', 'الكم']);
    expect(attributes.map((row) => row.displayOrder)).toEqual([1, 2, 3]);
    expect(attributes.map((row) => row.statusText)).toEqual(['نشط', 'نشط', 'نشط']);
  });

  it('➕ إضافة خاصية — 🔢 الترتيب التالي، والاسم المكرر مرفوض', async () => {
    const created = await post('/tailoring/measurement-attributes', { nameAr: 'الرقبة' });
    expect(created.status).toBe(201);
    // `ISNULL(MAX(DisplayOrder), 0) + 1` — a new خاصية goes last.
    expect(data(created.body)).toMatchObject({ nameAr: 'الرقبة', displayOrder: 4, statusText: 'نشط' });

    const nameless = await post('/tailoring/measurement-attributes', { nameAr: '   ' });
    expect(nameless.status).toBe(422);
    expect(nameless.body).toMatchObject({
      code: 'TAILORING_ATTRIBUTE_NAME_REQUIRED',
      detail: 'الرجاء إدخال اسم الخاصية',
    });

    const duplicate = await post('/tailoring/measurement-attributes', { nameAr: 'الرقبة' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      code: 'TAILORING_ATTRIBUTE_NAME_TAKEN',
      detail: 'اسم الخاصية موجود مسبقاً',
    });
  });

  it('✏️ تعديل الخاصية — إعادة التسمية، ونسخةٌ قديمة تُرفض', async () => {
    const attributes = rowsOf((await get('/tailoring/measurement-attributes')).body);
    const neck = attributes.find((row) => row.nameAr === 'الرقبة') as Record<string, unknown>;

    const stale = await patch(`/tailoring/measurement-attributes/${neck.id as string}`, {
      version: 99,
      nameAr: 'رقبة',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const renamed = await patch(`/tailoring/measurement-attributes/${neck.id as string}`, {
      version: neck.version as number,
      nameAr: 'محيط الرقبة',
    });
    expect(renamed.status).toBe(200);
    expect(data(renamed.body)).toMatchObject({ nameAr: 'محيط الرقبة', displayOrder: 4 });

    const unknown = await patch('/tailoring/measurement-attributes/00000000-0000-4000-8000-000000000000', {
      nameAr: 'شيء',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'TAILORING_ATTRIBUTE_NOT_FOUND' });
  });

  it('🔕 تعطيل — «سيتم إخفاؤها من القياسات الجديدة»', async () => {
    const attributes = rowsOf((await get('/tailoring/measurement-attributes')).body);
    const neck = attributes.find((row) => row.nameAr === 'محيط الرقبة') as Record<string, unknown>;

    const disabled = await post(`/tailoring/measurement-attributes/${neck.id as string}/deactivate`, {});
    expect(disabled.status).toBe(201);
    expect(data(disabled.body)).toMatchObject({ active: false, statusText: 'معطل' });

    // The list still shows it (the desktop's `LoadData` has no filter), the card does not.
    const all = rowsOf((await get('/tailoring/measurement-attributes')).body);
    expect(all.find((row) => row.nameAr === 'محيط الرقبة')).toMatchObject({ statusText: 'معطل' });
    const activeOnly = rowsOf((await get('/tailoring/measurement-attributes?activeOnly=true')).body);
    expect(activeOnly.map((row) => row.nameAr)).toEqual(['الطول', 'العرض', 'الكم']);

    // «تفعيل» is the way back — the desktop has no button for it, but تعطيل is not a death sentence.
    const revived = await patch(`/tailoring/measurement-attributes/${neck.id as string}`, { active: true });
    expect(data(revived.body)).toMatchObject({ active: true, statusText: 'نشط' });
  });

  it('▲▼ تحريك للأعلى وللأسفل — الترتيب يُبدَّل، والطرفان لا يتحركان', async () => {
    const before = rowsOf((await get('/tailoring/measurement-attributes')).body);
    expect(before.map((row) => row.nameAr)).toEqual(['الطول', 'العرض', 'الكم', 'محيط الرقبة']);

    const up = await post(`/tailoring/measurement-attributes/${sleeveId}/move`, { direction: 'up' });
    expect(up.status).toBe(201);
    expect(data(up.body)).toMatchObject({ nameAr: 'الكم', displayOrder: 2 });
    expect(rowsOf((await get('/tailoring/measurement-attributes')).body).map((row) => row.nameAr)).toEqual([
      'الطول',
      'الكم',
      'العرض',
      'محيط الرقبة',
    ]);

    const down = await post(`/tailoring/measurement-attributes/${sleeveId}/move`, { direction: 'down' });
    expect(data(down.body)).toMatchObject({ nameAr: 'الكم', displayOrder: 3 });

    // At the top there is no neighbour: the desktop returns quietly, and so do we.
    const atTop = await post(`/tailoring/measurement-attributes/${lengthId}/move`, { direction: 'up' });
    expect(data(atTop.body)).toMatchObject({ nameAr: 'الطول', displayOrder: 1 });

    const unknown = await post('/tailoring/measurement-attributes/00000000-0000-4000-8000-000000000000/move', {
      direction: 'up',
    });
    expect(unknown.status).toBe(404);
  });

  it('🧾 حفظ القياس — البطاقة كاملة: 👤 الاسم و📅 التاريخ و📐 القيم وعددها', async () => {
    const created = await post('/tailoring/measurements', {
      partyId: customerId,
      name: 'محمد علي',
      measurementDate: '2026-03-01',
      notes: 'قياس الصيف',
      values: [
        { attributeId: lengthId, value: '170' },
        { attributeId: widthId, value: '46' },
        // A value of zero is not a value: `decimal.TryParse` then `val > 0`.
        { attributeId: sleeveId, value: '0' },
      ],
    });
    expect(created.status).toBe(201);
    const measurement = data(created.body);
    measurementId = measurement.id as string;

    expect(measurement).toMatchObject({
      partyId: customerId,
      customerName: 'محمد علي',
      customerPhone: '0551234567',
      name: 'محمد علي',
      displayName: 'محمد علي',
      measurementDate: '2026-03-01',
      notes: 'قياس الصيف',
      active: true,
      // 📐 عدد المقاسات — two, because the zero was never written.
      measurementCount: 2,
    });
    expect(measurement.values).toEqual([
      { attributeId: lengthId, attributeName: 'الطول', value: '170', displayOrder: 1 },
      { attributeId: widthId, attributeName: 'العرض', value: '46', displayOrder: 2 },
    ]);
  });

  it('الرفوض — من صندوق البحث إلى بطاقة القياس', async () => {
    const noCustomer = await post('/tailoring/measurements', { values: [{ attributeId: lengthId, value: '1' }] });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_CUSTOMER_REQUIRED',
      detail: 'الرجاء البحث عن عميل أولًا',
    });

    const nameless = await post('/tailoring/measurements', {
      partyId: customerId,
      name: '   ',
      values: [{ attributeId: lengthId, value: '1' }],
    });
    expect(nameless.status).toBe(422);
    expect(nameless.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_NAME_REQUIRED',
      detail: 'الرجاء إدخال اسم صاحب القياس',
    });

    const empty = await post('/tailoring/measurements', { partyId: customerId, name: 'محمد علي', values: [] });
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_VALUE_REQUIRED',
      detail: 'الرجاء إدخال قياس واحد على الأقل',
    });

    const zeroOnly = await post('/tailoring/measurements', {
      partyId: customerId,
      name: 'محمد علي',
      values: [{ attributeId: lengthId, value: '0' }],
    });
    expect(zeroOnly.status).toBe(422);
    expect(zeroOnly.body).toMatchObject({ code: 'TAILORING_MEASUREMENT_VALUE_REQUIRED' });

    const foreignAttribute = await post('/tailoring/measurements', {
      partyId: customerId,
      name: 'محمد علي',
      values: [{ attributeId: '00000000-0000-4000-8000-000000000000', value: '5' }],
    });
    expect(foreignAttribute.status).toBe(404);
    expect(foreignAttribute.body).toMatchObject({ code: 'TAILORING_ATTRIBUTE_NOT_FOUND' });

    const blankSearch = await get('/tailoring/measurements?search=' + encodeURIComponent('   '));
    expect(blankSearch.status).toBe(422);
    expect(blankSearch.body).toMatchObject({
      code: 'TAILORING_MEASUREMENT_SEARCH_REQUIRED',
      detail: 'الرجاء إدخال رقم الجوال أو اسم العميل',
    });

    const missingCustomer = await get('/tailoring/measurements?search=0000000000');
    expect(missingCustomer.status).toBe(404);
    expect(missingCustomer.body).toMatchObject({
      code: 'TAILORING_CUSTOMER_NOT_FOUND',
      detail: 'لم يتم العثور على عميل',
    });
  });

  it('👤 اسم صاحب القياس فارغ — «قياس بتاريخ …» كما في الديسكتوب', async () => {
    // The endpoint existed before 👤 الاسم (the customer card's own columns are keys,
    // not خاصية rows), so an unnamed قياس is still accepted — and the grid's fallback is
    // the desktop's own sentence (`frmOrderDetails.LoadCustomerMeasurements` L259).
    const legacy = await post('/tailoring/measurements', {
      partyId: otherCustomerId,
      measurements: { height: '170', shoulder: '46' },
    });
    expect(legacy.status).toBe(201);
    const row = data(legacy.body);
    expect(row.name).toBeNull();
    expect(row.displayName).toBe(`قياس بتاريخ ${row.measurementDate as string}`);
    expect(row.values).toEqual([]);
    expect(row.measurements).toMatchObject({ height: '170' });

    await del(`/tailoring/measurements/${row.id as string}`);
  });

  it('📋 قائمة القياسات — «🔍 بحث» بالجوال أو بالاسم، والأحدث أولاً', async () => {
    const second = await post('/tailoring/measurements', {
      partyId: customerId,
      name: 'محمد علي — قياس الشتاء',
      measurementDate: '2026-03-10',
      values: [{ attributeId: lengthId, value: '172' }],
    });
    expect(second.status).toBe(201);

    const all = await get('/tailoring/measurements');
    expect(rowsOf(all.body).map((row) => row.measurementDate)).toEqual(['2026-03-10', '2026-03-01']);

    // `mobile LIKE @Search OR name LIKE @Search` — one box, two columns.
    const byPhone = await get('/tailoring/measurements?search=0551234567');
    expect(data(byPhone.body)).toHaveLength(2);
    expect((byPhone.body.meta as Record<string, Record<string, string>>).customer).toMatchObject({
      id: customerId,
      name: 'محمد علي',
      phone: '0551234567',
    });

    const byName = await get('/tailoring/measurements?search=' + encodeURIComponent('سالم'));
    expect(data(byName.body)).toHaveLength(0);
    expect((byName.body.meta as Record<string, Record<string, string>>).customer).toMatchObject({
      id: otherCustomerId,
    });

    const oneParty = await get(`/tailoring/measurements?partyId=${customerId}`);
    expect(data(oneParty.body)).toHaveLength(2);

    await del(`/tailoring/measurements/${data(second.body).id as string}`);
  });

  it('✏️ تعديل القياس — ما أُرسل وحده يُكتب، والصفر يمحوه', async () => {
    const current = data((await get(`/tailoring/measurements/${measurementId}`)).body);
    const stale = await patch(`/tailoring/measurements/${measurementId}`, { version: 99, notes: 'تعديل قديم' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await patch(`/tailoring/measurements/${measurementId}`, {
      version: current.version as number,
      name: 'محمد علي — معدّل',
      notes: 'بعد التعديل',
      values: [
        { attributeId: lengthId, value: '175' },
        // العرض صار صفراً: `DELETE FROM MeasurementValues` then only what is > 0.
        { attributeId: widthId, value: '0' },
        { attributeId: sleeveId, value: '60' },
      ],
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({
      name: 'محمد علي — معدّل',
      notes: 'بعد التعديل',
      measurementCount: 2,
      measurementDate: '2026-03-01',
      customerName: 'محمد علي',
    });
    expect(data(updated.body).values).toEqual([
      { attributeId: lengthId, attributeName: 'الطول', value: '175', displayOrder: 1 },
      { attributeId: sleeveId, attributeName: 'الكم', value: '60', displayOrder: 3 },
    ]);

    const unknown = await patch('/tailoring/measurements/00000000-0000-4000-8000-000000000000', { notes: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'TAILORING_MEASUREMENT_NOT_FOUND' });
  });

  it('🗑️ حذف القياس — يغيب عن القائمة، وعزل المؤسسات', async () => {
    const removed = await del(`/tailoring/measurements/${measurementId}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body)).toEqual({ deleted: true, id: measurementId });

    const gone = await get(`/tailoring/measurements/${measurementId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'TAILORING_MEASUREMENT_NOT_FOUND' });
    expect(data((await get('/tailoring/measurements')).body)).toHaveLength(0);

    const again = await del(`/tailoring/measurements/${measurementId}`);
    expect(again.status).toBe(404);

    // A second tenant sees neither the قياس nor the خصائص of the first.
    const strangerAttributes = rowsOf((await asStranger('get', '/tailoring/measurement-attributes')).body);
    expect(strangerAttributes.map((row) => row.nameAr)).toEqual(['الطول', 'العرض', 'الكم']);
    const strangerRead = await asStranger('get', `/tailoring/measurements/${measurementId}`);
    expect(strangerRead.status).toBe(404);
    const strangerDelete = await asStranger('delete', `/tailoring/measurements/${measurementId}`);
    expect(strangerDelete.status).toBe(404);
  });
});
