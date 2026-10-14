import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part nine — ⛵ المرسى: ➕ الإضافات.
 *
 * `Form_WPF/frmAdditions.xaml` («📋 إضافات» — لوحتها «📋 إدارة الإضافات») is three boxes
 * and three buttons:
 *
 *   🔢 الرقم (`txtNo`, read-only) · 📝 الاسم (`txtName`) · 💰 القيمة (`txtSalePrice`)
 *   ➕ جديد · 💾 حفظ · 🗑️ حذف
 *   والشبكة: `🔢 الرقم · 📝 الاسم · 💰 القيمة`
 *
 * and its three sentences: «يجب إدخال اسم الإضافة ⚠️» · «يجب تحديد الإضافة المراد حذفها
 * ⚠️» · «هل أنت متأكد من حذف هذه الإضافة؟ 🗑️».
 *
 * The other half is «🎁 الإضافات» in `Form_WPF/frmBookingM.xaml` («الحجوزات»):
 *
 *   LoadAdditions()                 → select id, Name from Additions where IsDeleted=0
 *   cmbAdditions_SelectionChanged   → «السعر» = SalePrice
 *   txtQuant_TextChanged            → «الإجمالي» = ROUND(price × quant, 2)
 *   Add2Dgv                         → «يجب إدخال الكمية  » · وإضافةٌ في الشبكة أصلاً
 *                                     تُجمَع كمّيتها على صفّها (`Quantity += quant`)
 *   insert into BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted)
 */
describe('المرسى — frmAdditions · 🎁 الإضافات من frmBookingM', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const asViewer = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: viewer.token, body });
  const asStranger = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: stranger.token, body });

  let branchId = '';
  let partyId = '';
  let vesselId = '';
  let groupId = '';
  let bookingId = '';
  let lifeJacketId = '';
  let fuelId = '';
  const day = '2026-09-01';

  beforeAll(async () => {
    ctx = await createTestApp('marina-additions');
    actor = await createActor(ctx, {
      tenantCode: 'marina-add',
      email: 'owner@marina-add.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'marina.view', 'marina.manage', 'parties.manage'],
    });
    // 👁️ A second person in the same tenant: the window may be read, not written.
    viewer = await createActor(ctx, {
      tenantCode: 'marina-add',
      email: 'viewer@marina-add.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'marina.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'marina-add-2',
      email: 'owner@marina-add-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'marina.view', 'marina.manage'],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'المرسى' });
    branchId = data(branch.body).id as string;
    const party = await post('/parties', { kind: 'customer', name: 'عميل المرسى', phone: '0551234567' });
    partyId = data(party.body).id as string;
    const group = await post('/marina/groups', { name: 'قوارب سريعة', code: 'FAST' });
    groupId = data(group.body).id as string;
    const vessel = await post('/marina/vessels', { groupId, code: 'V-1', name: 'الأمل', capacity: 6 });
    vesselId = data(vessel.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('🔢 الرقم — بطاقةٌ جديدة تُظهر الرقم التالي، ويكبر مع كل إضافة', async () => {
    const empty = await get('/marina/additions/next');
    expect(empty.status).toBe(200);
    expect(data(empty.body)).toMatchObject({ number: 1 });
    expect(rowsOf((await get('/marina/additions')).body)).toEqual([]);

    const created = await post('/marina/additions', { name: 'سترة نجاة', salePrice: '25' });
    expect(created.status).toBe(201);
    const card = data(created.body);
    lifeJacketId = card.id as string;
    expect(card).toMatchObject({ number: 1, name: 'سترة نجاة', salePrice: '25.0000', currency: 'SAR', usageCount: 0, version: 1 });

    const next = await get('/marina/additions/next');
    expect(data(next.body)).toMatchObject({ number: 2 });

    const second = await post('/marina/additions', { name: 'وقود', salePrice: '50' });
    expect(second.status).toBe(201);
    fuelId = data(second.body).id as string;
    expect(data(second.body)).toMatchObject({ number: 2, name: 'وقود', salePrice: '50.0000' });

    // «📋 إدارة الإضافات» — `select * from Additions where IsDeleted=0 ORDER BY id`.
    expect(rowsOf((await get('/marina/additions')).body).map((row) => row.number)).toEqual([1, 2]);
  });

  it('الرفوض — «يجب إدخال اسم الإضافة ⚠️»، وقيمةٌ فارغةٌ صفر، و«الإضافة غير موجودة»', async () => {
    const noName = await post('/marina/additions', { salePrice: '10' });
    expect(noName.status).toBe(422);
    expect(noName.body).toMatchObject({ code: 'MARINA_ADDITION_NAME_REQUIRED', detail: 'يجب إدخال اسم الإضافة ⚠️' });

    const blankName = await post('/marina/additions', { name: '   ', salePrice: '10' });
    expect(blankName.status).toBe(422);
    expect(blankName.body).toMatchObject({ code: 'MARINA_ADDITION_NAME_REQUIRED' });

    // 💰 القيمة — «إذا كان الصندوق فارغاً فهو صفر» (`txtSalePrice.Text = "0"`).
    const free = await post('/marina/additions', { name: 'ماء' });
    expect(free.status).toBe(201);
    expect(data(free.body)).toMatchObject({ number: 3, salePrice: '0.0000' });
    await del(`/marina/additions/${data(free.body).id as string}`);

    const missing = await patch('/marina/additions/00000000-0000-0000-0000-000000000000', { name: 'لا وجود' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'MARINA_ADDITION_NOT_FOUND', detail: 'الإضافة غير موجودة' });
  });

  it('✏️ تعديل — «✅ تم حفظ التعديلات بنجاح»، ونسخةٌ قديمة تُرفض', async () => {
    const before = data((await get('/marina/additions')).body[0] as unknown as Record<string, unknown>);
    const edited = await patch(`/marina/additions/${lifeJacketId}`, { version: 1, name: 'سترة نجاة (كبيرة)', salePrice: '30' });
    expect(edited.status).toBe(200);
    expect(data(edited.body)).toMatchObject({ number: 1, name: 'سترة نجاة (كبيرة)', salePrice: '30.0000', version: 2 });
    expect(typeof before).toBe('object');

    const stale = await patch(`/marina/additions/${lifeJacketId}`, { version: 1, name: 'قديم' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const noName = await patch(`/marina/additions/${lifeJacketId}`, { name: '' });
    expect(noName.status).toBe(422);
    expect(noName.body).toMatchObject({ code: 'MARINA_ADDITION_NAME_REQUIRED' });
    expect(data((await get('/marina/additions')).body[0] as unknown as Record<string, unknown>).name).toBe('سترة نجاة (كبيرة)');
  });

  it('🎁 الإضافات — الاسم والسعر من التعريف، و«الإجمالي» = الكمية × السعر', async () => {
    const created = await post('/marina/bookings', {
      branchId,
      partyId,
      vesselId,
      documentDate: day,
      startsAt: `${day}T08:00:00.000Z`,
      endsAt: `${day}T10:00:00.000Z`,
      periodHours: 2,
      rentalAmount: '400',
    });
    expect(created.status).toBe(201);
    bookingId = data(created.body).id as string;

    // «➕» على «🎁 الإضافات» — لا اسم يُكتب ولا سعر: كلاهما من `Additions`.
    const line = await post(`/marina/bookings/${bookingId}/additions`, { additionId: lifeJacketId, quantity: '2' });
    expect(line.status).toBe(201);
    expect(data(line.body)).toMatchObject({
      // 📝 الاسم من `Additions.name` (`GetAdditionsName`) و💰 القيمة من `SalePrice`.
      description: 'سترة نجاة (كبيرة)',
      additionId: lifeJacketId,
      quantity: '2.0000',
      unitPrice: '30.0000',
      // «الإجمالي» — `Math.Round(price * quant, 2)`.
      amount: '60.0000',
    });

    // `Add2Dgv` — الإضافة في الشبكة أصلاً: كمّيتها تُجمَع (`Quantity += quant`).
    const again = await post(`/marina/bookings/${bookingId}/additions`, { additionId: lifeJacketId, quantity: '1' });
    expect(again.status).toBe(201);
    expect(data(again.body)).toMatchObject({ quantity: '3.0000', unitPrice: '30.0000', amount: '90.0000' });

    const booking = data((await get(`/marina/bookings/${bookingId}`)).body);
    expect(booking.additions).toHaveLength(1);
    expect(booking).toMatchObject({ additionsTotal: '90.0000' });
  });

  it('الرفوض في الحجز — «يجب إدخال الكمية  » · «الإضافة غير موجودة» · 🧾 الاستخدام', async () => {
    const noQuantity = await post(`/marina/bookings/${bookingId}/additions`, { additionId: fuelId, quantity: '0' });
    expect(noQuantity.status).toBe(422);
    expect(noQuantity.body).toMatchObject({ code: 'MARINA_ADDITION_QUANTITY_REQUIRED', detail: 'يجب إدخال الكمية  ' });

    const unknown = await post(`/marina/bookings/${bookingId}/additions`, {
      additionId: '00000000-0000-0000-0000-000000000000',
      quantity: '1',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'MARINA_ADDITION_NOT_FOUND', detail: 'الإضافة غير موجودة' });

    // 🧾 الاستخدام — كم حجزاً يستعمل الإضافة؛ الديسكتوب لا يعرضه ويحذف تعريفه حذفاً قاطعاً.
    const rows = rowsOf((await get('/marina/additions')).body);
    expect(rows.find((row) => row.id === lifeJacketId)).toMatchObject({ usageCount: 1 });
    expect(rows.find((row) => row.id === fuelId)).toMatchObject({ usageCount: 0 });

    // «🎁 الإضافات» تُقرأ من تعريفها عند إنشاء الحجز كذلك.
    const bulk = await post('/marina/bookings', {
      branchId,
      partyId,
      vesselId,
      documentDate: day,
      startsAt: `${day}T12:00:00.000Z`,
      endsAt: `${day}T14:00:00.000Z`,
      periodHours: 2,
      rentalAmount: '400',
      additions: [{ additionId: fuelId, quantity: '3' }],
    });
    expect(bulk.status).toBe(201);
    const bulkBooking = data(bulk.body);
    expect(bulkBooking.additions).toEqual([
      { id: expect.any(String), additionId: fuelId, description: 'وقود', quantity: '3.0000', unitPrice: '50.0000', amount: '150.0000' },
    ]);
    await del(`/marina/bookings/${bulkBooking.id as string}`);
  });

  it('🗑️ حذف — «يجب تحديد الإضافة المراد حذفها ⚠️»، ثم تختفي من «🎁 الإضافات»', async () => {
    const nothing = await del('/marina/additions/00000000-0000-0000-0000-000000000000');
    expect(nothing.status).toBe(404);
    expect(nothing.body).toMatchObject({ code: 'MARINA_ADDITION_DELETE_REQUIRED', detail: 'يجب تحديد الإضافة المراد حذفها ⚠️' });

    const removed = await del(`/marina/additions/${fuelId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: fuelId });

    // لم تعد تُقترح على «🎁 الإضافات».
    expect(rowsOf((await get('/marina/additions')).body).map((row) => row.id)).toEqual([lifeJacketId]);
    // والصفّ الذي كُتب منها على الحجز يبقى باسمه وسعره وإجماليه.
    const booking = data((await get(`/marina/bookings/${bookingId}`)).body);
    expect(booking.additions).toHaveLength(1);
    expect(booking.additions).toEqual([
      { id: expect.any(String), additionId: lifeJacketId, description: 'سترة نجاة (كبيرة)', quantity: '3.0000', unitPrice: '30.0000', amount: '90.0000' },
    ]);

    const twice = await del(`/marina/additions/${fuelId}`);
    expect(twice.status).toBe(404);
    expect(twice.body).toMatchObject({ code: 'MARINA_ADDITION_DELETE_REQUIRED' });
  });

  it('الصلاحيات — «📋 إدارة الإضافات» تُقرأ بـ marina.view وتُكتب بـ marina.manage', async () => {
    expect((await asViewer('get', '/marina/additions')).status).toBe(200);
    expect((await asViewer('get', '/marina/additions/next')).status).toBe(200);

    expect((await asViewer('post', '/marina/additions', { name: 'بلا صلاحية' })).status).toBe(403);
    expect((await asViewer('patch', `/marina/additions/${lifeJacketId}`, { salePrice: '99' })).status).toBe(403);
    expect((await asViewer('delete', `/marina/additions/${lifeJacketId}`)).status).toBe(403);
  });

  it('عزل المستأجرين — إضافات هذا المرسى ليست عند جاره', async () => {
    expect(rowsOf((await asStranger('get', '/marina/additions')).body)).toEqual([]);
    expect((await asStranger('patch', `/marina/additions/${lifeJacketId}`, { salePrice: '1' })).status).toBe(404);
    expect((await asStranger('delete', `/marina/additions/${lifeJacketId}`)).status).toBe(404);

    // وجارٌ يبني إضافته الخاصة: أرقامه تبدأ من واحد، لا من حيث انتهى جاره.
    const neighbour = await api(ctx.server, 'post', '/api/v1/marina/additions', { token: stranger.token, body: { name: 'إضافة الجار' } });
    expect(neighbour.status).toBe(201);
    expect(data(neighbour.body)).toMatchObject({ number: 1, name: 'إضافة الجار' });
    expect(rowsOf((await get('/marina/additions')).body).map((row) => row.name)).toEqual(['سترة نجاة (كبيرة)']);
  });
});
