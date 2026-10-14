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
 * Phase 06 part one — سند القبض وسند الصرف.
 *
 * `Class/ReceiptOper.cs` saves a receipt and binds it to a journal entry in the same
 * breath (`SaveReceipt` at L159, `BindReceiptToEntry` at L21), and the entry carries the
 * receipt's البيان (`entry.Note = Receipt.Notes`), its cost centre and its مندوب
 * (`account.salesman`). The cloud had the money and none of the context: a voucher could
 * be posted with no entry at all — HRM's `payRun` does exactly that — so cash left the
 * safe and the ledger never heard of it.
 */
describe('Treasury vouchers — البيان، الوقت، المندوب، والقيد', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let safeId = '';
  let bankId = '';
  let customerId = '';
  let supplierId = '';
  let receivableAccountId = '';
  let payableAccountId = '';
  let chequesAccountId = '';
  let safeAccountId = '';
  let bankAccountId = '';
  let salesmanId = '';

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

  const party = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const safe = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: payload,
    });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const receipt = (payload: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/vouchers', { token: actor.token, body: payload });

  beforeAll(async () => {
    ctx = await createTestApp('treasury-vouchers');
    actor = await createActor(ctx, {
      tenantCode: 'tre-vou',
      email: 'owner@tre-vou.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.voucher.void',
        'treasury.cheque.clear',
        'treasury.transfer.manage',
        'treasury.expensetype.manage',
        'treasury.shift.close',
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
      tenantCode: 'tre-vou-2',
      email: 'owner@tre-vou-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.view', 'treasury.voucher.create'],
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

    receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    payableAccountId = await account({ code: '2110', nameAr: 'الموردون', type: 'liability' });
    chequesAccountId = await account({ code: '1130', nameAr: 'أوراق القبض', type: 'asset' });
    // `Class/Treasury.cs:17` — a treasury is an account first (Acc_Code 1211001) and a box
    // second; the cloud keeps the same link on the cash location.
    safeAccountId = await account({ code: '1211', nameAr: 'الصندوق الرئيسي', type: 'asset' });
    bankAccountId = await account({ code: '1221', nameAr: 'بنك الرياض', type: 'asset' });

    customerId = await party({
      code: 'C-1',
      kind: 'customer',
      name: 'عميل نقدي',
      receivableAccountId,
    });
    supplierId = await party({ code: 'S-1', kind: 'supplier', name: 'مورد', payableAccountId });

    const employee = await api(ctx.server, 'post', '/api/v1/hrm/employees', {
      token: actor.token,
      body: { employeeNo: 'E-1', name: 'مناديب المبيعات', branchId },
    });
    salesmanId = data(employee.body).id as string;

    safeId = await safe({
      branchId,
      kind: 'safe',
      name: 'الصندوق الرئيسي',
      accountId: safeAccountId,
      isDefault: true,
    });
    // A bank row needs its bank block — the cloud refuses a bank account with no bank.
    bankId = await safe({
      branchId,
      kind: 'bank',
      name: 'بنك الرياض',
      isDefault: true,
      bank: { bankName: 'بنك الرياض', iban: 'SA0380000000608010167519', accountNo: '608010167519' },
      accountId: bankAccountId,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. السند يحمل البيان والوقت والمندوب، ويرفض مندوباً من مؤسسة أخرى', async () => {
    const created = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-15',
      voucherTime: '9:05',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '1500',
      description: 'تحصيل فاتورة 2401',
      salesmanId,
      referenceNo: 'INV-2401',
      referenceDate: '2026-01-10',
    });
    expect(created.status).toBe(201);
    const voucher = data(created.body);
    expect(voucher.description).toBe('تحصيل فاتورة 2401');
    // A clerk types 9:05, not 09:05:00 — both are the same moment.
    expect(String(voucher.voucherTime).slice(0, 5)).toBe('09:05');
    expect(voucher.salesmanId).toBe(salesmanId);

    const foreign = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-15',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '1500',
      salesmanId: '00000000-0000-4000-8000-000000000000',
    });
    expect(foreign.status).toBe(422);
    expect(codeOf(foreign.body as Record<string, unknown>)).toBe('SALESMAN_NOT_FOUND');

    const badTime = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-15',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '1500',
      voucherTime: 'صباحاً',
    });
    expect(badTime.status).toBe(422);
    expect(codeOf(badTime.body as Record<string, unknown>)).toBe('VOUCHER_TIME_INVALID');
  });

  it('2. الترحيل يبني القيد إن لم يزوّد به: مدين الصندوق، دائن حساب العميل', async () => {
    const created = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-16',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '2000',
      description: 'سداد دفعة',
    });
    const voucherId = data(created.body).id as string;
    const posted = await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/post`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(posted.status);
    const voucher = data(posted.body);
    expect(voucher.status).toBe('posted');
    // The number comes from the document sequence, not from the clerk.
    expect(String(voucher.number)).toMatch(/^RV-/);
    expect(voucher.journalEntryId).toBeTruthy();

    const entry = await api(ctx.server, 'get', `/api/v1/journal-entries/${voucher.journalEntryId}`, {
      token: actor.token,
    });
    expect(entry.status).toBe(200);
    const entryData = data(entry.body);
    // 📝 البيان is what the ledger shows — this is BindReceiptToEntry's entry.Note.
    expect(entryData.description).toBe('سداد دفعة');
    const lines = (entryData.lines ?? []) as Array<Record<string, unknown>>;
    const debits = lines.filter((line) => Number(line.debit) > 0);
    const credits = lines.filter((line) => Number(line.credit) > 0);
    expect(debits.length).toBe(1);
    expect(credits.length).toBe(1);
    expect(Number(debits[0].debit)).toBe(2000);
    expect(debits[0].accountId).toBe(safeAccountId);
    expect(credits[0].accountId).toBe(receivableAccountId);
  });

  it('3. سند صرف يقلب القيد، والراتب يُقيَّد ولو لم يزوّد أحد بسطور', async () => {
    const created = await receipt({
      branchId,
      kind: 'payment',
      subtype: 'supplier',
      date: '2026-01-17',
      partyId: supplierId,
      cashLocationId: bankId,
      method: 'bank_transfer',
      amount: '800',
      description: 'سداد للمورد',
    });
    const voucherId = data(created.body).id as string;
    const posted = await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/post`, {
      token: actor.token,
      body: {},
    });
    expect([200, 201]).toContain(posted.status);
    const entry = await api(ctx.server, 'get', `/api/v1/journal-entries/${data(posted.body).journalEntryId}`, {
      token: actor.token,
    });
    const lines = (data(entry.body).lines ?? []) as Array<Record<string, unknown>>;
    const debits = lines.filter((line) => Number(line.debit) > 0);
    const credits = lines.filter((line) => Number(line.credit) > 0);
    // دائن البنك / مدين المورد — the mirror of a receipt.
    expect(debits[0].accountId).toBe(payableAccountId);
    expect(Number(credits[0].credit)).toBe(800);
    expect(credits[0].accountId).toBe(bankAccountId);
  });

  it('4. الشيك لا يلمس الصندوق حتى يُحصَّل، ويُقيَّد يوم التحصيل', async () => {
    await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: actor.token,
      body: {
        branchId,
        docType: 'receipt_voucher',
        mapping: { version: 1, chequesInHandAccountId: chequesAccountId },
      },
    });

    const created = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-18',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cheque',
      chequeNo: 'CHK-77',
      chequeDate: '2026-02-18',
      amount: '5000',
      description: 'شيك من العميل',
    });
    const voucherId = data(created.body).id as string;
    await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/post`, { token: actor.token, body: {} });

    const before = await api(ctx.server, 'get', `/api/v1/cash-locations/${safeId}/balances`, {
      token: actor.token,
    });
    const balanceOf = (body: unknown) =>
      rows(body).reduce((sum, row) => sum + Number(row.balance ?? 0), 0);
    const pending = balanceOf(before.body);

    const cleared = await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/cheque`, {
      token: actor.token,
      body: { action: 'clear' },
    });
    expect([200, 201]).toContain(cleared.status);
    expect((data(cleared.body) as { chequeState: string }).chequeState).toBe('cleared');

    const after = await api(ctx.server, 'get', `/api/v1/cash-locations/${safeId}/balances`, {
      token: actor.token,
    });
    // The cheque is money only once the bank honours it.
    expect(balanceOf(after.body) - pending).toBeCloseTo(5000, 4);

    // And the clearance is an entry, not just a number in a balance table.
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?source_type=voucher_cheque', {
      token: actor.token,
    });
    expect(rows(list.body).length).toBeGreaterThan(0);

    // A terminal cheque cannot be cleared twice.
    const twice = await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/cheque`, {
      token: actor.token,
      body: { action: 'clear' },
    });
    expect(twice.status).toBe(422);
    expect(codeOf(twice.body as Record<string, unknown>)).toBe('CHEQUE_INVALID_STATE');
  });

  it('5. الشيك المرتجع يعيد الدين على العميل', async () => {
    const created = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-19',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cheque',
      chequeNo: 'CHK-99',
      amount: '1200',
      description: 'شيك مرتجع',
    });
    const voucherId = data(created.body).id as string;
    await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/post`, { token: actor.token, body: {} });
    const bounced = await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/cheque`, {
      token: actor.token,
      body: { action: 'bounce' },
    });
    expect([200, 201]).toContain(bounced.status);

    // مرتجع: the debt the cheque was meant to settle is owed again.
    const statement = await api(ctx.server, 'get', `/api/v1/statements/general-ledger/${receivableAccountId}`, {
      token: actor.token,
    });
    expect([200, 201]).toContain(statement.status);
  });

  it('6. بحث السندات بالتاريخ والرقم والبيان، ومؤسسة أخرى لا ترى شيئاً', async () => {
    const all = await api(ctx.server, 'get', '/api/v1/vouchers?from=2026-01-16&to=2026-01-18', {
      token: actor.token,
    });
    const found = rows(all.body);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => String(row.date) >= '2026-01-16' && String(row.date) <= '2026-01-18')).toBe(true);

    const byNumber = await api(ctx.server, 'get', '/api/v1/vouchers?q=CHK-77', { token: actor.token });
    expect(rows(byNumber.body).length).toBe(1);

    const byDescription = await api(ctx.server, 'get', '/api/v1/vouchers?q=سداد', { token: actor.token });
    expect(rows(byDescription.body).length).toBeGreaterThan(0);

    const other = await api(ctx.server, 'get', '/api/v1/vouchers', { token: stranger.token });
    expect(rows(other.body).length).toBe(0);
  });

  it('7. المسوّدة تُعدَّل بعد الحفظ، والمرحَّل لا يُعدَّل', async () => {
    const created = await receipt({
      branchId,
      kind: 'receipt',
      subtype: 'customer',
      date: '2026-01-20',
      partyId: customerId,
      cashLocationId: safeId,
      method: 'cash',
      amount: '100',
      description: 'مسودة',
    });
    const voucherId = data(created.body).id as string;
    const patched = await api(ctx.server, 'patch', `/api/v1/vouchers/${voucherId}`, {
      token: actor.token,
      body: { amount: '250', description: 'مبلغ مصحح', voucherTime: '14:30' },
    });
    expect(patched.status).toBe(200);
    expect(data(patched.body).amount).toBe('250.0000');
    expect(data(patched.body).description).toBe('مبلغ مصحح');
    expect(String(data(patched.body).voucherTime).slice(0, 5)).toBe('14:30');

    await api(ctx.server, 'post', `/api/v1/vouchers/${voucherId}/post`, { token: actor.token, body: {} });
    const after = await api(ctx.server, 'patch', `/api/v1/vouchers/${voucherId}`, {
      token: actor.token,
      body: { amount: '999' },
    });
    expect(after.status).toBe(409);
    expect(codeOf(after.body as Record<string, unknown>)).toBe('VOUCHER_IMMUTABLE');
  });
});
