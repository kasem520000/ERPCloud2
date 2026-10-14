import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part six — ⛵ المرسى: الحجوزات والمخالفات.
 *
 * `Form_WPF/frmBookingM.xaml` («الحجوزات») is two tabs: «📋 بيانات الحجوزات» — 🔢 الرقم ·
 * 📅 التاريخ · 📋 الفئة · 🔖 حالة الحجز (مؤكد/غير مؤكد) · 🚢 نوع الحجز (حجز عادي/بحر
 * مفتوح) · 🕐 وقت الحجز · 📅 تاريخ الحجز · 👤 العميل · ⚓ المركب · 💰 القيمة · ⏱️ المدة
 * ساعة/دقيقة · 🎁 الإضافات (الكمية · السعر · الإجمالي) — و«🔍 البحث» برقم الحجز أو
 * بالتاريخين أو بالعميل. والمجاميع يُحسبها `CalcuAll`:
 *
 *   إجمالي الإضافات = Σ(العدد × السعر) · الإجمالي = الإضافات + القيمة ·
 *   ضريبة = ROUND(الإجمالي × MainVAT ÷ 100, 2) · الصافي = الإجمالي + الضريبة
 *
 * ورفضها الأول قبل أي صفٍّ: «يجب تحديد مدة الحجز».
 *
 * `Form_WPF/frmViolationM.xaml` («المخالفات») — 🔢 الرقم · 📅 التاريخ · ⛵ المركب ·
 * ⚠️ نوع المخالفة · ⏱️ مدة المخالفة (يوم) · 📝 ملاحظة — ورفوضها بترتيبها:
 * «يجب اختيار المركب» · «يجب تحديد مدة المخالفة» · «يجب تحديد نوع المخالفة» ·
 * «اختر المخالفة ليتم حذفها».
 */
describe('المرسى — frmBookingM · frmViolationM · frmInvoiceRentSrch', () => {
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
  let violationId = '';
  const day = '2026-08-01';

  beforeAll(async () => {
    ctx = await createTestApp('marina-documents');
    actor = await createActor(ctx, {
      tenantCode: 'marina-docs',
      email: 'owner@marina-docs.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'marina.view',
        'marina.manage',
        'marina.invoice',
        'parties.view',
        'parties.manage',
        'sales.view',
        'sales.invoice.create',
      ],
    });
    // 👁️ A second person in the same tenant: the windows may be read, not written.
    viewer = await createActor(ctx, {
      tenantCode: 'marina-docs',
      email: 'viewer@marina-docs.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'marina.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'marina-docs-2',
      email: 'owner@marina-docs-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'marina.view', 'marina.manage', 'parties.manage'],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'المرسى' });
    branchId = data(branch.body).id as string;
    const party = await post('/parties', { kind: 'customer', name: 'عميل المرسى', phone: '0551234567' });
    partyId = data(party.body).id as string;

    const group = await post('/marina/groups', { name: 'قوارب سريعة', code: 'FAST' });
    groupId = data(group.body).id as string;
    await post(`/marina/groups/${groupId}/pricing`, { periodKind: 'hour', price: '200' });
    const vessel = await post('/marina/vessels', { groupId, code: 'V-1', name: 'الأمل', capacity: 6 });
    vesselId = data(vessel.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('📋 بيانات الحجوزات — الرقم والحالة والنوع والمدة، والمجاميع الأربعة', async () => {
    const created = await post('/marina/bookings', {
      branchId,
      partyId,
      vesselId,
      documentDate: day,
      startsAt: `${day}T08:00:00.000Z`,
      endsAt: `${day}T10:00:00.000Z`,
      periodHours: 2,
      periodMinutes: 30,
      rentalAmount: '400',
      insuranceAmount: '100',
      bookingType: 'بحر مفتوح',
      status: 'غير مؤكد',
      additions: [
        { description: 'سترة نجاة', quantity: '2', unitPrice: '25' },
        { description: 'وقود', quantity: '1', unitPrice: '50' },
      ],
    });
    expect(created.status).toBe(201);
    const booking = data(created.body);
    bookingId = booking.id as string;

    // 🔢 الرقم — `BK-000001`, the first حجز of this tenant.
    expect(booking.number).toBe('BK-000001');
    expect(booking).toMatchObject({
      customerName: 'عميل المرسى',
      vesselName: 'الأمل',
      documentDate: day,
      // 🚢 نوع الحجز و🔖 حالة الحجز يُحفظان بنصّهما كما في `frmBookingM`.
      bookingType: 'بحر مفتوح',
      status: 'غير مؤكد',
      statusText: 'غير مؤكد',
      periodHours: 2,
      periodMinutes: 30,
      // ⏱️ المدة — `RentPeriod` = الساعة + الدقيقة ÷ 60.
      rentalPeriod: 2.5,
    });
    // 🎁 الإضافات — العدد × السعر = الإجمالي.
    expect(booking.additions).toEqual([
      { id: expect.any(String), additionId: null, description: 'سترة نجاة', quantity: '2.0000', unitPrice: '25.0000', amount: '50.0000' },
      { id: expect.any(String), additionId: null, description: 'وقود', quantity: '1.0000', unitPrice: '50.0000', amount: '50.0000' },
    ]);
    // `CalcuAll` — 400 + 100 إضافات + 100 تأمين = 600، و15% = 90، والصافي 690.
    expect(booking).toMatchObject({ additionsTotal: '100.0000', total: '600.0000', taxAmount: '90.0000', netAmount: '690.0000', vatRate: 15 });
  });

  it('الرفوض — «يجب تحديد مدة الحجز»، وحالةٌ أو نوعٌ مجهول', async () => {
    const noPeriod = await post('/marina/bookings', {
      branchId,
      partyId,
      vesselId,
      // Two timestamps an hour apart would do; both boxes standing at zero does not.
      startsAt: `${day}T08:00:00.000Z`,
      endsAt: `${day}T08:00:00.000Z`,
      periodHours: 0,
      periodMinutes: 0,
    });
    expect(noPeriod.status).toBe(422);
    expect(noPeriod.body).toMatchObject({ code: 'MARINA_BOOKING_PERIOD_REQUIRED', detail: 'يجب تحديد مدة الحجز' });

    const badType = await post('/marina/bookings', {
      branchId, partyId, vesselId,
      startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`,
      bookingType: 'رحلة صيد',
    });
    expect(badType.status).toBe(422);
    expect(badType.body).toMatchObject({ code: 'MARINA_BOOKING_TYPE_UNKNOWN', detail: 'نوع الحجز غير معروف' });

    const missing = await get('/marina/bookings/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'MARINA_BOOKING_NOT_FOUND' });
  });

  it('🎁 الإضافات — «✔» يضيف صفاً و«🗑️ حذف» يمحوه', async () => {
    const added = await post(`/marina/bookings/${bookingId}/additions`, { description: 'كابتن', quantity: '1', unitPrice: '120' });
    expect(added.status).toBe(201);
    expect(data(added.body)).toMatchObject({ description: 'كابتن', quantity: '1.0000', unitPrice: '120.0000', amount: '120.0000' });
    const additionId = data(added.body).id as string;

    // The الإجمالي of the حجز grows with it: 100 + 120 = 220 إضافات.
    const withAddition = await get(`/marina/bookings/${bookingId}`);
    expect(data(withAddition.body)).toMatchObject({ additionsTotal: '220.0000', total: '720.0000', taxAmount: '108.0000', netAmount: '828.0000' });

    const removed = await del(`/marina/bookings/${bookingId}/additions/${additionId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: additionId });
    expect(data((await get(`/marina/bookings/${bookingId}`)).body)).toMatchObject({ additionsTotal: '100.0000' });
  });

  it('✏️ تعديل — الحجز وإضافاته معاً، ونسخةٌ قديمة تُرفض', async () => {
    const current = data((await get(`/marina/bookings/${bookingId}`)).body);

    const stale = await patch(`/marina/bookings/${bookingId}`, { version: (current.version as number) + 7, rentalAmount: '999' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await patch(`/marina/bookings/${bookingId}`, {
      version: current.version as number,
      status: 'مؤكد',
      periodHours: 3,
      periodMinutes: 0,
      rentalAmount: '500',
      // `delete BookingAddition where bookId=…` then these — never a diff.
      additions: [{ description: 'رسو', quantity: '1', unitPrice: '80' }],
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({
      status: 'مؤكد',
      statusText: 'مؤكد',
      rentalPeriod: 3,
      additionsTotal: '80.0000',
      total: '680.0000',
      netAmount: '782.0000',
      version: (current.version as number) + 1,
    });
    expect(data(updated.body).additions).toHaveLength(1);
  });

  it('🔍 البحث — بالرقم وبالعميل وبالتاريخين، و«📋 نتائج البحث»', async () => {
    const byNumber = rowsOf((await get('/marina/bookings?number=BK-000001')).body);
    expect(byNumber.map((row) => row.id as string)).toEqual([bookingId]);

    const byCustomer = rowsOf((await get(`/marina/bookings?customer=${encodeURIComponent('عميل المرسى')}`)).body);
    expect(byCustomer.map((row) => row.id as string)).toEqual([bookingId]);

    const byPhone = rowsOf((await get('/marina/bookings?customer=0551234567')).body);
    expect(byPhone.map((row) => row.id as string)).toEqual([bookingId]);

    const inRange = rowsOf((await get(`/marina/bookings?from=${day}&to=${day}`)).body);
    expect(inRange.map((row) => row.id as string)).toEqual([bookingId]);
    // A day on which nothing was booked is empty, not everything.
    const outside = rowsOf((await get('/marina/bookings?from=2020-01-01&to=2020-01-02')).body);
    expect(outside).toEqual([]);
  });

  it('⚠️ المخالفات — النوع والمدة والرقم، وثلاثة رفوض بترتيبها', async () => {
    const noVessel = await post('/marina/violations', { violationDate: day, violationType: 'تأخير', periodDays: '2', description: 'تأخر عن الرصيف' });
    expect(noVessel.status).toBe(422);
    expect(noVessel.body).toMatchObject({ code: 'MARINA_VESSEL_REQUIRED', detail: 'يجب اختيار المركب' });

    const noPeriod = await post('/marina/violations', { violationDate: day, vesselId, violationType: 'تأخير' });
    expect(noPeriod.status).toBe(422);
    expect(noPeriod.body).toMatchObject({ code: 'MARINA_VIOLATION_PERIOD_REQUIRED', detail: 'يجب تحديد مدة المخالفة' });

    const noType = await post('/marina/violations', { violationDate: day, vesselId, periodDays: '2' });
    expect(noType.status).toBe(422);
    expect(noType.body).toMatchObject({ code: 'MARINA_VIOLATION_TYPE_REQUIRED', detail: 'يجب تحديد نوع المخالفة' });

    const created = await post('/marina/violations', {
      violationDate: day,
      vesselId,
      partyId,
      violationType: 'تأخير',
      periodDays: '2',
      description: 'تأخر عن الرصيف',
    });
    expect(created.status).toBe(201);
    const violation = data(created.body);
    violationId = violation.id as string;
    // 🔢 الرقم — `MAX(id) + 1` there, `VI-000001` here; ⚙️ الحالة «مفتوحة» on insert.
    expect(violation).toMatchObject({
      number: 'VI-000001',
      vesselName: 'الأمل',
      customerName: 'عميل المرسى',
      violationType: 'تأخير',
      periodDays: '2.0000',
      description: 'تأخر عن الرصيف',
      status: 'open',
      statusText: 'مفتوحة',
    });

    const list = rowsOf((await get('/marina/violations')).body);
    expect(list.map((row) => row.id as string)).toEqual([violationId]);
    const byType = rowsOf((await get(`/marina/violations?type=${encodeURIComponent('تأخير')}`)).body);
    expect(byType).toHaveLength(1);
    const other = rowsOf((await get('/marina/violations?type=شيء-آخر')).body);
    expect(other).toEqual([]);
  });

  it('✏️ تعديل المخالفة و🗑️ حذفها — و«اختر المخالفة ليتم حذفها»', async () => {
    const current = data(await get(`/marina/violations/${violationId}`));

    const updated = await patch(`/marina/violations/${violationId}`, {
      version: current.version as number,
      periodDays: '5',
      status: 'closed',
      description: 'تأخر يومين إضافيين',
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({ periodDays: '5.0000', status: 'closed', statusText: 'مغلقة' });

    const stale = await patch(`/marina/violations/${violationId}`, { version: 99, periodDays: '1' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const removed = await del(`/marina/violations/${violationId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: violationId });

    const gone = await get(`/marina/violations/${violationId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'MARINA_VIOLATION_NOT_FOUND', detail: 'اختر المخالفة ليتم حذفها' });
    expect(rowsOf((await get('/marina/violations')).body)).toEqual([]);
  });

  it('🧾 فاتورة التأجير — القيمة والإضافات والضريبة والصافي، ثم «🔍 خيارات البحث»', async () => {
    const invoice = await post(`/marina/bookings/${bookingId}/rental-invoice`, {});
    expect(invoice.status).toBe(201);
    const rental = data(invoice.body);
    // 💰 القيمة (`tot_Rent`) · الإضافات · التأمين · الإجمالي · ضريبة 15% · الصافي.
    expect(rental).toMatchObject({
      periodAmount: '500.0000',
      additionsAmount: '80.0000',
      insuranceAmount: '100.0000',
      total: '680.0000',
      taxAmount: '102.0000',
      netAmount: '782.0000',
      documentDate: day,
    });

    // `frmInvoiceRentSrch` — «🧾 قائمة الفواتير»: الرقم · التاريخ · العميل · الصافي · الجوال.
    const all = rowsOf((await get('/marina/rental-invoices')).body);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ number: 'BK-000001', customerName: 'عميل المرسى', customerPhone: '0551234567', netAmount: '782.0000' });

    const byNet = rowsOf((await get('/marina/rental-invoices?minNet=700&maxNet=800')).body);
    expect(byNet).toHaveLength(1);
    const tooRich = rowsOf((await get('/marina/rental-invoices?minNet=900')).body);
    expect(tooRich).toEqual([]);
    const byCustomer = rowsOf((await get(`/marina/rental-invoices?customer=${encodeURIComponent('عميل المرسى')}`)).body);
    expect(byCustomer).toHaveLength(1);
    const byRange = rowsOf((await get(`/marina/rental-invoices?from=${day}&to=${day}`)).body);
    expect(byRange).toHaveLength(1);
  });

  it('🗑️ حذف الحجز — «تم الحذف»، ولا أثر له بعدها', async () => {
    const removed = await del(`/marina/bookings/${bookingId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: bookingId });

    const gone = await get(`/marina/bookings/${bookingId}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'MARINA_BOOKING_NOT_FOUND' });
    expect(rowsOf((await get('/marina/bookings')).body)).toEqual([]);
  });

  it('الصلاحيات — «الحجوزات» و«المخالفات» تُقرأ بـ marina.view وتُكتب بـ marina.manage', async () => {
    const readBookings = await asViewer('get', '/marina/bookings');
    expect(readBookings.status).toBe(200);
    const readViolations = await asViewer('get', '/marina/violations');
    expect(readViolations.status).toBe(200);

    const write = await asViewer('post', '/marina/bookings', {
      branchId, partyId, vesselId,
      startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`,
    });
    expect(write.status).toBe(403);
    const writeViolation = await asViewer('post', '/marina/violations', { violationDate: day, vesselId, violationType: 'تأخير', periodDays: '1' });
    expect(writeViolation.status).toBe(403);
  });

  it('عزل المستأجرين — حجزُ هذا المرسى ليس عند جاره، ولا مخالفته', async () => {
    const booking = await post('/marina/bookings', {
      branchId, partyId, vesselId,
      documentDate: day,
      startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`,
      rentalAmount: '200',
    });
    const id = data(booking.body).id as string;
    const ticket = await post('/marina/violations', { violationDate: day, vesselId, violationType: 'تأخير', periodDays: '1' });
    const ticketId = data(ticket.body).id as string;

    const read = await asStranger('get', `/marina/bookings/${id}`);
    expect(read.status).toBe(404);
    const update = await asStranger('patch', `/marina/bookings/${id}`, { rentalAmount: '1' });
    expect(update.status).toBe(404);
    const remove = await asStranger('delete', `/marina/bookings/${id}`);
    expect(remove.status).toBe(404);
    const readViolation = await asStranger('get', `/marina/violations/${ticketId}`);
    expect(readViolation.status).toBe(404);

    expect(rowsOf((await asStranger('get', '/marina/bookings')).body)).toEqual([]);
    expect(rowsOf((await asStranger('get', '/marina/violations')).body)).toEqual([]);

    await del(`/marina/bookings/${id}`);
  });
});
