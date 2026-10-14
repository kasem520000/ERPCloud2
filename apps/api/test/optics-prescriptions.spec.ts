import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part five — 👓 النظارات.
 *
 * `Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات») is one window with two tabs:
 *
 *   • «👓  القياسات» — two columns, «🔴 العين اليمنى (RE)» and «🟢 العين اليسرى (LE)»,
 *     five boxes each: `SPH · CYL · AX · ADD · IPD`. `bindClass` writes **two** rows —
 *     `orientation` "R" then "L" — into
 *     `Glasses(InvGlobalID, ItemId, orientation, SPH, CYL, AX, [ADD], IPD)`
 *     (`Class/InvoiceOper.cs` L1662), and `Class/Print.cs` L710 prints them back as
 *     `ReSPH … ReIPD` و`LeSPH … LeIPD`. Nothing parses them: every value is `VarChar`.
 *   • «⚙  أسماء الحقول» — «حقل 1» … «حقل 5» under «R (Right)» and «حقل 6» … «حقل 10»
 *     under «L (Left)». «💾 حفظ الأسماء» is `delete from Other_Column` then
 *     `insert into Other_Column (R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)` and «تم الحفظ بنجاح».
 *   • The tabs are not both open: from a فاتورة (`code = 1`) the window is القياسات
 *     alone with «🔄 جديد · ✔ إدراج · ✖ خروج»; from the definitions entry «⚙ أسماء
 *     الحقول» و«💾 حفظ الأسماء» appear too.
 *
 * The captions are not in the markup — `loadNameLbl` reads them as
 * `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD') from Other_Column`, which is why the
 * defaults in this suite are those ten strings, and why a tenant may rename any of them.
 */
describe('النظارات — frmGlasses · Other_Column · glassOtions', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const put = (path: string, body: Record<string, unknown>) => api(ctx.server, 'put', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const asViewer = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: viewer.token, body });
  const asStranger = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) =>
    api(ctx.server, method, `/api/v1${path}`, { token: stranger.token, body });

  let customerId = '';
  let otherCustomerId = '';
  let prescriptionId = '';

  beforeAll(async () => {
    ctx = await createTestApp('optics-prescriptions');
    actor = await createActor(ctx, {
      tenantCode: 'opt-glasses',
      email: 'owner@opt-glasses.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'optics.view', 'optics.manage', 'parties.manage'],
    });
    // 👁️ A second person in the same tenant: «👓 القياسات» may be read, not written.
    viewer = await createActor(ctx, {
      tenantCode: 'opt-glasses',
      email: 'viewer@opt-glasses.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'optics.view'],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'opt-glasses-2',
      email: 'owner@opt-glasses-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'optics.view', 'optics.manage', 'parties.manage'],
    });

    const provisioning = ctx.app.get(OrgProvisioningService);
    await provisioning.provisionOrgDefaults(actor.tenantId, { actorUserId: actor.userId });
    await provisioning.provisionOrgDefaults(stranger.tenantId, { actorUserId: stranger.userId });

    const customer = await post('/parties', { kind: 'customer', name: 'محمد علي', phone: '0551234567' });
    expect(customer.status).toBe(201);
    customerId = data(customer.body).id as string;

    const other = await post('/parties', { kind: 'customer', name: 'سالم أحمد', phone: '0557654321' });
    expect(other.status).toBe(201);
    otherCustomerId = data(other.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('⚙️ أسماء الحقول — عشرة صناديق بعناوينها الأصلية، وحقل 6 هو أول العين اليسرى', async () => {
    const labels = data((await get('/optics/field-labels')).body);
    // `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD')` — no row yet, so the defaults speak.
    expect(labels).toMatchObject({
      id: null,
      r1: 'RE-SPH',
      r2: 'RE-CYL',
      r3: 'RE-AX',
      r4: 'RE-ADD',
      r5: 'RE-IPD',
      l1: 'LE-SPH',
      l2: 'LE-CYL',
      l3: 'LE-AX',
      l4: 'LE-ADD',
      l5: 'LE-IPD',
      version: null,
    });
    expect(labels.right).toEqual([
      { key: 'sph', label: 'RE-SPH' },
      { key: 'cyl', label: 'RE-CYL' },
      { key: 'axis', label: 'RE-AX' },
      { key: 'add', label: 'RE-ADD' },
      { key: 'ipd', label: 'RE-IPD' },
    ]);
    expect(labels.left).toEqual([
      { key: 'sph', label: 'LE-SPH' },
      { key: 'cyl', label: 'LE-CYL' },
      { key: 'axis', label: 'LE-AX' },
      { key: 'add', label: 'LE-ADD' },
      { key: 'ipd', label: 'LE-IPD' },
    ]);
    // «حقل 1» … «حقل 10» — R1…R5 then L1…L5, the order `insertglasses` writes them in.
    expect((labels.fields as Array<Record<string, unknown>>).map((field) => field.placeholder)).toEqual([
      'حقل 1', 'حقل 2', 'حقل 3', 'حقل 4', 'حقل 5', 'حقل 6', 'حقل 7', 'حقل 8', 'حقل 9', 'حقل 10',
    ]);
    expect((labels.fields as Array<Record<string, unknown>>)[5]).toMatchObject({ slot: 'l1', side: 'L', key: 'sph' });
  });

  it('💾 حفظ الأسماء — الصفّ يُستبدل، والفارغ يُقرأ ببديله، والثانية تكتب فوق الأولى', async () => {
    const saved = await put('/optics/field-labels', {
      r1: 'SPH يمين',
      r2: 'CYL يمين',
      r3: 'AX يمين',
      r4: 'ADD يمين',
      r5: 'IPD يمين',
      l1: 'SPH يسار',
      l2: 'CYL يسار',
      // l3 is sent blank: the desktop would store «» and lose the caption; `isnull`
      // cannot tell «لم يُسمَّ» from «سُمّي بلا اسم», so the default answers.
      l3: '   ',
      l4: 'ADD يسار',
      l5: 'IPD يسار',
    });
    expect(saved.status).toBe(200);
    const labels = data(saved.body);
    expect(labels).toMatchObject({ r1: 'SPH يمين', l1: 'SPH يسار', l3: 'LE-AX' });
    expect(labels.id).toBeTruthy();

    // `delete from Other_Column` then insert — never two rows, never a left-over.
    const again = data((await put('/optics/field-labels', { r1: 'درجة اليمين' })).body);
    expect(again).toMatchObject({ r1: 'درجة اليمين' });
    expect(again.l1).toBe('LE-SPH');
    expect(again.id).not.toBe(labels.id);
  });

  it('👓 بيانات النظارات — عشر قيمٍ نصية: لا تُحلَّل، ولا تُرفض', async () => {
    const created = await post('/optics/prescriptions', {
      partyId: customerId,
      orientation: 'distance',
      rightEye: { sph: '-2.00', cyl: '-0.50', axis: '90', add: '+1.25', ipd: '62' },
      // «PL» (plano) is a legitimate value, and the desktop writes it as text.
      leftEye: { sph: 'PL', cyl: '-0.25', axis: '85', add: '+1.25', ipd: '62' },
      notes: 'وصفة الصيف',
    });
    expect(created.status).toBe(201);
    const prescription = data(created.body);
    prescriptionId = prescription.id as string;

    expect(prescription).toMatchObject({
      partyId: customerId,
      customerName: 'محمد علي',
      customerPhone: '0551234567',
      orientation: 'distance',
      rightEye: { sph: '-2.00', cyl: '-0.50', axis: '90', add: '+1.25', ipd: '62' },
      leftEye: { sph: 'PL', cyl: '-0.25', axis: '85', add: '+1.25', ipd: '62' },
      notes: 'وصفة الصيف',
      filledCount: 10,
    });

    const read = await get(`/optics/prescriptions/${prescriptionId}`);
    expect(read.status).toBe(200);
    expect(data(read.body)).toMatchObject({ id: prescriptionId, filledCount: 10 });
  });

  it('الرفوض — «الرجاء اختيار عميل» و«لم يتم العثور على عميل»', async () => {
    const noCustomer = await post('/optics/prescriptions', { rightEye: { sph: '-1.00' } });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body).toMatchObject({ code: 'OPTICS_CUSTOMER_REQUIRED', detail: 'الرجاء اختيار عميل' });

    const unknownCustomer = await post('/optics/prescriptions', {
      partyId: '00000000-0000-4000-8000-000000000000',
      rightEye: { sph: '-1.00' },
    });
    expect(unknownCustomer.status).toBe(404);
    expect(unknownCustomer.body).toMatchObject({ code: 'OPTICS_CUSTOMER_NOT_FOUND', detail: 'لم يتم العثور على عميل' });

    // A وصفة that is not there: 404, not 200 with nothing in it.
    const missing = await get('/optics/prescriptions/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'OPTICS_PRESCRIPTION_NOT_FOUND' });
  });

  it('✏️ تعديل — القيم تتغيّر، ونسخةٌ قديمة تُرفض', async () => {
    const current = data((await get(`/optics/prescriptions/${prescriptionId}`)).body);

    const stale = await patch(`/optics/prescriptions/${prescriptionId}`, {
      version: (current.version as number) + 5,
      rightEye: { sph: '-9.99' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const updated = await patch(`/optics/prescriptions/${prescriptionId}`, {
      version: current.version as number,
      rightEye: { sph: '-2.25', cyl: '-0.50', axis: '90', add: '+1.25', ipd: '62' },
      notes: 'وصفة الشتاء',
    });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({ notes: 'وصفة الشتاء', rightEye: { sph: '-2.25' }, version: (current.version as number) + 1 });

    // Patching the eye keeps the hand that was already written: `bindControls` reads R or L.
    expect(data(updated.body).leftEye).toMatchObject({ sph: 'PL', axis: '85' });
  });

  it('🔍 بحث — بجوال العميل أو باسمه، وصندوقٌ فارغ مرفوض', async () => {
    const empty = await get('/optics/prescriptions?search=%20%20');
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ code: 'OPTICS_SEARCH_REQUIRED', detail: 'الرجاء إدخال رقم الجوال أو اسم العميل' });

    const byPhone = await get('/optics/prescriptions?search=0551234567');
    expect(byPhone.status).toBe(200);
    const body = byPhone.body as { data: unknown[]; meta: { total: number; customer: { id: string; name: string } | null } };
    expect(body.meta.customer).toMatchObject({ id: customerId, name: 'محمد علي' });
    expect(body.data.map((row) => (row as { id: string }).id)).toEqual([prescriptionId]);

    const byName = await get('/optics/prescriptions?search=سالم');
    // سالم أحمد has no وصفة: the عميل is found, the grid is empty.
    const named = byName.body as { data: unknown[]; meta: { customer: { id: string } | null } };
    expect(named.meta.customer?.id).toBe(otherCustomerId);
    expect(named.data).toEqual([]);

    const nobody = await get('/optics/prescriptions?search=لا-أحد');
    expect(nobody.status).toBe(404);
    expect(nobody.body).toMatchObject({ code: 'OPTICS_CUSTOMER_NOT_FOUND', detail: 'لم يتم العثور على عميل' });
  });

  it('📋 القائمة — وصفات العميل وحدها بـ ?partyId=، والكل بلا مرشِّح', async () => {
    const second = await post('/optics/prescriptions', { partyId: otherCustomerId, rightEye: { sph: '+1.00' } });
    expect(second.status).toBe(201);

    const mine = await get(`/optics/prescriptions?partyId=${customerId}`);
    const mineRows = rowsOf(mine.body);
    expect(mineRows.map((row) => row.id as string)).toEqual([prescriptionId]);
    expect((mine.body as { meta: { total: number } }).meta.total).toBe(1);

    const all = await get('/optics/prescriptions');
    const allRows = rowsOf(all.body);
    expect(allRows.length).toBe(2);
    expect((all.body as { meta: { total: number } }).meta.total).toBe(2);
    // الأحدث أولاً — `ORDER BY created_at DESC`.
    expect(allRows[0]?.id).toBe(data(second.body).id as string);

    await del(`/optics/prescriptions/${data(second.body).id as string}`);
  });

  it('🗑️ حذف — الوصفة تُخفى: لا تُقرأ، ولا تظهر في القائمة', async () => {
    const temporary = await post('/optics/prescriptions', { partyId: customerId, rightEye: { sph: '-1.00' } });
    const id = data(temporary.body).id as string;

    const deleted = await del(`/optics/prescriptions/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, id });
    // `InvoiceOper` deletes a line's glasses with the invoice; here the row is only hidden.
    expect(data(deleted.body)).toMatchObject({ deleted: true, id });

    const read = await get(`/optics/prescriptions/${id}`);
    expect(read.status).toBe(404);
    const list = rowsOf((await get(`/optics/prescriptions?partyId=${customerId}`)).body);
    expect(list.map((row) => row.id as string)).not.toContain(id);
    expect(list.map((row) => row.id as string)).toContain(prescriptionId);
  });

  it('قسم الطباعة — «👓 بيانات النظارات» بعناوين المؤسسة', async () => {
    const section = await get(`/optics/invoice-lines/${prescriptionId}/print-section`);
    expect(section.status).toBe(200);
    // `rows` و`title` keep the shape the print route already had; the ten captions are new.
    expect(section.body).toMatchObject({ title: '👓 بيانات النظارات', rows: [], right: {}, left: {} });
    expect((section.body as { labels: { right: Array<{ key: string; label: string }> } }).labels.right[0]).toEqual({
      key: 'sph',
      label: 'درجة اليمين',
    });
  });

  it('الصلاحيات — «👓 القياسات» تُقرأ بـ optics.view، وتُكتب بـ optics.manage', async () => {
    const read = await asViewer('get', '/optics/prescriptions');
    expect(read.status).toBe(200);
    const labels = await asViewer('get', '/optics/field-labels');
    expect(labels.status).toBe(200);

    const write = await asViewer('post', '/optics/prescriptions', { partyId: customerId });
    expect(write.status).toBe(403);
    const save = await asViewer('put', '/optics/field-labels', { r1: 'شيء' });
    expect(save.status).toBe(403);
    const remove = await asViewer('delete', `/optics/prescriptions/${prescriptionId}`);
    expect(remove.status).toBe(403);
  });

  it('عزل المستأجرين — وصفة محمد ليست عند جاره، ولا عناوينه', async () => {
    const read = await asStranger('get', `/optics/prescriptions/${prescriptionId}`);
    expect(read.status).toBe(404);
    const update = await asStranger('patch', `/optics/prescriptions/${prescriptionId}`, { notes: 'سرقة' });
    expect(update.status).toBe(404);
    const remove = await asStranger('delete', `/optics/prescriptions/${prescriptionId}`);
    expect(remove.status).toBe(404);

    const list = rowsOf((await asStranger('get', '/optics/prescriptions')).body);
    expect(list).toEqual([]);

    // «⚙ أسماء الحقول» هي للمؤسسة وحدها: المؤسسة الأخرى لم تسمِّ شيئاً بعد.
    const strangerLabels = data((await asStranger('get', '/optics/field-labels')).body);
    expect(strangerLabels).toMatchObject({ id: null, r1: 'RE-SPH', l5: 'LE-IPD' });
  });
});
