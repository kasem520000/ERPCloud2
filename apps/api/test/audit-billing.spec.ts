import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { withOwnerClient } from '@erp/testing';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-04 (Stripe) · AUD-05 · AUD-06 — الفوترة القديمة `/billing/*`.
 *
 * ما كان قبل الإصلاح (وما يُثبته هذا الملف بطلباتٍ حقيقية على PostgreSQL مع RLS):
 *   • `POST /billing/webhook` بلا `@Public()` ⇒ 401 من `AuthGuard` قبل `constructEvent`،
 *     أي أن Stripe لا تستطيع تسليم أي حدث.
 *   • كل عبارة SQL على `tenant_subscriptions`/`activation_requests` بلا `withTenantTx`
 *     ⇒ سياسة `FORCE ROW LEVEL SECURITY` تُطابق صفراً ⇒ قراءة الرخصة `null` وطلب التفعيل
 *     يفشل — يُثبت هنا بقراءة رخصةٍ حقيقية، وعزلِ مستأجرٍ عن آخر.
 *   • إعادة تسليم الحدث نفسه تُلغي الاشتراك النشط (التحديث الأول يمرّ على الحيّ، والثاني
 *     لا يجد `incomplete`) ⇒ يُثبت هنا بأن الحدث المكرّر لا يغيّر رخصةً نشطة.
 *
 * ويشمل الملف مسار الدفع `checkout`: نداء المزوّد يقع **بعد** كتابة الصفّ المحلّي داخل
 * المعاملة نفسها؛ فإذا رُفض الإدراج لا تُنشأ جلسة دفع خارجية (يُقاس بعدّ الطلبات على خادم
 * Stripe وهميّ محلّي — بلا شبكة).
 */

const STRIPE_SECRET = 'sk_test_audit';
const WEBHOOK_SECRET = 'whsec_audit';


describe('AUD-04/05/06 — ويب هوك Stripe وسياق RLS وتكرار الأحداث', () => {
  let ctx: TestApp;
  let actor: Actor;
  let otherActor: Actor;
  let operator: Actor;
  let planId = '';
  let stripeRequests = 0;
  let stripeServer: Server;
  let stripePort = 0;

  const data = (response: { body: Record<string, unknown> }) =>
    (response.body.data ?? response.body) as Record<string, any>;

  const subscriptionRow = (tenantId: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT id, status, provider, activated_at, provider_subscription_id, provider_checkout_session_id
           FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      );
      return result.rows[0] as Record<string, unknown> | undefined;
    });

  const insertSubscription = (options: {
    id?: string;
    tenantId: string;
    planId?: string;
    status: string;
    provider?: string;
    checkoutSessionId?: string | null;
  }) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const id = options.id ?? randomUUID();
      await client.query(
        `INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider, provider_checkout_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, options.tenantId, options.planId ?? planId, options.status, options.provider ?? 'stripe', options.checkoutSessionId ?? null],
      );
      return id;
    });

  const webhookEventCount = () =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT count(*)::int AS total FROM billing_webhook_events`);
      return (result.rows[0] as { total: number }).total;
    });

  const stripeEvent = (options: { eventId: string; tenantId: string; subscriptionId?: string; sessionId?: string; plan?: string }) => {
    const payload = JSON.stringify({
      id: options.eventId,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: options.sessionId ?? `cs_${options.eventId}`,
          object: 'checkout.session',
          payment_status: 'paid',
          subscription: `sub_${options.eventId}`,
          customer: 'cus_audit',
          metadata: {
            tenantId: options.tenantId,
            planId: options.plan ?? planId,
            ...(options.subscriptionId ? { subscriptionId: options.subscriptionId } : {}),
          },
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return { payload, signature };
  };

  const deliver = (payload: string, signature: string) =>
    api(ctx.server, 'post', '/api/v1/billing/webhook', {
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = STRIPE_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    // خادم Stripe وهميّ: العميل الحقيقي (stripe-node) يتحدّث إليه عبر خيارات host/port،
    // فلا شبكة خارجية ويُقاس عدد النداءات بدقّة.
    stripeServer = createServer((request, response) => {
      stripeRequests += 1;
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `cs_mock_${stripeRequests}`, object: 'checkout.session', url: 'http://checkout.test/pay', status: 'open' }));
      });
    });
    await new Promise<void>((resolve) => stripeServer.listen(0, '127.0.0.1', resolve));
    const address = stripeServer.address();
    stripePort = typeof address === 'object' && address ? address.port : 0;
    process.env.STRIPE_API_HOST = '127.0.0.1';
    process.env.STRIPE_API_PORT = String(stripePort);
    process.env.STRIPE_API_PROTOCOL = 'http';

    ctx = await createTestApp('audit-billing');
    actor = await createActor(ctx, { tenantCode: 'audit-billing', email: 'owner@audit-billing.test', permissions: ALL_PLATFORM_PERMISSIONS });
    otherActor = await createActor(ctx, { tenantCode: 'audit-billing-2', email: 'owner@audit-billing-2.test', permissions: ALL_PLATFORM_PERMISSIONS });
    operator = await createActor(ctx, {
      tenantCode: 'audit-billing-console',
      email: 'operator@audit-billing.test',
      isPlatformAdmin: true,
      platformRoles: ['platform_owner'],
    });

    planId = randomUUID();
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(
        `INSERT INTO billing_plans (id, code, name, interval, amount, currency, stripe_price_id, active)
         VALUES ($1, 'audit-plan', 'Audit plan', 'month', 100, 'SAR', 'price_audit', true)`,
        [planId],
      );
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
    await new Promise<void>((resolve) => stripeServer.close(() => resolve()));
    delete process.env.STRIPE_API_HOST;
    delete process.env.STRIPE_API_PORT;
    delete process.env.STRIPE_API_PROTOCOL;
  });

  it('AUD-05 موجب: المنشأة تقرأ رخصتها الحقيقية عبر سياق RLS', async () => {
    const id = await insertSubscription({ tenantId: actor.tenantId, status: 'incomplete' });

    const response = await api(ctx.server, 'get', '/api/v1/billing/subscription', { token: actor.token });
    expect(response.status).toBe(200);
    expect(data(response).id).toBe(id);
    expect(data(response).status).toBe('incomplete');
    expect(data(response).plan_code).toBe('audit-plan');
  });

  it('AUD-05 عزل: منشأةٌ أخرى لا ترى رخصة هذه المنشأة', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/billing/subscription', { token: otherActor.token });
    expect(response.status).toBe(200);
    expect(response.body.data, 'a tenant without a licence sees nothing').toBeNull();

    const mine = await api(ctx.server, 'get', '/api/v1/billing/subscription', { token: actor.token });
    expect(data(mine).id).not.toBeUndefined();
  });

  it('AUD-05 موجب: طلب التفعيل اليدوي يُكتب في سياق المستأجر ومراجعته بحارس المنصّة', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/billing/activation-requests', {
      token: actor.token,
      body: { planId, notes: 'audit' },
    });
    expect(created.status).toBe(201);
    expect(data(created).status).toBe('pending');
    const requestId = String(data(created).id);

    const tenantRead = await api(ctx.server, 'get', '/api/v1/billing/activation-requests', { token: actor.token });
    expect(tenantRead.status, 'the console list stays behind the platform guard').toBe(403);

    const consoleList = await api(ctx.server, 'get', '/api/v1/billing/activation-requests', { token: operator.token });
    expect(consoleList.status).toBe(200);
    const listed = consoleList.body.data as Array<Record<string, unknown>>;
    expect(listed.map((row) => String(row.id))).toContain(requestId);

    const reviewed = await api(ctx.server, 'post', `/api/v1/billing/activation-requests/${requestId}/review`, {
      token: operator.token,
      body: { approve: true, notes: 'approved by audit test' },
    });
    expect(reviewed.status).toBe(201);
    expect(data(reviewed).status).toBe('approved');

    const subscription = await subscriptionRow(actor.tenantId);
    expect(subscription?.status).toBe('active');
    expect(subscription?.provider).toBe('manual');
  });

  it('AUD-04 موجب: توقيع صحيح بلا رمز مستخدم يصل إلى المعالج ويفعّل الرخصة', async () => {
    const boundId = await insertSubscription({
      tenantId: actor.tenantId,
      status: 'incomplete',
      checkoutSessionId: `cs_bound_${Date.now()}`,
    });
    const { payload, signature } = stripeEvent({
      eventId: `evt_paid_${Date.now()}`,
      tenantId: actor.tenantId,
      subscriptionId: boundId,
    });

    const response = await deliver(payload, signature);
    expect(response.status).toBe(200);
    expect(data(response).handled).toBe(true);
    expect(data(response).subscriptionId).toBe(boundId);

    const row = await subscriptionRow(actor.tenantId);
    expect(row?.id).toBe(boundId);
    expect(row?.status).toBe('active');
    expect(row?.provider_subscription_id).toBeTruthy();
  });

  it('AUD-04 سالب: توقيع خاطئ ⇒ 401 بلا أي كتابة', async () => {
    const before = await webhookEventCount();
    const { payload } = stripeEvent({ eventId: `evt_bad_${Date.now()}`, tenantId: actor.tenantId });

    const response = await deliver(payload, 't=1,v1=deadbeef');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('BILLING_SIGNATURE_INVALID');
    expect(await webhookEventCount()).toBe(before);
  });

  it('AUD-06: تكرار الحدث لا يلغي اشتراكاً نشطاً', async () => {
    const targetId = await insertSubscription({ tenantId: actor.tenantId, status: 'incomplete' });
    const eventId = `evt_replay_${Date.now()}`;
    const { payload, signature } = stripeEvent({ eventId, tenantId: actor.tenantId, subscriptionId: targetId });

    const first = await deliver(payload, signature);
    expect(data(first).handled).toBe(true);
    expect((await subscriptionRow(actor.tenantId))?.status).toBe('active');

    const replay = await deliver(payload, signature);
    expect(replay.status).toBe(200);
    expect(data(replay).duplicate).toBe(true);

    const afterReplay = await subscriptionRow(actor.tenantId);
    expect(afterReplay?.id, 'the replay must not retire the live licence').toBe(targetId);
    expect(afterReplay?.status).toBe('active');
  });

  it('AUD-06: تسليم متزامن للحدث نفسه ⇒ تسجيلٌ واحد ولا أثر مزدوج', async () => {
    const targetId = await insertSubscription({ tenantId: actor.tenantId, status: 'incomplete' });
    const eventId = `evt_race_${Date.now()}`;
    const { payload, signature } = stripeEvent({ eventId, tenantId: actor.tenantId, subscriptionId: targetId });

    const [first, second] = await Promise.all([deliver(payload, signature), deliver(payload, signature)]);
    const handled = [first, second].filter((response) => data(response).handled === true);
    const duplicates = [first, second].filter((response) => data(response).duplicate === true);
    expect(handled).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    const rows = await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT count(*)::int AS total FROM billing_webhook_events WHERE event_id = $1`, [eventId]);
      return (result.rows[0] as { total: number }).total;
    });
    expect(rows).toBe(1);
    expect((await subscriptionRow(actor.tenantId))?.id).toBe(targetId);
  });

  it('AUD-06: حدثٌ متأخّر لا يُحيي رخصةً أُلغيت', async () => {
    const targetId = await insertSubscription({ tenantId: actor.tenantId, status: 'incomplete', checkoutSessionId: `cs_late_${Date.now()}` });
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now() WHERE id = $1`, [targetId]);
    });

    const { payload, signature } = stripeEvent({
      eventId: `evt_late_${Date.now()}`,
      tenantId: actor.tenantId,
      subscriptionId: targetId,
      sessionId: `cs_late_${Date.now()}`,
    });
    const response = await deliver(payload, signature);

    expect(response.status).toBe(200);
    const row = await subscriptionRow(actor.tenantId);
    expect(row?.id).toBe(targetId);
    expect(row?.status, 'a late event must not resurrect a canceled licence').toBe('canceled');
  });

  it('AUD-05: رفض إدراج الصفّ المحلّي يمنع إنشاء جلسة دفع خارجية', async () => {
    // Failpoint حقيقي على القاعدة (لا محاكاة): مُشغِّلٌ يرفض إدراج صفّ الفوترة لهذه
    // المنشأة، فيجب أن يفشل الطلب **قبل** أي نداء إلى Stripe.
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION audit_block_subscription() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit failpoint: subscription insert blocked'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER audit_block_subscription_trigger BEFORE INSERT ON tenant_subscriptions
        FOR EACH ROW EXECUTE FUNCTION audit_block_subscription();
      `);
    });
    const before = stripeRequests;
    try {
      const response = await api(ctx.server, 'post', '/api/v1/billing/checkout', { token: actor.token, body: { planId } });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(stripeRequests, 'no external checkout session without a local row').toBe(before);
    } finally {
      await withOwnerClient(ctx.db.ownerUrl, async (client) => {
        await client.query(`DROP TRIGGER IF EXISTS audit_block_subscription_trigger ON tenant_subscriptions`);
        await client.query(`DROP FUNCTION IF EXISTS audit_block_subscription()`);
      });
    }
  });

  it('AUD-05/06 موجب: checkout يربط الجلسة الخارجية برخصةٍ واحدة', async () => {
    const before = stripeRequests;
    const response = await api(ctx.server, 'post', '/api/v1/billing/checkout', { token: actor.token, body: { planId } });

    expect(response.status).toBe(201);
    expect(String(data(response).url)).toContain('http://checkout.test/pay');
    expect(stripeRequests).toBe(before + 1);

    const row = await subscriptionRow(actor.tenantId);
    expect(row?.status).toBe('incomplete');
    expect(row?.provider).toBe('stripe');
    expect(String(row?.provider_checkout_session_id)).toBe(String(data(response).id));
  });
});
