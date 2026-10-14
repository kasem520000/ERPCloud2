import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import qrcode from 'qrcode-generator';
import {
  DomainError,
  PLATFORM_DUNNING_MAX_ATTEMPTS,
  amountInArabicWords,
  billingAuditActions,
  billingDunningLadder,
  buildPlatformEntitlementKeys,
  calculateInvoiceTotals,
  errorCodes,
  findPlatformSettingDefinition,
  formatSequenceNumber,
  platformAnnualAmount,
  platformDaysOverdue,
  platformDunningMessage,
  platformDunningRunResultSchema,
  platformDueDate,
  platformFormatAmount,
  platformEntitlementValueFits,
  platformInvoiceSchema,
  platformInvoiceSummarySchema,
  platformMonthlyAmount,
  platformParseAmount,
  platformPlanSchema,
  platformProration,
  platformRevenueSchema,
  platformSubscriptionSchema,
  type PlatformDunningBoard,
  type PlatformDunningChannel,
  type PlatformDunningRun,
  type PlatformDunningRunResult,
  type PlatformInvoice,
  type PlatformInvoiceCreate,
  type PlatformInvoiceIssue,
  type PlatformInvoicePay,
  type PlatformInvoiceStatus,
  type PlatformInvoiceSummary,
  type PlatformInvoiceVoid,
  type PlatformPlan,
  type PlatformPlanChangeResult,
  type PlatformPlanEntitlement,
  type PlatformPlanEntitlementsUpdate,
  type PlatformPlanInput,
  type PlatformPlanUpdate,
  type PlatformRevenue,
  type PlatformSubscription,
  type PlatformSubscriptionCancel,
  type PlatformSubscriptionChangePlan,
  type PlatformSubscriptionGrant,
  type PlatformSubscriptionPause,
} from '@erp/contracts';
import { tenantSettingsRegistry } from '@erp/config';
import {
  newId,
  platformSettings,
  withPlatformAdminTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext, systemContext } from '../../../request-context/request-context.js';
import { buildQrPayload } from '../../einvoicing/zatca/qr.js';
import { WebhookPublisher } from '../../developer/webhook-publisher.service.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

/**
 * P-C4 — «الباقات والتراخيص والفوترة»: ما تبيعه المنصة، وبكم، وعلى أي ورقة.
 *
 * القواعد التي تحكم كل دالة هنا:
 *
 * 1. **كل شيء داخل `withPlatformAdminTx`** — القياس عبر المستأجرين لا يكون إلا على مستوى
 *    المنصة (`platform_admin_plane`)، وسطور الفاتورة تحمل `tenant_id` لتقرأها سياسة العزل
 *    نفسها لو احتاجها سطح العميل لاحقاً.
 * 2. **المال نصٌّ لا عدد**: كل مبلغ يُقرأ `::text` ويُحسب بمقياس الفلسين عبر دوال العقود
 *    (`platformProration` · `calculateInvoiceTotals`) — لا كسور عائمة، ولا تقريبان مختلفان
 *    بين الفاتورة والشاشة.
 * 3. **المسودّة ليست مستنداً ضريبياً**: الرقم يُخصَّص عند الإصدار فقط
 *    (`platform_invoice_sequences`، داخل المعاملة نفسها فلا فجوة عند التراجع)، والفاتورة
 *    المدفوعة لا تُلغى — تُردّ. والفاتورة المُلغاة تحفظ رقمها لأن المدقّق يسأل عن الرقم.
 * 4. **قرارٌ يُدقَّق بسبب**: تغيير باقة، إيقاف، إلغاء، إلغاء فاتورة، إعداد باقة — كلها تحمل
 *    سبباً مكتوباً وصفَّ تدقيق، والقاعدة (`platform_settings.billing.*`) تُنسخ على المستند
 *    فلا يتغيّر اسم البائع في ورقة صدرت أمس.
 * 5. **لا رسائل بريد بعد (P-C6)**: المتابعة تُسجَّل وتُجدول بحالة `scheduled`، ولا تدّعي
 *    `sent` إلا إذا كانت يدوية (اتّصال سجّله المشغّل بنفسه).
 */

/** الحالات التي يبقى فيها الترخيص «حَيّاً» — السلّم نفسه في العقود، و`sql.raw` لقيمة ثابتة. */
const liveStatuses = sql.raw("ARRAY['trialing', 'active', 'past_due', 'paused']");

const DOC_TYPE_INVOICE = 'platform_invoice';
const DOC_TYPE_CREDIT_NOTE = 'platform_credit_note';

@Injectable()
export class PlatformBillingService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    // P-C11 — `subscription.*`: تغيّر الترخيص خبرُ العميل الأول، فيُعلَن.
    private readonly webhooks: WebhookPublisher,
  ) {}

  // ================================================================== plans

  /** `GET /platform/plans/entitlement-keys` — مفاتيح الحقوق المعروفة في المنتج. */
  entitlementKeys() {
    return buildPlatformEntitlementKeys(
      tenantSettingsRegistry.map((definition) => ({
        key: definition.key,
        description: definition.description,
        defaultValue: definition.defaultValue,
      })),
    );
  }

  /** `GET /platform/plans` — الكتالوج كاملاً مع حقوق كل باقة ومكافئها الشهري. */
  async listPlans(): Promise<PlatformPlan[]> {
    mustBePlatformAdmin();
    const rows = await withPlatformAdminTx(this.database.db, (tx) => this.planRows(tx));
    return rows.map((row) => this.planView(row));
  }

  /**
   * `POST /platform/plans` — الحفظ بنفس الرمز يحدّث، كما كان قبل P-C4.
   *
   * الشكل صار موصوفاً في العقود (`platformPlanInputSchema`) بدل جسمٍ لا يُتحقَّق منه، والحقوق
   * تُكتب بنقطة النهاية الخاصة بها (`PUT …/entitlements`) لأن استبدال مجموعةٍ كاملة قرارٌ
   * مختلف عن إنشاء باقة.
   */
  async createPlan(input: PlatformPlanInput): Promise<PlatformPlan> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const plan = await withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO billing_plans (id, code, name, interval, amount, currency, stripe_price_id, active)
        VALUES (${newId()}, ${input.code}, ${input.name}, ${input.interval}, ${input.amount}::numeric,
                ${input.currency}, ${input.stripePriceId ?? null}, ${input.active})
        ON CONFLICT (code) DO UPDATE
          SET name = EXCLUDED.name, interval = EXCLUDED.interval, amount = EXCLUDED.amount,
              currency = EXCLUDED.currency, stripe_price_id = EXCLUDED.stripe_price_id,
              active = EXCLUDED.active, updated_at = now()
        RETURNING id
      `);
      const planId = String(result.rows[0]!.id);

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.PLAN_CREATE,
        entity: 'billing_plan',
        entityId: planId,
        after: {
          code: input.code,
          name: input.name,
          interval: input.interval,
          amount: input.amount,
          currency: input.currency,
          active: input.active,
        },
        meta: { scope: 'platform_console', upsertByCode: true },
      });

      const rows = await this.planRows(tx, planId);
      return rows[0];
    });

    if (!plan) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة الباقة بعد الحفظ', 500);
    return this.planView(plan);
  }

  /** `PATCH /platform/plans/:id` — تعديل باقة قائمة بسببٍ مكتوب (السعر يمسّ عملاء حاليين). */
  async updatePlan(planId: string, input: PlatformPlanUpdate): Promise<PlatformPlan> {
    mustBePlatformAdmin();
    const auth = getAuthContext();
    const { reason, ...changes } = input;

    const plan = await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = (await this.planRows(tx, planId))[0];
      if (!before) throw new DomainError(errorCodes.NOT_FOUND, 'الباقة غير موجودة', 404);

      // One UPDATE with COALESCE-free dynamic columns: every field is optional, and building
      // the statement from the fields actually sent keeps unknown ones untouched.
      const assignments = [
        changes.name !== undefined ? sql`name = ${changes.name}` : undefined,
        changes.interval !== undefined ? sql`interval = ${changes.interval}` : undefined,
        changes.amount !== undefined ? sql`amount = ${changes.amount}::numeric` : undefined,
        changes.currency !== undefined ? sql`currency = ${changes.currency}` : undefined,
        changes.stripePriceId !== undefined ? sql`stripe_price_id = ${changes.stripePriceId}` : undefined,
        changes.active !== undefined ? sql`active = ${changes.active}` : undefined,
      ].filter((entry): entry is SQL => entry !== undefined);

      await tx.execute(sql`
        UPDATE billing_plans SET ${sql.join(assignments, sql`, `)}, updated_at = now()
         WHERE id = ${planId}
      `);

      const after = (await this.planRows(tx, planId))[0]!;
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.PLAN_UPDATE,
        entity: 'billing_plan',
        entityId: planId,
        before: this.planAuditShape(before),
        after: this.planAuditShape(after),
        meta: { scope: 'platform_console', reason },
      });
      return after;
    });

    return this.planView(plan);
  }

  /** `PUT /platform/plans/:id/entitlements` — المجموعة الكاملة الجديدة (استبدال لا دمج). */
  async setPlanEntitlements(
    planId: string,
    input: PlatformPlanEntitlementsUpdate,
  ): Promise<PlatformPlan> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const known = new Map(this.entitlementKeys().map((entry) => [entry.key, entry]));
    const seen = new Set<string>();
    for (const entitlement of input.entitlements) {
      const definition = known.get(entitlement.key);
      if (!definition) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `حقٌّ غير معروف في المنتج: ${entitlement.key}`,
          422,
          { key: entitlement.key },
        );
      }
      if (seen.has(entitlement.key)) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, `حقٌّ مكرَّر: ${entitlement.key}`, 422, {
          key: entitlement.key,
        });
      }
      seen.add(entitlement.key);
      if (entitlement.kind !== definition.kind) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `نوع الحقّ «${entitlement.kind}» لا يطابق «${definition.labelAr}» (${definition.kind})`,
          422,
          { key: entitlement.key },
        );
      }
      if (!platformEntitlementValueFits(definition.valueKind, entitlement.value)) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `قيمة «${definition.labelAr}» يجب أن تكون ${definition.valueKind}`,
          422,
          { key: entitlement.key },
        );
      }
    }

    const plan = await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = (await this.planRows(tx, planId))[0];
      if (!before) throw new DomainError(errorCodes.NOT_FOUND, 'الباقة غير موجودة', 404);

      await tx.execute(sql`DELETE FROM billing_plan_entitlements WHERE plan_id = ${planId}`);
      for (const entitlement of input.entitlements) {
        await tx.execute(sql`
          INSERT INTO billing_plan_entitlements (id, plan_id, kind, key, value, created_by)
          VALUES (${newId()}, ${planId}, ${entitlement.kind}, ${entitlement.key},
                  ${JSON.stringify(entitlement.value)}::jsonb, ${auth.userId})
        `);
      }

      const after = (await this.planRows(tx, planId))[0]!;
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.PLAN_ENTITLEMENTS,
        entity: 'billing_plan',
        entityId: planId,
        before: { entitlements: before.entitlements },
        after: { entitlements: after.entitlements },
        meta: { scope: 'platform_console', reason: input.reason, count: input.entitlements.length },
      });
      return after;
    });

    return this.planView(plan);
  }

  // ================================================================== subscriptions

  /** `GET /platform/subscriptions` — كل ترخيص عبر كل العملاء. */
  async listSubscriptions(status?: string): Promise<PlatformSubscription[]> {
    mustBePlatformAdmin();
    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        ${this.subscriptionSelect()}
        WHERE (${status ?? null}::text IS NULL OR s.status = ${status ?? null})
        ORDER BY s.created_at DESC
        LIMIT 500
      `),
    );
    return rows.rows.map((row) => this.subscriptionView(row));
  }

  /**
   * `POST /platform/subscriptions` — إصدار ترخيص أو تمديده يدوياً.
   *
   * بدعة P-C4: **التجربة**. `trialDays > 0` تُصدر ترخيصاً بحالة `trialing` ينتهي في
   * `trial_ends_at` بلا فاتورة، وهو نصف «تجربة · تفعيل» في الخطة. والترخيص الحيّ السابق
   * يُلغى أولاً — فهرس `tenant_subscriptions_active_tenant_key` يمنع ترخيصين حيّين، ولا نريد
   * أن يكتشف المشغّل ذلك كخطأ قاعدة بيانات.
   */
  async grantSubscription(input: PlatformSubscriptionGrant): Promise<PlatformSubscription> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const subscriptionId = await withPlatformAdminTx(this.database.db, async (tx) => {
      const plan = await tx.execute(sql`
        SELECT id, code, name, amount::text, currency, interval FROM billing_plans WHERE id = ${input.planId}
      `);
      const chosen = plan.rows[0];
      if (!chosen) throw new DomainError(errorCodes.NOT_FOUND, 'الباقة غير موجودة', 404);

      const tenant = await tx.execute(sql`SELECT id, code, name FROM tenants WHERE id = ${input.tenantId}`);
      const buyer = tenant.rows[0];
      if (!buyer) throw new DomainError(errorCodes.NOT_FOUND, 'العميل غير موجود', 404);

      // A tenant never holds two live licences: the previous one is retired, not deleted.
      const retired = await tx.execute(sql`
        UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now(),
               canceled_reason = 'استُبدل بترخيص جديد', updated_at = now(), updated_by = ${auth.userId}
         WHERE tenant_id = ${input.tenantId} AND status = ANY(${liveStatuses})
        RETURNING id
      `);

      const trialing = input.trialDays > 0;
      const activatedAt = trialing ? sql`null::timestamptz` : sql`now()`;
      const trialEndsAt = trialing
        ? sql`now() + (${input.trialDays} || ' days')::interval`
        : sql`null::timestamptz`;
      // الفترة المدفوعة في التجربة تبدأ **بعد** انتهائها لا اليوم: تجربة 14 يوماً وشهرٌ واحد
      // تعني شهراً كاملاً من 1 أكتوبر إلى 1 نوفمبر، لا فترةً تنقضي نصفها داخل التجربة.
      const periodStart = trialing
        ? sql`(now() + (${input.trialDays} || ' days')::interval)`
        : sql`now()`;
      const inserted = await tx.execute(sql`
        INSERT INTO tenant_subscriptions
          (id, tenant_id, plan_id, status, provider, activated_at, current_period_start,
           current_period_end, trial_ends_at, billing_email, notes, updated_by)
        VALUES (${newId()}, ${input.tenantId}, ${input.planId}, ${trialing ? 'trialing' : 'active'}, 'manual',
                ${activatedAt}, ${periodStart},
                (${periodStart} + (${input.months} || ' months')::interval),
                ${trialEndsAt},
                ${input.billingEmail ?? null}, ${input.notes ?? null}, ${auth.userId})
        RETURNING id
      `);
      const created = String(inserted.rows[0]!.id);

      await this.audit.recordInTx(tx, {
        tenantId: input.tenantId,
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.SUBSCRIPTION_GRANT,
        entity: 'tenant_subscription',
        entityId: created,
        before: { retiredSubscriptions: retired.rows.map((row) => String(row.id)) },
        after: {
          planCode: String(chosen.code),
          months: input.months,
          trialDays: input.trialDays,
          status: trialing ? 'trialing' : 'active',
        },
        meta: { scope: 'platform_console', tenantCode: String(buyer.code) },
      });
      return created;
    });

    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`${this.subscriptionSelect()} WHERE s.id = ${subscriptionId}`),
    );
    const row = rows.rows[0];
    if (!row) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة الترخيص بعد الإصدار', 500);
    const granted = this.subscriptionView(row);
    void this.webhooks.emit('subscription.activated', granted.tenantId, {
      subscriptionId: granted.id,
      planCode: granted.planCode,
      status: granted.status,
      currentPeriodEnd: granted.currentPeriodEnd,
      trialEndsAt: granted.trialEndsAt,
    });
    return granted;
  }

  /**
   * `POST /platform/subscriptions/:id/change-plan` — ترقية أو تخفيض.
   *
   * الحساب في العقود (`platformProration`) لا هنا، والمستند يُنشأ **مسودّة**: المسودّة لا
   * تستهلك رقماً ضريبياً، فخطأ مشغّل في ترقيةٍ لا يحرق رقماً على المدقق. المدة الجديدة تبدأ
   * اليوم (شهرٌ أو سنة كاملة): مقابل الباقة الجديدة كامل، والرصيد غير المستهلك من القديمة
   * يُخصم منه — فاتورة إن كان الفرق موجباً، إشعار دائن إن كان سالباً، ولا مستند إن كان صفراً.
   *
   * ورصيدٌ واحد لا يُحسب: **التجربة**. الفترة المدفوعة تبدأ بعد انتهائها، فمن غيّر باقته وهو
   * يُجرّب لا يملك رصيداً يُخصم — يبدأ فترته الجديدة اليوم، ويُفوتر بكامل الباقة الجديدة.
   */
  async changePlan(
    subscriptionId: string,
    input: PlatformSubscriptionChangePlan,
  ): Promise<PlatformPlanChangeResult> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const result = await withPlatformAdminTx(this.database.db, async (tx) => {
      const subscription = (await this.subscriptionRows(tx, subscriptionId))[0];
      if (!subscription) throw new DomainError(errorCodes.NOT_FOUND, 'الترخيص غير موجود', 404);
      if (!(subscription.status === 'trialing' || subscription.status === 'active' || subscription.status === 'past_due')) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لا يمكن تغيير باقة ترخيصٍ حالته «${String(subscription.status)}»`,
          422,
          { status: subscription.status },
        );
      }
      if (String(subscription.plan_id) === input.planId) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'الباقة المطلوبة هي الباقة الحالية', 422);
      }

      const target = (await tx.execute(sql`
        SELECT id, code, name, amount::text, currency, interval FROM billing_plans WHERE id = ${input.planId}
      `)).rows[0];
      if (!target) throw new DomainError(errorCodes.NOT_FOUND, 'الباقة المطلوبة غير موجودة', 404);

      const settings = await this.billingSettings(tx);
      const interval = String(target.interval) === 'year' ? 'year' : 'month';
      const fromInterval = String(subscription.interval) === 'year' ? 'year' : 'month';

      // What period are we computing into? A licence that has never run (no dates) — or whose
      // paid period already lapsed — is treated as one full period starting today, the same
      // rule the grant path applies. Only a period still running produces a credit.
      const today = dateOnly(new Date());
      const declaredEnd = subscription.current_period_end
        ? dateOnly(subscription.current_period_end)
        : addMonths(
            subscription.current_period_start ? dateOnly(subscription.current_period_start) : today,
            fromInterval === 'year' ? 12 : 1,
          );
      // **التجربة مدة غير مدفوعة**: لا رصيد فيها لأن العميل لم يدفع شيئاً بعد، ومن غيّر باقته
      // وهو يُجرّب يبدأ فترته المدفوعة اليوم بالكامل. وهذا هو الفرق بين «رصيد» و«هدية».
      const previouslyTrialing = subscription.status === 'trialing';
      const running = !previouslyTrialing && declaredEnd > today;
      const periodStart = running
        ? subscription.current_period_start
          ? dateOnly(subscription.current_period_start)
          : today
        : today;
      const periodEnd = running ? declaredEnd : addMonths(today, fromInterval === 'year' ? 12 : 1);

      const computed = platformProration({
        periodStart,
        periodEnd,
        at: dateOnly(new Date()),
        fromPlan: { code: String(subscription.plan_code), amount: String(subscription.amount), interval: fromInterval },
        toPlan: { code: String(target.code), amount: String(target.amount), interval },
        currency: String(target.currency),
      });
      // التجربة لا رصيد فيها: الرصيد ثمن مدةٍ دفعها العميل ولم يستهلكها، ومن يُجرّب لم يدفع.
      // فالفترة الجديدة تبدأ اليوم، ويُفوتر بكامل الباقة الجديدة، والمتبقّي صفرٌ صريحاً.
      const proration = previouslyTrialing
        ? {
            ...computed,
            remainingDays: 0,
            credit: platformFormatAmount(0n),
            net: platformFormatAmount(platformParseAmount(computed.charge)),
          }
        : computed;

      // The new period starts today: the customer buys a whole month (or year) of the new
      // plan, and the unused balance of the old one is credited against it.
      const newPeriodEnd = addMonths(periodStart, interval === 'year' ? 12 : 1);

      await tx.execute(sql`
        UPDATE tenant_subscriptions
           SET plan_id = ${input.planId}, status = 'active', activated_at = COALESCE(activated_at, now()),
               current_period_start = ${periodStart}::date, current_period_end = ${newPeriodEnd}::date,
               cancel_at_period_end = false, updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${subscriptionId}
      `);

      const net = platformParseAmount(proration.net);
      let invoiceId: string | null = null;
      let invoiceNumber: string | null = null;
      let invoiceKind: 'invoice' | 'credit_note' | null = null;

      if (net !== 0n) {
        const credit = platformParseAmount(proration.credit);
        const lines =
          net > 0n
            ? [
                {
                  kind: 'subscription' as const,
                  description: `باقة «${String(target.name)}» — ${interval === 'year' ? 'سنة' : 'شهر'} يبدأ ${periodStart} وينتهي ${newPeriodEnd}`,
                  amount: platformFormatAmount(platformParseAmount(String(target.amount))),
                  metadata: { planCode: String(target.code), interval, periodStart, periodEnd: newPeriodEnd },
                },
                ...(credit > 0n
                  ? [
                      {
                        kind: 'proration' as const,
                        description: `رصيد غير مستهلك من باقة «${String(subscription.plan_name)}» — ${proration.remainingDays} يوماً من ${proration.periodDays}`,
                        amount: platformFormatAmount(-credit),
                        metadata: {
                          planCode: String(subscription.plan_code),
                          remainingDays: proration.remainingDays,
                          periodDays: proration.periodDays,
                        },
                      },
                    ]
                  : []),
              ]
            : [
                {
                  kind: 'proration' as const,
                  description: `رصيد غير مستهلك من باقة «${String(subscription.plan_name)}» مقابل «${String(target.name)}» — ${proration.remainingDays} يوماً من ${proration.periodDays}`,
                  amount: proration.net,
                  metadata: {
                    planCode: String(subscription.plan_code),
                    remainingDays: proration.remainingDays,
                    periodDays: proration.periodDays,
                  },
                },
              ];

        invoiceKind = net > 0n ? 'invoice' : 'credit_note';
        invoiceId = await this.insertInvoice(tx, {
          tenantId: String(subscription.tenant_id),
          subscriptionId,
          kind: invoiceKind,
          currency: String(target.currency),
          lines,
          taxRate: settings.taxRate,
          periodStart,
          periodEnd: newPeriodEnd,
          buyerName: String(subscription.tenant_name),
          buyerEmail: subscription.billing_email ? String(subscription.billing_email) : null,
          note: `تغيير باقة (${String(subscription.plan_code)} ← ${String(target.code)}) — ${input.reason}`,
          actorUserId: auth.userId,
        });

        await this.audit.recordInTx(tx, {
          tenantId: String(subscription.tenant_id),
          actorUserId: auth.userId,
          actorLabel: await this.actorLabel(tx, auth.userId),
          action: billingAuditActions.SUBSCRIPTION_CHANGE_PLAN,
          entity: 'tenant_subscription',
          entityId: subscriptionId,
          before: { planCode: String(subscription.plan_code), amount: String(subscription.amount) },
          after: { planCode: String(target.code), amount: String(target.amount), periodEnd: newPeriodEnd },
          meta: {
            scope: 'platform_console',
            reason: input.reason,
            proration,
            invoiceId,
            currency: String(target.currency),
          },
        });
      } else {
        await this.audit.recordInTx(tx, {
          tenantId: String(subscription.tenant_id),
          actorUserId: auth.userId,
          actorLabel: await this.actorLabel(tx, auth.userId),
          action: billingAuditActions.SUBSCRIPTION_CHANGE_PLAN,
          entity: 'tenant_subscription',
          entityId: subscriptionId,
          before: { planCode: String(subscription.plan_code) },
          after: { planCode: String(target.code), periodEnd: newPeriodEnd },
          meta: { scope: 'platform_console', reason: input.reason, proration, invoiceId: null, invoiceKind: null },
        });
      }

      const refreshed = (await this.subscriptionRows(tx, subscriptionId))[0]!;
      return {
        subscription: this.subscriptionView(refreshed),
        proration,
        invoiceId,
        invoiceNumber,
        invoiceKind,
      };
    });

    void this.webhooks.emit('subscription.plan_changed', result.subscription.tenantId, {
      subscriptionId: result.subscription.id,
      planCode: result.subscription.planCode,
      status: result.subscription.status,
      currentPeriodEnd: result.subscription.currentPeriodEnd,
      prorationNet: result.proration.net,
      invoiceId: result.invoiceId,
      invoiceKind: result.invoiceKind,
    });
    return {
      subscription: result.subscription,
      proration: result.proration,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      invoiceKind: result.invoiceKind,
    };
  }

  /** `POST /platform/subscriptions/:id/pause` — إيقاف مؤقت بسببٍ مكتوب. */
  async pauseSubscription(
    subscriptionId: string,
    input: PlatformSubscriptionPause,
  ): Promise<PlatformSubscription> {
    const paused = await this.transition(subscriptionId, {
      action: billingAuditActions.SUBSCRIPTION_PAUSE,
      reason: input.reason,
      allowed: ['trialing', 'active', 'past_due'],
      apply: (tx, auth) => tx.execute(sql`
        UPDATE tenant_subscriptions
           SET status = 'paused', paused_at = now(), cancel_at_period_end = false,
               updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${subscriptionId}
      `),
    });
    // P-C11 — الإيقاف قرارٌ يمسّ عمل العميل اليوم، فيُعلَن بسببه لا يُكتشف عند أول رفض.
    void this.webhooks.emit('subscription.suspended', paused.tenantId, {
      subscriptionId: paused.id,
      status: paused.status,
      reason: input.reason,
      pausedAt: paused.pausedAt,
    });
    return paused;
  }

  /**
   * `POST /platform/subscriptions/:id/resume` — استئناف وإرجاع أيام الإيقاف.
   *
   * العميل دفع مدةً أوقفناها عليه، فالأيام التي مرّت وهو موقوف تُضاف إلى نهاية المدة: إيقافٌ
   * بلا إرجاعٍ يومٍ يأخذ مالاً بلا مقابل، وهو ما يسأل عنه العميل في أول فاتورة تالية.
   */
  async resumeSubscription(
    subscriptionId: string,
    input: PlatformSubscriptionPause,
  ): Promise<PlatformSubscription> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const id = await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = (await this.subscriptionRows(tx, subscriptionId))[0];
      if (!before) throw new DomainError(errorCodes.NOT_FOUND, 'الترخيص غير موجود', 404);
      if (String(before.status) !== 'paused') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لا يمكن استئناف ترخيصٍ حالته «${String(before.status)}»`,
          422,
          { status: before.status },
        );
      }

      const pausedAt = iso(before.paused_at);
      const pausedSeconds = pausedAt
        ? Math.max(0, Math.round((Date.now() - new Date(pausedAt).getTime()) / 1000))
        : 0;

      await tx.execute(sql`
        UPDATE tenant_subscriptions
           SET status = ${before.activated_at ? 'active' : 'trialing'}, resumed_at = now(),
               current_period_end = current_period_end + (${pausedSeconds} || ' seconds')::interval,
               trial_ends_at = CASE WHEN trial_ends_at IS NULL THEN NULL
                                    ELSE trial_ends_at + (${pausedSeconds} || ' seconds')::interval END,
               updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${subscriptionId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId: String(before.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.SUBSCRIPTION_RESUME,
        entity: 'tenant_subscription',
        entityId: subscriptionId,
        before: { status: 'paused', pausedAt: iso(before.paused_at) },
        after: { status: before.activated_at ? 'active' : 'trialing', extendedBySeconds: pausedSeconds },
        meta: { scope: 'platform_console', reason: input.reason },
      });
      return subscriptionId;
    });

    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`${this.subscriptionSelect()} WHERE s.id = ${id}`),
    );
    return this.subscriptionView(rows.rows[0]!);
  }

  /**
   * `POST /platform/subscriptions/:id/cancel` — إلغاء فوري أو بانتهاء المدة.
   *
   * `atPeriodEnd` يترك الترخيص حيّاً ويعلّم `cancel_at_period_end`: العميل دفع حتى نهاية
   * المدة، فلا يُقطع قبلها. والإلغاء الفوري يكتب السبب على الصف — «لماذا أُلغي هذا العميل؟»
   * سؤالٌ يُسأل بعد شهور.
   */
  async cancelSubscription(
    subscriptionId: string,
    input: PlatformSubscriptionCancel,
  ): Promise<PlatformSubscription> {
    const atPeriodEnd = input.atPeriodEnd;
    return this.transition(subscriptionId, {
      action: billingAuditActions.SUBSCRIPTION_CANCEL,
      reason: input.reason,
      allowed: ['trialing', 'active', 'past_due', 'paused'],
      apply: (tx, auth) =>
        atPeriodEnd
          ? tx.execute(sql`
              UPDATE tenant_subscriptions
                 SET cancel_at_period_end = true, canceled_reason = ${input.reason},
                     updated_at = now(), updated_by = ${auth.userId}
               WHERE id = ${subscriptionId}
            `)
          : tx.execute(sql`
              UPDATE tenant_subscriptions
                 SET status = 'canceled', canceled_at = now(), canceled_reason = ${input.reason},
                     cancel_at_period_end = false, updated_at = now(), updated_by = ${auth.userId}
               WHERE id = ${subscriptionId}
            `),
    });
  }

  // ================================================================== invoices

  /** `GET /platform/invoices` — قائمة الفواتير والإشعارات. */
  async listInvoices(query: {
    status?: PlatformInvoiceStatus;
    kind?: 'invoice' | 'credit_note';
    tenantId?: string;
    limit: number;
  }): Promise<PlatformInvoiceSummary[]> {
    mustBePlatformAdmin();
    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        ${this.invoiceSelect()}
        WHERE (${query.status ?? null}::text IS NULL OR i.status = ${query.status ?? null})
          AND (${query.kind ?? null}::text IS NULL OR i.kind = ${query.kind ?? null})
          AND (${query.tenantId ?? null}::uuid IS NULL OR i.tenant_id = ${query.tenantId ?? null}::uuid)
        ORDER BY i.created_at DESC
        LIMIT ${query.limit}
      `),
    );
    return rows.rows.map((row) => this.invoiceView(row, false) as PlatformInvoiceSummary);
  }

  /** `GET /platform/invoices/:id` — فاتورة واحدة بسطورها ودفعاتها (يفتحها درج التفاصيل). */
  async invoice(invoiceId: string): Promise<PlatformInvoice> {
    mustBePlatformAdmin();
    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`${this.invoiceSelect()} WHERE i.id = ${invoiceId}`),
    );
    const row = rows.rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الفاتورة غير موجودة', 404);
    return this.invoiceView(row, true) as PlatformInvoice;
  }

  /**
   * `POST /platform/invoices` — مسودّة من فترة الترخيص.
   *
   * تُرفض المسودّة المكرّرة لنفس المدة: هذا هو منع «التحصيل المزدوج» عند منبعه — فاتورتان
   * لنفس الفترة تعني أن العميل سيُطالَب مرتين، ومهما كان المشغّل متعمّداً فالقاعدة تمنعه.
   */
  async createInvoice(input: PlatformInvoiceCreate): Promise<PlatformInvoice> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const invoiceId = await withPlatformAdminTx(this.database.db, async (tx) => {
      const subscription = (await this.subscriptionRows(tx, input.subscriptionId))[0];
      if (!subscription) throw new DomainError(errorCodes.NOT_FOUND, 'الترخيص غير موجود', 404);
      if (!['trialing', 'active', 'past_due', 'paused'].includes(String(subscription.status))) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لا تُصدَر فاتورة لترخيصٍ حالته «${String(subscription.status)}»`,
          422,
          { status: subscription.status },
        );
      }

      const periodStart = input.periodStart ?? dateOnly(subscription.current_period_start ?? new Date());
      const periodEnd = input.periodEnd ?? dateOnly(subscription.current_period_end ?? new Date());

      const duplicate = await tx.execute(sql`
        SELECT id, number, status FROM platform_invoices
         WHERE subscription_id = ${input.subscriptionId} AND period_start = ${periodStart}::date
           AND period_end = ${periodEnd}::date AND status <> 'void'
         LIMIT 1
      `);
      if (duplicate.rows[0]) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `توجد فاتورة قائمة لهذه المدة (${String(duplicate.rows[0].number ?? duplicate.rows[0].status)})`,
          422,
          { invoiceId: String(duplicate.rows[0].id) },
        );
      }

      const settings = await this.billingSettings(tx);
      const interval = String(subscription.interval) === 'year' ? 'سنة' : 'شهر';
      const created = await this.insertInvoice(tx, {
        buyerTaxNumber: input.buyerTaxNumber ?? null,
        tenantId: String(subscription.tenant_id),
        subscriptionId: input.subscriptionId,
        kind: 'invoice',
        currency: String(subscription.currency),
        lines: [
          {
            kind: 'subscription',
            description: `اشتراك باقة «${String(subscription.plan_name)}» — ${interval} من ${periodStart} إلى ${periodEnd}`,
            amount: String(subscription.amount),
            metadata: { planCode: String(subscription.plan_code), periodStart, periodEnd },
          },
        ],
        taxRate: settings.taxRate,
        periodStart,
        periodEnd,
        buyerName: String(subscription.tenant_name),
        buyerEmail: subscription.billing_email ? String(subscription.billing_email) : null,
        note: input.note ?? null,
        actorUserId: auth.userId,
      });

      await this.audit.recordInTx(tx, {
        tenantId: String(subscription.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.INVOICE_CREATE,
        entity: 'platform_invoice',
        entityId: created,
        after: {
          subscriptionId: input.subscriptionId,
          periodStart,
          periodEnd,
          amount: String(subscription.amount),
          taxRate: settings.taxRate,
        },
        meta: { scope: 'platform_console', reason: input.reason },
      });
      return created;
    });

    return this.invoice(invoiceId);
  }

  /**
   * `POST /platform/invoices/:id/issue` — المستند يصير ضريبيًّا: رقمٌ متسلسل وتاريخ.
   *
   * الرقم يُخصَّص في المعاملة نفسها (`platform_invoice_sequences`)، فإن تراجعت المعاملة
   * تراجع معها الرقم ولم تبقَ فجوةٌ يسأل عنها المدقّق. ولا يُعاد رقمٌ أبداً.
   */
  async issueInvoice(invoiceId: string, input: PlatformInvoiceIssue): Promise<PlatformInvoice> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = (await tx.execute(sql`
        SELECT id, kind, status, number, total::text, tenant_id FROM platform_invoices WHERE id = ${invoiceId}
      `)).rows[0];
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الفاتورة غير موجودة', 404);
      if (String(current.status) !== 'draft') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لا تُصدَر فاتورةٌ حالته «${String(current.status)}»`,
          422,
          { status: current.status },
        );
      }

      const lines = await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform_invoice_lines WHERE invoice_id = ${invoiceId}
      `);
      if (Number(lines.rows[0]?.n ?? 0) === 0) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'فاتورة بلا سطور لا تُصدَر', 422);
      }

      // A credit note keeps its own series: an auditor reading a VAT return must never mix
      // a sale and its reversal in one sequence.
      const isCreditNote = String(current.kind) === 'credit_note';
      const number = await this.nextNumber(
        tx,
        isCreditNote ? DOC_TYPE_CREDIT_NOTE : DOC_TYPE_INVOICE,
        isCreditNote ? 'PCN-' : 'PINV-',
      );

      const settings = await this.billingSettings(tx);
      const issueDate = input.issueDate ?? dateOnly(new Date());
      const dueDate = input.dueDate ?? platformDueDate(issueDate, input.dueInDays ?? settings.termsDays);

      await tx.execute(sql`
        UPDATE platform_invoices
           SET status = 'issued', number = ${number}, issue_date = ${issueDate}::date,
               due_date = ${dueDate}::date, issued_at = now(), issued_by = ${auth.userId},
               seller_tax_number = COALESCE(seller_tax_number, ${settings.sellerTaxNumber}),
               note = COALESCE(${input.note ?? null}::text, note), updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${invoiceId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId: String(current.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.INVOICE_ISSUE,
        entity: 'platform_invoice',
        entityId: invoiceId,
        before: { status: 'draft', number: null },
        after: { status: 'issued', number, issueDate, dueDate, total: String(current.total) },
        meta: { scope: 'platform_console', series: isCreditNote ? DOC_TYPE_CREDIT_NOTE : DOC_TYPE_INVOICE },
      });
    });

    return this.invoice(invoiceId);
  }

  /**
   * `POST /platform/invoices/:id/pay` — تسجيل تحصيل.
   *
   * الدفعة الجزئية مسموحة، والزائدة عن المتبقّي مرفوضة: منعُ التحصيل المزدوج هنا ليس
   * تحسيناً بل شرط — إدخال نفس التحويل البنكي مرتين يضاعف المدفوع فيدفع العميل ضريبةً على
   * مبلغ لم يُحصَّل. والفاتورة المدفوعة بالكامل تصير `paid`؛ والمبلغ المتبقّي محسوب لا مخزَّن.
   */
  async payInvoice(invoiceId: string, input: PlatformInvoicePay): Promise<PlatformInvoice> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = (await tx.execute(sql`
        SELECT id, status, kind, total::text, paid_amount::text, tenant_id, number
          FROM platform_invoices WHERE id = ${invoiceId}
      `)).rows[0];
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الفاتورة غير موجودة', 404);
      if (String(current.status) !== 'issued') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          String(current.status) === 'paid'
            ? 'الفاتورة مدفوعة بالكامل — لا تُسجَّل دفعة ثانية'
            : `لا تُحصَّل فاتورةٌ حالته «${String(current.status)}»`,
          422,
          { status: current.status },
        );
      }
      if (String(current.kind) === 'credit_note') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'الإشعار الدائن لا يُحصَّل', 422);
      }

      const remaining =
        platformParseAmount(String(current.total)) - platformParseAmount(String(current.paid_amount));
      // الاسم `collected` لا `amount`: القيمة bigint بأصغر وحدة نقدية، والاسم `amount`
      // محجوز في حرس المال على `number` (PROJECT_CONTRACT §3) فيُلبِس القارئ.
      const collected = input.amount ? platformParseAmount(input.amount) : remaining;
      if (collected <= 0n) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'المبلغ يجب أن يكون أكبر من صفر', 422);
      }
      if (collected > remaining) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `المبلغ يتجاوز المتبقّي (${platformFormatAmount(remaining)})`,
          422,
          { remaining: platformFormatAmount(remaining) },
        );
      }

      await tx.execute(sql`
        INSERT INTO platform_payments
          (id, invoice_id, tenant_id, method, amount, reference, receipt_file_id, status,
           received_at, recorded_by, note)
        VALUES (${newId()}, ${invoiceId}, ${String(current.tenant_id)}, ${input.method},
                ${platformFormatAmount(collected)}, ${input.reference ?? null}, ${input.receiptFileId ?? null},
                'recorded', COALESCE(${input.receivedAt ?? null}::timestamptz, now()), ${auth.userId},
                ${input.note ?? null})
      `);

      const settled = await tx.execute(sql`
        UPDATE platform_invoices i
           SET paid_amount = agg.total,
               status = CASE WHEN agg.total >= i.total THEN 'paid' ELSE i.status END,
               paid_at = CASE WHEN agg.total >= i.total THEN now() ELSE i.paid_at END,
               updated_at = now(), updated_by = ${auth.userId}
          FROM (
            SELECT COALESCE(SUM(amount), 0)::numeric(20,4) AS total
              FROM platform_payments WHERE invoice_id = ${invoiceId} AND status = 'recorded'
          ) agg
         WHERE i.id = ${invoiceId}
        RETURNING i.status, i.paid_amount::text, i.total::text
      `);
      const after = settled.rows[0]!;

      await this.audit.recordInTx(tx, {
        tenantId: String(current.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.INVOICE_PAY,
        entity: 'platform_invoice',
        entityId: invoiceId,
        before: { paidAmount: String(current.paid_amount), status: String(current.status) },
        after: {
          paidAmount: String(after.paid_amount),
          status: String(after.status),
          method: input.method,
          reference: input.reference ?? null,
        },
        meta: {
          scope: 'platform_console',
          receiptFileId: input.receiptFileId ?? null,
          partial: platformFormatAmount(collected) !== String(after.total),
        },
      });
    });

    return this.invoice(invoiceId);
  }

  /**
   * `POST /platform/invoices/:id/void` — إلغاء بسببٍ مكتوب.
   *
   * المدفوعة لا تُلغى: تُردّ (`platform_payments.status = 'refunded'` في P-C5). وإلغاء فاتورة
   * صادرة **يبقي رقمها**: المدقق يقرأ التسلسل، ورقمٌ اختفى أسوأ من رقمٍ بصفر مبلغ.
   */
  async voidInvoice(invoiceId: string, input: PlatformInvoiceVoid): Promise<PlatformInvoice> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = (await tx.execute(sql`
        SELECT id, status, number, paid_amount::text, tenant_id FROM platform_invoices WHERE id = ${invoiceId}
      `)).rows[0];
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الفاتورة غير موجودة', 404);
      if (!['draft', 'issued'].includes(String(current.status))) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          String(current.status) === 'paid'
            ? 'الفاتورة مدفوعة — تُردّ دفعاتها ولا تُلغى'
            : 'الفاتورة ملغاة أصلاً',
          422,
          { status: current.status },
        );
      }

      await tx.execute(sql`
        UPDATE platform_invoices
           SET status = 'void', voided_at = now(), voided_by = ${auth.userId}, void_reason = ${input.reason},
               updated_at = now(), updated_by = ${auth.userId}
         WHERE id = ${invoiceId}
      `);

      await this.audit.recordInTx(tx, {
        tenantId: String(current.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.INVOICE_VOID,
        entity: 'platform_invoice',
        entityId: invoiceId,
        before: { status: String(current.status), paidAmount: String(current.paid_amount) },
        after: { status: 'void', number: current.number ? String(current.number) : null },
        meta: { scope: 'platform_console', reason: input.reason },
      });
    });

    return this.invoice(invoiceId);
  }

  /** `GET /platform/invoices/:id/print` — ورقة A4 مكتفية بذاتها (معاينة داخل إطار). */
  async printInvoice(invoiceId: string): Promise<string> {
    mustBePlatformAdmin();
    const invoice = await this.invoice(invoiceId);
    const row = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT t.code AS tenant_code, t.name AS tenant_name FROM tenants t WHERE t.id = ${invoice.tenantId}
      `),
    );
    const tenant = row.rows[0];
    return renderInvoicePage(invoice, {
      tenantCode: tenant ? String(tenant.tenant_code) : invoice.tenantCode,
      tenantName: tenant ? String(tenant.tenant_name) : invoice.tenantName,
    });
  }

  // ================================================================== dunning

  /**
   * `GET /platform/dunning` — المحاولات، والجدول، والسلّم الفعّال.
   *
   * «الجدول» ليس تخميناً في الشاشة: الخدمة تحسب لكل فاتورة متأخّرة رقم محاولتها القادمة
   * وتاريخها من سلّم الإعدادات (`billing.dunning_days`)، فما يعرضه المشغّل هو ما سيفعله الزر.
   */
  async dunningBoard(subscriptionId?: string): Promise<PlatformDunningBoard> {
    mustBePlatformAdmin();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const settings = await this.billingSettings(tx);
      const attempts = await tx.execute(sql`
        SELECT d.id, d.subscription_id, d.invoice_id, d.tenant_id, d.attempt_no, d.channel, d.status,
               d.scheduled_at, d.sent_at, d.message, d.outcome, d.created_at,
               t.code AS tenant_code, t.name AS tenant_name, i.number AS invoice_number
          FROM dunning_attempts d
          JOIN tenants t ON t.id = d.tenant_id
          LEFT JOIN platform_invoices i ON i.id = d.invoice_id
         WHERE (${subscriptionId ?? null}::uuid IS NULL OR d.subscription_id = ${subscriptionId ?? null}::uuid)
         ORDER BY d.scheduled_at DESC, d.attempt_no DESC
         LIMIT 200
      `);

      const schedule = await tx.execute(sql`
        SELECT i.id AS invoice_id, i.number, i.subscription_id, i.tenant_id, i.due_date, i.currency,
               (i.total - i.paid_amount)::text AS remaining,
               t.code AS tenant_code, t.name AS tenant_name,
               (SELECT COUNT(*) FROM dunning_attempts d WHERE d.invoice_id = i.id)::int AS attempts_made
          FROM platform_invoices i
          JOIN tenants t ON t.id = i.tenant_id
         WHERE i.status = 'issued' AND i.kind = 'invoice' AND i.due_date < current_date
           AND (${subscriptionId ?? null}::uuid IS NULL OR i.subscription_id = ${subscriptionId ?? null}::uuid)
         ORDER BY i.due_date ASC
         LIMIT 200
      `);

      const ladder = settings.ladder.length > 0 ? settings.ladder : [0];
      const scheduleRows = schedule.rows.map((row) => {
        const made = Number(row.attempts_made ?? 0);
        const nextNo = made + 1;
        const exhausted = nextNo > PLATFORM_DUNNING_MAX_ATTEMPTS;
        const offsetDays = ladder[Math.min(made, ladder.length - 1)] ?? 0;
        return {
          invoiceId: String(row.invoice_id),
          invoiceNumber: row.number ? String(row.number) : null,
          subscriptionId: String(row.subscription_id),
          tenantId: String(row.tenant_id),
          tenantCode: String(row.tenant_code),
          tenantName: String(row.tenant_name),
          dueDate: row.due_date ? dateOnly(row.due_date) : null,
          daysOverdue: platformDaysOverdue(row.due_date ? dateOnly(row.due_date) : null),
          remaining: money(row.remaining),
          currency: String(row.currency).trim(),
          attemptsMade: made,
          nextAttemptNo: nextNo,
          nextAttemptAt: exhausted
            ? null
            : `${addDays(dateOnly(row.due_date), offsetDays)}T00:00:00.000Z`,
          exhausted,
        };
      });

      return {
        attempts: attempts.rows.map((row) => ({
          id: String(row.id),
          subscriptionId: String(row.subscription_id),
          invoiceId: row.invoice_id ? String(row.invoice_id) : null,
          invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
          tenantId: String(row.tenant_id),
          tenantCode: String(row.tenant_code),
          tenantName: String(row.tenant_name),
          attemptNo: Number(row.attempt_no),
          channel: row.channel as PlatformDunningChannel,
          status: row.status as PlatformDunningBoard['attempts'][number]['status'],
          scheduledAt: iso(row.scheduled_at) ?? new Date().toISOString(),
          sentAt: iso(row.sent_at),
          message: String(row.message),
          outcome: row.outcome ? String(row.outcome) : null,
          createdAt: iso(row.created_at) ?? new Date().toISOString(),
        })),
        schedule: scheduleRows,
        ladderDays: ladder,
        maxAttempts: PLATFORM_DUNNING_MAX_ATTEMPTS,
        currency: scheduleRows[0]?.currency ?? 'SAR',
      };
    });
  }

  /**
   * `POST /platform/dunning/:subscription/run` — تشغيل المتابعة على فواتير ترخيص.
   *
   * المحاولة تُنشأ **مجدولة** لا «مُرسلة»: لا خدمة بريد بعد (P-C6)، وادّعاء الإرسال كذبٌ في
   * سجلّ العميل. القناة اليدوية (`manual`) هي الوحيدة التي تُسجَّل `sent` لأن المشغّل نفسه
   * أجرى الاتّصال. والفاتورة المدفوعة أو المُلغاة تُتجاوَز بسببه المعلَن لا بصمت.
   * وعند أول متابعةٍ على ترخيصٍ فعّال يصير الترخيص `past_due` — أثرٌ مقيس لا زخرفة.
   */
  async runDunning(
    subscriptionId: string,
    input: PlatformDunningRun,
  ): Promise<PlatformDunningRunResult> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const subscription = (await this.subscriptionRows(tx, subscriptionId))[0];
      if (!subscription) throw new DomainError(errorCodes.NOT_FOUND, 'الترخيص غير موجود', 404);

      const targets = await tx.execute(sql`
        SELECT i.id, i.number, i.due_date, (i.total - i.paid_amount)::text AS remaining, i.currency,
               (SELECT COUNT(*) FROM dunning_attempts d WHERE d.invoice_id = i.id)::int AS attempts_made
          FROM platform_invoices i
         WHERE i.subscription_id = ${subscriptionId} AND i.kind = 'invoice'
           AND (${input.invoiceId ?? null}::uuid IS NULL OR i.id = ${input.invoiceId ?? null}::uuid)
           AND i.status = 'issued' AND i.due_date < current_date
         ORDER BY i.due_date ASC
      `);

      const created: PlatformDunningRunResult['created'] = [];
      const skipped: PlatformDunningRunResult['skipped'] = [];

      for (const row of targets.rows) {
        const made = Number(row.attempts_made ?? 0);
        const attemptNo = made + 1;
        if (attemptNo > PLATFORM_DUNNING_MAX_ATTEMPTS) {
          skipped.push({
            invoiceId: String(row.id),
            reason: `استُنفدت المحاولات (${PLATFORM_DUNNING_MAX_ATTEMPTS})`,
          });
          continue;
        }

        const message = platformDunningMessage({
          attemptNo,
          tenantName: String(subscription.tenant_name),
          invoiceNumber: row.number ? String(row.number) : null,
          total: money(row.remaining),
          currency: String(row.currency).trim(),
          dueDate: row.due_date ? dateOnly(row.due_date) : null,
        });
        const manual = input.channel === 'manual';
        const attemptId = newId();
        await tx.execute(sql`
          INSERT INTO dunning_attempts
            (id, tenant_id, subscription_id, invoice_id, attempt_no, channel, status,
             scheduled_at, sent_at, message, outcome, created_by)
          VALUES (${attemptId}, ${String(subscription.tenant_id)}, ${subscriptionId}, ${String(row.id)},
                  ${attemptNo}, ${input.channel}, ${manual ? 'sent' : 'scheduled'}, now(),
                  ${manual ? sql`now()` : null}, ${message},
                  ${manual ? 'اتّصال هاتفي سجّله المشغّل' : null}, ${auth.userId})
        `);

        created.push({
          id: attemptId,
          subscriptionId,
          invoiceId: String(row.id),
          invoiceNumber: row.number ? String(row.number) : null,
          tenantId: String(subscription.tenant_id),
          tenantCode: String(subscription.tenant_code),
          tenantName: String(subscription.tenant_name),
          attemptNo,
          channel: input.channel,
          status: manual ? 'sent' : 'scheduled',
          scheduledAt: new Date().toISOString(),
          sentAt: manual ? new Date().toISOString() : null,
          message,
          outcome: manual ? 'اتّصال هاتفي سجّله المشغّل' : null,
          createdAt: new Date().toISOString(),
        });
      }

      // A licence with an overdue invoice that is still 'active' is, by the platform's own
      // vocabulary, `past_due`. Recording it here means the customer list, the revenue board
      // and the licence screen all agree without anyone pressing a second button.
      let status = String(subscription.status);
      if (created.length > 0 && status === 'active') {
        await tx.execute(sql`
          UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now(), updated_by = ${auth.userId}
           WHERE id = ${subscriptionId}
        `);
        status = 'past_due';
      }

      await this.audit.recordInTx(tx, {
        tenantId: String(subscription.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: billingAuditActions.DUNNING_RUN,
        entity: 'tenant_subscription',
        entityId: subscriptionId,
        before: { status: String(subscription.status) },
        after: { status, attempts: created.length, skipped: skipped.length },
        meta: {
          scope: 'platform_console',
          channel: input.channel,
          ...(input.reason ? { reason: input.reason } : {}),
          invoices: created.map((attempt) => attempt.invoiceId),
        },
      });

      return platformDunningRunResultSchema.parse({
        subscriptionId,
        subscriptionStatus: status,
        created,
        skipped,
      });
    });
  }

  // ================================================================== revenue

  /**
   * `GET /platform/revenue` — لوحة الإيراد.
   *
   * التعريفات مثبَّتة في العقد لا هنا: `mrr` = مجموع المكافئ الشهري للتراخيص المتعاقَدة
   * (`active` و `past_due`)، و`arr` = `mrr × 12`، و`overdue` = المتبقّي على فاتورة صادرة
   * تجاوزت استحقاقها. التجربة والموقوف مؤقتاً ليسا إيراداً، لكنهما محسوبان ليُقرأ الأثر.
   */
  async revenue(): Promise<PlatformRevenue> {
    mustBePlatformAdmin();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const subscriptions = await tx.execute(sql`
        SELECT s.status, p.amount::text, p.interval, p.currency
          FROM tenant_subscriptions s JOIN billing_plans p ON p.id = s.plan_id
         WHERE s.status = ANY(${liveStatuses})
      `);

      const counts = { active: 0, trialing: 0, pastDue: 0, paused: 0, canceled: 0 };
      const byCurrency = new Map<string, bigint>();
      for (const row of subscriptions.rows) {
        const status = String(row.status);
        if (status === 'active') counts.active += 1;
        else if (status === 'trialing') counts.trialing += 1;
        else if (status === 'past_due') counts.pastDue += 1;
        else if (status === 'paused') counts.paused += 1;
        if (status !== 'active' && status !== 'past_due') continue;
        const currency = String(row.currency).trim();
        const monthly = platformMonthlyAmount(
          String(row.amount),
          String(row.interval) === 'year' ? 'year' : 'month',
        );
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + platformParseAmount(monthly));
      }

      const canceled = await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM tenant_subscriptions WHERE status = 'canceled'
      `);
      counts.canceled = Number(canceled.rows[0]?.n ?? 0);

      const ranked = [...byCurrency.entries()].sort((left, right) => (right[1] > left[1] ? 1 : -1));
      const currency = ranked[0]?.[0] ?? 'SAR';
      const mrr = platformFormatAmount(ranked[0]?.[1] ?? 0n);

      const totals = await tx.execute(sql`
        SELECT
          COALESCE(SUM(i.total - i.paid_amount) FILTER (WHERE i.status = 'issued' AND i.kind = 'invoice'), 0)::text AS outstanding,
          COALESCE(SUM(i.total - i.paid_amount) FILTER (WHERE i.status = 'issued' AND i.kind = 'invoice' AND i.due_date < current_date), 0)::text AS overdue,
          COUNT(*) FILTER (WHERE i.status = 'issued' AND i.kind = 'invoice' AND i.due_date < current_date)::int AS overdue_count
        FROM platform_invoices i
      `);
      const collected = await tx.execute(sql`
        SELECT COALESCE(SUM(p.amount), 0)::text AS collected
          FROM platform_payments p
         WHERE p.status = 'recorded' AND p.received_at >= date_trunc('month', now())
      `);

      const upcoming = await tx.execute(sql`
        SELECT i.id, i.number, i.due_date, i.total::text, i.total - i.paid_amount AS remaining, t.name AS tenant_name
          FROM platform_invoices i JOIN tenants t ON t.id = i.tenant_id
         WHERE i.status = 'issued' AND i.kind = 'invoice'
         ORDER BY i.due_date ASC NULLS LAST
         LIMIT 10
      `);

      const row = totals.rows[0] ?? {};
      return platformRevenueSchema.parse({
        currency,
        mrr,
        arr: platformAnnualAmount(mrr),
        outstanding: money(row.outstanding),
        overdue: money(row.overdue),
        overdueCount: Number(row.overdue_count ?? 0),
        mixedCurrency: byCurrency.size > 1,
        collectedThisMonth: money(collected.rows[0]?.collected),
        counts,
        upcoming: upcoming.rows.map((entry) => ({
          invoiceId: String(entry.id),
          number: entry.number ? String(entry.number) : null,
          tenantName: String(entry.tenant_name),
          dueDate: entry.due_date ? dateOnly(entry.due_date) : null,
          total: money(entry.total),
          remaining: money(entry.remaining),
          daysOverdue: platformDaysOverdue(entry.due_date ? dateOnly(entry.due_date) : null),
        })),
      });
    });
  }

  // ================================================================== internals

  /**
   * قراءة إعدادات الفوترة الفعّالة: صفُّ المنصة إن وُجد، وإلا القيمة الافتراضية من الفهرس.
   *
   * تُقرأ هنا لا في الطبقة الأعلى لأن كل مسار يحتاجها (نسبة الضريبة على الفاتورة، مهلة
   * السداد عند الإصدار، سلّم المتابعة، وهوية البائع المنسوخة على المستند).
   */
  private async billingSettings(tx: DrizzleTx): Promise<{
    taxRate: number;
    termsDays: number;
    ladder: number[];
    sellerName: string;
    sellerTaxNumber: string;
    sellerAddress: string;
  }> {
    const keys = [
      'billing.tax_rate',
      'billing.payment_terms_days',
      'billing.dunning_days',
      'billing.seller_name',
      'billing.seller_tax_number',
      'billing.seller_address',
    ];
    // `inArray` لا `ANY(ARRAY[...])`: درايزل يوسّع مصفوفة JavaScript إلى صفٍّ من الوسائط
    // `($1, $2, …)`، وهو ليس مصفوفةً في SQL — والاستعلام يفشل قبل أن يصل إلى القاعدة.
    const rows = await tx
      .select({ key: platformSettings.key, raw: sql<string>`${platformSettings.value}::text` })
      .from(platformSettings)
      .where(and(isNull(platformSettings.tenantId), inArray(platformSettings.key, keys)));
    const stored = new Map(rows.map((row) => [String(row.key), JSON.parse(String(row.raw)) as unknown]));
    const value = (key: string): unknown =>
      stored.has(key) ? stored.get(key) : findPlatformSettingDefinition(key)?.defaultValue;

    const ladderSetting = value('billing.dunning_days');
    return {
      taxRate: Number(value('billing.tax_rate') ?? 15),
      termsDays: Number(value('billing.payment_terms_days') ?? 14),
      ladder: billingDunningLadder(
        Array.isArray(ladderSetting) ? ladderSetting.map((entry) => String(entry)) : [],
      ),
      sellerName: String(value('billing.seller_name') ?? ''),
      sellerTaxNumber: String(value('billing.seller_tax_number') ?? ''),
      sellerAddress: String(value('billing.seller_address') ?? ''),
    };
  }

  /** إنشاء مسودّة فاتورة أو إشعار دائن بسطورها — المسارُ الواحد الذي يمرّ منه كل مستند. */
  private async insertInvoice(
    tx: DrizzleTx,
    input: {
      tenantId: string;
      subscriptionId: string | null;
      kind: 'invoice' | 'credit_note';
      currency: string;
      lines: Array<{
        kind: 'subscription' | 'proration' | 'discount' | 'adjustment';
        description: string;
        amount: string;
        metadata?: Record<string, unknown>;
      }>;
      taxRate: number;
      periodStart: string;
      periodEnd: string;
      buyerName: string;
      buyerEmail: string | null;
      /** الرقم الضريبي للمشتري إن أدخله المشغّل — يُنسخ على المستند ولا يُشتق من ملفه. */
      buyerTaxNumber?: string | null;
      note: string | null;
      actorUserId: string;
    },
  ): Promise<string> {
    const settings = await this.billingSettings(tx);
    const totals = calculateInvoiceTotals({
      lines: input.lines.map((line) => ({
        quantity: '1',
        unitPrice: line.amount,
        taxRate: String(input.taxRate),
      })),
      scale: 2,
    });

    const invoiceId = newId();
    await tx.execute(sql`
      INSERT INTO platform_invoices
        (id, tenant_id, subscription_id, kind, status, currency, subtotal, tax_rate, tax_amount, total,
         buyer_name, buyer_tax_number, buyer_email, seller_name, seller_tax_number, seller_address,
         period_start, period_end, note, created_by)
      VALUES (${invoiceId}, ${input.tenantId}, ${input.subscriptionId}, ${input.kind}, 'draft',
              ${input.currency}, ${totals.subtotal}::numeric, ${String(input.taxRate)}::numeric,
              ${totals.tax}::numeric, ${totals.total}::numeric, ${input.buyerName},
              ${input.buyerTaxNumber ?? null}, ${input.buyerEmail},
              ${settings.sellerName}, ${settings.sellerTaxNumber || null}, ${settings.sellerAddress},
              ${input.periodStart}::date, ${input.periodEnd}::date, ${input.note}, ${input.actorUserId})
    `);

    let lineNo = 1;
    for (const line of input.lines) {
      await tx.execute(sql`
        INSERT INTO platform_invoice_lines
          (id, invoice_id, tenant_id, line_no, kind, description, quantity, unit_price, amount, metadata)
        VALUES (${newId()}, ${invoiceId}, ${input.tenantId}, ${lineNo}, ${line.kind}, ${line.description},
                1, ${line.amount}::numeric, ${line.amount}::numeric,
                ${JSON.stringify(line.metadata ?? {})}::jsonb)
      `);
      lineNo += 1;
    }

    return invoiceId;
  }

  /** تخصيص رقم المستند من تسلسل المنصة — داخل معاملة المستند فلا فجوة عند التراجع. */
  private async nextNumber(tx: DrizzleTx, docType: string, prefix: string): Promise<string> {
    const result = await tx.execute(sql`
      INSERT INTO platform_invoice_sequences (doc_type, prefix, padding, current_value, updated_at)
      VALUES (${docType}, ${prefix}, 5, 1, now())
      ON CONFLICT (doc_type) DO UPDATE
        SET current_value = platform_invoice_sequences.current_value + 1, updated_at = now()
      RETURNING current_value, prefix, padding
    `);
    const row = result.rows[0]!;
    return formatSequenceNumber(Number(row.current_value), String(row.prefix), Number(row.padding));
  }

  /** تغيير حالة ترخيص مع تدقيق موحّد: الحراسة، ثم الكتابة، ثم الصف. */
  private async transition(
    subscriptionId: string,
    options: {
      action: string;
      reason: string;
      allowed: readonly string[];
      apply: (tx: DrizzleTx, auth: { userId: string }) => Promise<unknown>;
    },
  ): Promise<PlatformSubscription> {
    mustBePlatformAdmin();
    const auth = getAuthContext();

    const id = await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = (await this.subscriptionRows(tx, subscriptionId))[0];
      if (!before) throw new DomainError(errorCodes.NOT_FOUND, 'الترخيص غير موجود', 404);
      if (!options.allowed.includes(String(before.status))) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `لا يمكن هذا الإجراء على ترخيصٍ حالته «${String(before.status)}»`,
          422,
          { status: before.status },
        );
      }

      await options.apply(tx, { userId: auth.userId });

      const after = (await this.subscriptionRows(tx, subscriptionId))[0]!;
      await this.audit.recordInTx(tx, {
        tenantId: String(before.tenant_id),
        actorUserId: auth.userId,
        actorLabel: await this.actorLabel(tx, auth.userId),
        action: options.action,
        entity: 'tenant_subscription',
        entityId: subscriptionId,
        before: {
          status: String(before.status),
          planCode: String(before.plan_code),
          periodEnd: iso(before.current_period_end),
        },
        after: {
          status: String(after.status),
          cancelAtPeriodEnd: Boolean(after.cancel_at_period_end),
          periodEnd: iso(after.current_period_end),
        },
        meta: { scope: 'platform_console', reason: options.reason },
      });
      return subscriptionId;
    });

    const rows = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`${this.subscriptionSelect()} WHERE s.id = ${id}`),
    );
    return this.subscriptionView(rows.rows[0]!);
  }

  private subscriptionSelect() {
    return sql`
      SELECT s.id, s.status, s.provider, s.current_period_start, s.current_period_end, s.activated_at,
             s.canceled_at, s.created_at, s.trial_ends_at, s.paused_at, s.resumed_at,
             s.cancel_at_period_end, s.canceled_reason, s.billing_email, s.notes,
             t.id AS tenant_id, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
             p.id AS plan_id, p.name AS plan_name, p.code AS plan_code, p.amount::text, p.currency, p.interval,
             (SELECT COUNT(*) FROM platform_invoices i
               WHERE i.subscription_id = s.id AND i.status = 'issued')::int AS due_invoice_count
        FROM tenant_subscriptions s
        JOIN tenants t ON t.id = s.tenant_id
        JOIN billing_plans p ON p.id = s.plan_id
    `;
  }

  private subscriptionRows(tx: DrizzleTx, subscriptionId: string): Promise<Array<Record<string, unknown>>> {
    return tx.execute(sql`
      SELECT s.id, s.status, s.provider, s.current_period_start, s.current_period_end, s.activated_at,
             s.canceled_at, s.created_at, s.trial_ends_at, s.paused_at, s.resumed_at,
             s.cancel_at_period_end, s.canceled_reason, s.billing_email, s.notes,
             t.id AS tenant_id, t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status,
             p.id AS plan_id, p.name AS plan_name, p.code AS plan_code, p.amount::text, p.currency, p.interval,
             (SELECT COUNT(*) FROM platform_invoices i
               WHERE i.subscription_id = s.id AND i.status = 'issued')::int AS due_invoice_count
        FROM tenant_subscriptions s
        JOIN tenants t ON t.id = s.tenant_id
        JOIN billing_plans p ON p.id = s.plan_id
       WHERE s.id = ${subscriptionId}
    `).then((result) => result.rows as Array<Record<string, unknown>>);
  }

  private subscriptionView(row: Record<string, unknown>): PlatformSubscription {
    return platformSubscriptionSchema.parse({
      id: String(row.id),
      status: String(row.status),
      provider: String(row.provider),
      tenantId: String(row.tenant_id),
      tenantCode: String(row.tenant_code),
      tenantName: String(row.tenant_name),
      tenantStatus: String(row.tenant_status),
      planId: String(row.plan_id),
      planCode: String(row.plan_code),
      planName: String(row.plan_name),
      amount: money(row.amount),
      currency: String(row.currency).trim(),
      interval: String(row.interval) === 'year' ? 'year' : 'month',
      monthlyAmount: platformMonthlyAmount(
        String(row.amount),
        String(row.interval) === 'year' ? 'year' : 'month',
      ),
      currentPeriodStart: iso(row.current_period_start),
      currentPeriodEnd: iso(row.current_period_end),
      trialEndsAt: iso(row.trial_ends_at),
      pausedAt: iso(row.paused_at),
      resumedAt: iso(row.resumed_at),
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      canceledReason: row.canceled_reason ? String(row.canceled_reason) : null,
      billingEmail: row.billing_email ? String(row.billing_email) : null,
      notes: row.notes ? String(row.notes) : null,
      activatedAt: iso(row.activated_at),
      canceledAt: iso(row.canceled_at),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      dueInvoiceCount: Number(row.due_invoice_count ?? 0),
    });
  }

  private planRows(tx: DrizzleTx, planId?: string) {
    return tx
      .execute(sql`
        SELECT p.id, p.code, p.name, p.interval, p.amount::text, p.currency, p.stripe_price_id, p.active,
               p.created_at,
               (SELECT COUNT(*) FROM tenant_subscriptions s
                 WHERE s.plan_id = p.id AND s.status = ANY(${liveStatuses}))::int AS active_subscriptions,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'key', e.key, 'value', e.value) ORDER BY e.key)
                   FROM billing_plan_entitlements e WHERE e.plan_id = p.id
               ), '[]'::jsonb) AS entitlements
          FROM billing_plans p
         WHERE (${planId ?? null}::uuid IS NULL OR p.id = ${planId ?? null}::uuid)
         ORDER BY p.active DESC, p.amount ASC, p.code ASC
      `)
      .then((result) => result.rows as Array<Record<string, unknown>>);
  }

  private planView(row: Record<string, unknown>): PlatformPlan {
    const keys = new Map(this.entitlementKeys().map((entry) => [entry.key, entry]));
    const raw = (row.entitlements as Array<{ kind: string; key: string; value: unknown }> | null) ?? [];
    const entitlements: PlatformPlanEntitlement[] = raw.map((entry) => {
      const definition = keys.get(entry.key);
      return {
        kind: (definition?.kind ?? entry.kind) as PlatformPlanEntitlement['kind'],
        key: entry.key,
        value: entry.value as PlatformPlanEntitlement['value'],
        // A key that left the product still reads back with its own name: a plan written
        // yesterday must not fail to render because the catalogue changed today.
        labelAr: definition?.labelAr ?? entry.key,
        // والاسم الإنجليزي من الفهرس نفسه — تقرؤه صفحة الأسعار العامة (`GET /public/plans`).
        labelEn: definition?.labelEn ?? entry.key,
        registry: definition?.registry ?? 'platform',
      };
    });

    return platformPlanSchema.parse({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      interval: String(row.interval) === 'year' ? 'year' : 'month',
      amount: money(row.amount),
      currency: String(row.currency).trim(),
      stripePriceId: row.stripe_price_id ? String(row.stripe_price_id) : null,
      active: Boolean(row.active),
      activeSubscriptions: Number(row.active_subscriptions ?? 0),
      monthlyAmount: platformMonthlyAmount(
        String(row.amount),
        String(row.interval) === 'year' ? 'year' : 'month',
      ),
      entitlements,
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
    });
  }

  private planAuditShape(row: Record<string, unknown>) {
    return {
      code: String(row.code),
      name: String(row.name),
      interval: String(row.interval),
      amount: String(row.amount),
      currency: String(row.currency).trim(),
      active: Boolean(row.active),
    };
  }

  private invoiceSelect() {
    return sql`
      SELECT i.id, i.kind, i.status, i.number, i.tenant_id, i.subscription_id, i.issue_date, i.due_date,
             i.currency, i.subtotal::text, i.tax_rate::text, i.tax_amount::text, i.total::text,
             i.paid_amount::text, (i.total - i.paid_amount)::text AS remaining,
             i.buyer_name, i.buyer_tax_number, i.buyer_email, i.seller_name, i.seller_tax_number,
             i.seller_address, i.period_start, i.period_end, i.note, i.issued_at, i.paid_at,
             i.voided_at, i.void_reason, i.created_at,
             t.code AS tenant_code, t.name AS tenant_name,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'lineNo', l.line_no, 'kind', l.kind, 'description', l.description,
                        'quantity', l.quantity::text, 'unitPrice', l.unit_price::text, 'amount', l.amount::text)
                      ORDER BY l.line_no)
                 FROM platform_invoice_lines l WHERE l.invoice_id = i.id
             ), '[]'::jsonb) AS lines,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'id', pay.id, 'method', pay.method, 'amount', pay.amount::text,
                        'reference', pay.reference, 'receiptFileId', pay.receipt_file_id,
                        'gateway', pay.gateway, 'status', pay.status, 'receivedAt', pay.received_at,
                        'recordedByLabel', u.full_name, 'note', pay.note) ORDER BY pay.received_at)
                 FROM platform_payments pay LEFT JOIN users u ON u.id = pay.recorded_by
                WHERE pay.invoice_id = i.id
             ), '[]'::jsonb) AS payments
        FROM platform_invoices i
        JOIN tenants t ON t.id = i.tenant_id
    `;
  }

  private invoiceView(row: Record<string, unknown>, withDetail: boolean): PlatformInvoice | PlatformInvoiceSummary {
    const lines = withDetail
      ? ((row.lines as Array<Record<string, unknown>> | null) ?? []).map((line) => ({
          lineNo: Number(line.lineNo),
          kind: String(line.kind) as PlatformInvoice['lines'][number]['kind'],
          description: String(line.description),
          quantity: String(line.quantity),
          unitPrice: money(line.unitPrice),
          amount: money(line.amount),
        }))
      : [];
    const payments = withDetail
      ? ((row.payments as Array<Record<string, unknown>> | null) ?? []).map((payment) => ({
          id: String(payment.id),
          method: String(payment.method) as PlatformInvoice['payments'][number]['method'],
          amount: money(payment.amount),
          reference: payment.reference ? String(payment.reference) : null,
          receiptFileId: payment.receiptFileId ? String(payment.receiptFileId) : null,
          gateway: payment.gateway ? String(payment.gateway) : null,
          status: String(payment.status),
          receivedAt: iso(payment.receivedAt) ?? new Date().toISOString(),
          recordedByLabel: payment.recordedByLabel ? String(payment.recordedByLabel) : null,
          note: payment.note ? String(payment.note) : null,
        }))
      : [];

    const shape = {
      id: String(row.id),
      kind: String(row.kind) as PlatformInvoice['kind'],
      status: String(row.status) as PlatformInvoice['status'],
      number: row.number ? String(row.number) : null,
      tenantId: String(row.tenant_id),
      tenantCode: String(row.tenant_code),
      tenantName: String(row.tenant_name),
      subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
      issueDate: row.issue_date ? dateOnly(row.issue_date) : null,
      dueDate: row.due_date ? dateOnly(row.due_date) : null,
      currency: String(row.currency).trim(),
      subtotal: money(row.subtotal),
      taxRate: money(row.tax_rate),
      taxAmount: money(row.tax_amount),
      total: money(row.total),
      paidAmount: money(row.paid_amount),
      remaining: money(row.remaining),
      buyerName: String(row.buyer_name),
      buyerTaxNumber: row.buyer_tax_number ? String(row.buyer_tax_number) : null,
      buyerEmail: row.buyer_email ? String(row.buyer_email) : null,
      sellerName: String(row.seller_name),
      sellerTaxNumber: row.seller_tax_number ? String(row.seller_tax_number) : null,
      sellerAddress: row.seller_address ? String(row.seller_address) : null,
      periodStart: row.period_start ? dateOnly(row.period_start) : null,
      periodEnd: row.period_end ? dateOnly(row.period_end) : null,
      note: row.note ? String(row.note) : null,
      issuedAt: iso(row.issued_at),
      paidAt: iso(row.paid_at),
      voidedAt: iso(row.voided_at),
      voidReason: row.void_reason ? String(row.void_reason) : null,
      daysOverdue: platformDaysOverdue(row.due_date ? dateOnly(row.due_date) : null),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
    };

    return withDetail
      ? platformInvoiceSchema.parse({ ...shape, lines, payments })
      : platformInvoiceSummarySchema.parse(shape);
  }

  /** اسم الفاعل: المشغّل ليس عضوًا في المنشأة التي يعمل عليها، فالعضوية لا تعرفه. */
  private async actorLabel(tx: DrizzleTx, userId: string | undefined): Promise<string> {
    if (!userId) return 'النظام';
    const rows = await tx.execute(sql`SELECT full_name FROM users WHERE id = ${userId} LIMIT 1`);
    return String(rows.rows[0]?.full_name ?? 'مدير المنصة');
  }
}

// -------------------------------------------------------------------- helpers

function mustBePlatformAdmin(): void {
  // مهمّةٌ خلفية (سياق النظام) تقرأ الإيراد للتقرير الأسبوعي: لا جلسةَ مشغّل تُصنع لها،
  // والوسم `system` لا يضعه مسار HTTP أصلاً (`runAsSystem` وحدها). وما عدا ذلك الحاجز كما هو.
  if (systemContext()) return;
  if (!getAuthContext().isPlatformAdmin) {
    throw new DomainError(errorCodes.FORBIDDEN, 'platform-admin plane requires is_platform_admin', 403);
  }
}

/**
 * المال بمنزلتين دائماً — أوامر `numeric` في القاعدة بأربع، فـ`amount::text` يصل `499.0000`.
 *
 * الرقم الذي يُعرض في الشاشة يجب أن يكون الرقم الذي يُحسب في العقد: نُطبّع عند حدّ القراءة
 * مرة واحدة (`platformFormatAmount` بعد `platformParseAmount`) فلا يُصلح كل مسار عرضٍ تقريبه.
 */
function money(value: unknown): string {
  return platformFormatAmount(platformParseAmount(String(value ?? '0')));
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `YYYY-MM-DD` من `Date` أو من نصٍّ يعيده السائق (تاريخ بلا وقت، أو طابع زمني). */
function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** `numeric` يعود `null` إذا لم يكن هناك صفّ إجمالي — والصفر أصدق من `null` في الشاشة. */
/**
 * ورقة الفاتورة — A4 مكتفية بذاتها، بنفس منطق `PrintTemplatesService` في سطح العميل: لا CSS
 * خارجي ولا خطوط ولا صور، فتُفتح داخل إطار، وتُحفظ ملفاً، وتُطبع كما هي.
 */
function renderInvoicePage(
  invoice: PlatformInvoice,
  buyer: { tenantCode: string; tenantName: string },
): string {
  const esc = (value: unknown): string =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const money = (value: string): string =>
    `${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const title = invoice.kind === 'credit_note' ? 'إشعار دائن' : 'فاتورة ضريبية';
  const statusLabel =
    invoice.status === 'paid'
      ? 'مدفوعة'
      : invoice.status === 'void'
        ? 'ملغاة'
        : invoice.status === 'issued'
          ? 'صادرة'
          : 'مسودّة';

  const rows = invoice.lines
    .map(
      (line) => `<tr>
        <td>${line.lineNo}</td>
        <td>${esc(line.description)}</td>
        <td class="num">${esc(line.quantity)}</td>
        <td class="num">${money(line.unitPrice)}</td>
        <td class="num">${money(line.amount)}</td>
      </tr>`,
    )
    .join('');

  const payments =
    invoice.payments.length === 0
      ? ''
      : `<h2>الدفعات</h2>
        <table class="report">
          <thead><tr><th>التاريخ</th><th>الطريقة</th><th>المرجع</th><th class="num">المبلغ</th><th>سجّلها</th></tr></thead>
          <tbody>${invoice.payments
            .map(
              (payment) => `<tr>
                <td dir="ltr">${esc(payment.receivedAt.slice(0, 10))}</td>
                <td>${esc(paymentLabel(payment.method))}</td>
                <td dir="ltr">${esc(payment.reference ?? '—')}</td>
                <td class="num">${money(payment.amount)}</td>
                <td>${esc(payment.recordedByLabel ?? '—')}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`;

  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} ${esc(invoice.number ?? '')}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif; color: #111; margin: 0; padding: 16px; background: #f4f5f7; font-size: 12px; }
  .sheet { background: #fff; max-width: 210mm; margin: 0 auto; padding: 16mm 14mm; box-shadow: 0 1px 8px rgba(0,0,0,.12); }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  .doc-head h1 { font-size: 18px; margin: 0 0 2px; }
  .doc { text-align: left; }
  .doc .number { font-size: 16px; font-weight: 700; }
  .parties { display: flex; gap: 16px; margin-top: 12px; }
  .party { flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
  .party h2 { font-size: 12px; margin: 0 0 4px; color: #555; }
  table.report { width: 100%; border-collapse: collapse; margin-top: 12px; }
  table.report th, table.report td { border: 1px solid #ccc; padding: 4px 6px; text-align: right; vertical-align: top; }
  table.report thead th { background: #f0f1f3; }
  .num { text-align: left; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 10px; margin-inline-start: auto; width: 300px; }
  .totals div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dotted #ccc; }
  .totals div.grand { border-bottom: 0; border-top: 2px solid #111; font-weight: 700; font-size: 14px; }
  .meta { margin-top: 12px; color: #444; }
  .qr { margin-top: 12px; display: inline-flex; flex-direction: column; align-items: center; gap: 2px; }
  .qr svg { width: 104px; height: 104px; }
  .qr span { font-size: 10px; color: #666; }
  .foot { margin-top: 14px; border-top: 1px solid #999; padding-top: 6px; text-align: center; color: #555; }
  .badge { display: inline-block; border: 1px solid #888; border-radius: 999px; padding: 1px 10px; font-size: 11px; }
</style>
</head>
<body>
<div class="sheet">
  <div class="doc-head">
    <div>
      <h1>${esc(invoice.sellerName || 'المنصة')}</h1>
      <div class="muted">${esc(invoice.sellerAddress ?? '')}</div>
      ${invoice.sellerTaxNumber ? `<div>الرقم الضريبي: <span dir="ltr">${esc(invoice.sellerTaxNumber)}</span></div>` : ''}
    </div>
    <div class="doc">
      <div class="number">${esc(title)}</div>
      <div>الرقم: <span dir="ltr">${esc(invoice.number ?? '— مسودّة —')}</span></div>
      <div>تاريخ الإصدار: <span dir="ltr">${esc(invoice.issueDate ?? '—')}</span></div>
      <div>تاريخ الاستحقاق: <span dir="ltr">${esc(invoice.dueDate ?? '—')}</span></div>
      <div class="badge">${esc(statusLabel)}</div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h2>العميل (المشتري)</h2>
      <div><strong>${esc(buyer.tenantName)}</strong></div>
      <div>الرمز: <span dir="ltr">${esc(buyer.tenantCode)}</span></div>
      <div>الرقم الضريبي: <span dir="ltr">${esc(invoice.buyerTaxNumber ?? '—')}</span></div>
      ${invoice.buyerEmail ? `<div dir="ltr">${esc(invoice.buyerEmail)}</div>` : ''}
    </div>
    <div class="party">
      <h2>فترة الاشتراك</h2>
      <div>من <span dir="ltr">${esc(invoice.periodStart ?? '—')}</span> إلى <span dir="ltr">${esc(invoice.periodEnd ?? '—')}</span></div>
      <div>العملة: <span dir="ltr">${esc(invoice.currency)}</span></div>
      ${invoice.daysOverdue > 0 ? `<div>متأخّرة ${invoice.daysOverdue} يوماً</div>` : ''}
    </div>
  </div>

  <table class="report">
    <thead>
      <tr><th style="width:36px">#</th><th>البند</th><th class="num" style="width:70px">الكمية</th><th class="num" style="width:110px">السعر</th><th class="num" style="width:120px">المبلغ</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div><span>الإجمالي قبل الضريبة</span><span class="num">${money(invoice.subtotal)} ${esc(invoice.currency)}</span></div>
    <div><span>ضريبة القيمة المضافة (${esc(Number(invoice.taxRate).toString())}٪)</span><span class="num">${money(invoice.taxAmount)} ${esc(invoice.currency)}</span></div>
    <div class="grand"><span>الإجمالي</span><span class="num">${money(invoice.total)} ${esc(invoice.currency)}</span></div>
    <div><span>المدفوع</span><span class="num">${money(invoice.paidAmount)} ${esc(invoice.currency)}</span></div>
    <div><span>المتبقّي</span><span class="num">${money(invoice.remaining)} ${esc(invoice.currency)}</span></div>
  </div>

  <div class="meta"><strong>الإجمالي بالحروف:</strong> ${esc(amountInArabicWords(invoice.total, invoice.currency))}</div>

  ${qrBlock(invoice)}

  ${payments}

  ${invoice.note ? `<div class="meta"><strong>ملاحظة:</strong> ${esc(invoice.note)}</div>` : ''}
  ${invoice.voidReason ? `<div class="meta"><strong>سبب الإلغاء:</strong> ${esc(invoice.voidReason)}</div>` : ''}

  <div class="foot">${esc(title)} — ${esc(invoice.sellerName || 'المنصة')} · ${esc(invoice.currency)} · ${esc(invoice.status)}</div>
</div>
</body>
</html>`;
}

/**
 * رمز الاستجابة السريعة كما تشترطه هيئة الزكاة والضريبة والجمارك: حمولة TLV بخمسة حقول
 * (اسم البائع، رقمه الضريبي، الطابع الزمني، الإجمالي مع الضريبة، الضريبة) مبنية بـ
 * `buildQrPayload` نفسه الذي يبنيه سطح العميل — لا مُنشئ ثانياً في المستودع.
 *
 * ولا يُرسم على مسودّة ولا على ملغاة: المستند غير الضريبي لا يحمل رمزاً ضريبياً.
 */
function qrBlock(invoice: PlatformInvoice): string {
  if (invoice.status === 'draft' || invoice.status === 'void') return '';
  if (!invoice.sellerTaxNumber || !/^\d{15}$/.test(invoice.sellerTaxNumber)) return '';
  const payload = buildQrPayload({
    sellerName: invoice.sellerName || 'المنصة',
    vatNo: invoice.sellerTaxNumber,
    timestamp: invoice.issuedAt ?? invoice.createdAt,
    grandTotal: invoice.total,
    vatTotal: invoice.taxAmount,
  });
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  return `<div class="qr">${qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true })}<span>الرمز الضريبي (ZATCA)</span></div>`;
}

function paymentLabel(method: string): string {
  return (
    {
      bank_transfer: 'تحويل بنكي',
      cash: 'نقداً',
      card: 'بطاقة',
      other: 'أخرى',
    } as Record<string, string>
  )[method] ?? method;
}
