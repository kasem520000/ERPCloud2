import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part seven — ⛵ المرسى: 📋 بطاقة الفئة و⏰ فترات التأجير.
 *
 * `Form_WPF/frmGroupM.xaml` («📋 بطاقة فئة») — 🖼️ صورة الفئة · 🔢 رقم الفئة · رمز الفئة ·
 * اسم الفئة (عربي) · اسم الفئة (EN) · قيمة الساعة · عرض الساعة (دقيقة) · قيمة النصف ساعة ·
 * عرض النصف ساعة (دقيقة) · «➕ إضافة مدة» · «📋 قائمة الفئات» (رقم الفئة · رمز الفئة · اسم
 * الفئة · قيمة الساعة · قيمة النصف ساعة) · ⏮ ◀ ▶ ⏭ · 🗑️ حذف · 💾 حفظ.
 *
 * What «💾 حفظ» writes (`frmGroupM.xaml.cs`):
 *
 *   insert into GroupMarine(id, code, name, nameEN, HourPrice, HalfHPrice,
 *     OfferHour, OfferHalf, IsDeleted, image) …
 *   delete from RentPeriodSub where MGroupID=…
 *   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- 2 · ساعة
 *   insert into RentPeriodSub(MGroupID, code, periodID, rent, offer) …   -- 1 · نصف ساعة
 *
 * and `Form_WPF/frmAddPeriod.xaml` («⏰ إدارة فترات التأجير») is the rest of the durations:
 * «⏰ المدة · 💵 السعر · 🎁 العرض · 🗑️ حذف», saved as `delete` then every row again.
 *
 * Refusals, in the windows' own words: «ادخل الفئة» · «الفئة تم ادخالها مسبقا» ·
 * «اختر الفئة ليتم حذفها» · «هذه الفئة لها ارتباطات فرعية لايمكن حذفها» ·
 * «يجب إستكمال البيانات ⚠️».
 */
describe('المرسى — frmGroupM · frmAddPeriod', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const put = (path: string, body: Record<string, unknown>) => api(ctx.server, 'put', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const asViewer = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: viewer.token, body });
  const asStranger = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: stranger.token, body });

  let groupId = '';
  let secondGroupId = '';

  beforeAll(async () => {
    ctx = await createTestApp('marina-groups');
    actor = await createActor(ctx, {
      tenantCode: 'marina-groups',
      email: 'owner@marina-groups.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'marina.view', 'marina.manage'],
    });
    // 👁️ A second person in the same tenant: the windows may be read, not written.
    viewer = await createActor(ctx, {
      tenantCode: 'marina-groups',
      email: 'viewer@marina-groups.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'marina.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'marina-groups-2',
      email: 'owner@marina-groups-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'marina.view', 'marina.manage'],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('⏰ المدة — عشر مددٍ من `RentPeriod`، من نصف ساعة إلى خمس ساعات', async () => {
    const response = await get('/marina/rent-periods');
    expect(response.status).toBe(200);
    const periods = rowsOf(response.body);
    expect(periods).toHaveLength(10);
    expect(periods[0]).toMatchObject({ id: 1, name: 'نصف ساعة', minutes: 30 });
    expect(periods[1]).toMatchObject({ id: 2, name: 'ساعة', minutes: 60 });
    expect(periods[9]).toMatchObject({ id: 10, name: 'خمس ساعات', minutes: 300 });
  });

  it('📋 بطاقة فئة — الرقم والرمز والاسمين والقيمتين والعرضين والصورة، والفترتان', async () => {
    const created = await post('/marina/groups', {
      code: 'STD',
      name: 'قوارب قياسية',
      nameEn: 'Standard boats',
      hourPrice: '200',
      hourOfferMinutes: 10,
      halfHourPrice: '120',
      halfHourOfferMinutes: 5,
      imageUrl: 'https://example.test/group.png',
    });
    expect(created.status).toBe(201);
    const card = data(created.body);
    groupId = card.id as string;

    expect(card).toMatchObject({
      code: 'STD',
      name: 'قوارب قياسية',
      nameEn: 'Standard boats',
      hourPrice: '200.0000',
      hourOfferMinutes: 10,
      halfHourPrice: '120.0000',
      halfHourOfferMinutes: 5,
      imageUrl: 'https://example.test/group.png',
      vesselCount: 0,
      // 🔢 الرقم — `LoadNextNo` عند الديسكتوب هو عدد الفئات + 1.
      number: 1,
    });

    // `frmGroupM` يكتب ساعة ونصف ساعة من صندوقي البطاقة.
    const periods = card.periods as Array<Record<string, unknown>>;
    expect(periods).toHaveLength(2);
    expect(periods.find((row) => row.periodId === 2)).toMatchObject({ periodName: 'ساعة', minutes: 60, price: '200.0000', offerMinutes: 10 });
    expect(periods.find((row) => row.periodId === 1)).toMatchObject({ periodName: 'نصف ساعة', minutes: 30, price: '120.0000', offerMinutes: 5 });

    const read = await get(`/marina/groups/${groupId}`);
    expect(read.status).toBe(200);
    expect(data(read.body)).toMatchObject({ code: 'STD', periods: expect.any(Array) });
  });

  it('الرفوض — «ادخل الفئة» · «الفئة تم ادخالها مسبقا» · رابط الصورة · «الفئة غير موجودة»', async () => {
    const noCode = await post('/marina/groups', { name: 'بلا رمز' });
    expect(noCode.status).toBe(422);
    expect(noCode.body).toMatchObject({ code: 'MARINA_GROUP_CODE_REQUIRED', detail: 'ادخل الفئة' });

    const duplicate = await post('/marina/groups', { code: 'STD', name: 'نفس الرمز' });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body).toMatchObject({ code: 'MARINA_GROUP_DUPLICATE', detail: 'الفئة تم ادخالها مسبقا' });

    const badImage = await post('/marina/groups', { code: 'IMG', name: 'صورة مكسورة', imageUrl: 'not-a-link' });
    expect(badImage.status).toBe(422);
    expect(badImage.body).toMatchObject({ code: 'MARINA_GROUP_IMAGE_INVALID', detail: 'رابط صورة الفئة غير صحيح' });

    const missing = await get('/marina/groups/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'MARINA_GROUP_NOT_FOUND', detail: 'الفئة غير موجودة' });
  });

  it('✏️ تعديل — البطاقة وفترتَيها معاً، ونسخةٌ قديمة تُرفض', async () => {
    const before = data((await get(`/marina/groups/${groupId}`)).body);
    const edited = await patch(`/marina/groups/${groupId}`, {
      version: before.version as number,
      name: 'قوارب قياسية (معدّلة)',
      hourPrice: '250',
      halfHourPrice: '150',
      hourOfferMinutes: 15,
    });
    expect(edited.status).toBe(200);
    const card = data(edited.body);
    expect(card).toMatchObject({ name: 'قوارب قياسية (معدّلة)', hourPrice: '250.0000', halfHourPrice: '150.0000', hourOfferMinutes: 15 });
    // ⏰ تتبع الفترة البطاقة: `delete` ثم `insert` كما يفعل `frmGroupM`.
    const hour = (card.periods as Array<Record<string, unknown>>).find((row) => row.periodId === 2);
    expect(hour).toMatchObject({ price: '250.0000', offerMinutes: 15 });
    // 🖼️ الصورة لم تُمسَّ لأنها لم تُرسَل.
    expect(card.imageUrl).toBe('https://example.test/group.png');
    expect(card.version as number).toBeGreaterThan(before.version as number);

    const stale = await patch(`/marina/groups/${groupId}`, { version: before.version as number, name: 'قديم' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('⏰ فترات التأجير — «➕ إضافة مدة»، ثم «يجب إستكمال البيانات ⚠️»', async () => {
    const replaced = await put(`/marina/groups/${groupId}/periods`, {
      periods: [
        { periodId: 1, price: '150', offerMinutes: 5 },
        { periodId: 2, price: '250', offerMinutes: 15 },
        { periodId: 4, price: '450', offerMinutes: 30 },
        { periodId: 6, price: '600', offerMinutes: 45 },
      ],
    });
    expect(replaced.status).toBe(200);
    const rows = data(replaced.body).periods as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.periodId === 4)).toMatchObject({ periodName: 'ساعتين', minutes: 120, price: '450.0000', offerMinutes: 30 });
    expect(rows.find((row) => row.periodId === 6)).toMatchObject({ periodName: 'ثلاث ساعات', minutes: 180, price: '600.0000', offerMinutes: 45 });

    // 💵 سعرٌ بصفر أو مدةٌ مجهولة — «يجب إستكمال البيانات ⚠️»، ولا صفَّ يُمحى.
    const incomplete = await put(`/marina/groups/${groupId}/periods`, { periods: [{ periodId: 2, price: '0' }] });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body).toMatchObject({ code: 'MARINA_PERIOD_INCOMPLETE', detail: 'يجب إستكمال البيانات ⚠️' });
    const unknown = await put(`/marina/groups/${groupId}/periods`, { periods: [{ periodId: 99, price: '10' }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: 'MARINA_PERIOD_INCOMPLETE' });
    const survivors = data((await get(`/marina/groups/${groupId}`)).body).periods as Array<Record<string, unknown>>;
    expect(survivors).toHaveLength(4);

    const noGroup = await put('/marina/groups/00000000-0000-0000-0000-000000000000/periods', { periods: [{ periodId: 2, price: '10' }] });
    expect(noGroup.status).toBe(404);
    expect(noGroup.body).toMatchObject({ code: 'MARINA_GROUP_NOT_FOUND' });
  });

  it('⏮ ◀ ▶ ⏭ — المشي في «📋 قائمة الفئات»، والوقوف عند الطرفين', async () => {
    const second = await post('/marina/groups', { code: 'VIP', name: 'قوارب فاخرة', hourPrice: '400', halfHourPrice: '240' });
    expect(second.status).toBe(201);
    secondGroupId = data(second.body).id as string;

    const cards = rowsOf((await get('/marina/groups')).body);
    expect(cards).toHaveLength(2);
    // «📋 قائمة الفئات» تمشي بترتيب 🔢 الرقم، كما تمشي الأسهم.
    expect(cards.map((row) => row.number)).toEqual([1, 2]);

    const first = data((await get('/marina/groups/navigate?dir=first')).body);
    expect(first.id).toBe(groupId);
    const last = data((await get('/marina/groups/navigate?dir=last')).body);
    expect(last.id).toBe(secondGroupId);
    const next = data((await get(`/marina/groups/navigate?dir=next&currentId=${groupId}`)).body);
    expect(next.id).toBe(secondGroupId);
    const previous = data((await get(`/marina/groups/navigate?dir=previous&currentId=${secondGroupId}`)).body);
    expect(previous.id).toBe(groupId);
    // `if (!reader.HasRows) return;` — عند الطرف يبقى مكانه.
    const stuck = data((await get(`/marina/groups/navigate?dir=next&currentId=${secondGroupId}`)).body);
    expect(stuck.id).toBe(secondGroupId);
  });

  it('🗑️ حذف — «هذه الفئة لها ارتباطات فرعية لايمكن حذفها»، ثم «اختر الفئة ليتم حذفها»', async () => {
    const vessel = await post('/marina/vessels', { groupId, code: 'V-1', name: 'الأمل', capacity: 6 });
    expect(vessel.status).toBe(201);
    const vesselId = data(vessel.body).id as string;
    expect(data((await get(`/marina/groups/${groupId}`)).body).vesselCount).toBe(1);

    const inUse = await del(`/marina/groups/${groupId}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: 'MARINA_GROUP_IN_USE', detail: 'هذه الفئة لها ارتباطات فرعية لايمكن حذفها' });

    // ⚓ يُتقاعد المركب، فتستطيع الفئة أن تتبعه.
    const retired = await del(`/marina/vessels/${vesselId}`);
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ deleted: true, id: vesselId });
    expect(data((await get(`/marina/groups/${groupId}`)).body).vesselCount).toBe(0);

    const nothing = await del('/marina/groups/00000000-0000-0000-0000-000000000000');
    expect(nothing.status).toBe(404);
    expect(nothing.body).toMatchObject({ code: 'MARINA_GROUP_DELETE_REQUIRED', detail: 'اختر الفئة ليتم حذفها' });

    const removed = await del(`/marina/groups/${groupId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deleted: true, id: groupId });
    const gone = await get(`/marina/groups/${groupId}`);
    expect(gone.status).toBe(404);
    groupId = '';
  });

  it('الصلاحيات — «📋 قائمة الفئات» تُقرأ بـ marina.view وتُكتب بـ marina.manage', async () => {
    const readCards = await asViewer('get', '/marina/groups');
    expect(readCards.status).toBe(200);
    const readPeriods = await asViewer('get', '/marina/rent-periods');
    expect(readPeriods.status).toBe(200);
    const readOne = await asViewer('get', `/marina/groups/${secondGroupId}`);
    expect(readOne.status).toBe(200);
    const walk = await asViewer('get', '/marina/groups/navigate?dir=first');
    expect(walk.status).toBe(200);

    const write = await asViewer('post', '/marina/groups', { code: 'NOPE', name: 'فئة جديدة' });
    expect(write.status).toBe(403);
    const edit = await asViewer('patch', `/marina/groups/${secondGroupId}`, { hourPrice: '10' });
    expect(edit.status).toBe(403);
    const remove = await asViewer('delete', `/marina/groups/${secondGroupId}`);
    expect(remove.status).toBe(403);
    const periods = await asViewer('put', `/marina/groups/${secondGroupId}/periods`, { periods: [{ periodId: 2, price: '10' }] });
    expect(periods.status).toBe(403);
  });

  it('عزل المستأجرين — فئة هذا المرسى ليست عند جاره', async () => {
    const read = await asStranger('get', `/marina/groups/${secondGroupId}`);
    expect(read.status).toBe(404);
    const edit = await asStranger('patch', `/marina/groups/${secondGroupId}`, { hourPrice: '1' });
    expect(edit.status).toBe(404);
    const remove = await asStranger('delete', `/marina/groups/${secondGroupId}`);
    expect(remove.status).toBe(404);
    const periods = await asStranger('put', `/marina/groups/${secondGroupId}/periods`, { periods: [{ periodId: 2, price: '10' }] });
    expect(periods.status).toBe(404);

    expect(rowsOf((await asStranger('get', '/marina/groups')).body)).toEqual([]);
  });
});
