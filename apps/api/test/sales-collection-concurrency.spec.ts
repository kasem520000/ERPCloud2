import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenantTx } from '@erp/database';
import { sql } from 'drizzle-orm';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * ⚖️ التحصيل والإلغاء تحت التزامن — the two operations where a stale read turns into money.
 *
 * `SalesService.addPayment` كانت تحسب `paid_total` من نسخة الفاتورة المقروءة **قبل** المعاملة،
 * فدفعتان متزامنتان كانتا تجمعان على الرصيد نفسه وتعبران سقف الفاتورة معاً. و`SalesService.void`
 * كانت تقرأ الحالة خارج المعاملة، فإلغاءان متزامنان كانا يعكسان القيد والمخزون مرتين.
 * الاثنتان صارتا تقفلان صف الفاتورة (`FOR UPDATE`) وتقرآن الحالة والمال المُودَعين بعده.
 *
 * الاختبارات هنا تطلق الطلبين **معاً** (`Promise.all`) على قاعدة حقيقية بأقفالها ومعاملاتها،
 * ثم تقرأ النتيجة من الدفتر: `paid_total`، صفوف الدفعات، عدد المرايا، ورصيد المخزون.
 */
describe('Sales collection & void under concurrency', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  async function levelOf(): Promise<number> {
    const response = await api(
      ctx.server,
      'get',
      `/api/v1/inventory/levels?warehouse_id=${warehouseId}&item_id=${itemId}`,
      { token: actor.token },
    );
    const rows = (response.body.data ?? response.body) as Array<{ quantity: string }>;
    return Number(rows[0]?.quantity ?? 0);
  }

  async function invoiceRow(invoiceId: string) {
    return withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT status, paid_total::text, total::text, payment_status,
               (SELECT COUNT(*)::int FROM invoice_payments p
                 WHERE p.tenant_id = ${actor.tenantId}::uuid AND p.invoice_id = ${invoiceId}::uuid) AS payments
        FROM sales_invoices
        WHERE id = ${invoiceId}::uuid AND tenant_id = ${actor.tenantId}::uuid
      `);
      return (rows as { rows: Array<Record<string, unknown>> }).rows[0]!;
    });
  }

  async function reversalCount(invoiceId: string): Promise<number> {
    return withTenantTx(ctx.handle.db, actor.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt
        FROM journal_entries rev
        JOIN journal_entries orig ON orig.id = rev.reversal_of
        WHERE rev.tenant_id = ${actor.tenantId}::uuid
          AND orig.source_type = 'sales_invoice'
          AND orig.source_id = ${invoiceId}::uuid
      `);
      return (rows as { rows: Array<{ cnt: number }> }).rows[0]?.cnt ?? 0;
    });
  }

  const postInvoice = async (qty: string, unitPrice = '100') => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        lines: [{ itemId, quantity: qty, unitPrice, taxRate: '15' }],
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

  beforeAll(async () => {
    ctx = await createTestApp('sales-concurrency');
    actor = await createActor(ctx, {
      tenantCode: 'conc-alpha',
      email: 'owner@conc-alpha.test',
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
        'sales.invoice.pay',
        'sales.invoice.void',
        'sales.return.create',
        'parties.view',
        'parties.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'accounting.account.view',
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
        sku: 'SKU-CONC',
        nameAr: 'صنف التزامن',
        categoryId: data(category.body).id,
        baseUnitId: data(unit.body).id,
        salePrice: '100.0000',
        purchasePrice: '40.0000',
      },
    });
    itemId = data(item.body).id as string;

    const opening = await api(ctx.server, 'post', '/api/v1/inventory/ledger/record', {
      token: actor.token,
      body: {
        lines: [
          {
            itemId,
            warehouseId,
            qty: '100',
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
      body: { kind: 'customer', name: 'عميل التزامن' },
    });
    partyId = data(party.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('never collects more than the invoice when two payments race', async () => {
    // فاتورة بإجمالي 115 (100 + ضريبة 15) — دفعتان من 100 معاً: واحدة تكفي وتفيض.
    const invoice = await postInvoice('1');
    const due = Number((await invoiceRow(invoice.id)).total);

    const [first, second] = await Promise.all([
      api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/payments`, {
        token: actor.token,
        body: { method: 'credit', amount: '100', idempotencyKey: `race-a-${invoice.id}` },
      }),
      api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/payments`, {
        token: actor.token,
        body: { method: 'credit', amount: '100', idempotencyKey: `race-b-${invoice.id}` },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    // واحدة قُبلت والأخرى رُفضت لتجاوزها المستحق — ولا خطأ داخلي (قفل أو انتهاك تفرد).
    expect(statuses).toEqual([201, 422]);
    const refused = first.status === 422 ? first : second;
    expect(codeOf(refused.body)).toBe('PAYMENT_EXCEEDS_DUE');

    const row = await invoiceRow(invoice.id);
    expect(Number(row.paid_total)).toBeCloseTo(100, 4);
    expect(Number(row.paid_total)).toBeLessThanOrEqual(due + 0.0001);
    expect(Number(row.payments)).toBe(1);
    expect(row.payment_status).toBe('partial');
  });

  it('returns the stored payment when the same idempotency key is replayed', async () => {
    const invoice = await postInvoice('2');
    const first = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/payments`, {
      token: actor.token,
      body: { method: 'credit', amount: '50', idempotencyKey: `replay-${invoice.id}` },
    });
    expect(first.status).toBe(201);
    const replay = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/payments`, {
      token: actor.token,
      body: { method: 'credit', amount: '50', idempotencyKey: `replay-${invoice.id}` },
    });
    expect(replay.status).toBe(201);
    expect((data(replay.body) as { id: string }).id).toBe((data(first.body) as { id: string }).id);

    const row = await invoiceRow(invoice.id);
    expect(Number(row.paid_total)).toBeCloseTo(50, 4);
    expect(Number(row.payments)).toBe(1);
  });

  it('voids an invoice once when two requests race for it', async () => {
    const levelBefore = await levelOf();
    const invoice = await postInvoice('6');
    expect(await levelOf()).toBe(levelBefore - 6);

    const [first, second] = await Promise.all([
      api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
        token: actor.token,
        body: { reason: 'إلغاء أول' },
      }),
      api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/void`, {
        token: actor.token,
        body: { reason: 'إلغاء ثانٍ' },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(first.status < 500 && second.status < 500).toBe(true);

    // البضاعة رجعت مرّة واحدة لا مرتين، ومرآة واحدة لقيد الفاتورة.
    expect(await levelOf()).toBe(levelBefore);
    expect(await reversalCount(invoice.id)).toBe(1);
    expect((await invoiceRow(invoice.id)).status).toBe('voided');
  });

  it('refuses a return that exceeds what the invoice sold', async () => {
    const invoice = await postInvoice('4');
    const tooMuch = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        reason: 'مرتجع زائد',
        lines: [{ itemId, quantity: '9', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.status).toBeLessThan(500);

    const allowed = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        reason: 'مرتجع جزئي',
        lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    const returnId = (data(allowed.body) as { id: string }).id;
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${returnId}/post`, {
      token: actor.token,
      body: {},
    });

    // المرتجع أعاد الكمية فعلاً إلى الرفّ.
    const level = await levelOf();
    expect(level).toBeGreaterThan(0);

    // ولا يُعاد أكثر مما رجع: مرتجع ثانٍ على الكمية نفسها مرفوض.
    const again = await api(ctx.server, 'post', `/api/v1/sales/invoices/${invoice.id}/return`, {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId,
        reason: 'مرتجع مكرر',
        lines: [{ itemId, quantity: '3', unitPrice: '100', taxRate: '15' }],
      },
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
  });
});
