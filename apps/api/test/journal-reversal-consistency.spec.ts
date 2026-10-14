import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 اتساق عكس القيود — the reversal convention, measured on the reports rather than on one entry.
 *
 * الاصطلاح المعتمد (الترحيل `0047` + `reporting/report-catalog.ts ← entryStateScope`):
 *
 *   * العكس **مرآة وحدها**؛ القيد الأصلي يبقى `status = 'posted'` ولا تُمسّ قيمه، فيصير
 *     الأصل ومرآته صفراً في كل رصيد يجمع `posted` (ميزان المراجعة، الأستاذ، أرصدة الحسابات).
 *   * «لاغي» = قيدٌ تشير إليه مرآة (`reversal_of`)، لا `status = 'void'`.
 *
 * وكان ثلاثة مسارات تخالفه — `InventoryService.reversalEntry` (إلغاء مناقلة/سند)،
 * `SalesService.void` و`PurchasesService.void` — تُرحِّل المرآة **وتُبطل الأصل** معاً:
 * فيسقط الأصل من كل ميزان وتبقى مرآته، وينحرف رصيد الحساب بمقدار المستند الملغى.
 * كل اختبار هنا يقيس **ميزان المراجعة وأرصدة الحسابات قبل العملية وبعدها**، لا القيد وحده،
 * لأن الانحراف لا يظهر إلا في التقرير.
 */
describe('Journal reversal consistency — العكس لا يُنحرف الميزان', () => {
  let ctx: TestApp;
  let actor: Actor;

  let branchId = '';
  let warehouseId = '';
  let secondWarehouseId = '';
  let itemId = '';
  let partyId = '';
  let fiscalPeriodId = '';

  let salesAccountId = '';
  let vatOutputAccountId = '';
  let receivableAccountId = '';
  let inventoryAccountId = '';
  let cogsAccountId = '';
  let transitAccountId = '';
  let varianceAccountId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;
  const money = (value: unknown): string => Number(value ?? 0).toFixed(4);

  /** رصيد الحساب كما يراه التقرير الرسمي (`status = 'posted'` فقط) — مدين − دائن. */
  async function balanceOf(accountId: string): Promise<number> {
    const rows = (
      await api(ctx.server, 'get', '/api/v1/accounts?with_balances=1', { token: actor.token })
    ).body as { data: Array<Record<string, unknown>> };
    const row = rows.data.find((entry) => entry.id === accountId);
    return Number(((row?.balance ?? {}) as { balance?: string }).balance ?? 0);
  }

  /**
   * ميزان المراجعة — **صافي** كل حساب (مدين − دائن) مع إهمال الأصفار.
   *
   * لماذا الصافي لا الحركة: العملية الملغاة تترك حركةً في التقرير (الأصل ومرآته)، وهذا مطلوب —
   * فالسجلّ لا يُمحى. ما يجب أن يعود كما كان هو **الصافي**، وهو ما يقرأه ميزان المراجعة
   * والأستاذ وأرصدة الحسابات. والحساب الذي لا يظهر في الصفوف صافيه صفر.
   */
  async function trialNets(): Promise<Record<string, string>> {
    const rows = await trialRows();
    const nets: Record<string, string> = {};
    for (const row of rows) {
      const id = String(row.accountId ?? row.id ?? '');
      const net = Number(row.debit ?? 0) - Number(row.credit ?? 0);
      if (Math.abs(net) > 0.00005) nets[id] = money(net);
    }
    return nets;
  }

  /** صفوف ميزان المراجعة كما هي — للحركة والإجماليات، لا للصافي وحده. */
  async function trialRows(): Promise<Array<Record<string, unknown>>> {
    const response = await api(ctx.server, 'get', '/api/v1/statements/trial-balance', {
      token: actor.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body.data ?? []) as Array<Record<string, unknown>>;
  }

  /** الميزان متوازن دائماً: مجموع المدين = مجموع الدائن. */
  function assertBalanced(rows: Array<Record<string, unknown>>) {
    const debit = rows.reduce((sum, row) => sum + Number(row.debit ?? 0), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit ?? 0), 0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.0001);
    return { debit, credit };
  }

  async function levelOf(warehouse = warehouseId): Promise<number> {
    const response = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouse}&item_id=${itemId}`,
      { token: actor.token },
    );
    const rows = (response.body.data ?? response.body) as Array<{ quantity: string }>;
    return Number(rows[0]?.quantity ?? 0);
  }

  /** كل القيود المرتبطة بمستند، بحالتها ومراجعها — من قاعدة الاختبار مباشرة. */
  async function journalOf(sourceType: string, sourceId: string) {
    return withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT e.id::text, e.number, e.kind, e.status, e.reversal_of::text, e.description,
               l.account_id::text, l.debit::text, l.credit::text, l.party_id::text,
               l.cost_center_id::text, l.salesman_id::text, l.branch_id::text
        FROM journal_entries e
        JOIN journal_entry_lines l ON l.entry_id = e.id
        WHERE e.tenant_id = ${actor.tenantId}::uuid
          AND e.source_type = ${sourceType}
          AND e.source_id = ${sourceId}::uuid
        ORDER BY e.created_at ASC, l.line_no ASC
      `);
      return (rows as { rows: Array<Record<string, string | null>> }).rows;
    });
  }

  /** تصنيف السجلّ: «لاغي» = قيد تشير إليه مرآة، و«معتمد» = مُرحَّل ولا مرآة له. */
  async function registerClass(entryId: string): Promise<'posted' | 'cancelled'> {
    return withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT (je.status = 'posted' AND NOT EXISTS (
                  SELECT 1 FROM journal_entries rev
                  WHERE rev.tenant_id = je.tenant_id AND rev.reversal_of = je.id
                ))::int AS active
        FROM journal_entries je
        WHERE je.id = ${entryId}::uuid AND je.tenant_id = ${actor.tenantId}::uuid
      `);
      return Number((rows as { rows: Array<{ active: number }> }).rows[0]?.active ?? 0) === 1
        ? 'posted'
        : 'cancelled';
    });
  }

  async function reversalCountOf(entryId: string): Promise<number> {
    return withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM journal_entries
        WHERE tenant_id = ${actor.tenantId}::uuid AND reversal_of = ${entryId}::uuid
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp('journal-reversal');
    actor = await createActor(ctx, {
      tenantCode: 'reversal-alpha',
      email: 'owner@reversal-alpha.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'sales.invoice.void',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'accounting.account.view',
        'accounting.journal.post',
        'accounting.journal.reverse',
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
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    const periods = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });
    const periodRows = (periods.body.data ?? periods.body) as Array<{ id: string; status: string }>;
    const openPeriod = periodRows.find((row) => row.status === 'open');
    if (openPeriod) fiscalPeriodId = openPeriod.id;

    const category = await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', {
      token: actor.token,
      body: { code: 'GEN', nameAr: 'عام' },
    });
    const unit = await api(ctx.server, 'post', '/api/v1/organization/catalog/units', {
      token: actor.token,
      body: { code: 'PCS', nameAr: 'حبة' },
    });
    const item = await api(ctx.server, 'post', '/api/v1/organization/catalog/items', {
      token: actor.token,
      body: {
        sku: 'SKU-REV',
        nameAr: 'صنف العكس',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100.0000',
        purchasePrice: '40.0000',
      },
    });
    itemId = data(item.body).id as string;

    const second = await api(ctx.server, 'post', '/api/v1/warehouses', {
      token: actor.token,
      body: { branchId, code: 'WH-REV-2', name: 'مستودع العكس الثاني' },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    secondWarehouseId = data(second.body).id as string;

    const opening = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '200',
            unitCost: '40',
            direction: 'in',
            docType: 'opening',
            docId: newId(),
          },
        ],
      },
    });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);

    const party = await api(ctx.server, 'post', '/api/v1/parties', {
      token: actor.token,
      body: { kind: 'customer', name: 'عميل العكس' },
    });
    partyId = data(party.body).id as string;

    const profile = await api(
      ctx.server,
      'get',
      `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=sales_invoice`,
      { token: actor.token },
    );
    const mapping = data(profile.body).mapping as Record<string, string>;
    salesAccountId = mapping.salesAccountId;
    vatOutputAccountId = mapping.vatOutputAccountId;
    receivableAccountId = mapping.receivableAccountId;
    inventoryAccountId = mapping.inventoryAccountId;
    cogsAccountId = mapping.cogsAccountId;
    transitAccountId = mapping.stockInTransitAccountId;
    varianceAccountId = mapping.inventoryAdjustmentAccountId;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const postInvoice = async (qty: string) => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: qty, unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const draft = data(created.body) as { id: string };
    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${draft.id}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    return data(posted.body) as { id: string; number: string; total: string };
  };

  it('voiding a sales invoice puts the trial balance and every account back exactly', async () => {
    const before = {
      trial: await trialNets(),
      rows: await trialRows(),
      sales: await balanceOf(salesAccountId),
      vat: await balanceOf(vatOutputAccountId),
      receivable: await balanceOf(receivableAccountId),
      inventory: await balanceOf(inventoryAccountId),
      cogs: await balanceOf(cogsAccountId),
      level: await levelOf(),
    };

    const invoice = await postInvoice('10');
    // الفاتورة أثّرت فعلاً — وإلا كان «العودة إلى ما قبلها» كلاماً بلا معنى.
    expect(await levelOf()).toBe(before.level - 10);
    expect(await balanceOf(receivableAccountId)).not.toBe(before.receivable);

    const voided = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'إلغاء بطلب العميل' },
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);

    // 1) المخزون والإيراد والضريبة والذمم وتكلفة البضاعة — كلها كما كانت قبل الفاتورة.
    expect(await levelOf()).toBe(before.level);
    expect(await balanceOf(salesAccountId)).toBeCloseTo(before.sales, 4);
    expect(await balanceOf(vatOutputAccountId)).toBeCloseTo(before.vat, 4);
    expect(await balanceOf(receivableAccountId)).toBeCloseTo(before.receivable, 4);
    expect(await balanceOf(inventoryAccountId)).toBeCloseTo(before.inventory, 4);
    expect(await balanceOf(cogsAccountId)).toBeCloseTo(before.cogs, 4);

    // 2) ميزان المراجعة: صافي كل حساب كما كان، والميزان متوازن، والحركة باقية في التقرير
    //    (الأصل ومرآته معاً — فالسجلّ لا يُمحى، والصافي وحده هو ما يجب أن يعود صفراً).
    const afterRows = await trialRows();
    assertBalanced(afterRows);
    expect(await trialNets()).toEqual(before.trial);
    expect(afterRows.length).toBeGreaterThan(before.rows.length);

    // 3) الأصل يبقى مُرحَّلاً، والمرآة تحمل `reversalOf` وأبعاد السطر.
    const entries = await journalOf('sales_invoice', invoice.id);
    const original = entries.find((row) => row.kind !== 'reversal')!;
    const mirror = entries.find((row) => row.kind === 'reversal')!;
    expect(original.status).toBe('posted');
    expect(mirror.status).toBe('posted');
    expect(mirror.reversal_of).toBe(original.id);
    expect(mirror.description).toContain(invoice.number);
    const originalSales = entries.find(
      (row) => row.account_id === salesAccountId && row.id === original.id,
    )!;
    const mirrorSales = entries.find(
      (row) => row.account_id === salesAccountId && row.id === mirror.id,
    )!;
    expect(money(mirrorSales.debit)).toBe(money(originalSales.credit));
    expect(money(mirrorSales.credit)).toBe(money(originalSales.debit));
    // الطرف على السطر: المرآة التي تسقطه تُبقي الدين في كشف حساب العميل.
    expect(mirror.party_id).toBe(originalSales.party_id);

    // 4) سجلّ القيود: الأصل «لاغي» لأن مرآة تشير إليه — لا لأن حالته مُسحت.
    expect(await registerClass(original.id)).toBe('cancelled');
    expect(await registerClass(mirror.id)).toBe('posted');
    expect(await reversalCountOf(original.id)).toBe(1);

    // 5) إعادة الإبطال لا تُنشئ مرآة ثانية ولا تُحرِّك رصيداً.
    const again = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
      token: actor.token,
      body: { reason: 'مرة أخرى' },
    });
    expect(again.status).toBe(409);
    expect(await reversalCountOf(original.id)).toBe(1);
    expect(await trialNets()).toEqual(before.trial);
  });

  it('cancelling a sent transfer leaves المخزون and بضاعة تحت التحويل net zero', async () => {
    const before = {
      trial: await trialNets(),
      inventory: await balanceOf(inventoryAccountId),
      transit: await balanceOf(transitAccountId),
      source: await levelOf(),
      target: await levelOf(secondWarehouseId),
    };

    const created = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: secondWarehouseId,
        lines: [{ itemId, qty: '7' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const transferId = (data(created.body) as { id: string }).id;

    const sent = await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/send`, {
      token: actor.token,
      body: {},
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(await levelOf()).toBe(before.source - 7);
    // القيمة واقفة في الطريق:Dr بضاعة تحت التحويل / Cr المخزون.
    expect(await balanceOf(transitAccountId)).not.toBe(before.transit);

    const cancelled = await api(
      ctx.server,
      'post',
      `/api/v1/inventory/transfers/${transferId}/cancel`,
      { token: actor.token, body: { reason: 'أُدخلت بالخطأ' } },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);

    // الكمية عادت، والحسابان — في منظور «المرحَّل فقط» الذي تقرأه التقارير — كما كانا.
    expect(await levelOf()).toBe(before.source);
    expect(await levelOf(secondWarehouseId)).toBe(before.target);
    expect(await balanceOf(inventoryAccountId)).toBeCloseTo(before.inventory, 4);
    expect(await balanceOf(transitAccountId)).toBeCloseTo(before.transit, 4);
    assertBalanced(await trialRows());
    expect(await trialNets()).toEqual(before.trial);

    // قيد الإرسال يبقى مُرحَّلاً ومرآته واحدة.
    const entries = await journalOf('stock_transfer', transferId);
    const sendEntry = entries.find((row) => row.kind !== 'reversal')!;
    expect(sendEntry.status).toBe('posted');
    expect(await reversalCountOf(sendEntry.id)).toBe(1);
    expect(await registerClass(sendEntry.id)).toBe('cancelled');
  });

  it('cancels a transfer once when two requests race for it', async () => {
    const before = {
      inventory: await balanceOf(inventoryAccountId),
      transit: await balanceOf(transitAccountId),
      level: await levelOf(),
    };

    const created = await api(ctx.server, 'post', '/api/v1/inventory/transfers/draft', {
      token: actor.token,
      body: {
        branchId,
        fromWarehouseId: warehouseId,
        toWarehouseId: secondWarehouseId,
        lines: [{ itemId, qty: '4' }],
      },
    });
    const transferId = (data(created.body) as { id: string }).id;
    await api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/send`, {
      token: actor.token,
      body: {},
    });

    // طلبان في اللحظة نفسها على المستند نفسه — لا تسلسل يدّعي التزامن.
    const [first, second] = await Promise.all([
      api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/cancel`, {
        token: actor.token,
        body: { reason: 'إلغاء أول' },
      }),
      api(ctx.server, 'post', `/api/v1/inventory/transfers/${transferId}/cancel`, {
        token: actor.token,
        body: { reason: 'إلغاء ثانٍ' },
      }),
    ]);

    // أحدهما نجح والآخر رُفض، ولا واحد منهما انفجر بخطأ داخلي (انتهاك تفرد مثلًا).
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(first.status < 500 && second.status < 500).toBe(true);

    // مرآة واحدة لا اثنتان، والأثر مرّة واحدة لا مرتين.
    const entries = await journalOf('stock_transfer', transferId);
    const sendEntry = entries.find((row) => row.kind !== 'reversal')!;
    expect(await reversalCountOf(sendEntry.id)).toBe(1);
    expect(await levelOf()).toBe(before.level);
    expect(await balanceOf(inventoryAccountId)).toBeCloseTo(before.inventory, 4);
    expect(await balanceOf(transitAccountId)).toBeCloseTo(before.transit, 4);
  });

  it('voiding a stock voucher restores the balance and refuses a second reversal', async () => {
    const before = {
      level: await levelOf(),
      inventory: await balanceOf(inventoryAccountId),
      trial: await trialNets(),
    };

    const created = await api(ctx.server, 'post', '/api/v1/inventory/vouchers', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        kind: 'stock_in',
        reason: 'إيداع للاختبار',
        lines: [{ itemId, qty: '12', unitCost: '25' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const voucherId = (data(created.body) as { id: string }).id;

    const posted = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${voucherId}/post`, {
      token: actor.token,
      body: {},
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const journalEntryId = (data(posted.body) as { journalEntryId: string }).journalEntryId;
    expect(await levelOf()).toBe(before.level + 12);

    const voided = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${voucherId}/void`, {
      token: actor.token,
      body: { reason: 'خطأ في الإدخال' },
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);
    expect(await levelOf()).toBe(before.level);
    expect(await balanceOf(inventoryAccountId)).toBeCloseTo(before.inventory, 4);
    assertBalanced(await trialRows());
    expect(await trialNets()).toEqual(before.trial);

    expect(await reversalCountOf(journalEntryId)).toBe(1);
    const second = await api(ctx.server, 'post', `/api/v1/inventory/vouchers/${voucherId}/void`, {
      token: actor.token,
      body: { reason: 'مرة ثانية' },
    });
    expect(second.status).toBe(409);
    expect(await reversalCountOf(journalEntryId)).toBe(1);
  });

  it('reverses only posted entries, only once, and only with a reason', async () => {
    // قيد مسودة يُزرع مباشرة: لا مسار API ينشئ مسودة، والمسودة لا تُعكس بل تُلغى.
    const draftId = newId();
    const accountRow = await withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO journal_entries (id, tenant_id, branch_id, fiscal_period_id, date, kind, status, description)
        VALUES (${draftId}::uuid, ${actor.tenantId}::uuid, ${branchId}::uuid,
                COALESCE(NULLIF(${fiscalPeriodId}, '')::uuid, (
                  SELECT id FROM fiscal_periods
                  WHERE tenant_id = ${actor.tenantId}::uuid AND status = 'open'
                  ORDER BY start_date DESC LIMIT 1)),
                CURRENT_DATE, 'manual', 'draft', 'مسودة اختبار')
      `);
      await tx.execute(sql`
        INSERT INTO journal_entry_lines (entry_id, line_no, tenant_id, account_id, debit, credit)
        VALUES (${draftId}::uuid, 1, ${actor.tenantId}::uuid, ${inventoryAccountId}::uuid, 50, 0),
               (${draftId}::uuid, 2, ${actor.tenantId}::uuid, ${varianceAccountId}::uuid, 0, 50)
      `);
      const rows = await tx.execute(sql`
        SELECT fiscal_period_id::text FROM journal_entries WHERE id = ${draftId}::uuid
      `);
      return (rows as { rows: Array<{ fiscal_period_id: string }> }).rows[0]!;
    });

    const draftReversal = await api(
      ctx.server,
      'post',
      `/api/v1/journal-entries/${draftId}/reverse`,
      {
        token: actor.token,
        body: {
          branchId,
          fiscalPeriodId: accountRow.fiscal_period_id,
          date: new Date().toISOString().slice(0, 10),
          reason: 'محاولة عكس مسودة',
        },
      },
    );
    expect(draftReversal.status).toBe(409);
    expect(codeOf(draftReversal.body)).toBe('JOURNAL_NOT_POSTED');
    expect(await reversalCountOf(draftId)).toBe(0);

    // قيد مُرحَّل: يُعكس مرة، والثانية مرفوضة بكود واضح.
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: new Date().toISOString().slice(0, 10),
        branchId,
        description: 'قيد اختبار العكس',
        lines: [
          { accountId: varianceAccountId, debit: '33' },
          { accountId: inventoryAccountId, credit: '33' },
        ],
      },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const entryId = data(posted.body).id as string;

    const noReason = await api(ctx.server, 'post', `/api/v1/journal-entries/${entryId}/reverse`, {
      token: actor.token,
      body: {
        branchId,
        fiscalPeriodId: accountRow.fiscal_period_id,
        date: new Date().toISOString().slice(0, 10),
        reason: '   ',
      },
    });
    expect(noReason.status).toBe(422);
    expect(codeOf(noReason.body)).toBe('REVERSAL_REASON_REQUIRED');

    const once = await api(ctx.server, 'post', `/api/v1/journal-entries/${entryId}/reverse`, {
      token: actor.token,
      body: {
        branchId,
        fiscalPeriodId: accountRow.fiscal_period_id,
        date: new Date().toISOString().slice(0, 10),
        reason: 'عكس صحيح',
      },
    });
    expect(once.status, JSON.stringify(once.body)).toBeLessThan(300);
    expect(await reversalCountOf(entryId)).toBe(1);

    const twice = await api(ctx.server, 'post', `/api/v1/journal-entries/${entryId}/reverse`, {
      token: actor.token,
      body: {
        branchId,
        fiscalPeriodId: accountRow.fiscal_period_id,
        date: new Date().toISOString().slice(0, 10),
        reason: 'عكس ثانٍ',
      },
    });
    expect(twice.status).toBe(409);
    expect(codeOf(twice.body)).toBe('JOURNAL_ALREADY_REVERSED');
    expect(await reversalCountOf(entryId)).toBe(1);

    // الأثر الصافي صفر: القيد وعكسه معاً لا يتركان شيئاً في حساب التسوية.
    const detail = await api(ctx.server, 'get', `/api/v1/journal-entries/${entryId}`, {
      token: actor.token,
    });
    expect((data(detail.body) as { status: string }).status).toBe('posted');
    expect(await registerClass(entryId)).toBe('cancelled');
  });
});
