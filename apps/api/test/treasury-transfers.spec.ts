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
 * Phase 06 part six — مناقلة (`Form_WPF/frmSafesTransfer.xaml`).
 *
 * The window is `مناقلة` and its workflow is three states across two safes:
 *
 *   `INSERT INTO SafesTransfer(id, date, safe_from, safe_to, branch, IsSent, IsReceived,
 *                              IS_Deleted) VALUES(…, 0, 0, 0)`
 *   `UPDATE SafesTransfer SET IsSent = 1`      — `✅ اعتماد الإرسال`
 *   `UPDATE SafesTransfer SET IsReceived = 1`  — `✅ تأكيد الاستلام`
 *
 * with the refusals that make the states mean something: a transfer already sent is
 * sent («المناقلة تم إرسالها سابقاً»), a transfer not sent cannot be received, and a
 * receipt cannot exceed what was sent («لا يمكن استلام كمية أكبر من الكمية المرسلة»).
 *
 * **The finding that shaped this part:** `SafesTransfer` has **no amount column**. Its
 * sub-table carries items (`ItemId`, `value` = quantity, `AvrgCost`, `ReceivedValue`,
 * `Diff`), and `safe_from`/`safe_to` come from `Safes`, which in this product is the
 * store/safe list. So `frmSafesTransfer` — and `Reports/rptSafeTransfer.repx`, whose
 * fields are الصنف · الفئة · المستودع · الباركود · الكمية — is a **مناقلة أصناف بين
 * المخازن**, and the desktop moves money between safes with a سند صرف and a سند قبض.
 *
 * What the cloud therefore needed for the treasury was the money equivalent of that
 * lifecycle on `/cash-transfers` (draft → sent → received, with `🗑️ حذف` for a draft
 * and `🔍 البحث` by `🔢 رقم التحويل` and `📅 من تاريخ`/`إلى تاريخ`), and — for the
 * desktop's own item form — the same search on `/inventory/transfers`. Both are tested
 * here: the money one directly, the item one as the search that window was built around.
 */
describe('Treasury cash transfers — مناقلة الخزن', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let safeAId = '';
  let safeBId = '';
  let warehouseAId = '';
  let warehouseBId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const account = async (payload: Record<string, unknown>) => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', { token: actor.token, body: payload });
    expect(created.status).toBe(201);
    return data(created.body).id as string;
  };

  const transfers = (query = '') =>
    api(ctx.server, 'get', `/api/v1/cash-transfers${query ? `?${query}` : ''}`, { token: actor.token });

  /** Money travels as text: the API stores `numeric(20,4)`, not a floating guess. */
  const create = async (amountText: string, from = safeAId, to = safeBId) => {
    const created = await api(ctx.server, 'post', '/api/v1/cash-transfers', {
      token: actor.token,
      body: { branchId, fromCashLocationId: from, toCashLocationId: to, amount: amountText },
    });
    expect(created.status).toBe(201);
    return data(created.body);
  };

  const balanceOf = async (cashLocationId: string) => {
    const response = await api(ctx.server, 'get', `/api/v1/cash-locations/${cashLocationId}/balances`, {
      token: actor.token,
    });
    const row = list(response.body).find((entry) => entry.currencyCode === 'SAR');
    return Number((row?.balance as string | undefined) ?? '0');
  };

  beforeAll(async () => {
    ctx = await createTestApp('treasury-transfers');
    actor = await createActor(ctx, {
      tenantCode: 'tre-trans',
      email: 'owner@tre-trans.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'treasury.view',
        'treasury.transfer.manage',
        'treasury.voucher.create',
        'treasury.voucher.post',
        'organization.cashlocation.view',
        'organization.cashlocation.manage',
        'organization.branch.manage',
        'organization.warehouse.manage',
        'organization.postingprofile.view',
        'inventory.view',
        'inventory.adjust',
        'inventory.transfer',
        'inventory.transfer.receive',
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'tre-trans-2',
      email: 'owner@tre-trans-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'treasury.view', 'treasury.transfer.manage'],
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

    const safeAccountA = await account({ code: '1211', nameAr: 'الخزنة أ', type: 'asset' });
    const safeAccountB = await account({ code: '1212', nameAr: 'الخزنة ب', type: 'asset' });
    const cashAccountId = await account({ code: '1221', nameAr: 'النقدية', type: 'asset' });

    for (const [name, accountId, capture] of [
      ['الخزنة أ', safeAccountA, 'a'],
      ['الخزنة ب', safeAccountB, 'b'],
    ] as const) {
      const safe = await api(ctx.server, 'post', '/api/v1/cash-locations', {
        token: actor.token,
        body: { branchId, kind: 'safe', name, accountId },
      });
      expect(safe.status).toBe(201);
      if (capture === 'a') safeAId = data(safe.body).id as string;
      if (capture === 'b') safeBId = data(safe.body).id as string;
    }

    for (const [code, capture] of [
      ['WHA', 'a'],
      ['WHB', 'b'],
    ] as const) {
      const warehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
        token: actor.token,
        body: { branchId, code, name: `مخزن ${code}` },
      });
      expect(warehouse.status).toBe(201);
      if (capture === 'a') warehouseAId = data(warehouse.body).id as string;
      if (capture === 'b') warehouseBId = data(warehouse.body).id as string;
    }

    // Sending stock out of one store and into transit is posted against accounts, the
    // same way the treasury posts money — a movement with no entry is a mystery later.
    const stockAccountId = await account({ code: '1130', nameAr: 'المخزون', type: 'asset' });
    const transitAccountId = await account({ code: '1145', nameAr: 'بضاعة في الطريق', type: 'asset' });
    // R13 — 🧾 نقد تحت التحويل: where money sits between send and receive. The cloud
    // extension `1211003` is the chart's own account for it (next to `1270003`).
    const cashTransitAccountId = await account({ code: '1211003', nameAr: 'نقد تحت التحويل', type: 'asset' });
    for (const [docType, mapping] of [
      ['receipt_voucher', { cashAccountId }],
      ['payment_voucher', { cashAccountId }],
      ['stock_transfer', { inventoryAccountId: stockAccountId, stockInTransitAccountId: transitAccountId }],
      ['cash_transfer', { cashInTransitAccountId: cashTransitAccountId }],
    ] as const) {
      const profile = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
        token: actor.token,
        body: { branchId, docType, mapping: { version: 1, ...mapping } },
      });
      expect(profile.status).toBeLessThan(300);
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('المال لا يخرج قبل «✅ اعتماد الإرسال»', async () => {
    const draft = await create('500');
    expect(draft.status).toBe('draft');
    expect(draft.number).toBeFalsy();

    const before = await balanceOf(safeAId);
    const sent = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, {
      token: actor.token,
      body: {},
    });
    expect(sent.status).toBeLessThan(300);
    const body = data(sent.body);
    expect(body.status).toBe('sent');
    // 🔢 الرقم is allocated on sending, the way a voucher is numbered on posting.
    expect(String(body.number)).toMatch(/^CT-/);
    // R13 — الإرسال يقيّد: Dr نقد تحت التحويل / Cr خزنة المصدر، ورقم القيد محفوظ.
    expect(body.sentJournalEntryId).toBeTruthy();
    expect(body.cashInTransitAccountId).toBeTruthy();

    expect(await balanceOf(safeAId)).toBeCloseTo(before - 500, 4);
    expect(await balanceOf(safeBId)).toBeCloseTo(0, 4);

    // والشبكة تعلن القيد كما تعلن الرصيد — لا قيدَ بلا أثرٍ في الدفتر.
    const listed = list((await transfers(`number=${encodeURIComponent(String(body.number))}`)).body).find(
      (row) => row.id === draft.id,
    ) as Record<string, unknown> | undefined;
    expect(listed?.sentJournalEntryId).toBe(body.sentJournalEntryId);
  });

  it('«✅ تأكيد الاستلام» يدخل المال خزنة الوصول', async () => {
    const draft = await create('250');
    const sent = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, { token: actor.token, body: {} });
    expect(sent.status).toBeLessThan(300);
    expect(await balanceOf(safeBId)).toBeCloseTo(0, 4);

    const received = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/receive`, {
      token: actor.token,
      body: {},
    });
    expect(received.status).toBeLessThan(300);
    const rBody = data(received.body);
    expect(rBody.status).toBe('received');
    // R13 — الاستلام يقيّد: Dr خزنة الوصول / Cr نقد تحت التحويل.
    expect(rBody.receivedJournalEntryId).toBeTruthy();
    expect(await balanceOf(safeBId)).toBeCloseTo(250, 4);

    const listed = list((await transfers(`number=${encodeURIComponent(String(data(sent.body).number))}`)).body).find(
      (row) => row.id === draft.id,
    ) as Record<string, unknown> | undefined;
    expect(listed?.receivedJournalEntryId).toBe(rBody.receivedJournalEntryId);
  });

  it('مناقلة أُرسلت لا تُرسل مرة أخرى', async () => {
    const draft = await create('100');
    await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, { token: actor.token, body: {} });

    const again = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, {
      token: actor.token,
      body: {},
    });
    expect(again.status).toBe(422);
    expect(codeOf(again.body)).toBe('CASH_TRANSFER_INVALID_STATE');
  });

  it('لا استلام بلا إرسال — ولا استلام مرتين', async () => {
    const draft = await create('120');
    const tooEarly = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/receive`, {
      token: actor.token,
      body: {},
    });
    expect(tooEarly.status).toBe(422);
    expect(codeOf(tooEarly.body)).toBe('CASH_TRANSFER_INVALID_STATE');

    await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, { token: actor.token, body: {} });
    await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/receive`, { token: actor.token, body: {} });
    const twice = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/receive`, {
      token: actor.token,
      body: {},
    });
    expect(twice.status).toBe(422);
  });

  it('🗑️ حذف للمسودة فقط — المُرسَلة تُردّ بمناقلة أخرى', async () => {
    const draft = await create('70');
    const cancelled = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/cancel`, {
      token: actor.token,
      body: {},
    });
    expect(cancelled.status).toBeLessThan(300);
    expect(data(cancelled.body).status).toBe('voided');

    const sent = await create('80');
    await api(ctx.server, 'post', `/api/v1/cash-transfers/${sent.id}/send`, { token: actor.token, body: {} });
    const refuse = await api(ctx.server, 'post', `/api/v1/cash-transfers/${sent.id}/cancel`, {
      token: actor.token,
      body: {},
    });
    expect(refuse.status).toBe(422);
    expect(codeOf(refuse.body)).toBe('CASH_TRANSFER_INVALID_STATE');
  });

  it('من خزنة إلى نفسها ليست مناقلة', async () => {
    const same = await api(ctx.server, 'post', '/api/v1/cash-transfers', {
      token: actor.token,
      body: { branchId, fromCashLocationId: safeAId, toCashLocationId: safeAId, amount: '10' },
    });
    expect(same.status).toBe(422);
    expect(codeOf(same.body)).toBe('CASH_TRANSFER_INVALID');
  });

  it('🔍 البحث بالرقم وبالحالة وبالفترة', async () => {
    const draft = await create('310');
    await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, { token: actor.token, body: {} });
    const sentRows = list((await transfers('status=sent')).body);
    expect(sentRows.length).toBeGreaterThan(0);
    expect(sentRows.every((row) => row.status === 'sent')).toBe(true);
    // 🏦 من خزنة / 🏦 إلى خزنة are resolved by the service, not guessed in the browser.
    expect(sentRows.every((row) => typeof row.fromName === 'string' && typeof row.toName === 'string')).toBe(true);

    const byNumber = list((await transfers('status=sent')).body).find((row) => row.id === draft.id);
    const numbered = await transfers(`number=${encodeURIComponent(String(byNumber?.number ?? ''))}`);
    expect(list(numbered.body).some((row) => row.id === draft.id)).toBe(true);

    // 📅 من تاريخ / إلى تاريخ — a window far in the past holds nothing of ours.
    const past = await transfers('from=2001-01-01&to=2001-01-31');
    expect(list(past.body).length).toBe(0);
  });

  it('مناقلة مستأجر آخر لا تُرى ولا تُرسل', async () => {
    const draft = await create('45');

    const theirs = await api(ctx.server, 'get', '/api/v1/cash-transfers', { token: stranger.token });
    expect(list(theirs.body).length).toBe(0);

    const send = await api(ctx.server, 'post', `/api/v1/cash-transfers/${draft.id}/send`, {
      token: stranger.token,
      body: {},
    });
    expect(send.status).toBe(422);
  });

  it('🔍 مناقلة الأصناف تُبحث برقمها أيضاً', async () => {
    // `frmSafesTransfer`'s own window: `🔢 رقم التحويل` · `📅 من تاريخ` · `📅 إلى تاريخ`.
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
        sku: 'ITM-TR',
        nameAr: 'صنف مناقلة',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100',
        costPrice: '60',
      },
    });
    const itemId = data(item.body).id as string;
    const openingDocIds = {
      a: '00000000-0000-4000-8000-00000000000a',
      b: '00000000-0000-4000-8000-00000000000b',
    };
    for (const warehouseId of [warehouseAId, warehouseBId]) {
      const receipt = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
        token: actor.token,
        body: {
          lines: [
            {
              itemId,
              warehouseId,
              qty: '50',
              unitCost: '60',
              direction: 'in',
              docType: 'opening',
              docId: openingDocIds[warehouseId === warehouseAId ? 'a' : 'b'],
            },
          ],
        },
      });
      expect(receipt.status).toBeLessThan(300);
    }

    const transfer = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseAId,
        toWarehouseId: warehouseBId,
        lines: [{ itemId, qty: '5' }],
      },
    });
    expect(transfer.status).toBeLessThan(300);
    const transferId = data(transfer.body).id as string;
    const sent = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/send`, {
      token: actor.token,
      body: {},
    });
    expect(sent.status).toBeLessThan(300);

    const rows = list((await api(ctx.server, 'get', '/api/v1/inventory/transfers', { token: actor.token })).body);
    const row = rows.find((entry) => entry.id === transferId);
    expect(row).toBeTruthy();

    // A transfer that has left is what the receiving store waits for.
    const inTransit = list(
      (await api(ctx.server, 'get', '/api/v1/inventory/transfers?status=in_transit', { token: actor.token })).body,
    );
    expect(inTransit.some((entry) => entry.id === transferId)).toBe(true);

    const future = list(
      (await api(ctx.server, 'get', '/api/v1/inventory/transfers?from=2099-01-01&to=2099-12-31', {
        token: actor.token,
      })).body,
    );
    expect(future.some((entry) => entry.id === transferId)).toBe(false);
  });
});
