import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The reversal, and the `void` that never was.
 *
 * Found on the way through Phase 07 part four (🌳 مراكز التكلفة), where a cost centre
 * kept spending that had been reversed. Two separate defects:
 *
 *   1. `prevent_posted_journal_mutation()` — installed by `0004_accounting.sql` L115 —
 *      allows exactly one mutation of a posted entry (`status = 'void'`) and then
 *      `RETURN OLD`, which throws the value it just allowed away. Every `void` since
 *      then has been silently discarded: a cancelled sale kept its revenue, a cancelled
 *      purchase kept its cost, and a reversal left its original `posted`. Migration
 *      `0047` fixes the return value.
 *
 *   2. `reverseJournal` inserted a *mirrored* entry (debit for credit) **and** voided the
 *      original. Those two are the same subtraction twice, so once (1) was fixed the
 *      reversal moved a balance by twice the amount. A reversal is the mirror alone: the
 *      two entries together already net to nothing, and `reversalOf` is what marks the
 *      original as undone.
 *
 *   3. The mirrored lines carried only `partyId` and `description` — no cost centre, no
 *      branch, no salesman. Every report scoped to one of those dimensions kept the
 *      original's amount while the ledger had already let it go.
 */
describe('Reversal and void — العكس والإبطال', () => {
  let ctx: TestApp;
  let actor: Actor;
  let client: pg.Client;

  let branchId = '';
  let periodId = '';
  let expenseId = '';
  let cashId = '';
  let centerId = '';
  let employeeId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;
  /** Every entry in this suite is posted relative to today, so a period is always open. */
  const iso = (offsetDays: number) => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + offsetDays);
    return at.toISOString().slice(0, 10);
  };

  const balanceOf = async (accountId: string) => {
    const rows = (await api(ctx.server, 'get', '/api/v1/accounts?with_balances=1', { token: actor.token })).body as {
      data: Array<Record<string, unknown>>;
    };
    const row = rows.data.find((entry) => entry.id === accountId);
    return Number(((row?.balance ?? {}) as { balance?: string }).balance ?? 0);
  };

  beforeAll(async () => {
    ctx = await createTestApp('reversal-and-void');
    actor = await createActor(ctx, {
      tenantCode: 'je-reverse',
      email: 'owner@je-reverse.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'hrm.view',
        'hrm.manage',
        'organization.branch.manage',
      ],
    });
    client = new pg.Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();

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
    const centre = await api(ctx.server, 'post', '/api/v1/cost-centers', {
      token: actor.token,
      body: { code: 'C1', nameAr: 'الإدارة' },
    });
    centerId = data(centre.body).id as string;
    const employee = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: actor.token,
      body: { employeeNo: 'E-1', name: 'مندوب', salaryComponents: {} },
    });
    employeeId = data(employee.body).id as string;
    const account = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    expenseId = await account({ code: '5100', nameAr: 'مصروفات', type: 'expense' });
    cashId = await account({ code: '1100', nameAr: 'النقدية', type: 'asset' });
  });

  afterAll(async () => {
    await client?.end();
    await ctx?.close();
  });

  it('1. العكس — مرآة القيد تحمل أبعاد السطر كلها', async () => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: iso(0),
        lines: [
          { accountId: expenseId, debit: '120', costCenterId: centerId, salesmanId: employeeId, branchId },
          { accountId: cashId, credit: '120' },
        ],
      },
    });
    const entryId = data(posted.body).id as string;

    const reversed = await api(ctx.server, 'post', `/api/v1/journal-entries/${entryId}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: periodId, date: iso(0), reason: 'عكس للتحقق' },
    });
    expect(reversed.status).toBeLessThan(300);
    const reversalId = data(reversed.body).id as string;

    const stored = (await api(ctx.server, 'get', `/api/v1/journal-entries/${reversalId}`, { token: actor.token })).body as {
      data: { lines: Array<Record<string, unknown>> };
    };
    const line = stored.data.lines.find((row) => row.accountCode === '5100');
    // The mirror: amounts swapped …
    expect(Number(line?.debit)).toBe(0);
    expect(Number(line?.credit)).toBe(120);
    // … and every dimension carried, or the cost centre keeps money the ledger released.
    expect(line?.costCenterId).toBe(centerId);
    expect(line?.salesmanId).toBe(employeeId);
  });

  it('2. العكس — يصفّر الأثر ولا يضاعفه', async () => {
    const before = await balanceOf(expenseId);
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: iso(0),
        lines: [
          { accountId: expenseId, debit: '300', costCenterId: centerId },
          { accountId: cashId, credit: '300' },
        ],
      },
    });
    const entryId = data(posted.body).id as string;
    expect(near((await balanceOf(expenseId)) - before, 300)).toBe(true);

    await api(ctx.server, 'post', `/api/v1/journal-entries/${entryId}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: periodId, date: iso(0), reason: 'عكس للتحقق' },
    });
    // Not −300 twice, not 0 once: the two entries together are the whole story.
    expect(near(await balanceOf(expenseId), before)).toBe(true);

    const original = (await api(ctx.server, 'get', `/api/v1/journal-entries/${entryId}`, { token: actor.token })).body as {
      data: { status: string; reversalOf: string | null };
    };
    // The original keeps its status — the mirror is the reversal, and `reversalOf` on the
    // mirror is what marks it undone.
    expect(original.data.status).toBe('posted');
  });

  it('3. الإبطال — ما سمح به الحارس يُطبَّق (ترحيل 0047)', async () => {
    const tenantId = (await client.query('select current_setting($1, true) as t', ['app.tenant_id'])).rows[0]?.t;
    void tenantId;
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: iso(0),
        lines: [
          { accountId: expenseId, debit: '70' },
          { accountId: cashId, credit: '70' },
        ],
      },
    });
    const entryId = data(posted.body).id as string;
    const before = await balanceOf(expenseId);

    // The guard allows a `void` and must now apply it — this is the migration.
    const result = await client.query('update journal_entries set status = $1 where id = $2', ['void', entryId]);
    expect(result.rowCount).toBe(1);
    const after = await client.query('select status from journal_entries where id = $1', [entryId]);
    expect(after.rows[0]?.status).toBe('void');
    expect(near(before - (await balanceOf(expenseId)), 70)).toBe(true);
  });

  it('4. القيد المرحّل يبقى مصوناً — ما عدا الإبطال', async () => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: iso(0),
        lines: [
          { accountId: expenseId, debit: '11' },
          { accountId: cashId, credit: '11' },
        ],
      },
    });
    const entryId = data(posted.body).id as string;

    await expect(
      client.query('update journal_entries set description = $1 where id = $2', ['عبث', entryId]),
    ).rejects.toThrow(/immutable/);
    await expect(client.query('delete from journal_entries where id = $1', [entryId])).rejects.toThrow(/immutable/);
  });
});
