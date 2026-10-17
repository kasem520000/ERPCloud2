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
 * M6.5 — التسوية البنكية: من المطابقة إلى الترحيل القابل للمراجعة.
 *
 * The bank-feed plane could match a statement line to a posted invoice or voucher,
 * but a line the books never knew (bank charges, interest, wire fees) could only be
 * left pending or ignored forever. This suite walks the reviewable match→post flow:
 * the desk confirms the counter account, the line becomes a balanced two-line entry
 * through the same posting core every other module uses, and the line remembers
 * which entry carries it. The invariant from 0096 survives: suggestions pre-fill
 * the form, nothing is ever posted silently.
 */
describe('Treasury bank reconciliation — مطابقة ثم ترحيل قابل للمراجعة', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;

  let branchId = '';
  let bankLedgerAccountId = '';
  let chargesAccountId = '';
  let interestAccountId = '';
  let costCenterId = '';
  let linkedBankAccountId = '';
  let unlinkedBankAccountId = '';
  let statementId = '';
  let unlinkedStatementId = '';
  let marchPeriodId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const rows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const importStatement = async (bankAccountId: string, csv: string) => {
    const created = await api(ctx.server, 'post', '/api/v1/treasury/bank-statements/import', {
      token: actor.token,
      body: { bankAccountId, csv },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return data(created.body).statement as Record<string, unknown>;
  };

  const linesOf = async (id: string) => {
    const listed = await api(ctx.server, 'get', `/api/v1/treasury/bank-statements/${id}/lines`, { token: actor.token });
    expect(listed.status).toBe(200);
    return rows(listed.body);
  };

  const postLine = (statement: string, lineId: string, body: Record<string, unknown>, token = actor.token) =>
    api(ctx.server, 'post', `/api/v1/treasury/bank-statements/${statement}/lines/${lineId}/post`, { token, body });

  beforeAll(async () => {
    ctx = await createTestApp('treasury-bank-post');
    actor = await createActor(ctx, {
      tenantCode: 'tre-bnk',
      email: 'owner@tre-bnk.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.bank.view',
        'treasury.bank.manage',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.period.close',
        'accounting.period.view',
        'accounting.reports.view',
      ],
    });
    viewer = await createActor(ctx, {
      tenantId: actor.tenantId,
      tenantCode: 'tre-bnk',
      email: 'viewer@tre-bnk.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.bank.view'],
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

    bankLedgerAccountId = await account({ code: '1221', nameAr: 'البنك — الحساب الجاري', type: 'asset' });
    chargesAccountId = await account({ code: '4201', nameAr: 'مصاريف بنكية', type: 'expense' });
    interestAccountId = await account({ code: '4301', nameAr: 'إيرادات فوائد بنكية', type: 'revenue' });

    const costCenter = await api(ctx.server, 'post', '/api/v1/cost-centers', {
      token: actor.token,
      body: { code: 'CC-BNK', nameAr: 'مركز تكلفة الخزينة' },
    });
    expect(costCenter.status).toBe(201);
    costCenterId = data(costCenter.body).id as string;

    const periods = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });
    expect(periods.status).toBe(200);
    marchPeriodId = (rows(periods.body).find((row) => row.startDate === `${year}-03-01`) ?? {}).id as string;
    expect(marchPeriodId).toBeTruthy();

    const linked = await api(ctx.server, 'post', '/api/v1/treasury/bank-accounts', {
      token: actor.token,
      body: { bankName: 'بنك الرياض', accountNo: '608010167519', currency: 'SAR', accountId: bankLedgerAccountId },
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    linkedBankAccountId = data(linked.body).id as string;

    const unlinked = await api(ctx.server, 'post', '/api/v1/treasury/bank-accounts', {
      token: actor.token,
      body: { bankName: 'بنك التسوية غير المرتبط', accountNo: '9999', currency: 'SAR' },
    });
    expect(unlinked.status).toBe(201);
    unlinkedBankAccountId = data(unlinked.body).id as string;

    const statement = await importStatement(
      linkedBankAccountId,
      [
        'date,description,amount,balance',
        `${year}-03-02,إيداع فائدة شهرية,12,5012`,
        `${year}-03-05,رسوم تحويل بنكية,-25,4987`,
        `${year}-03-12,عمولة إدارة حساب,-5,4682`,
      ].join('\n'),
    );
    statementId = statement.id as string;
    expect(statementId).toBeTruthy();

    const unlinkedStatement = await importStatement(
      unlinkedBankAccountId,
      ['date,description,amount,balance', `${year}-03-08,رسوم بنك,10,1010`].join('\n'),
    );
    unlinkedStatementId = unlinkedStatement.id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. يرحّل فائدة بنكية (حركة موجبة): بنك مدين والإيراد دائن', async () => {
    const lines = await linesOf(statementId);
    const interestLine = lines.find((row) => row.description === 'إيداع فائدة شهرية');
    expect(interestLine?.status).toBe('pending');

    const posted = await postLine(statementId, interestLine!.id as string, { accountId: interestAccountId });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const payload = data(posted.body) as { line: Record<string, unknown>; journalEntry: Record<string, unknown> };
    expect(payload.line.status).toBe('posted');
    expect(payload.line.postedJournalEntryId).toBe(payload.journalEntry.id);
    expect(String(payload.journalEntry.number)).toMatch(/^JE-/);

    const entry = await api(ctx.server, 'get', `/api/v1/journal-entries/${payload.journalEntry.id}`, { token: actor.token });
    expect(entry.status).toBe(200);
    const entryBody = data(entry.body) as Record<string, unknown>;
    expect(entryBody.sourceType).toBe('bank_statement_line');
    expect(entryBody.sourceId).toBe(interestLine!.id);
    const entryLines = entryBody.lines as Array<Record<string, string>>;
    expect(entryLines).toHaveLength(2);
    const bankLeg = entryLines.find((line) => line.accountId === bankLedgerAccountId)!;
    const interestLeg = entryLines.find((line) => line.accountId === interestAccountId)!;
    expect(bankLeg.debit).toBe('12.0000');
    expect(bankLeg.credit).toBe('0.0000');
    expect(interestLeg.debit).toBe('0.0000');
    expect(interestLeg.credit).toBe('12.0000');
  });

  it('2. يرحّل رسوماً بنكية (حركة سالبة) مع مركز تكلفة، ويعرض رقم القيد في سطر الكشف', async () => {
    const lines = await linesOf(statementId);
    const chargeLine = lines.find((row) => row.description === 'رسوم تحويل بنكية');

    const posted = await postLine(statementId, chargeLine!.id as string, { accountId: chargesAccountId, costCenterId });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const payload = data(posted.body) as { journalEntry: Record<string, unknown> };

    const entry = await api(ctx.server, 'get', `/api/v1/journal-entries/${payload.journalEntry.id}`, { token: actor.token });
    const entryLines = (data(entry.body) as Record<string, unknown>).lines as Array<Record<string, string>>;
    const bankLeg = entryLines.find((line) => line.accountId === bankLedgerAccountId)!;
    const chargeLeg = entryLines.find((line) => line.accountId === chargesAccountId)!;
    expect(bankLeg.credit).toBe('25.0000');
    expect(chargeLeg.debit).toBe('25.0000');
    expect(chargeLeg.costCenterId).toBe(costCenterId);

    const refreshed = await linesOf(statementId);
    const settled = refreshed.find((row) => row.description === 'رسوم تحويل بنكية')!;
    expect(settled.status).toBe('posted');
    expect(settled.postedJournalNumber).toBe(payload.journalEntry.number);
  });

  it('3. لا ترحيل مكرراً ولا لحركة غير معلّقة، وفشل الترحيل يترك السطر معلّقاً', async () => {
    const lines = await linesOf(statementId);
    const interestLine = lines.find((row) => row.description === 'إيداع فائدة شهرية');
    const feeLine = lines.find((row) => row.description === 'عمولة إدارة حساب');

    const reposted = await postLine(statementId, interestLine!.id as string, { accountId: interestAccountId });
    expect(reposted.status).toBe(409);
    expect(codeOf(reposted.body)).toBe('BANK_LINE_NOT_PENDING');

    // The guards below fire while the line is still pending, and each failure must
    // roll back completely: no entry, the line stays pending for the next attempt.
    const sameAccount = await postLine(statementId, feeLine!.id as string, { accountId: bankLedgerAccountId });
    expect(sameAccount.status).toBe(422);
    expect(codeOf(sameAccount.body)).toBe('BANK_POST_ACCOUNT_SAME');

    const unknownAccount = await postLine(statementId, feeLine!.id as string, { accountId: '00000000-0000-0000-0000-000000000001' });
    expect(unknownAccount.status).toBe(422);
    expect(codeOf(unknownAccount.body)).toBe('BANK_ACCOUNT_LEDGER_INVALID');

    const stillPending = (await linesOf(statementId)).find((row) => row.description === 'عمولة إدارة حساب');
    expect(stillPending?.status).toBe('pending');

    const ignored = await api(ctx.server, 'post', `/api/v1/treasury/bank-statements/${statementId}/lines/${feeLine!.id}/ignore`, { token: actor.token, body: {} });
    expect(ignored.status).toBe(201);
    const postedAfterIgnore = await postLine(statementId, feeLine!.id as string, { accountId: chargesAccountId });
    expect(postedAfterIgnore.status).toBe(409);
    expect(codeOf(postedAfterIgnore.body)).toBe('BANK_LINE_NOT_PENDING');
  });

  it('4. يرفض الترحيل لحساب بنكي غير مرتبط بدمج دفتري، وبلا صلاحية إدارة', async () => {
    const lines = await linesOf(unlinkedStatementId);
    const unlinkedLine = lines[0];
    const refused = await postLine(unlinkedStatementId, unlinkedLine.id as string, { accountId: chargesAccountId });
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('BANK_ACCOUNT_UNLINKED');

    const forbidden = await postLine(statementId, unlinkedLine.id as string, { accountId: chargesAccountId }, viewer.token);
    expect(forbidden.status).toBe(403);

    const viewerLines = await api(ctx.server, 'get', `/api/v1/treasury/bank-statements/${statementId}/lines`, { token: viewer.token });
    expect(viewerLines.status).toBe(200);
  });

  it('5. لا إلغاء لسطر مرحَّل إلا بعد عكس قيده، ثم يُعاد ترحيله بمفتاح جديد', async () => {
    const lines = await linesOf(statementId);
    const chargeLine = lines.find((row) => row.description === 'رسوم تحويل بنكية')!;
    expect(chargeLine.status).toBe('posted');

    const blocked = await api(ctx.server, 'delete', `/api/v1/treasury/bank-statements/${statementId}/lines/${chargeLine.id}/match`, { token: actor.token });
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked.body)).toBe('BANK_LINE_POSTED');

    const reversal = await api(ctx.server, 'post', `/api/v1/journal-entries/${chargeLine.postedJournalEntryId}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: marchPeriodId, date: `${new Date().getUTCFullYear()}-03-31`, reason: 'عكس رسوم سُجّلت مرتين' },
    });
    expect(reversal.status, JSON.stringify(reversal.body)).toBeLessThan(300);

    const unblocked = await api(ctx.server, 'delete', `/api/v1/treasury/bank-statements/${statementId}/lines/${chargeLine.id}/match`, { token: actor.token });
    expect(unblocked.status).toBeLessThan(300);
    const backToPending = data(unblocked.body);
    expect(backToPending.status).toBe('pending');
    expect(backToPending.postedJournalEntryId).toBeNull();

    // The reversed entry keeps its key; the re-post lands under a fresh ordinal key.
    const reposted = await postLine(statementId, chargeLine.id as string, { accountId: interestAccountId, description: 'تصنيف جديد بعد المراجعة' });
    expect(reposted.status, JSON.stringify(reposted.body)).toBe(201);
    const payload = data(reposted.body) as { journalEntry: Record<string, unknown> };
    expect(payload.journalEntry.id).not.toBe(chargeLine.postedJournalEntryId);
  });

  it('6. التقرير يحتسب المرحَّل ضمن المسوّى، والكشف يكتمل حين لا يبقى معلّق', async () => {
    const report = await api(ctx.server, 'get', `/api/v1/treasury/bank-reconciliation?bank_account_id=${linkedBankAccountId}`, { token: actor.token });
    expect(report.status).toBe(200);
    const summary = data(report.body);
    // +12 فائدة مرحَّلة، −25 رسوم أعيد ترحيلها بعد العكس، −5 عمولة متجاهلة.
    expect(summary.postedLines).toBe(2);
    expect(summary.matchedLines).toBe(0);
    expect(summary.pendingLines).toBe(0);
    expect(summary.ignoredLines).toBe(1);
    expect(summary.postedMovement).toBe('-13.0000');

    const statement = await api(ctx.server, 'get', `/api/v1/treasury/bank-statements/${statementId}`, { token: actor.token });
    expect(data(statement.body).status).toBe('reconciled');
  });
});
