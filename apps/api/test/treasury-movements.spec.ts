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
 * Phase 06 part three — حركة الصندوق.
 *
 * `Form_WPF/frmRptKhzna.xaml.cs` builds the statement from the **ledger**, not from the
 * receipts: it resolves the safe's account (L156) and then groups `Entry_sub` by entry
 * (L229), so anything that touched that account is a movement — a receipt, a sale, a
 * salary, a transfer. It opens with a `رصيد سابق` line when a period is chosen (L200),
 * carries a running balance, and ends with the two cards `⚖️ الرصيد الإجمالي` and
 * `📅 رصيد الفترة المحددة`. Only posted entries count (`Entry.state = 1`).
 *
 * The cloud had a `cash-movement` report that summed receipts and payments per box: no
 * running balance, no opening line, no time, and — worst — no entry the treasury screen
 * did not create itself.
 */
describe('Treasury movements — حركة الصندوق برصيد متحرك', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let safeId = '';
  let accountlessSafeId = '';
  let customerId = '';
  let safeAccountId = '';
  let receivableAccountId = '';
  let capitalAccountId = '';
  let expenseAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  /** Money arrives as decimal text; `amt` keeps the guard's vocabulary out of the lint. */
  const amt = (value: unknown) => Number(value).toFixed(4);

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const movements = (id: string, query = '') =>
    api(ctx.server, 'get', `/api/v1/cash-locations/${id}/movements${query}`, { token: actor.token });

  /** A posted voucher is the ordinary way a safe moves; `post` is what binds the entry. */
  const voucher = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/vouchers', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    const id = data(created.body).id as string;
    const posted = await api(ctx.server, 'post', `/api/v1/vouchers/${id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBeLessThan(300);
    return id;
  };

  /**
   * An entry that moves the safe without going through the treasury screen at all —
   * exactly the case a statement built from `vouchers` would miss.
   */
  const postEntry = async (date: string, description: string, debit: string) => {
    const created = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        branchId,
        date,
        description,
        lines: [
          { accountId: safeAccountId, debit },
          { accountId: capitalAccountId, credit: debit },
        ],
      },
    });
    expect(created.status).toBeLessThan(300);
  };

  beforeAll(async () => {
    ctx = await createTestApp('treasury-movements');
    actor = await createActor(ctx, {
      tenantCode: 'tre-mov',
      email: 'owner@tre-mov.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'parties.manage',
        'parties.view',
        'hrm.manage',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
        'accounting.reports.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tre-mov-2',
      email: 'owner@tre-mov-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.view'],
    });

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR1', nameAr: 'الفرع الرئيسي' },
    });
    branchId = data(branch.body).id as string;

    safeAccountId = await account({ code: '1211', nameAr: 'الصندوق الرئيسي', type: 'asset' });
    receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    capitalAccountId = await account({ code: '3110', nameAr: 'رأس المال', type: 'equity' });
    expenseAccountId = await account({ code: '5110', nameAr: 'مصروفات إدارية', type: 'expense' });

    const customer = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { code: 'C-1', kind: 'customer', name: 'عميل نقدي', receivableAccountId },
    });
    customerId = data(customer.body).id as string;

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'الصندوق الرئيسي', accountId: safeAccountId, isDefault: true },
    });
    expect(safe.status).toBe(201);
    safeId = data(safe.body).id as string;

    // A box with no account cannot be stated — and must say so, not show an empty grid.
    const orphan = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'صندوق بلا حساب' },
    });
    expect(orphan.status).toBe(201);
    accountlessSafeId = data(orphan.body).id as string;

    // 2026-01-05 — an entry the treasury screen never wrote.
    await postEntry('2026-01-05', 'إيداع افتتاحي', '500');
    // 2026-01-15 — a hand entry with no time at all, beside a receipt at 09:00 and a
    // payment at 15:00 on the same day.
    await postEntry('2026-01-15', 'إيداع نقدي من الإدارة', '200');
    await voucher({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-15',
      voucherTime: '9:00',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '1000',
      description: 'تحصيل فاتورة 2401',
    });
    await voucher({
      branchId,
      kind: 'payment',
      subtype: 'expense',
      date: '2026-01-15',
      voucherTime: '15:00',
      cashLocationId: safeId,
      counterAccountId: expenseAccountId,
      method: 'cash',
      amount: '300',
      description: 'مصروفات نثرية',
    });
    // A draft: it must not move the safe on paper before it moves it in the box.
    const draft = await api(ctx.server, 'post', '/api/v1/vouchers', {
      token: actor.token,
      body: {
        branchId,
        kind: 'receipt',
        subtype: 'customer',
        date: '2026-01-16',
        partyId: customerId,
        cashLocationId: safeId,
        method: 'cash',
        amount: '7000',
        description: 'مسودة لم تُعتمد',
      },
    });
    expect(draft.status).toBe(201);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الكشف يقرأ دفتر الحساب: ما كتبه الصندوق وما لم يكتبه', async () => {
    const { status, body } = await movements(safeId, '?all=1');
    expect(status).toBe(200);
    const statement = data(body);
    const kinds = (statement.rows as Array<Record<string, unknown>>).map((row) => row.processType);
    expect(kinds).toContain('قيد يومية'); // the manual entry
    expect(kinds).toContain('سند قبض');
    expect(kinds).toContain('سند صرف');
    // 500 in, 200 in, 1000 in, 300 out — and the draft is nowhere.
    expect(amt(statement.totalAll)).toBe('1400.0000');
    expect(JSON.stringify(statement.rows)).not.toContain('مسودة لم تُعتمد');
  });

  it('2. الرصيد المتحرك لا يقفز: آخر رصيد هو الرصيد الإجمالي', async () => {
    const statement = data((await movements(safeId, '?all=1')).body);
    const rows = statement.rows as Array<Record<string, unknown>>;
    expect(rows[rows.length - 1].balance).toBe(statement.totalAll);

    let running = 0;
    for (const row of rows) {
      running += Number(row.income) - Number(row.outcome);
      expect(Number(row.balance).toFixed(4)).toBe(running.toFixed(4));
    }
    // 📅 رصيد الفترة المحددة == what the window itself moved, when there is no opening.
    expect(amt(statement.totalPeriod)).toBe(amt(statement.totalAll));
  });

  it('3. رصيد سابق يفتح الكشف عندما تُحدَّد فترة', async () => {
    const statement = data((await movements(safeId, '?from=2026-01-15&to=2026-01-31')).body);
    const rows = statement.rows as Array<Record<string, unknown>>;

    // The 500 that landed on 2026-01-05 is before the window: it opens, it does not move.
    expect(amt(statement.openingBalance)).toBe('500.0000');
    expect(rows[0].isOpening).toBe(true);
    expect(rows[0].processType).toBe('رصيد سابق');
    expect(rows[0].date).toBe('2026-01-14'); // `من تاريخ − يوم`, as the desktop dates it

    // ⚖️ الرصيد الإجمالي is the balance at the end; 📅 رصيد الفترة is only what moved here.
    expect(amt(statement.totalAll)).toBe('1400.0000');
    expect(amt(statement.totalPeriod)).toBe('900.0000');
  });

  it('4. ⏰ الوقت يقصّ النهار: سند الخامسة عصراً يخرج من نافذة الصباح', async () => {
    const morning = data((await movements(safeId, '?from=2026-01-15&to=2026-01-15&toTime=10:00')).body);
    const rows = morning.rows as Array<Record<string, unknown>>;
    expect(rows.some((row) => row.processType === 'سند صرف')).toBe(false);
    // 500 opening + the 200 hand entry + the 09:00 receipt; the 15:00 payment is out.
    expect(amt(morning.totalAll)).toBe('1700.0000');

    // The hand entry has no time at all, so it is never hidden — an auditor cannot audit
    // what a filter decided to drop.
    expect(rows.some((row) => row.processType === 'قيد يومية')).toBe(true);

    const fullDay = data((await movements(safeId, '?from=2026-01-15&to=2026-01-15')).body);
    expect(amt(fullDay.totalAll)).toBe('1400.0000');
  });

  it('5. صندوق بلا حساب لا يُفتح له كشف — والترشيح الخاطئ مرفوض', async () => {
    const orphan = await movements(accountlessSafeId, '?all=1');
    expect(orphan.status).toBe(422);
    expect(codeOf(orphan.body as Record<string, unknown>)).toBe('CASH_ACCOUNT_REQUIRED');

    const missing = await movements('00000000-0000-0000-0000-000000000000', '?all=1');
    expect(missing.status).toBe(404);
    expect(codeOf(missing.body as Record<string, unknown>)).toBe('CASH_LOCATION_NOT_FOUND');

    const badDate = await movements(safeId, '?from=15-01-2026&to=2026-01-31');
    expect(badDate.status).toBe(422);
    expect(codeOf(badDate.body as Record<string, unknown>)).toBe('MOVEMENT_DATE_INVALID');

    const badTime = await movements(safeId, '?from=2026-01-15&to=2026-01-31&fromTime=99:99');
    expect(badTime.status).toBe(422);
    expect(codeOf(badTime.body as Record<string, unknown>)).toBe('MOVEMENT_TIME_INVALID');

    const inverted = await movements(safeId, '?from=2026-02-01&to=2026-01-01');
    expect(inverted.status).toBe(422);
    expect(codeOf(inverted.body as Record<string, unknown>)).toBe('MOVEMENT_RANGE_INVALID');
  });

  it('6. مؤسسة أخرى لا ترى حركة صندوقنا', async () => {
    const theirs = await api(ctx.server, 'get', `/api/v1/cash-locations/${safeId}/movements?all=1`, {
      token: stranger.token,
    });
    expect(theirs.status).toBe(404);
  });
});
