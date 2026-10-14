import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part three — 📒 إنشاء قيد يومية (`Form_WPF/FrmNewEntry.xaml`).
 *
 * The window's card is `رقم القيد` (allocated by `LoadResNo` when it saves) ·
 * `📅 التاريخ` · `⏰ الوقت` · `🔑 الرقم العام` · `✅ قيد ضريبي` · `📝 الملاحظة`, and its
 * grid is `📋 تفاصيل القيد` with `رمز الحساب · اسم الحساب · مدين · دائن · مركز تكلفة ·
 * الشرح · المندوب`.
 *
 * Two of those need columns the cloud does not have (migration `0046`): `⏰ الوقت`,
 * because the desktop stores a *timestamp* — two entries written the same day keep the
 * order they were written in, and حركة الصندوق filters by date *and* time — and
 * `المندوب`, which the desktop carries on every line (`Entry_sub.salesman`).
 * `✅ قيد ضريبي` is `Entry.IsVAT`.
 *
 * The third thing the window does is fill in what the clerk left empty: `Save()`
 * (L745) writes `سند قيد يومية رقم: {EntryNo} بتاريخ {date}` when الملاحظة is blank, and
 * (L761) names each unnamed line after the account it settles. An entry with no note is
 * unfindable a year later, so those two defaults are part of the card, not of the
 * screen.
 */
describe('Journal entry card — إنشاء قيد يومية', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let periodId = '';
  let cashId = '';
  let capitalId = '';
  let costCenterId = '';
  let employeeId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const amt = (value: unknown) => Number(value).toFixed(4);
  const today = () => new Date().toISOString().slice(0, 10);

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const post = (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/journal-entries', { token: actor.token, body });

  const read = (id: string, token = actor.token) =>
    api(ctx.server, 'get', `/api/v1/journal-entries/${id}`, { token });

  beforeAll(async () => {
    ctx = await createTestApp('journal-entry-card');
    actor = await createActor(ctx, {
      tenantCode: 'je-card',
      email: 'owner@je-card.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.create',
        'accounting.reports.view',
        'accounting.period.view',
        'accounting.period.close',
        'hrm.view',
        'hrm.manage',
        'organization.branch.manage',
        'organization.cashlocation.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'je-card-2',
      email: 'owner@je-card-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'accounting.reports.view'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);
    const periods = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });
    periodId = (data(periods.body) as Array<{ id: string; status: string }>).find((row) => row.status === 'open')!.id;

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    const center = await api(ctx.server, 'post', '/api/v1/cost-centers', {
      token: actor.token,
      body: { code: 'CC1', nameAr: 'مركز عام' },
    });
    costCenterId = data(center.body).id as string;

    const employee = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: actor.token,
      body: { employeeNo: 'E-1', name: 'مناديب التحقق', salaryComponents: {} },
    });
    expect(employee.status).toBeLessThan(300);
    employeeId = data(employee.body).id as string;

    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });
    capitalId = await account({ code: '4000', nameAr: 'رأس المال', type: 'equity' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. ⏰ الوقت — يُحفظ مع القيد ويُردّ كما كُتب', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      time: '09:45',
      lines: [
        { accountId: cashId, debit: '100' },
        { accountId: capitalId, credit: '100' },
      ],
    });
    expect(posted.status).toBeLessThan(300);
    const id = data(posted.body).id as string;

    const stored = data((await read(id)).body);
    expect(String(stored.entryTime ?? '').slice(0, 5)).toBe('09:45');
  });

  it('2. ✅ قيد ضريبي — علامة على القيد، وخطؤها الافتراضي', async () => {
    const vat = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      isVat: true,
      lines: [
        { accountId: cashId, debit: '30' },
        { accountId: capitalId, credit: '30' },
      ],
    });
    expect(data(vat.body).isVat).toBe(true);

    const plain = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '40' },
        { accountId: capitalId, credit: '40' },
      ],
    });
    expect(data(plain.body).isVat).toBe(false);
  });

  it('3. المندوب — على سطر القيد، ويُقرأ من القيد', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '70', salesmanId: employeeId, costCenterId },
        { accountId: capitalId, credit: '70' },
      ],
    });
    expect(posted.status).toBeLessThan(300);
    const id = data(posted.body).id as string;

    const stored = (await read(id)).body as { data: { lines: Array<Record<string, unknown>> } };
    const line = stored.data.lines.find((row) => row.accountCode === '1100');
    expect(line?.salesmanId).toBe(employeeId);
    expect(line?.costCenterId).toBe(costCenterId);
  });

  it('4. رقم القيد و🔑 الرقم العام — الأول متسلسل والثاني هو هوية القيد', async () => {
    const first = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '11' },
        { accountId: capitalId, credit: '11' },
      ],
    });
    const second = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '12' },
        { accountId: capitalId, credit: '12' },
      ],
    });

    const firstNumber = String(data(first.body).number);
    const secondNumber = String(data(second.body).number);
    expect(firstNumber).toMatch(/^JE-/);
    expect(secondNumber).not.toBe(firstNumber);

    const id = data(second.body).id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data((await read(id)).body).id).toBe(id);
  });

  it('5. 📝 الملاحظة — تُملأ تلقائياً برقم القيد وتاريخه إن تُركت', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '21' },
        { accountId: capitalId, credit: '21' },
      ],
    });
    const number = String(data(posted.body).number);
    expect(String(data(posted.body).description)).toBe(`سند قيد يومية رقم: ${number} بتاريخ ${today()}`);

    const named = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      description: '  تسوية يدوية  ',
      lines: [
        { accountId: cashId, debit: '22' },
        { accountId: capitalId, credit: '22' },
      ],
    });
    // What the clerk wrote is kept — trimmed, never replaced by the default.
    expect(String(data(named.body).description)).toBe('تسوية يدوية');
  });

  it('6. الشرح — سطرٌ بلا شرح يُسمّى بالحساب الذي يسدّده', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '31' },
        { accountId: capitalId, credit: '31', description: 'رأس المال' },
      ],
    });
    const number = String(data(posted.body).number);
    const stored = (await read(data(posted.body).id as string)).body as {
      data: { lines: Array<Record<string, unknown>> };
    };
    const cashLine = stored.data.lines.find((row) => row.accountCode === '1100');
    expect(String(cashLine?.description)).toBe(
      `سند قيد يومية رقم: ${number} - سداد دفعة من حساب: النقدية`,
    );
    expect(String(stored.data.lines.find((row) => row.accountCode === '4000')?.description)).toBe('رأس المال');
  });

  it('7. الفرق — قيدٌ غير متوازن لا يُحفظ', async () => {
    const unbalanced = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '100' },
        { accountId: capitalId, credit: '99.99' },
      ],
    });
    expect(unbalanced.status).toBe(422);
    expect((unbalanced.body as { code?: string }).code).toBe('JOURNAL_NOT_BALANCED');
  });

  it('8. التوافق — قيدٌ بلا الحقول الجديدة كما كان تماماً', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      description: 'قيد قديم',
      lines: [
        { accountId: cashId, debit: '50' },
        { accountId: capitalId, credit: '50' },
      ],
    });
    const body = data(posted.body);
    expect(body.isVat).toBe(false);
    expect(body.entryTime ?? null).toBeNull();
    expect(body.status).toBe('posted');
    // … and the entry itself is unchanged: two lines, 50 on each side, no salesman.
    const stored = (await read(body.id as string)).body as { data: { lines: Array<Record<string, unknown>> } };
    expect(stored.data.lines).toHaveLength(2);
    expect(amt(stored.data.lines[0]?.debit)).toBe('50.0000');
    expect(stored.data.lines[0]?.salesmanId ?? null).toBeNull();
  });

  it('9. عزل المؤسسات — قيد مؤسسة أخرى غير موجود', async () => {
    const posted = await post({
      branchId,
      fiscalPeriodId: periodId,
      date: today(),
      lines: [
        { accountId: cashId, debit: '60' },
        { accountId: capitalId, credit: '60' },
      ],
    });
    const id = data(posted.body).id as string;
    expect((await read(id, stranger.token)).status).toBe(404);
  });
});
