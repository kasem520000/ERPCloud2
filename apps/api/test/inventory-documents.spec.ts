import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * سند إدخال / إخراج · بضاعة أول المدة · مناقلة · جرد وتسوية — Phase 05 of the
 * desktop-parity programme.
 *
 * The desktop `frmInvInOutput` saved these documents with `Entry entry = null`: the
 * stock moved, the ledger did not, and `frmReGenerateEntries` was the repair tool that
 * retro-fitted an entry (invType 4 → account 4200003) for anyone who remembered to run
 * it. The cloud cannot inherit that, because sales and purchases already post to the
 * inventory account — a document that moved quantity without an entry would leave the
 * ledger permanently disagreeing with the stock balance.
 *
 * These tests pin the contract that replaces it: every stock document is numbered,
 * branch-scoped, approved before posting, and writes its movements *and* one balanced
 * journal in a single transaction.
 */
describe('Inventory documents (vouchers, adjustments, transfers)', () => {
  let ctx: TestApp;
  let actor: Actor;
  let neighbour: Actor;

  let branchId = '';
  let warehouseId = '';
  let secondWarehouseId = '';
  let itemA = '';
  let itemB = '';
  let serviceItem = '';
  let lotTrackedItem = '';

  let inventoryAccountId = '';
  let openingAccountId = '';
  let varianceAccountId = '';
  let transitAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('inventory-documents');
    actor = await createActor(ctx, {
      tenantCode: 'inv-alpha',
      email: 'owner@inv-alpha.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'inventory.view',
        'inventory.adjust',
        'inventory.adjust.approve',
        'inventory.transfer',
        'inventory.transfer.receive',
        'inventory.negative.override',
        'accounting.account.view',
        'accounting.reports.view',
        'accounting.period.close',
        'organization.postingprofile.view',
      ],
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    warehouseId = defaults.warehouseId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    const categoryId = data(category.body).id as string;
    const unitId = data(unit.body).id as string;

    const makeItem = async (payload: Record<string, unknown>) => {
      const created = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
        token: actor.token,
        body: { categoryId, baseUnitId: unitId, ...payload },
      });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };

    itemA = await makeItem({ sku: 'SKU-A', nameAr: 'صنف أ', minQty: '5' });
    itemB = await makeItem({ sku: 'SKU-B', nameAr: 'صنف ب' });
    serviceItem = await makeItem({ sku: 'SKU-SVC', nameAr: 'خدمة', kind: 'service' });
    lotTrackedItem = await makeItem({ sku: 'SKU-LOT', nameAr: 'صنف بدفعات', trackLot: true });

    const secondWarehouse = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH2', name: 'مستودع ثانٍ' },
    });
    expect(secondWarehouse.status).toBe(201);
    secondWarehouseId = data(secondWarehouse.body).id as string;

    const resolved = await api(
      ctx.server,
      'get',
      `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=stock_voucher`,
      { token: actor.token },
    );
    expect(resolved.status).toBe(200);
    const mapping = data(resolved.body).mapping as Record<string, string>;
    inventoryAccountId = mapping.inventoryAccountId as string;
    openingAccountId = mapping.openingBalanceAccountId as string;
    varianceAccountId = mapping.inventoryAdjustmentAccountId as string;
    transitAccountId = mapping.stockInTransitAccountId as string;

    neighbour = await createActor(ctx, {
      tenantCode: 'inv-beta',
      email: 'owner@inv-beta.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'inventory.view',
        'inventory.adjust',
      ],
    });
    await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(neighbour.tenantId);
  }, 240_000);

  afterAll(async () => ctx.close());

  const levelOf = async (itemId: string, warehouse = warehouseId): Promise<string> => {
    const levels = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouse}&item_id=${itemId}`,
      { token: actor.token },
    );
    const rows = (levels.body.data ?? levels.body) as Array<{ quantity: string }>;
    return rows[0]?.quantity ?? '0';
  };

  const journalOf = async (
    match: string,
  ): Promise<{ id: string; lines: Array<{ accountId: string; debit: string; credit: string }> }> => {
    const list = await api(ctx.server, 'get', '/api/v1/journal-entries?limit=50', { token: actor.token });
    const entries = (list.body.data ?? list.body) as Array<{ id: string; description: string; kind: string }>;
    const entry = entries.find((row) => (row.description ?? '').includes(match) && row.kind !== 'reversal');
    expect(entry, `journal entry matching ${match}`).toBeDefined();
    const detail = await api(ctx.server, 'get', `/api/v1/journal-entries/${entry?.id}`, {
      token: actor.token,
    });
    const body = data(detail.body) as {
      id: string;
      lines: Array<{ accountId: string; debit: string; credit: string }>;
    };
    return { id: body.id, lines: body.lines ?? [] };
  };

  const line = (lines: Array<{ accountId: string; debit: string; credit: string }>, accountId: string) =>
    lines.find((row) => row.accountId === accountId);

  const money = (value: string) => Number(value).toFixed(4);

  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const voucher = async (body: Record<string, unknown>) =>
    api(ctx.server, 'post', '/api/v1/inventory/vouchers', { token: actor.token, body });

  const postVoucher = (id: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/post`, { token: actor.token, body });

  it('maps the three new inventory accounts in the tenant posting profile', () => {
    expect(inventoryAccountId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(openingAccountId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(varianceAccountId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(transitAccountId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Set([inventoryAccountId, openingAccountId, varianceAccountId, transitAccountId]).size).toBe(4);
  });

  it('posts a stock-in voucher: stock rises and المخزون is debited', async () => {
    const before = Number(await levelOf(itemA));
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_in',
      reason: 'إيداع افتتاحي',
      lines: [{ itemId: itemA, qty: '10', unitCost: '25' }],
    });
    expect(created.status).toBe(201);
    const draft = data(created.body) as { id: string; number: string; status: string; total_cost?: string };
    expect(draft.number).toMatch(/^SIN-\d{6}$/);
    expect(draft.status).toBe('draft');

    const posted = await postVoucher(draft.id);
    expect(posted.status).toBe(201);
    const result = data(posted.body) as { status: string; totalCost: string; journalEntryId: string };
    expect(result.status).toBe('posted');
    expect(money(result.totalCost)).toBe('250.0000');
    expect(result.journalEntryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number(await levelOf(itemA))).toBe(before + 10);

    const journal = await journalOf(draft.number);
    expect(money(line(journal.lines, inventoryAccountId)?.debit ?? '0')).toBe('250.0000');
    expect(money(line(journal.lines, varianceAccountId)?.credit ?? '0')).toBe('250.0000');
  });

  it('refuses to post the same voucher twice', async () => {
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_in',
      lines: [{ itemId: itemB, qty: '1', unitCost: '1' }],
    });
    const id = (data(created.body) as { id: string }).id;
    expect((await postVoucher(id)).status).toBe(201);
    const again = await postVoucher(id);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('INVENTORY_VOUCHER_INVALID_STATUS');
  });

  it('posts a stock-out voucher at average cost and credits المخزون', async () => {
    const before = Number(await levelOf(itemA));
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_out',
      reason: 'إخراج للاستهلاك الداخلي',
      lines: [{ itemId: itemA, qty: '4' }],
    });
    expect(created.status).toBe(201);
    const id = (data(created.body) as { id: string; number: string }).id;
    const number = (data(created.body) as { number: string }).number;
    expect(number).toMatch(/^SOU-\d{6}$/);

    const posted = await postVoucher(id);
    expect(posted.status).toBe(201);
    expect(money((data(posted.body) as { totalCost: string }).totalCost)).toBe('100.0000');
    expect(Number(await levelOf(itemA))).toBe(before - 4);

    const journal = await journalOf(number);
    expect(money(line(journal.lines, varianceAccountId)?.debit ?? '0')).toBe('100.0000');
    expect(money(line(journal.lines, inventoryAccountId)?.credit ?? '0')).toBe('100.0000');
  });

  it('books بضاعة أول المدة against the opening balance account', async () => {
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'opening',
      lines: [{ itemId: itemB, qty: '50', unitCost: '12' }],
    });
    expect(created.status).toBe(201);
    const { id, number } = data(created.body) as { id: string; number: string };
    expect(number).toMatch(/^OP-\d{6}$/);
    expect((await postVoucher(id)).status).toBe(201);

    const journal = await journalOf(number);
    expect(money(line(journal.lines, inventoryAccountId)?.debit ?? '0')).toBe('600.0000');
    expect(money(line(journal.lines, openingAccountId)?.credit ?? '0')).toBe('600.0000');
  });

  it('rejects a service item and a lot-tracked item with no lot', async () => {
    const service = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_in',
      lines: [{ itemId: serviceItem, qty: '1', unitCost: '5' }],
    });
    expect(service.status).toBe(422);
    expect(codeOf(service.body)).toBe('INVENTORY_ITEM_NOT_STOCKED');

    const lotless = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_in',
      lines: [{ itemId: lotTrackedItem, qty: '1', unitCost: '5' }],
    });
    expect(lotless.status).toBe(422);
    expect(codeOf(lotless.body)).toBe('INVENTORY_LOT_REQUIRED');
  });

  it('voids a posted voucher: stock and ledger both roll back', async () => {
    const before = Number(await levelOf(itemB));
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_in',
      lines: [{ itemId: itemB, qty: '5', unitCost: '10' }],
    });
    const id = (data(created.body) as { id: string }).id;
    expect((await postVoucher(id)).status).toBe(201);
    expect(Number(await levelOf(itemB))).toBe(before + 5);

    const voided = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/void`, {
      token: actor.token,
      body: { reason: 'خطأ في الإدخال' },
    });
    expect(voided.status).toBe(201);
    expect((data(voided.body) as { status: string }).status).toBe('voided');
    expect(Number(await levelOf(itemB))).toBe(before);

    const second = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${id}/void`, {
      token: actor.token,
      body: { reason: 'مرة ثانية' },
    });
    expect(second.status).toBe(409);
  });

  it('counts the shelf, books the variance and posts one balanced entry', async () => {
    const counted = 3;
    const created = await api(ctx.server, 'post', '/api/v1/inventory/adjustments', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        reason: 'جرد سنوي',
        lines: [{ itemId: itemB, countedQty: String(counted) }],
      },
    });
    expect(created.status).toBe(201);
    const { id, number } = data(created.body) as { id: string; number: string };
    expect(number).toMatch(/^ADJ-\d{6}$/);

    const unapproved = await api(ctx.server, 'post', `/api/v1/inventory/adjustments/${id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(unapproved.status).toBe(422);
    expect(codeOf(unapproved.body)).toBe('ADJUSTMENT_APPROVAL_REQUIRED');

    const posted = await api(ctx.server, 'post', `/api/v1/inventory/adjustments/${id}/post`, {
      token: actor.token,
      body: { approved: true },
    });
    expect(posted.status).toBe(201);
    const result = data(posted.body) as {
      status: string;
      lines: Array<{ varianceQty: string; varianceValue: string }>;
      journalEntryId: string | null;
    };
    expect(result.status).toBe('posted');
    expect(result.lines[0]?.varianceQty).not.toBe('0.0000');
    expect(Number(await levelOf(itemB))).toBe(counted);
    expect(result.journalEntryId).toMatch(/^[0-9a-f-]{36}$/i);

    const journal = await journalOf(number);
    const debit = journal.lines.reduce((sum, row) => sum + Number(row.debit), 0);
    const credit = journal.lines.reduce((sum, row) => sum + Number(row.credit), 0);
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
  });

  it('moves goods between warehouses and parks the value in transit', async () => {
    const beforeSource = Number(await levelOf(itemA));
    const beforeTarget = Number(await levelOf(itemA, secondWarehouseId));

    const created = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: secondWarehouseId,
        lines: [{ itemId: itemA, qty: '3' }],
      },
    });
    expect(created.status).toBe(201);
    const transfer = data(created.body) as { id: string; number: string; status: string; branchId: string };
    expect(transfer.number).toMatch(/^TR-\d{6}$/);
    expect(transfer.status).toBe('draft');
    expect(transfer.branchId).toBe(branchId);

    const sent = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transfer.id}/send`, {
      token: actor.token,
      body: {},
    });
    expect(sent.status).toBe(201);
    const sentBody = data(sent.body) as { status: string; value: string; journalEntryId: string };
    expect(sentBody.status).toBe('in_transit');
    expect(sentBody.journalEntryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number(sentBody.value)).toBeGreaterThan(0);
    expect(Number(await levelOf(itemA))).toBe(beforeSource - 3);

    const sendJournal = await journalOf(`مناقلة ${transfer.number} — إرسال`);
    expect(money(line(sendJournal.lines, transitAccountId)?.debit ?? '0')).toBe(money(sentBody.value));
    expect(money(line(sendJournal.lines, inventoryAccountId)?.credit ?? '0')).toBe(money(sentBody.value));

    const received = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transfer.id}/receive`, {
      token: actor.token,
      body: { received: [{ lineNo: 1, qty: '3' }] },
    });
    expect(received.status).toBe(201);
    expect((data(received.body) as { status: string }).status).toBe('received');
    expect(Number(await levelOf(itemA, secondWarehouseId))).toBe(beforeTarget + 3);

    const receiveJournal = await journalOf(`مناقلة ${transfer.number} — استلام`);
    expect(money(line(receiveJournal.lines, inventoryAccountId)?.debit ?? '0')).toBe(money(sentBody.value));
    expect(money(line(receiveJournal.lines, transitAccountId)?.credit ?? '0')).toBe(money(sentBody.value));
  });

  it('puts the goods back when an in-transit transfer is cancelled', async () => {
    const before = Number(await levelOf(itemA));
    const created = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: secondWarehouseId,
        lines: [{ itemId: itemA, qty: '2' }],
      },
    });
    const id = (data(created.body) as { id: string }).id;
    expect(
      (
        await api(ctx.server, 'post', `/api/v1/inventory/transfers/${id}/send`, {
          token: actor.token,
          body: {},
        })
      ).status,
    ).toBe(201);
    expect(Number(await levelOf(itemA))).toBe(before - 2);

    const cancelled = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${id}/cancel`, {
      token: actor.token,
      body: { reason: 'إلغاء المناقلة' },
    });
    expect(cancelled.status).toBe(201);
    expect((data(cancelled.body) as { status: string }).status).toBe('cancelled');
    expect(Number(await levelOf(itemA))).toBe(before);
  });

  it('refuses a transfer whose warehouses are the same', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: warehouseId,
        lines: [{ itemId: itemA, qty: '1' }],
      },
    });
    expect(created.status).toBe(422);
    expect(codeOf(created.body)).toBe('INVALID_STOCK_TRANSFER');
  });

  it('reports items sitting below their reorder point', async () => {
    // itemA carries minQty 5; drain the warehouse below it.
    const level = Number(await levelOf(itemA));
    if (level >= 5) {
      const out = await voucher({
        branchId,
        warehouseId,
        kind: 'stock_out',
        lines: [{ itemId: itemA, qty: String(level - 1) }],
      });
      const id = (data(out.body) as { id: string }).id;
      expect((await postVoucher(id)).status).toBe(201);
    }
    const list = await api(ctx.server, 'get', '/api/v1/inventory/below-minimum', { token: actor.token });
    expect(list.status).toBe(200);
    const rows = (list.body.data ?? list.body) as Array<{ itemId: string; shortage: string }>;
    expect(rows.some((row) => row.itemId === itemA)).toBe(true);
    expect(Number(rows.find((row) => row.itemId === itemA)?.shortage)).toBeGreaterThan(0);
  });

  it('issues stock below zero only with the override permission and flag', async () => {
    const level = Number(await levelOf(itemB));
    const created = await voucher({
      branchId,
      warehouseId,
      kind: 'stock_out',
      lines: [{ itemId: itemB, qty: String(level + 25) }],
    });
    const id = (data(created.body) as { id: string }).id;

    const refused = await postVoucher(id);
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('STOCK_INSUFFICIENT');

    const forced = await postVoucher(id, { allowNegative: true });
    expect(forced.status).toBe(201);
    expect(Number(await levelOf(itemB))).toBe(-25);
  });

  it('keeps one tenant’s stock documents out of another’s register', async () => {
    const mine = await api(ctx.server, 'get', '/api/v1/inventory/vouchers', { token: actor.token });
    const mineRows = (mine.body.data ?? mine.body) as Array<{ id: string }>;
    expect(mineRows.length).toBeGreaterThan(0);

    const theirs = await api(ctx.server, 'get', '/api/v1/inventory/vouchers', { token: neighbour.token });
    const theirRows = (theirs.body.data ?? theirs.body) as Array<{ id: string }>;
    expect(theirRows.length).toBe(0);

    const crossPost = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${mineRows[0]?.id}/post`, {
      token: neighbour.token,
      body: {},
    });
    expect(crossPost.status).toBe(404);
  });
});
