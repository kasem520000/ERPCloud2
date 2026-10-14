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
 * Phase 06 part two — تعريف الخزن والبنوك.
 *
 * `Form_WPF/frmTreasury.xaml.cs:222` refuses to save a الصندوق whose responsible
 * employees are empty — «يجب اختيار موظف مسئول» — and then, inside the same
 * transaction, deletes `Stock_Emps` for the box and re-inserts it. `frmBanks.xaml`
 * carries the bank's own card on the same row: 🌍 الدولة، 🏙️ المدينة، 📍 المنطقة،
 * تليفون، موبايل، 💰 نسبة الاقتطاع %.
 *
 * The cloud's `cash_locations` had the box, the branch and the account — and neither a
 * signature nor a note, so nobody could say who answers for a safe's balance.
 */
describe('Treasury masters — مسئولو الصندوق وملاحظاته وبيانات البنك', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let safeAccountId = '';
  let bankAccountId = '';
  let firstEmployeeId = '';
  let secondEmployeeId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const employee = async (employeeNo: string, name: string) => {
    const created = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: actor.token,
      body: { employeeNo, name, branchId },
    });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const safe = (payload: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/cash-locations', { token: actor.token, body: payload });

  beforeAll(async () => {
    ctx = await createTestApp('treasury-custody');
    actor = await createActor(ctx, {
      tenantCode: 'tre-cus',
      email: 'owner@tre-cus.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'hrm.manage',
        'accounting.account.manage',
        'treasury.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tre-cus-2',
      email: 'owner@tre-cus-2.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'hrm.manage',
      ],
    });

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    safeAccountId = await account({ code: '1211', nameAr: 'الصندوق', type: 'asset' });
    bankAccountId = await account({ code: '1221', nameAr: 'البنك', type: 'asset' });

    firstEmployeeId = await employee('E-1', 'أمين الصندوق');
    secondEmployeeId = await employee('E-2', 'مساعد أمين الصندوق');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الخزينة تُحفظ بمسئوليها وملاحظاتها', async () => {
    const created = await safe({
      branchId,
      kind: 'safe',
      name: 'الصندوق الرئيسي',
      accountId: safeAccountId,
      isDefault: true,
      custodianIds: [firstEmployeeId, secondEmployeeId],
      notes: 'يُغلق يومياً الساعة الثامنة',
    });
    expect(created.status).toBe(201);
    const row = data(created.body);
    expect(row.custodianIds).toEqual([firstEmployeeId, secondEmployeeId]);
    expect(row.notes).toBe('يُغلق يومياً الساعة الثامنة');

    // And the read brings them back — a master you cannot read back is a master you guess at.
    const read = await api(ctx.server, 'get', `/api/v1/cash-locations/${row.id}`, { token: actor.token });
    expect(data(read.body).custodianIds).toEqual([firstEmployeeId, secondEmployeeId]);
  });

  it('2. صندوق بلا مسئول مرفوض — «يجب اختيار موظف مسئول»', async () => {
    const none = await safe({
      branchId,
      kind: 'safe',
      name: 'صندوق بلا مسئول',
      accountId: safeAccountId,
      custodianIds: [],
    });
    expect(none.status).toBe(422);
    expect(codeOf(none.body as Record<string, unknown>)).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(none.body)).toContain('custodianIds');
  });

  it('3. موظف من مؤسسة أخرى لا يُجعل مسئولاً', async () => {
    const foreign = await safe({
      branchId,
      kind: 'safe',
      name: 'صندوق بمسئول غريب',
      accountId: safeAccountId,
      custodianIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(foreign.status).toBe(422);
    expect(JSON.stringify(foreign.body)).toContain('custodianIds');

    // The stranger's own employee is theirs, not ours.
    const theirs = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: stranger.token,
      body: { employeeNo: 'X-1', name: 'موظف مؤسسة أخرى' },
    });
    expect(theirs.status).toBe(201);
    const outsider = data(theirs.body).id as string;
    const refused = await safe({
      branchId,
      kind: 'safe',
      name: 'صندوق بمسئول خارجي',
      accountId: safeAccountId,
      custodianIds: [outsider],
    });
    expect(refused.status).toBe(422);
  });

  it('4. التحديث يستبدل المسئولين كما يفعل الديسكتوب: حذف ثم إدراج', async () => {
    const created = await safe({
      branchId,
      kind: 'safe',
      name: 'صندوق الفرع',
      accountId: safeAccountId,
      custodianIds: [firstEmployeeId, secondEmployeeId],
    });
    const id = data(created.body).id as string;

    const trimmed = await api(ctx.server, 'patch', `/api/v1/cash-locations/${id}`, {
      token: actor.token,
      body: { custodianIds: [secondEmployeeId], notes: 'مسئول واحد بعد التسليم' },
    });
    expect(trimmed.status).toBe(200);
    expect(data(trimmed.body).custodianIds).toEqual([secondEmployeeId]);
    expect(data(trimmed.body).notes).toBe('مسئول واحد بعد التسليم');

    // Taking the last custodian away is the desktop's own refusal, repeated.
    const emptied = await api(ctx.server, 'patch', `/api/v1/cash-locations/${id}`, {
      token: actor.token,
      body: { custodianIds: [] },
    });
    expect(emptied.status).toBe(422);
    const still = await api(ctx.server, 'get', `/api/v1/cash-locations/${id}`, { token: actor.token });
    expect(data(still.body).custodianIds).toEqual([secondEmployeeId]);
  });

  it('5. البنك يحمل بطاقته كاملة — الدولة والمدينة ونسبة الاقتطاع', async () => {
    const created = await safe({
      branchId,
      kind: 'bank',
      name: 'بنك الرياض',
      accountId: bankAccountId,
      isDefault: true,
      bank: {
        bankName: 'بنك الرياض',
        iban: 'SA0380000000608010167519',
        swift: 'RJBLSARI',
        accountNo: '608010167519',
        country: 'المملكة العربية السعودية',
        city: 'الرياض',
        region: 'العليا',
        phone: '0114013030',
        mobile: '0550000000',
        deductionPct: '2.5',
      },
      changeInPos: true,
      notes: 'حساب التحصيل الرئيسي',
    });
    expect(created.status).toBe(201);
    const bank = data(created.body).bank as Record<string, string>;
    expect(bank.country).toBe('المملكة العربية السعودية');
    expect(bank.city).toBe('الرياض');
    expect(bank.deductionPct).toBe('2.5');

    // نسبة الاقتطاع outside 0…100 is refused, not rounded.
    const absurd = await safe({
      branchId,
      kind: 'bank',
      name: 'بنك بنسبة خاطئة',
      accountId: bankAccountId,
      bank: { bankName: 'بنك', deductionPct: '150' },
    });
    expect(absurd.status).toBe(400);
  });

  it('6. القائمة تعيد المسئولين، ومؤسسة أخرى لا ترى صناديقنا', async () => {
    const list = await api(ctx.server, 'get', '/api/v1/cash-locations?filter[kind]=safe&limit=100', {
      token: actor.token,
    });
    const rows = data(list.body) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Array.isArray(row.custodianIds))).toBe(true);
    expect(rows.some((row) => (row.custodianIds as string[]).includes(firstEmployeeId))).toBe(true);

    const theirs = await api(ctx.server, 'get', '/api/v1/cash-locations?filter[kind]=safe', {
      token: stranger.token,
    });
    expect((data(theirs.body) as unknown[]).length).toBe(0);
  });
});
