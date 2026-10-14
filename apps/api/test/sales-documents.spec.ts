import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Quotations and customer payment methods.
 *
 * A quotation is the one sales document that must **not** reach the ledger, and a payment
 * method is the one directory where "exactly one default" is a data invariant rather than
 * a UI convention — both are easy to regress, so they are proved end to end here.
 */
describe('quotations and payment methods', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let itemId = '';

  beforeAll(async () => {
    ctx = await createTestApp('sales-documents');
    actor = await createActor(ctx, {
      tenantCode: 'quotes-alpha',
      email: 'owner@quotes-alpha.test',
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
        'parties.view',
        'parties.manage',
      ],
    });

    const branch = await api(ctx.server, 'post', '/api/v1/branches', {
      token: actor.token,
      body: { code: 'MAIN', nameAr: 'الفرع الرئيسي' },
    });
    branchId = ((branch.body.data ?? branch.body) as { id: string }).id;

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
        sku: 'SKU-1',
        nameAr: 'صنف تجريبي',
        categoryId: ((category.body.data ?? category.body) as { id: string }).id,
        baseUnitId: ((unit.body.data ?? unit.body) as { id: string }).id,
        salePrice: '100.0000',
      },
    });
    itemId = ((item.body.data ?? item.body) as { id: string }).id;
  }, 240_000);

  afterAll(async () => ctx.close());

  const quotationBody = (validUntil?: string) => ({
    branchId,
    cashCustomerName: 'عميل نقدي',
    validUntil,
    lines: [{ itemId, quantity: '2', unitPrice: '100', taxRate: '15' }],
  });

  it('numbers a quotation on creation and refuses to post it', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/quotations', { token: actor.token, body: quotationBody('2099-12-31') });
    expect(created.status).toBe(201);
    const quotation = (created.body.data ?? created.body) as { id: string; number: string; kind: string; total: string };
    expect(quotation.kind).toBe('quotation');
    expect(quotation.number).toMatch(/^QT-\d{6}$/);
    expect(quotation.total).toBe('230.0000');

    const posted = await api(ctx.server, 'post', `/api/v1/sales/invoices/${quotation.id}/post`, { token: actor.token, body: {} });
    expect(posted.status).toBe(409);
    expect(posted.body.code).toBe('SALES_QUOTATION_NOT_POSTABLE');
  });

  it('converts a quotation into a draft invoice exactly once', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/quotations', { token: actor.token, body: quotationBody('2099-12-31') });
    const quotation = (created.body.data ?? created.body) as { id: string; total: string };

    const converted = await api(ctx.server, 'post', `/api/v1/sales/quotations/${quotation.id}/convert`, { token: actor.token, body: {} });
    expect(converted.status).toBe(201);
    const invoice = (converted.body.data ?? converted.body) as { id: string; kind: string; status: string; total: string; referenceInvoiceId: string };
    expect(invoice.kind).toBe('sale');
    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(quotation.total);
    expect(invoice.referenceInvoiceId).toBe(quotation.id);

    const again = await api(ctx.server, 'post', `/api/v1/sales/quotations/${quotation.id}/convert`, { token: actor.token, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SALES_QUOTATION_ALREADY_CONVERTED');
  });

  it('refuses to convert a quotation whose validity has passed', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/sales/quotations', { token: actor.token, body: quotationBody('2020-01-01') });
    const quotation = (created.body.data ?? created.body) as { id: string };

    const converted = await api(ctx.server, 'post', `/api/v1/sales/quotations/${quotation.id}/convert`, { token: actor.token, body: {} });
    expect(converted.status).toBe(422);
    expect(converted.body.code).toBe('SALES_QUOTATION_EXPIRED');
  });

  it('keeps exactly one default payment method and rejects a duplicate code', async () => {
    const cash = await api(ctx.server, 'post', '/api/v1/payment-methods', {
      token: actor.token,
      body: { code: 'CASH', nameAr: 'نقداً', kind: 'cash', isDefault: true },
    });
    expect(cash.status).toBe(201);

    const duplicate = await api(ctx.server, 'post', '/api/v1/payment-methods', { token: actor.token, body: { code: 'CASH', nameAr: 'مكرر' } });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe('PAYMENT_METHOD_CODE_TAKEN');

    const negative = await api(ctx.server, 'post', '/api/v1/payment-methods', {
      token: actor.token,
      body: { code: 'NET', nameAr: 'آجل', kind: 'credit', dueDays: -1 },
    });
    expect(negative.status).toBe(422);
    expect(negative.body.code).toBe('PAYMENT_METHOD_DUE_DAYS_INVALID');

    const card = await api(ctx.server, 'post', '/api/v1/payment-methods', {
      token: actor.token,
      body: { code: 'CARD', nameAr: 'شبكة', kind: 'card', isDefault: true },
    });
    expect(card.status).toBe(201);

    const list = await api(ctx.server, 'get', '/api/v1/payment-methods', { token: actor.token });
    const methods = (list.body.data ?? list.body) as Array<{ code: string; isDefault: boolean }>;
    expect(methods.filter((method) => method.isDefault).map((method) => method.code)).toEqual(['CARD']);
  });
});
