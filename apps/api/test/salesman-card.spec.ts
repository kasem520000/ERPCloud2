import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 09 part one — 🧑‍💼 شاشة المندوبين (`Form_WPF/frmSalesMen.xaml`).
 *
 * The window is a card of one name, three commission percentages and three contacts.
 * `btnSave_Click` L155 writes
 * `salesmen(name, comm, tel, mobile, email, notes, IS_Deleted, Profit_Comm, Colle_Comm)`
 * and `btnDelete_Click` L215 refuses an empty selection with «اختر مندوباً ليتم حذفه.».
 * `LoadDG` L63 lists `WHERE name LIKE N'%…%' AND IS_Deleted=0`, and
 * `Button1_Click` L272 opens `frmInvBySalesMen` — the report that *reads* the three
 * percentages (see `salesman-commissions.spec.ts`).
 *
 * The cloud's `salesmen` was a name and a flag. A مندوب with no rate has no commission,
 * which is why «كم يستحق هذا المندوب؟» had no answer even though every فاتورة carries
 * his id.
 */
describe('شاشة المندوبين — frmSalesMen', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let employeeId = '';

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
  const list = async () => rowsOf((await get('/sales/salesmen')).body);

  beforeAll(async () => {
    ctx = await createTestApp('salesman-card');
    actor = await createActor(ctx, {
      tenantCode: 'smn-card',
      email: 'owner@smn-card.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'sales.view',
        'sales.salesman.manage',
        'hrm.view',
        'hrm.manage',
        'organization.branch.manage',
        'accounting.period.view',
        'accounting.period.close',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'smn-card-2',
      email: 'owner@smn-card-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'sales.view', 'sales.salesman.manage', 'hrm.manage'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await post('/fiscal-years', {
      name: `FY${year}`,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    });
    expect(fiscal.status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    const employee = await post('/hrm/employees', {
      employeeNo: 'SM-1',
      name: 'سالم أحمد',
      branchId,
    });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('بطاقة مندوب بالعمولات الثلاث — والصفر هو الأصل لمن لا عمولة له', async () => {
    const created = await post('/sales/salesmen', {
      name: 'مندوب أول',
      commissionRate: '10',
      collectionCommissionRate: '5',
      profitCommissionRate: '20',
      tel: '014567890',
      mobile: '0551234567',
      email: 'first@example.test',
      notes: 'مندوب المنطقة الشمالية',
      employeeId,
    });
    expect(created.status).toBe(201);
    const card = data(created.body);
    expect(card).toMatchObject({
      name: 'مندوب أول',
      // `comm` · `Colle_Comm` · `Profit_Comm` — the three boxes of `frmSalesMen.xaml`.
      commissionRate: '10.0000',
      collectionCommissionRate: '5.0000',
      profitCommissionRate: '20.0000',
      tel: '014567890',
      mobile: '0551234567',
      email: 'first@example.test',
      notes: 'مندوب المنطقة الشمالية',
      employeeId,
      active: true,
    });

    // A card with no rates is a مندوب who earns nothing — and that is a legal answer.
    const plain = await post('/sales/salesmen', { name: 'مندوب بلا عمولة' });
    expect(plain.status).toBe(201);
    expect(data(plain.body)).toMatchObject({
      commissionRate: '0.0000',
      collectionCommissionRate: '0.0000',
      profitCommissionRate: '0.0000',
    });
  });

  it('نسبة العمولة بين 0 و100 — وما ليس رقماً ليس نسبة', async () => {
    const tooHigh = await post('/sales/salesmen', { name: 'مندوب جشع', commissionRate: '250' });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body).toMatchObject({ code: 'SALESMAN_RATE_RANGE', detail: 'نسبة العمولة يجب أن تكون بين 0 و100' });

    const negative = await post('/sales/salesmen', { name: 'مندوب سالب', profitCommissionRate: '-1' });
    expect(negative.status).toBe(422);
    expect(negative.body).toMatchObject({ code: 'SALESMAN_RATE_RANGE' });

    const notANumber = await post('/sales/salesmen', {
      name: 'مندوب نص',
      collectionCommissionRate: 'عشرة',
    });
    expect(notANumber.status).toBe(422);
    expect(notANumber.body).toMatchObject({ code: 'SALESMAN_RATE_INVALID', detail: 'نسبة العمولة يجب أن تكون رقماً' });

    // `double.TryParse(..., out c) ? c : 0` L174 — the desktop would have stored a zero.
    // Nothing was written, so the list is still the two cards of the first test.
    const listed = await list();
    expect(listed.map((row) => row.name)).toEqual(['مندوب أول', 'مندوب بلا عمولة']);
  });

  it('الموظف — بطاقة الموظف تُربط، وموظفُ مؤسسةٍ أخرى ليس موظفاً هنا', async () => {
    const unknown = await post('/sales/salesmen', {
      name: 'مندوب بلا موظف',
      employeeId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: 'SALESMAN_EMPLOYEE_NOT_FOUND', detail: 'الموظف غير موجود' });

    const before = await list();
    const first = before.find((row) => row.name === 'مندوب أول') as { id: string };
    const relinked = await patch(`/sales/salesmen/${first.id}`, { employeeId: null });
    expect(relinked.status).toBe(200);
    expect(data(relinked.body).employeeId).toBeNull();

    // One مندوب card per employee card — the link is unique, so a second card may not
    // claim an employee another card already holds.
    const second = await post('/sales/salesmen', { name: 'مندوب ثانٍ', employeeId });
    expect(second.status).toBe(201);
    const clash = await patch(`/sales/salesmen/${first.id}`, { employeeId });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'SALESMAN_EMPLOYEE_TAKEN',
      detail: 'هذا الموظف مرتبط بمندوب آخر',
    });
  });

  it('تحديثٌ جزئي — ما أُرسل وحده يتغيّر', async () => {
    const listed = await list();
    const card = listed.find((row) => row.name === 'مندوب أول') as { id: string };

    const updated = await patch(`/sales/salesmen/${card.id}`, { commissionRate: '12.5' });
    expect(updated.status).toBe(200);
    expect(data(updated.body)).toMatchObject({
      commissionRate: '12.5000',
      // The two rates that were not sent keep their values.
      collectionCommissionRate: '5.0000',
      profitCommissionRate: '20.0000',
      mobile: '0551234567',
      notes: 'مندوب المنطقة الشمالية',
    });

    const cleared = await patch(`/sales/salesmen/${card.id}`, { notes: null, tel: '' });
    expect(cleared.status).toBe(200);
    expect(data(cleared.body)).toMatchObject({ notes: null, tel: '' });

    const missing = await patch('/sales/salesmen/00000000-0000-4000-8000-000000000000', {
      commissionRate: '5',
    });
    expect(missing.status).toBe(404);
  });

  it('عزل المستأجرين — مندوبُ مؤسسةٍ لا تراه أخرى', async () => {
    const mine = await list();
    expect(mine.length).toBeGreaterThan(0);

    const theirs = await api(ctx.server, 'get', '/api/v1/sales/salesmen', { token: stranger.token });
    expect(theirs.status).toBe(200);
    expect(rowsOf(theirs.body)).toHaveLength(0);

    const target = mine[0] as { id: string };
    const touched = await api(ctx.server, 'patch', `/api/v1/sales/salesmen/${target.id}`, {
      token: stranger.token,
      body: { commissionRate: '99' },
    });
    expect(touched.status).toBe(404);
  });
});
