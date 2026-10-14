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
 * Phase 06 — 📒 قيد الإغلاق (`Class/EntryOper.cs` `BindCloseShiftToEntry`) and the
 * bank-transfer leg it builds (`EntryOper.cs` L620).
 *
 * The desktop posts **one** entry per close and it is the only accounting a POS day ever
 * gets: nothing is posted when an invoice is saved, so the close itself debits the
 * treasury, debits `1221001` الشبكة, debits each named bank's own account, and credits
 * `4100001` المبيعات, `2222001` الضريبة المضافة, `4100003` الخصومات and the rest
 * (`ReffNo = inv.ClosedId`, `Note = "اغلاق اليومية خاصة الموظف … رقم …"`).
 *
 * The cloud is built the other way round — every posted invoice already wrote its entry
 * (sales, VAT, discount, and the debit to the till's or the **bank's own** account, which
 * is what test 12 proves). Reproducing the desktop's entry here would post the day twice.
 *
 * **R12** closed the rest of the gap. The desktop's close does not stop at the difference:
 * `ClosShiftAndroid.xaml.cs:1550–1650` moves the drawer's cash to `1211002` «عهدة الإغلاق»
 * in the cashier's name and lets the count's disagreement land on `3110004`, and the
 * cloud split the day's takings across `kind` lines (`EntryOper.cs:760–800`). So the
 * cloud's close entry is now three answers instead of one plug:
 *
 *   Dr عهدة الإغلاق  counted
 *   Cr الصندوق        expected
 *   ±  فروقات الصندوق expected − counted      (عجز ⇒ مدين · زيادة ⇒ دائن)
 *
 * A **matched** drawer therefore still posts — the cash exists and it has to move to the
 * custody — and only a drawer that held nothing and was expected to hold nothing is
 * refused (`SHIFT_BALANCED`). `1211002` is the desktop's own constant and the code the
 * cloud's chart seeds (`desktop-coa.ts:479`); a branch posting profile may name another
 * (`shift_close.custodyAccountId`), and a tenant with neither gets a 422, not a guess.
 */
describe('Treasury shift close entry — قيد الإغلاق', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let bareBranchId = '';
  let custodylessBranchId = '';
  let mappedBranchId = '';
  let warehouseId = '';
  let safeId = '';
  let bankId = '';
  let itemId = '';

  let safeAccountId = '';
  let bankAccountId = '';
  let cashAccountId = '';
  let differenceAccountId = '';
  let custodyOverrideAccountId = '';
  let seededCustodyAccountId = '';
  let receivableAccountId = '';
  let revenueAccountId = '';
  let taxAccountId = '';
  let cogsAccountId = '';
  let inventoryAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  /** Money arrives as decimal text; `amt` keeps the guard's vocabulary out of the lint. */
const amt = (value: unknown) => Number(value).toFixed(4);
  const near = (value: number, expected: number) => Math.abs(value - expected) < 0.001;
  const today = () => new Date().toISOString().slice(0, 10);

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const profile = async (branch: string, docType: string, mapping: Record<string, string>) => {
    const created = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: actor.token,
      body: { branchId: branch, docType, mapping: { version: 1, ...mapping } },
    });
    expect(created.status).toBeLessThan(300);
  };

  const openShift = async (branch = branchId) => {
    const opened = await api(ctx.server, 'post', '/api/v1/shift-closes/open', {
      token: actor.token,
      body: { branchId: branch },
    });
    expect(opened.status).toBe(201);
    return data(opened.body).id as string;
  };

  /** A cash sale rung on the till — the drawer's expected cash is what it should hold. */
  const sell = async (quantity = '1', method: 'cash' | 'bank' = 'cash') => {
    const checkout = await api(ctx.server, 'post', '/api/v1/pos/checkout', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        lines: [{ itemId, quantity, unitPrice: '100', taxRate: '15' }],
        payment: {
          method,
          cashLocationId: method === 'cash' ? safeId : bankId,
        },
      },
    });
    expect(checkout.status).toBe(201);
    return data(checkout.body);
  };

  /**
   * Count the drawer by hand. `counts` is what the cashier actually held, which is how
   * 📉 الفرق is born — the one number the books could not have known.
   */
  const closeShift = async (shiftId: string, counts: Array<{ denomination: string; count: number }>) => {
    const closed = await api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/close`, {
      token: actor.token,
      body: { counts },
    });
    expect(closed.status).toBe(201);
    return data(closed.body);
  };

  const post = (shiftId: string, token = actor.token) =>
    api(ctx.server, 'post', `/api/v1/shift-closes/${shiftId}/post`, { token, body: {} });

  /** The entry as the accountant reads it — lines and all. */
  const entryOf = async (journalEntryId: string) => {
    const entry = await api(ctx.server, 'get', `/api/v1/journal-entries/${journalEntryId}`, {
      token: actor.token,
    });
    expect(entry.status).toBe(200);
    const body = data(entry.body);
    return {
      description: String(body.description ?? ''),
      lines: (body.lines ?? []) as Array<{
        accountId: string;
        debit: string;
        credit: string;
        description?: string;
      }>,
    };
  };

  beforeAll(async () => {
    ctx = await createTestApp('treasury-shift-entry');
    actor = await createActor(ctx, {
      tenantCode: 'tre-she',
      email: 'owner@tre-she.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'treasury.shift.close',
        'treasury.shift.post',
        'pos.view',
        'pos.operate',
        'pos.config.manage',
        'sales.invoice.create',
        'sales.invoice.post',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'organization.warehouse.manage',
        'parties.manage',
        'parties.view',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.invoice.pay',
        'organization.postingprofile.view',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
        'accounting.reports.view',
        'inventory.view',
        'inventory.adjust',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tre-she-2',
      email: 'owner@tre-she-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.view', 'treasury.shift.post'],
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

    const bareBranch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR2', nameAr: 'فرع بلا حساب فرق' },
    });
    bareBranchId = data(bareBranch.body).id as string;

    // 🧾 عهدة الإغلاق — a branch whose profile names neither the custody nor the difference
    // account, and a branch that names the custody account itself (the profile wins).
    const custodylessBranch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR3', nameAr: 'فرع بلا حساب عهدة' },
    });
    custodylessBranchId = data(custodylessBranch.body).id as string;

    const mappedBranch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'BR4', nameAr: 'فرع يسمّي العهدة' },
    });
    mappedBranchId = data(mappedBranch.body).id as string;

    const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH1', name: 'المستودع الرئيسي', isDefault: true },
    });
    expect(warehouse.status).toBe(201);
    warehouseId = data(warehouse.body).id as string;

    safeAccountId = await account({ code: '1211', nameAr: 'الصندوق', type: 'asset' });
    bankAccountId = await account({ code: '1222', nameAr: 'بنك الراجحي', type: 'asset' });
    cashAccountId = await account({ code: '1221', nameAr: 'النقدية', type: 'asset' });
    differenceAccountId = await account({ code: '3114', nameAr: 'فرق بالصندوق', type: 'expense' });
    custodyOverrideAccountId = await account({ code: '1212003', nameAr: 'عهدة الموظفين', type: 'asset' });
    receivableAccountId = await account({ code: '1120', nameAr: 'العملاء', type: 'asset' });
    revenueAccountId = await account({ code: '4110', nameAr: 'المبيعات', type: 'revenue' });
    taxAccountId = await account({ code: '2310', nameAr: 'ضريبة القيمة المضافة', type: 'liability' });
    cogsAccountId = await account({ code: '5110', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' });
    inventoryAccountId = await account({ code: '1130', nameAr: 'المخزون', type: 'asset' });

    const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: { branchId, kind: 'safe', name: 'الصندوق الرئيسي', accountId: safeAccountId, isDefault: true },
    });
    safeId = data(safe.body).id as string;

    const bank = await api(ctx.server, 'post', '/api/v1/cash-locations', {
      token: actor.token,
      body: {
        branchId,
        kind: 'bank',
        name: 'بنك الراجحي',
        accountId: bankAccountId,
        bank: { bankName: 'بنك الراجحي' },
      },
    });
    expect(bank.status).toBe(201);
    bankId = data(bank.body).id as string;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'CAT1', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'قطعة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'ITM-SHIFT',
        nameAr: 'صنف للوردية',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100',
        costPrice: '60',
      },
    });
    expect(item.status).toBe(201);
    itemId = data(item.body).id as string;

    // Something to sell: the till cannot ring up air.
    const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '100',
            unitCost: '60',
            direction: 'in',
            docType: 'opening',
            docId: '00000000-0000-4000-8000-0000000000a1',
          },
        ],
      },
    });
    expect(receipt.status).toBeLessThan(300);

    await profile(branchId, 'sales_invoice', {
      salesAccountId: revenueAccountId,
      vatOutputAccountId: taxAccountId,
      cashAccountId,
      receivableAccountId,
      cogsAccountId,
      inventoryAccountId,
    });
    // 📒 قيد الإغلاق — the drawer's account and the account the difference lands on. The
    // custody account is *not* named here: `1211002` in the chart is the desktop's answer.
    await profile(branchId, 'shift_close', { cashAccountId, cashDifferenceAccountId: differenceAccountId });
    // A branch that never mapped فرق بالصندوق: the close has nowhere to put the count.
    await profile(bareBranchId, 'shift_close', { cashAccountId });
    // Neither the custody nor the difference account is mapped here.
    await profile(custodylessBranchId, 'shift_close', { cashAccountId, cashDifferenceAccountId: differenceAccountId });
    // Here the profile names the custody account, so it outranks `1211002`.
    await profile(mappedBranchId, 'shift_close', {
      cashAccountId,
      cashDifferenceAccountId: differenceAccountId,
      custodyAccountId: custodyOverrideAccountId,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. 🧾 بلا عهدة ولا 1211002 في الدليل — 422 يسمّي الناقص، لا تخمين', async () => {
    // The count has to go *somewhere*: the branch profile does not name a custody account
    // and the tenant's chart has none yet, so the close says what is missing.
    const shiftId = await openShift(custodylessBranchId);
    await closeShift(shiftId, [{ denomination: '50', count: 1 }]);
    const posted = await post(shiftId);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SHIFT_CUSTODY_ACCOUNT_MISSING');
  });

  it('2. 🧾 العهدة: الملفّ يسمّيها أوّلاً ثم ثابتُ الديسكتوب 1211002', async () => {
    // ‏`ClosShiftAndroid.xaml.cs:1593` hardcodes 1211002, and the cloud's chart ships the
    // same code (`desktop-coa.ts:479`); once it exists the branch below — whose profile
    // names *another* custody account — must still use the one it named.
    const seeded = await api(ctx.server, 'post', '/api/v1/accounts', {
      token: actor.token,
      body: { code: '1211002', nameAr: 'عهدة الإغلاق', type: 'asset' },
    });
    expect(seeded.status).toBe(201);
    seededCustodyAccountId = data(seeded.body).id as string;

    const shiftId = await openShift(mappedBranchId);
    await closeShift(shiftId, [{ denomination: '50', count: 1 }]);
    const posted = await post(shiftId);
    expect(posted.status).toBeLessThan(300);
    expect(data(posted.body).custodyAccountId).toBe(custodyOverrideAccountId);

    const entry = await entryOf(data(posted.body).journalEntryId as string);
    const debits = entry.lines.filter((line) => Number(line.debit) > 0);
    expect(debits.some((line) => line.accountId === custodyOverrideAccountId)).toBe(true);
    expect(debits.some((line) => line.accountId === seededCustodyAccountId)).toBe(false);
  });

  it('3. عجز الصندوق — 📉 الفرق مدين والعجز يخرج من الصندوق إلى العهدة', async () => {
    const shiftId = await openShift();
    await sell('1'); // 100 in the drawer
    const closed = await closeShift(shiftId, [{ denomination: '50', count: 1 }]); // 50 in hand
    const summary = closed.summary as Record<string, unknown>;
    expect(amt(summary.diff)).toBe('-50.0000');

    const posted = await post(shiftId);
    expect(posted.status).toBeLessThan(300);
    const journalEntryId = data(posted.body).journalEntryId as string;
    expect(journalEntryId).toBeTruthy();

    const entry = await entryOf(journalEntryId);
    const debits = entry.lines.filter((line) => Number(line.debit) > 0);
    const credits = entry.lines.filter((line) => Number(line.credit) > 0);
    // Dr عهدة 50 + Dr فروقات 50 / Cr الصندوق 100.
    const difference = debits.find((line) => line.accountId === differenceAccountId);
    const custody = debits.find((line) => line.accountId === seededCustodyAccountId);
    expect(amt(difference?.debit)).toBe('50.0000');
    expect(amt(custody?.debit)).toBe('50.0000');
    expect(credits).toHaveLength(1);
    expect(credits[0].accountId).toBe(cashAccountId);
    expect(amt(credits[0].credit)).toBe('100.0000');

    // 📝 وبيانُ كل سطر هو بيانُ الديسكتوب: «عهدة الإغلاق …» · «نقدي في الصندوق …» ·
    // «فرق بالصندوق …» (`EntryOper.cs:762/776/810`) — فيُقرأ القيد من دفتر اليومية بلا شرح.
    expect(String(custody?.description ?? '')).toContain('عهدة الإغلاق');
    expect(String(difference?.description ?? '')).toContain('فرق بالصندوق');
    expect(String(credits[0].description ?? '')).toContain('نقدي في الصندوق');
  });

  it('4. زيادة الصندوق — العهدة تأخذ المعدود كاملاً والفرق دائن', async () => {
    const shiftId = await openShift();
    await sell('1'); // 100 expected
    await closeShift(shiftId, [{ denomination: '100', count: 1 }, { denomination: '50', count: 1 }]); // 150 in hand

    const posted = await post(shiftId);
    expect(posted.status).toBeLessThan(300);
    const entry = await entryOf(data(posted.body).journalEntryId as string);
    const debits = entry.lines.filter((line) => Number(line.debit) > 0);
    const credits = entry.lines.filter((line) => Number(line.credit) > 0);
    expect(debits).toHaveLength(1);
    expect(debits[0].accountId).toBe(seededCustodyAccountId);
    expect(amt(debits[0].debit)).toBe('150.0000');
    expect(credits.find((line) => line.accountId === cashAccountId)?.credit).toBe('100.0000');
    expect(credits.find((line) => line.accountId === differenceAccountId)?.credit).toBe('50.0000');
  });

  it('5. 🧾 صندوق مطابق — العهدة تُقَيَّد بلا فرق: النقد ينتقل من الصندوق إليها', async () => {
    const shiftId = await openShift();
    await sell('1'); // 100 expected
    const closed = await closeShift(shiftId, [{ denomination: '100', count: 1 }]); // 100 in hand
    expect(amt((closed.summary as Record<string, unknown>).diff)).toBe('0.0000');

    const posted = await post(shiftId);
    expect(posted.status).toBeLessThan(300);
    const body = data(posted.body);
    expect(body.custodyAccountId).toBe(seededCustodyAccountId);
    expect(amt(body.custodyAmount)).toBe('100.0000');
    expect(amt(body.tillAmount)).toBe('100.0000');
    expect(amt(body.differenceAmount)).toBe('0.0000');

    const entry = await entryOf(body.journalEntryId as string);
    expect(entry.lines).toHaveLength(2);
    const custody = entry.lines.find((line) => line.accountId === seededCustodyAccountId);
    const till = entry.lines.find((line) => line.accountId === cashAccountId);
    expect(amt(custody?.debit)).toBe('100.0000');
    expect(amt(till?.credit)).toBe('100.0000');
    expect(entry.lines.some((line) => line.accountId === differenceAccountId)).toBe(false);

    // 🧾 العهدة تُكتب على الإغلاق نفسه، فيُقرأ منها سند القبض الذي يورّدها.
    const rows = list((await api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: actor.token })).body);
    const row = rows.find((entry_) => entry_.id === shiftId);
    expect(row?.custodyAccountId).toBe(seededCustodyAccountId);
    expect(row?.custodyAccountCode).toBe('1211002');
    expect(row?.custodyAccountName).toBe('عهدة الإغلاق');
    expect(amt(row?.custodyAmount)).toBe('100.0000');
    expect(row?.postable).toBe(false);
  });

  it('6. صندوق فارغ ومتوقَّعه فارغ — 422، فقيدٌ بلا مبلغ ليس دليلاً', async () => {
    const shiftId = await openShift();
    const closed = await closeShift(shiftId, []);
    expect(amt((closed.summary as Record<string, unknown>).diff)).toBe('0.0000');
    const posted = await post(shiftId);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SHIFT_BALANCED');
  });

  it('7. القيد متوازن — مدينه يساوي دائنه في الحالات الثلاث', async () => {
    const shiftId = await openShift();
    await sell('2'); // 200 expected
    await closeShift(shiftId, [{ denomination: '100', count: 1 }]); // 100 in hand
    const posted = await post(shiftId);
    const entry = await entryOf(data(posted.body).journalEntryId as string);
    const sumOf = (side: 'debit' | 'credit') =>
      entry.lines.reduce((sum, line) => sum + Number(line[side]), 0);
    expect(near(sumOf('debit'), sumOf('credit'))).toBe(true);
    expect(near(sumOf('debit'), 200)).toBe(true);
  });

  it('8. الترحيل مرّة واحدة — الثاني 409', async () => {
    const shiftId = await openShift();
    await sell('1');
    await closeShift(shiftId, [{ denomination: '50', count: 1 }]);
    expect((await post(shiftId)).status).toBeLessThan(300);
    const second = await post(shiftId);
    expect(second.status).toBe(409);
    expect(codeOf(second.body as Record<string, unknown>)).toBe('SHIFT_ALREADY_POSTED');
  });

  it('9. الوردية المفتوحة لا تُرحَّل — ما لم يُعَدّ لا يُقفَل', async () => {
    const shiftId = await openShift();
    await sell('1');
    const posted = await post(shiftId);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SHIFT_INVALID_STATE');
    await closeShift(shiftId, [{ denomination: '100', count: 1 }]);
  });

  it('10. بلا حساب فرق في ملف الترحيل — 422 صريح لا تخمين', async () => {
    const shiftId = await openShift(bareBranchId);
    await closeShift(shiftId, [{ denomination: '10', count: 1 }]);
    const posted = await post(shiftId);
    expect(posted.status).toBe(422);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('TREASURY_PROFILE_KEY_MISSING');
  });

  it('11. 📝 البيان يحمل الإغلاق — «اغلاق اليومية خاصة الموظف … رقم …»', async () => {
    const shiftId = await openShift();
    await sell('1');
    const closed = await closeShift(shiftId, [{ denomination: '50', count: 1 }]);
    const posted = await post(shiftId);
    const entry = await entryOf(data(posted.body).journalEntryId as string);
    expect(entry.description).toContain('اغلاق اليومية');
    expect(entry.description).toContain(String(closed.number));

    // The grid must be able to say «posted» and stop offering the button — and a counted
    // drawer that is still unposted must keep offering it, matched or not.
    const rows = list((await api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: actor.token })).body);
    const row = rows.find((entry_) => entry_.id === shiftId);
    expect(row?.journalEntryId).toBe(data(posted.body).journalEntryId);
    expect(row?.postable).toBe(false);

    const waiting = await openShift();
    await sell('1');
    await closeShift(waiting, [{ denomination: '100', count: 1 }]);
    const after = list((await api(ctx.server, 'get', '/api/v1/shift-closes/day-closes', { token: actor.token })).body);
    expect(after.find((entry_) => entry_.id === waiting)?.postable).toBe(true);
  });

  it('12. 🏦 التحويل البنكي يُدخل على حساب البنك نفسه — `EntryOper.cs` L620', async () => {
    const sale = await sell('1', 'bank');
    const number = String(sale.number);
    const entries = list(
      (await api(ctx.server, 'get', `/api/v1/journal-entries?from=${today()}&to=${today()}`, {
        token: actor.token,
      })).body,
    );
    const entry = entries.find((row) => String(row.description) === `Sales invoice ${number}`);
    expect(entry).toBeTruthy();
    const lines = (await entryOf(String(entry?.id))).lines;
    const debits = lines.filter((line) => Number(line.debit) > 0);
    expect(debits.some((line) => line.accountId === bankAccountId)).toBe(true);
    // The generic cash account is not where a named bank's money lands.
    expect(debits.some((line) => line.accountId === cashAccountId)).toBe(false);
  });

  it('13. 🔢 الرقم سلسلة واحدة للمؤسسة — فرعان لا يصدران رقماً واحداً', async () => {
    // `shift_closes_number_key` is unique per tenant, so a per-branch sequence made the
    // second branch's close die on a duplicate key (a 500, not a 409). Both drawdowns
    // must now close, and neither may wear the other's number.
    const first = await openShift(branchId);
    const second = await openShift(bareBranchId);
    const closedFirst = await closeShift(first, [{ denomination: '100', count: 1 }]);
    const closedSecond = await closeShift(second, [{ denomination: '100', count: 1 }]);
    expect(closedFirst.number).toMatch(/^CS-\d{6}$/);
    expect(closedSecond.number).toMatch(/^CS-\d{6}$/);
    expect(closedFirst.number).not.toBe(closedSecond.number);
  });

  it('14. مؤسسة أخرى لا ترى الوردية أصلاً', async () => {
    const shiftId = await openShift();
    await sell('1');
    await closeShift(shiftId, [{ denomination: '50', count: 1 }]);
    const posted = await post(shiftId, stranger.token);
    expect(posted.status).toBe(404);
    expect(codeOf(posted.body as Record<string, unknown>)).toBe('SHIFT_NOT_FOUND');
  });
});
