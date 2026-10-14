import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-04 (Salla) — الويب هوك كان: (أ) بلا `@Public()` فيرفضه `AuthGuard` بـ401 قبل أي
 * تحقّق، (ب) يقرأ `getTenantContext()` وهو سياقٌ غير موجود في طلبٍ عامّ، (ج) يوقّع
 * `JSON.stringify(req.body)` بدل البايتات الخام، (د) رفض الترويسة الغائبة كان يرمي
 * `TypeError` من `Buffer.from(undefined)` فيظهر 500 بدل 401.
 *
 * ويُثبت هنا: طلبٌ **بلا رمز مستخدم** يصل إلى المعالج، والمستأجر يُشتقّ من صفّ الاتصال
 * الموقَّع (لا من جسم الطلب)، وتوقيعٌ على بايتاتٍ أخرى يُرفض قبل أي كتابة.
 */

const WEBHOOK_SECRET = 'mock-webhook-secret';

describe('AUD-04 — ويب هوك Salla عامّ ومربوط بالبايتات الخام والمستأجر الموثوق', () => {
  let ctx: TestApp;
  let actor: Actor;
  let otherTenantActor: Actor;
  let branchId = '';
  let storeId = '';

  const post = (path: string, body: Record<string, unknown>, token = actor.token) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token, body });
  const data = (response: { body: Record<string, unknown> }) =>
    (response.body.data ?? response.body) as Record<string, any>;
  const sign = (payload: string, secret = WEBHOOK_SECRET) =>
    createHmac('sha256', secret).update(payload).digest('hex');

  const webhook = (payload: string, signature?: string, store = storeId) =>
    api(ctx.server, 'post', `/api/v1/integrations/salla/webhooks/${store}/orders`, {
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-salla-signature': signature }),
      },
      body: payload,
    });

  const sallaInvoiceCount = (tenantId: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS total FROM sales_invoices WHERE tenant_id = $1 AND order_type = 'salla'`,
        [tenantId],
      );
      return (result.rows[0] as { total: number }).total;
    });

  const order = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: 'order.created',
      data: {
        branchId,
        customer: { name: 'عميل سلة', mobile: '0500000000' },
        items: [{ name: 'قميص قطني', quantity: '2', amount: '120.0000' }],
      },
      ...overrides,
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-salla-webhook');
    actor = await createActor(ctx, {
      tenantCode: 'audit-salla',
      email: 'owner@audit-salla.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'salla.integration.view',
        'salla.integration.manage',
        'sales.invoice.create',
        'sales.view',
      ],
    });
    otherTenantActor = await createActor(ctx, {
      tenantCode: 'audit-salla-2',
      email: 'owner@audit-salla-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'salla.integration.manage'],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'الفرع الرئيسي' });
    branchId = data(branch).id as string;

    storeId = `MOCK-AUDIT-${Date.now()}`;
    const connection = await post('/integrations/salla/connections', {
      storeId,
      accessToken: 'mock-token',
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(connection.status).toBe(201);

    // متجرٌ آخر (مستأجر آخر) بسرٍّ مختلف: أساس فحص العزل وعدم اعتماد سرّ المنشأة الأولى.
    const otherConnection = await api(ctx.server, 'post', '/api/v1/integrations/salla/connections', {
      token: otherTenantActor.token,
      body: { storeId: `MOCK-OTHER-${Date.now()}`, accessToken: 'mock-token', webhookSecret: 'other-secret' },
    });
    expect(otherConnection.status).toBe(201);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('موجبة: طلب عامّ بلا رمز مستخدم وتوقيع صحيح يُنشئ فاتورة', async () => {
    const payload = order();
    const response = await webhook(payload, sign(payload));

    expect(response.status).toBe(201);
    expect(typeof data(response).invoiceId).toBe('string');
    expect(await sallaInvoiceCount(actor.tenantId)).toBe(1);
  });

  it('سالبة: بلا ترويسة توقيع ⇒ 401 لا 500', async () => {
    const payload = order();
    const response = await webhook(payload);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('SALLA_WEBHOOK_SIGNATURE_INVALID');
  });

  it('سالبة: توقيع خاطئ ⇒ 401 ولا تُكتب فاتورة', async () => {
    const before = await sallaInvoiceCount(actor.tenantId);
    const payload = order();
    const response = await webhook(payload, sign(payload, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(await sallaInvoiceCount(actor.tenantId)).toBe(before);
  });

  it('سالبة: توقيعٌ صحيح لجسمٍ آخر (بايتات مختلفة) يُرفض — التوقيع على البايتات الخام', async () => {
    const before = await sallaInvoiceCount(actor.tenantId);
    const signed = order();
    const tampered = JSON.stringify({ ...JSON.parse(signed), injected: true }, null, 2);

    expect(tampered).not.toBe(signed);
    const response = await webhook(tampered, sign(signed));

    expect(response.status).toBe(401);
    expect(await sallaInvoiceCount(actor.tenantId)).toBe(before);
  });

  it('سالبة: متجر مجهول ⇒ 404 بلا كشف أي منشأة', async () => {
    const payload = order();
    const response = await webhook(payload, sign(payload), 'MOCK-DOES-NOT-EXIST');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('SALLA_CONNECTION_NOT_FOUND');
  });

  it('سالبة: سرّ منشأة أخرى لا يوقّع لمتجر هذه المنشأة', async () => {
    const before = await sallaInvoiceCount(actor.tenantId);
    const payload = order();
    const response = await webhook(payload, sign(payload, 'other-secret'));

    expect(response.status).toBe(401);
    expect(await sallaInvoiceCount(actor.tenantId)).toBe(before);
  });
  it('AUD-14: السجل التدقيقي للويب هوك يُنسب إلى المستأجر المستخرج من التوقيع', async () => {
    const payload = order({ subject: 'إسناد' });
    expect((await webhook(payload, sign(payload))).status).toBe(201);

    const rows = await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT tenant_id, actor_user_id FROM audit_log
          WHERE meta->>'path' = 'integrations/salla/webhooks'
          ORDER BY created_at DESC LIMIT 1`,
      );
      return result.rows as Array<{ tenant_id: string | null; actor_user_id: string | null }>;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(actor.tenantId);
    expect(rows[0]!.actor_user_id).toBeNull();
  });

});
