import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 07 part five — 🗂️ إدارة الفترات المحاسبية.
 *
 * `Form_WPF/FrmAccountingPeriods.xaml` is one window with a card above a grid:
 * `رقم الفترة:` (read-only) · `اسم الفترة:` · `تاريخ من:` · `تاريخ إلى:` ·
 * `✔️ فترة نشطة حالياً` · `ملاحظات:` over
 * `الرقم · اسم الفترة · تاريخ البداية · تاريخ النهاية · نشطة · مغلقة · أغلقت بواسطة ·
 * تاريخ الإغلاق · ملاحظات`, and the action bar
 * `➕ إضافة · ✏️ تعديل · ⚡ تفعيل · 🔒 إغلاق الفترة · 🔓 إعادة فتح · 🆕 جديد · 🗑️ حذف ·
 * 🔄 تحديث`.
 *
 * `Class/AccountingPeriodManager.cs` is every statement behind it, and every refusal in
 * this file is that class's own wording — «يوجد تداخل في التواريخ مع فترة محاسبية أخرى»,
 * «لا يمكن تعديل فترة مغلقة. يرجى إعادة فتحها أولاً», «لا يمكن حذف فترة مغلقة»,
 * «لا يمكن تفعيل فترة محاسبية مغلقة».
 *
 * What the cloud was missing is the whole card: a period could be listed, closed and
 * reopened, and nothing else — not named, not dated, not marked active, not deleted.
 */
describe('الفترات المحاسبية — FrmAccountingPeriods', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  const year = new Date().getUTCFullYear();
  let branchId = '';
  let cashId = '';
  let revenueId = '';
  let firstId = '';
  let secondId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rows = (body: Record<string, unknown>): Array<Record<string, unknown>> => (body.data as Array<Record<string, unknown>>) ?? [];

  const period = (payload: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/fiscal-periods', { token: actor.token, body: payload });

  const list = () => api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });

  beforeAll(async () => {
    ctx = await createTestApp('fiscal-periods');
    actor = await createActor(ctx, {
      tenantCode: 'periods-one',
      email: 'owner@periods-one.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.period.reopen',
        'accounting.reports.view',
        'organization.branch.manage',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'periods-two',
      email: 'owner@periods-two.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'accounting.period.view', 'accounting.period.close'],
    });

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    const account = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });
    revenueId = await account({ code: '4100', nameAr: 'إيرادات', type: 'revenue' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. ➕ إضافة — الاسم والتاريخان و✔️ نشطة وملاحظات، والسنة تُفتح وحدها', async () => {
    // The desktop has no fiscal years: a period is addable on its own. Here the year that
    // covers the dates is found — or opened, because `fiscal_year_id` is not nullable.
    const created = await period({
      name: 'النصف الأول',
      startDate: `${year}-01-01`,
      endDate: `${year}-06-30`,
      isActive: true,
      notes: 'فترة تجريبية',
    });
    expect(created.status).toBe(201);
    const first = data(created.body);
    expect(first.name).toBe('النصف الأول');
    expect(first.notes).toBe('فترة تجريبية');
    expect(first.isActive).toBe(true);
    expect(first.status).toBe('open');
    expect(first.number).toBe(1);
    firstId = first.id as string;

    const years = await api(ctx.server, 'get', '/api/v1/fiscal-years', { token: actor.token });
    const opened = rows(years.body);
    expect(opened.length).toBe(1);
    expect(opened[0]?.name).toBe(String(year));
    expect(opened[0]?.startDate).toBe(`${year}-01-01`);

    const second = await period({ name: 'النصف الثاني', startDate: `${year}-07-01`, endDate: `${year}-12-31` });
    expect(second.status).toBe(201);
    const row = data(second.body);
    // ⚡ تفعيل is a single choice: adding an inactive period leaves the active one alone.
    expect(row.isActive).toBe(false);
    expect(row.number).toBe(2);
    expect(row.yearName).toBe(String(year));
    secondId = row.id as string;
  });

  it('2. «يوجد تداخل في التواريخ مع فترة محاسبية أخرى» — والتحقق قبل الحفظ', async () => {
    const overlap = await period({ name: 'متداخلة', startDate: `${year}-02-01`, endDate: `${year}-08-31` });
    expect(overlap.status).toBe(409);
    expect((overlap.body as { code?: string }).code).toBe('PERIOD_OVERLAP');
    expect(String((overlap.body as { detail?: string }).detail)).toContain('تداخل');

    const unnamed = await period({ name: '   ', startDate: `${year}-07-01`, endDate: `${year}-12-31` });
    expect(unnamed.status).toBe(422);
    expect((unnamed.body as { code?: string }).code).toBe('PERIOD_NAME_REQUIRED');

    const inverted = await period({ name: 'مقلوبة', startDate: `${year}-12-31`, endDate: `${year}-07-01` });
    expect(inverted.status).toBe(422);
    expect((inverted.body as { code?: string }).code).toBe('PERIOD_DATES_INVALID');
  });

  it('3. الرقم والترتيب — GetAllPeriods يرتّب تنازلياً بالتاريخ', async () => {
    const body = (await list()).body;
    const listed = rows(body);
    expect(listed.length).toBe(2);
    expect(listed[0]?.id).toBe(secondId);
    expect(listed[1]?.id).toBe(firstId);
    expect(listed[0]?.number).toBe(2);
    expect(listed[1]?.number).toBe(1);
    expect(listed[1]?.startDate).toBe(`${year}-01-01`);
    expect(listed[1]?.endDate).toBe(`${year}-06-30`);
  });

  it('4. ⚡ تفعيل — فترة نشطة واحدة، والمغلقة لا تُفعّل', async () => {
    const activated = await api(ctx.server, 'post', `/api/v1/fiscal-periods/${secondId}/activate`, { token: actor.token });
    expect(activated.status).toBe(201);
    expect(data(activated.body).isActive).toBe(true);

    const after = rows((await list()).body);
    expect(after.filter((row) => row.isActive === true).map((row) => row.id)).toEqual([secondId]);

    const closed = await api(ctx.server, 'post', `/api/v1/fiscal-periods/${firstId}/close`, { token: actor.token });
    expect(closed.status).toBe(201);

    const refused = await api(ctx.server, 'post', `/api/v1/fiscal-periods/${firstId}/activate`, { token: actor.token });
    expect(refused.status).toBe(409);
    expect(String((refused.body as { detail?: string }).detail)).toContain('لا يمكن تفعيل فترة محاسبية مغلقة');
  });

  it('5. 🔒 إغلاق الفترة — أغلقت بواسطة وتاريخ الإغلاق، وتُخرجها من النشطة', async () => {
    const listed = rows((await list()).body).find((row) => row.id === firstId) as Record<string, unknown>;
    expect(listed.status).toBe('closed');
    expect(listed.isActive).toBe(false);
    // `أغلقت بواسطة` is named, not a bare id — the desktop writes `Environment.UserName`.
    expect(listed.closedBy).toBeTruthy();
    expect(typeof listed.closedByName).toBe('string');
    expect(listed.closedAt).toBeTruthy();
  });

  it('6. ✏️ تعديل — «لا يمكن تعديل فترة مغلقة. يرجى إعادة فتحها أولاً»', async () => {
    const onClosed = await api(ctx.server, 'patch', `/api/v1/fiscal-periods/${firstId}`, {
      token: actor.token,
      body: { name: 'معدّلة' },
    });
    expect(onClosed.status).toBe(409);
    expect(String((onClosed.body as { detail?: string }).detail)).toContain('لا يمكن تعديل فترة مغلقة');

    const edited = await api(ctx.server, 'patch', `/api/v1/fiscal-periods/${secondId}`, {
      token: actor.token,
      body: { name: 'النصف الثاني ٢', notes: 'بعد التعديل' },
    });
    expect(edited.status).toBe(200);
    expect(data(edited.body).name).toBe('النصف الثاني ٢');
    expect(data(edited.body).notes).toBe('بعد التعديل');

    // The overlap check knows which period it is editing.
    const clash = await api(ctx.server, 'patch', `/api/v1/fiscal-periods/${secondId}`, {
      token: actor.token,
      body: { startDate: `${year}-06-01` },
    });
    expect(clash.status).toBe(409);
    expect((clash.body as { code?: string }).code).toBe('PERIOD_OVERLAP');
  });

  it('7. 🗑️ حذف — لا فترة مغلقة، ولا فترة لها قيود', async () => {
    const onClosed = await api(ctx.server, 'delete', `/api/v1/fiscal-periods/${firstId}`, { token: actor.token });
    expect(onClosed.status).toBe(409);
    expect(String((onClosed.body as { detail?: string }).detail)).toContain('لا يمكن حذف فترة مغلقة');

    // A period with an entry cannot go: `journal_entries.fiscal_period_id` is RESTRICT.
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: `${year}-08-15`,
        branchId,
        description: 'قيد داخل الفترة الثانية',
        lines: [
          { accountId: cashId, debit: '500' },
          { accountId: revenueId, credit: '500' },
        ],
      },
    });
    expect(posted.status).toBe(201);

    const inUse = await api(ctx.server, 'delete', `/api/v1/fiscal-periods/${secondId}`, { token: actor.token });
    expect(inUse.status).toBe(409);
    expect((inUse.body as { code?: string }).code).toBe('PERIOD_IN_USE');

    const reopened = await api(ctx.server, 'post', `/api/v1/fiscal-periods/${firstId}/reopen`, {
      token: actor.token,
      body: { reason: 'لتصحيح قيد' },
    });
    expect(reopened.status).toBe(201);
    const reopenedRow = rows((await list()).body).find((row) => row.id === firstId) as Record<string, unknown>;
    expect(reopenedRow.closedBy).toBeNull();
    expect(reopenedRow.closedAt).toBeNull();

    const deleted = await api(ctx.server, 'delete', `/api/v1/fiscal-periods/${firstId}`, { token: actor.token });
    expect(deleted.status).toBe(200);
    expect(rows((await list()).body).map((row) => row.id)).toEqual([secondId]);
  });

  it('8. عزل المؤسسات — فترة مؤسسة لا تُرى من أخرى', async () => {
    const foreign = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: stranger.token });
    expect(rows(foreign.body).length).toBe(0);

    const patched = await api(ctx.server, 'patch', `/api/v1/fiscal-periods/${secondId}`, {
      token: stranger.token,
      body: { name: 'مؤسسة أخرى' },
    });
    expect(patched.status).toBe(404);

    const removed = await api(ctx.server, 'delete', `/api/v1/fiscal-periods/${secondId}`, { token: stranger.token });
    expect(removed.status).toBe(404);
  });
});
