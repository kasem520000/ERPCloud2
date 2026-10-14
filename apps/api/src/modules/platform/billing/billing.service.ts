import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { withPlatformAdminTx, withTenantTx, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getTenantContext } from '../context/tenant-context.js';
import { getAuthContext } from '../../../request-context/request-context.js';

export type BillingPlan = { id: string; code: string; name: string; interval: 'month' | 'year'; amount: string; currency: string; stripePriceId: string | null };

type StripeClient = Stripe;

/**
 * سباقٌ صريح: هذا هو المسار الوحيد الذي ينادي Stripe في المستودع (اللوحة الحديثة لا
 * تنادي المزوّد). وهو **القديم** لكن له مستهلكون حيّون (`apps/staff/app/support/license`)،
 * فالإصلاح هنا لا إزالة:
 *
 *   • AUD-05 — كل عبارة SQL كانت تُنفَّذ على `this.database.db` مباشرة بلا
 *     `withTenantTx`/`withPlatformAdminTx`. جدولا `tenant_subscriptions` و`activation_requests`
 *     يحملان سياسة العزل بعنوان `FORCE ROW LEVEL SECURITY` (0019)، و`erp_api` بدوره
 *     `NOBYPASSRLS`: مع GUC غير مضبوط تُطابق السياسة صفراً من الصفوف. فقراءة رخصة عميلٍ
 *     كانت ترجع `null`، وإنشاء طلب تفعيل كان يفشل — لا يظهر ذلك على قاعدةٍ بصلاحيات
 *     مرتفعة، ولهذا صار كل استدعاء هنا داخل معاملةٍ تحمل السياق الصحيح:
 *       – مسار المستأجر (رخصته، جلسته، طلبه) → `withTenantTx`.
 *       – مسار المنصّة (مراجعة الطلبات، أحداث المزوّد) → `withPlatformAdminTx`.
 *
 *   • AUD-06 — التكرار: `billing_webhook_events` بقيد `(provider, event_id)` يجعل الحدث
 *     نفسه مرةً واحدة مهما أُعيد إرساله (حتى لو تزامن الإرسالان)، والحدث يُربط برخصةٍ
 *     **واحدة** عبر `metadata.subscriptionId` (وعبر `provider_checkout_session_id` كخطٍّ
 *     ثانٍ)، فلا يُختار الصف بالمطابقة على tenant/plan وحدها، ولا يُلمس اشتراكٌ نشط.
 */
@Injectable()
export class BillingService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /**
   * عميل Stripe — نقطة حقنٍ واحدة. `STRIPE_API_*` تسمح لبيئة الاختبار بتوجيه العميل إلى
   * خادمٍ محلّي (خيار `host`/`port`/`protocol` في stripe-node، وهو مصمَّم لهذا)، و**لا
   * تُقرأ في `NODE_ENV=production`** حتى لا يكون إعدادُ البيئة طريقاً لتحويل نداءات المزوّد.
   */
  private stripe(secret: string): StripeClient {
    if (process.env.NODE_ENV === 'production') return new Stripe(secret);
    const host = process.env.STRIPE_API_HOST;
    if (!host) return new Stripe(secret);
    return new Stripe(secret, {
      host,
      port: Number(process.env.STRIPE_API_PORT ?? 80),
      protocol: (process.env.STRIPE_API_PROTOCOL as 'http' | 'https' | undefined) ?? 'http',
      maxNetworkRetries: 0,
    });
  }

  private secret(): string {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new DomainError('BILLING_PROVIDER_NOT_CONFIGURED', 'Stripe is not configured', 503);
    return secret;
  }

  async listActivePlans(): Promise<BillingPlan[]> {
    return withTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`SELECT id, code, name, interval, amount::text, currency, stripe_price_id FROM billing_plans WHERE active = true ORDER BY amount ASC, interval ASC, code ASC`);
      return rowsOf<Record<string, unknown>>(result).map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name), interval: row.interval === 'year' ? 'year' : 'month', amount: String(row.amount), currency: String(row.currency), stripePriceId: row.stripe_price_id ? String(row.stripe_price_id) : null }));
    });
  }

  /**
   * إنشاء جلسة Checkout. الترتيب مقصود: الصفّ المحلّي (`incomplete`) يُكتب **قبل** نداء
   * المزوّد داخل المعاملة نفسها، فإن رُفض الإدراج (RLS أو قيد) لا تُنشأ جلسة دفع خارجية
   * أصلاً؛ وإن فشل المزوّد تُلغى المعاملة كلها فلا يبقى صفٌّ يتيم. ويُربط الترتيب برخصةٍ
   * واحدة عبر `metadata.subscriptionId` ومعرّف الجلسة في العمود الجديد.
   */
  async createStripeCheckout(planId: string) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    const secret = this.secret();
    const stripe = this.stripe(secret);
    const baseUrl = process.env.PUBLIC_APP_URL ?? `http://localhost:3001`;

    return withTenantTx(this.database.db, tenant.tenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT id, stripe_price_id FROM billing_plans WHERE id = ${planId}::uuid AND active = true`);
      const plan = rowsOf<Record<string, unknown>>(result)[0];
      if (!plan?.stripe_price_id) {
        throw new DomainError('BILLING_PLAN_NOT_CONFIGURED', 'This plan is not configured for Stripe', 422, { field: 'planId' });
      }

      const subscriptionId = newId();
      await tx.execute(sql`
        INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider)
        VALUES (${subscriptionId}::uuid, ${tenant.tenantId}::uuid, ${plan.id}::uuid, 'incomplete', 'stripe')
      `);

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: String(plan.stripe_price_id), quantity: 1 }],
        success_url: `${baseUrl}/portal?billing=success`,
        cancel_url: `${baseUrl}/pricing?billing=canceled`,
        metadata: { tenantId: tenant.tenantId, planId: String(plan.id), userId: auth.userId, subscriptionId },
      });

      await tx.execute(sql`
        UPDATE tenant_subscriptions
           SET provider_checkout_session_id = ${session.id}, updated_at = now()
         WHERE id = ${subscriptionId}::uuid AND tenant_id = ${tenant.tenantId}::uuid
      `);

      return { id: session.id, url: session.url };
    });
  }

  async requestManualActivation(planId: string, notes?: string) {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return withTenantTx(this.database.db, tenant.tenantId, async (tx) => {
      const result = await tx.execute(sql`INSERT INTO activation_requests (id, tenant_id, requested_by, plan_id, notes) SELECT ${newId()}::uuid, ${tenant.tenantId}::uuid, ${auth.userId}::uuid, id, ${notes ?? null} FROM billing_plans WHERE id = ${planId}::uuid AND active = true RETURNING id, tenant_id, plan_id, status, notes, created_at`);
      const row = rowsOf<Record<string, unknown>>(result)[0];
      if (!row) throw new DomainError('BILLING_PLAN_NOT_FOUND', 'Active billing plan was not found', 404);
      return row;
    });
  }

  async mySubscription() {
    const tenant = getTenantContext();
    return withTenantTx(this.database.db, tenant.tenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT s.id, s.status, s.provider, s.current_period_start, s.current_period_end, s.activated_at, p.code AS plan_code, p.name AS plan_name, p.amount::text, p.currency FROM tenant_subscriptions s JOIN billing_plans p ON p.id = s.plan_id WHERE s.tenant_id = ${tenant.tenantId}::uuid ORDER BY s.created_at DESC LIMIT 1`);
      return rowsOf<Record<string, unknown>>(result)[0] ?? null;
    });
  }

  /** قراءة المنصّة عبر كل المستأجرين — بسياق المنصّة وحده (MULTI_TENANCY §4). */
  async listActivationRequests() {
    const auth = getAuthContext();
    if (!auth.isPlatformAdmin) throw new DomainError('FORBIDDEN', 'Platform administrator access required', 403);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`SELECT r.id, r.tenant_id, r.plan_id, r.status, r.notes, r.created_at, t.code AS tenant_code, t.name AS tenant_name, p.name AS plan_name, p.amount::text FROM activation_requests r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN billing_plans p ON p.id = r.plan_id WHERE r.status = 'pending' ORDER BY r.created_at ASC`);
      return rowsOf<Record<string, unknown>>(result);
    });
  }

  async reviewActivation(requestId: string, approve: boolean, notes?: string) {
    const auth = getAuthContext();
    if (!auth.isPlatformAdmin) throw new DomainError('FORBIDDEN', 'Platform administrator access required', 403);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`WITH reviewed AS (UPDATE activation_requests SET status = ${approve ? 'approved' : 'rejected'}, reviewed_by = ${auth.userId}::uuid, reviewed_at = now(), notes = COALESCE(${notes ?? null}, notes), updated_at = now() WHERE id = ${requestId}::uuid AND status = 'pending' RETURNING id, tenant_id, plan_id, status) SELECT * FROM reviewed`);
      const request = rowsOf<Record<string, unknown>>(result)[0];
      if (!request) throw new DomainError('BILLING_ACTIVATION_NOT_PENDING', 'Pending activation request was not found', 404);
      if (approve) {
        // انتهت صلاحية الرخصة الحيّة السابقة أولاً: الفهرس الفريد
        // `tenant_subscriptions_active_tenant_key` (0068) يمنع ترخيصين فعّالين لمنشأة.
        await tx.execute(sql`UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now(), canceled_reason = 'استُبدل بتفعيل يدوي', updated_at = now() WHERE tenant_id = ${request.tenant_id}::uuid AND status IN ('trialing', 'active', 'past_due', 'paused')`);
        await tx.execute(sql`INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider, activated_at, current_period_start) VALUES (${newId()}::uuid, ${request.tenant_id}::uuid, ${request.plan_id}::uuid, 'active', 'manual', now(), now())`);
      }
      return request;
    });
  }

  /**
   * دالة المزوّد. لا سياق مستأجر في الطلب (وهو عامّ)، فالحدث يُستقبل بسياق المنصّة بعد
   * التحقّق من التوقيع على **البايتات الخام**.
   *
   * خطوات المعالجة بالترتيب:
   *   1. التحقّق من التوقيع (`constructEvent`) — قبل أي كتابة.
   *   2. قيد الحدث: `INSERT ... ON CONFLICT DO NOTHING` على `(provider, event_id)`.
   *      لا صف ⇒ حدثٌ مُعالَج سابقاً ⇒ `{ handled: false, duplicate: true }` بلا أي أثر.
   *   3. حلّ الرخصة: `metadata.subscriptionId` (هويّتنا) ثم `provider_checkout_session_id`.
   *      وإن غاب الربط لا نخمّن: نُسجّل الحدث بلا اشتراك ونعيد `{ handled: false }`.
   *   4. إنهاء الرخص الحيّة **الأخرى** ثم تفعيل الرخصة المستهدفة إن كانت ما زالت
   *      `incomplete`/`pending`. الرخصة `active` لا تُلمس (تكرار)، و`canceled` لا تُحيا
   *      (حدثٌ متأخّر لا يعيد رخصةً أُلغيت بعده).
   */
  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    const secret = this.secret();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) throw new DomainError('BILLING_PROVIDER_NOT_CONFIGURED', 'Stripe webhook is not configured', 503);

    let event: Stripe.Event;
    try {
      event = this.stripe(secret).webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      throw new DomainError('BILLING_SIGNATURE_INVALID', 'Stripe webhook signature is invalid', 401);
    }

    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
      return { handled: false, reason: 'ignored-event-type' };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== 'paid' || !session.subscription || !session.metadata?.tenantId || !session.metadata.planId) {
      return { handled: false, reason: 'incomplete-session' };
    }

    const tenantId = session.metadata.tenantId;
    const planId = session.metadata.planId;
    const boundSubscriptionId = session.metadata.subscriptionId ?? null;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const claimed = await tx.execute(sql`
        INSERT INTO billing_webhook_events (id, provider, event_id, event_type, tenant_id)
        VALUES (${newId()}::uuid, 'stripe', ${event.id}, ${event.type}, ${tenantId}::uuid)
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING id
      `);
      if (rowsOf<Record<string, unknown>>(claimed).length === 0) {
        return { handled: false, duplicate: true };
      }

      const target = await this.resolveSubscriptionTarget(tx, {
        tenantId,
        planId,
        boundSubscriptionId,
        checkoutSessionId: session.id,
      });

      if (!target) {
        return { handled: false, reason: 'subscription-not-found' };
      }

      await tx.execute(sql`
        UPDATE billing_webhook_events
           SET subscription_id = ${target.id}::uuid
         WHERE provider = 'stripe' AND event_id = ${event.id}
      `);

      // «رخصة حيّة واحدة لكل عميل» قاعدةُ قاعدةِ بيانات (0068): تُنهى الأخرى أولاً.
      await tx.execute(sql`
        UPDATE tenant_subscriptions
           SET status = 'canceled', canceled_at = now(), canceled_reason = 'استُبدل باشتراك Stripe', updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid
           AND id <> ${target.id}::uuid
           AND status IN ('trialing', 'active', 'past_due', 'paused')
      `);

      await tx.execute(sql`
        UPDATE tenant_subscriptions
           SET status = 'active',
               provider_customer_id = ${typeof session.customer === 'string' ? session.customer : null},
               provider_subscription_id = ${typeof session.subscription === 'string' ? session.subscription : null},
               provider_checkout_session_id = COALESCE(provider_checkout_session_id, ${session.id}),
               activated_at = now(),
               current_period_start = now(),
               updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid
           AND id = ${target.id}::uuid
           AND status IN ('incomplete', 'pending', 'past_due')
      `);

      return { handled: true, subscriptionId: target.id };
    });
  }

  /**
   * حلّ الرخصة المستهدفة: بالربط الصريح أولاً، ولا مطابقة ضيّقة على tenant+plan وحدها.
   * `metadata.subscriptionId` هو الصفّ الذي أنشأته `createStripeCheckout` بنفسها، و
   * `provider_checkout_session_id` خطٌّ ثانٍ لنفس الربط. وإن غاب الربط (جلسة قديمة أُنشئت
   * قبل هذا الإصدار) نُكمل فقط إن كان لصاحب الرخصة **صفٌّ واحد** غير مكتمل — وإلا فلا تخمين.
   */
  private async resolveSubscriptionTarget(
    tx: Parameters<Parameters<DatabaseHandle['db']['transaction']>[0]>[0],
    input: { tenantId: string; planId: string; boundSubscriptionId: string | null; checkoutSessionId: string },
  ): Promise<{ id: string } | undefined> {
    if (input.boundSubscriptionId) {
      const bound = await tx.execute(sql`SELECT id FROM tenant_subscriptions WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.boundSubscriptionId}::uuid LIMIT 1`);
      const row = rowsOf<Record<string, unknown>>(bound)[0];
      if (row) return { id: String(row.id) };
    }

    const bySession = await tx.execute(sql`SELECT id FROM tenant_subscriptions WHERE tenant_id = ${input.tenantId}::uuid AND provider = 'stripe' AND provider_checkout_session_id = ${input.checkoutSessionId} LIMIT 1`);
    const sessionRow = rowsOf<Record<string, unknown>>(bySession)[0];
    if (sessionRow) return { id: String(sessionRow.id) };

    // تراجع توافقي: صفٌّ واحد فقط يطابق (tenant, plan, provider, incomplete/pending).
    const candidates = await tx.execute(sql`
      SELECT id FROM tenant_subscriptions
       WHERE tenant_id = ${input.tenantId}::uuid AND plan_id = ${input.planId}::uuid
         AND provider = 'stripe' AND status IN ('incomplete', 'pending')
       LIMIT 2
    `);
    const rows = rowsOf<Record<string, unknown>>(candidates);
    return rows.length === 1 ? { id: String(rows[0]!.id) } : undefined;
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}
