import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  findPlatformSettingDefinition,
  maskSignupEmail,
  normalizeSignupCode,
  normalizeSignupEmail,
  SIGNUP_CODE_LENGTH,
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  signupEmailVariables,
  signupResendWaitSeconds,
  signupSetupTaskDefinitions,
  signupVerificationState,
  type SignupRequest,
  type SignupSetupTask,
  type SignupStarted,
  type SignupStatus,
  type SignupVerificationState,
  type SignupVerificationView,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { EmailService } from '../../email/email.service.js';
import { OrgProvisioningService } from '../../organization/provisioning/org-provisioning.service.js';
import { PlatformAdminService } from '../admin/platform-admin.service.js';
import { PublicPlansService } from '../billing/public-plans.service.js';

/**
 * P-M4 — «الاشتراك والتفعيل»: من زائرٍ إلى منشأةٍ عاملة في جلسة واحدة
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **المسار كلّه في مكانٍ واحد** لأن خطواته الأربع قصةٌ واحدة لا أربع خدمات: الباقة ←
 * المنشأة ← المدير ← التحقّق. ولو وُزّعت على المتحكّم لصار المعالج في الواجهة يعرف ترتيب
 * كتابة القاعدة — وذلك لا يصحّ أن يعرفه.
 *
 * **والرّمزان مختلفان، والخلط بينهما خللٌ أمني**:
 *
 *   * **الرمز (`code`)** ستة أرقام تُرسل بالبريد وحده، ويُخزَّن sha256 لها. غايته إثبات أن
 *     من يملأ النموذج **يملك العنوان**.
 *   * **الرمز المميّز (`token`)** 32 حرفاً عشوائياً يُعاد للعميل مرّةً واحدة عند التسجيل،
 *     ويُخزَّن sha256 له أيضاً. غايته إثبات أن **الطالب هو من بدأ التسجيل** — فيُطلب في
 *     التحقّق وإعادة الإرسال والحالة. وبهذا لا يصير `GET /signup/status/:email` سرداً
 *     للعناوين، والجواب عن عنوانٍ مجهول وعن رمزٍ خاطئ واحدٌ: **404**.
 *
 * **وفي المعاملة الواحدة**: ‏`PlatformAdminService.signup` تُنشئ المنشأة والمدير والدور
 * الأساسي وطلب التفعيل، و`OrgProvisioningService` تُكمل الفرع/المستودع/الخزنة/الدليل. ثم
 * يُكتب صفّ التحقّق ويُرسل البريد. وإن فشل البريد لا يُلغى التسجيل: الزائر يستطيع طلب
 * إرسالٍ جديد، وإلغاء ما نجح لأن رسالةً تعثّرت أسوأ من رسالةٍ متأخّرة.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly admin: PlatformAdminService,
    private readonly provisioning: OrgProvisioningService,
    private readonly plans: PublicPlansService,
    private readonly email: EmailService,
  ) {}

  // ═══════════════════════════════════════════════════ ١ · البدء

  /**
   * `POST /signup` — ينشئ المنشأة والمدير، ثم يُرسل رمز التحقّق.
   *
   * والرخصة **لا تُمنح هنا**: الطلب يبقى `pending` في طابور التفعيل
   * (`SIGNUP_ENABLED` بوابةٌ ثانية فوق حدّ المعدّل)، فلا يمنح زائرٌ نفسه ترخيصاً.
   */
  async start(input: SignupRequest): Promise<SignupStarted> {
    const email = normalizeSignupEmail(input.ownerEmail);

    // عنوانٌ يملك منشأةً بالفعل لا يُنشأ له ثانٍ من الباب العام: البدء من جديد لن يجعل
    // كلمة المرور الجديدة نافذة (المستخدم قائم بكلمته)، فيبقى الزائر ينتظر دخولاً لن يقع.
    await this.assertEmailIsFree(email);

    // الباقة تُفحَص **قبل** إنشاء أي صفّ: لو تُرك الفحص إلى ما بعد الإنشاء لَبقي ملفٌّ
    // يتيمٌ وطلبُ تفعيلٍ معلَّق من مجرّد باقةٍ أُرسلت خطأً — وهو نصّ الخطأ نفسه.
    const plan = input.planId ? await this.planChoice(input.planId) : null;

    const created = await this.admin.signup({ ...input, ownerEmail: email });
    await this.provisioning.provisionOrgDefaults(created.tenantId, {
      actorUserId: created.ownerUserId,
    });

    const token = randomBytes(24).toString('hex');
    const code = randomCode();
    const expiresAt = new Date(Date.now() + SIGNUP_CODE_TTL_MINUTES * 60_000);
    const trialDays = await this.trialDays();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      // تسجيلٌ سابق لم يكتمل: يُستبدل صفُّه (القيد الفريد الجزئي لا يسمح بصفّين معلّقين).
      await tx.execute(sql`
        DELETE FROM signup_verifications
         WHERE lower(email) = ${email} AND verified_at IS NULL
      `);
      await tx.execute(sql`
        INSERT INTO signup_verifications (
          id, email, tenant_id, tenant_code, tenant_name, owner_name, plan_id, locale,
          token_hash, code_hash, attempts, sends, last_sent_at, expires_at
        ) VALUES (
          ${newId()}, ${email}, ${created.tenantId}, ${created.tenantCode},
          ${input.companyName.trim()}, ${input.ownerFullName.trim()}, ${input.planId ?? null},
          ${input.locale}, ${digest(token)}, ${digest(code)}, 0, 1, now(), ${expiresAt}
        )
      `);
      // ما يطلبه الزائر يظهر في طابور التفعيل: الباقة، والتجربة المعلَنة، والأصل.
      if (created.activationRequestId) {
        await tx.execute(sql`
          UPDATE activation_requests
             SET notes = ${`Self-service signup · plan ${input.planId ? 'chosen' : 'none'} · trial ${trialDays}d · ${email}`},
                 updated_at = now()
           WHERE id = ${created.activationRequestId}
        `);
      }
    });

    await this.sendCode({
      email,
      ownerName: input.ownerFullName.trim(),
      companyName: input.companyName.trim(),
      code,
      expiresAt,
      locale: input.locale,
    });

    return {
      tenantCode: created.tenantCode,
      tenantName: input.companyName.trim(),
      ownerEmail: email,
      subscriptionStatus: created.subscriptionStatus === 'active' ? 'active' : 'pending',
      activationRequestId: created.activationRequestId,
      verification: this.verificationView({
        state: 'pending',
        email,
        sentAt: new Date(),
        expiresAt,
        attempts: 0,
        sends: 1,
      }),
      token,
      plan,
      trialDays,
    };
  }

  // ═══════════════════════════════════════════════════ ٢ · التحقّق

  /** `POST /signup/verify` — الرمز من البريد. النجاح **idempotent**: إعادة الإرسال تُعيد الحالة. */
  async verify(input: { email: string; token: string; code: string }): Promise<SignupStatus> {
    const email = normalizeSignupEmail(input.email);
    const row = await this.requireRow(email, input.token);

    if (row.verified_at) return this.status(email, input.token);

    const state = signupVerificationState({
      verifiedAt: row.verified_at as string | null,
      expiresAt: row.expires_at as Date,
      attempts: Number(row.attempts),
    });

    if (state === 'locked') {
      throw new DomainError(
        errorCodes.SIGNUP_CODE_INVALID,
        `تجاوزت عدد المحاولات (${SIGNUP_MAX_ATTEMPTS}). اطلب رمزاً جديداً لتُفتح المحاولات.`,
        422,
        { state, attemptsRemaining: 0 },
      );
    }
    if (state === 'expired') {
      throw new DomainError(
        errorCodes.SIGNUP_CODE_INVALID,
        `انتهت صلاحية الرمز بعد ${SIGNUP_CODE_TTL_MINUTES} دقيقة. اطلب رمزاً جديداً.`,
        422,
        { state, attemptsRemaining: SIGNUP_MAX_ATTEMPTS - Number(row.attempts) },
      );
    }

    const submitted = normalizeSignupCode(input.code);
    // المقارنة على التجزئة بزمنٍ ثابت: رمزٌ من ستة أرقام مساحته مليون احتمال، ومقارنةٌ
    // زمنية تكشف الأرقام الصحيحة واحداً واحداً.
    const matches = safeEqual(digest(submitted), String(row.code_hash));

    if (!matches) {
      const attempts = Number(row.attempts) + 1;
      await withPlatformAdminTx(this.database.db, (tx) =>
        tx.execute(sql`
          UPDATE signup_verifications SET attempts = ${attempts}, updated_at = now()
           WHERE id = ${String(row.id)}
        `),
      );
      throw new DomainError(
        errorCodes.SIGNUP_CODE_INVALID,
        attempts >= SIGNUP_MAX_ATTEMPTS
          ? `الرمز غير صحيح، وقد استُهلكت المحاولات (${SIGNUP_MAX_ATTEMPTS}). اطلب رمزاً جديداً.`
          : `الرمز غير صحيح. تبقّى ${SIGNUP_MAX_ATTEMPTS - attempts} محاولة.`,
        422,
        { state: attempts >= SIGNUP_MAX_ATTEMPTS ? 'locked' : 'pending', attemptsRemaining: Math.max(0, SIGNUP_MAX_ATTEMPTS - attempts) },
      );
    }

    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        UPDATE signup_verifications SET verified_at = now(), updated_at = now()
         WHERE id = ${String(row.id)}
      `),
    );

    return this.status(email, input.token);
  }

  // ═══════════════════════════════════════════════════ ٣ · إعادة الإرسال

  /** `POST /signup/resend` — رمزٌ جديد، بمهلة دقيقةٍ وسقفِ إرسالات. */
  async resend(input: { email: string; token: string }): Promise<SignupVerificationView> {
    const email = normalizeSignupEmail(input.email);
    const row = await this.requireRow(email, input.token);

    if (row.verified_at) {
      return this.verificationView({
        state: 'verified',
        email,
        sentAt: row.last_sent_at as string,
        expiresAt: row.expires_at as string,
        attempts: Number(row.attempts),
        sends: Number(row.sends),
      });
    }

    const wait = signupResendWaitSeconds(row.last_sent_at as string);
    if (wait > 0) {
      throw new DomainError(errorCodes.RATE_LIMITED, `يمكنك طلب رمزٍ جديد بعد ${wait} ثانية.`, 429, {
        retryAfterSeconds: wait,
      });
    }

    const sends = Number(row.sends);
    if (sends >= SIGNUP_MAX_SENDS) {
      throw new DomainError(
        errorCodes.RATE_LIMITED,
        `أُرسل الرمز ${SIGNUP_MAX_SENDS} مرات. ابدأ تسجيلاً جديداً بعنوانٍ آخر أو تواصل مع الدعم.`,
        429,
        { sends },
      );
    }

    const code = randomCode();
    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + SIGNUP_CODE_TTL_MINUTES * 60_000);

    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        UPDATE signup_verifications
           SET code_hash = ${digest(code)}, attempts = 0, sends = ${sends + 1},
               last_sent_at = ${sentAt}, expires_at = ${expiresAt}, updated_at = now()
         WHERE id = ${String(row.id)}
      `),
    );

    await this.sendCode({
      email,
      ownerName: String(row.owner_name ?? ''),
      companyName: String(row.tenant_name ?? ''),
      code,
      expiresAt,
      locale: String(row.locale) === 'en' ? 'en' : 'ar',
    });

    return this.verificationView({
      state: 'pending',
      email,
      sentAt,
      expiresAt,
      attempts: 0,
      sends: sends + 1,
    });
  }

  // ═══════════════════════════════════════════════════ ٤ · الحالة والتهيئة

  /** `GET /signup/status/:email` — الحالة وما تبقّى من مهامّ الإعداد. */
  async status(emailInput: string, token: string): Promise<SignupStatus> {
    const email = normalizeSignupEmail(emailInput);
    const row = await this.requireRow(email, token);
    const tenantId = String(row.tenant_id);

    const [plan, trialDays, setup, subscriptionStatus] = await Promise.all([
      row.plan_id ? this.planChoice(String(row.plan_id)) : Promise.resolve(null),
      this.trialDays(),
      this.setupTasks(tenantId),
      this.subscriptionStatus(tenantId),
    ]);

    const done = setup.filter((task) => task.done).length;

    return {
      tenantCode: String(row.tenant_code ?? ''),
      tenantName: String(row.tenant_name ?? ''),
      ownerEmail: email,
      subscriptionStatus,
      verification: this.verificationView({
        state: signupVerificationState({
          verifiedAt: row.verified_at as string | null,
          expiresAt: row.expires_at as string,
          attempts: Number(row.attempts),
        }),
        email,
        sentAt: row.last_sent_at as string,
        expiresAt: row.expires_at as string,
        attempts: Number(row.attempts),
        sends: Number(row.sends),
      }),
      plan,
      trialDays,
      setup,
      progress: { done, total: setup.length },
    };
  }

  /**
   * مهامّ الإعداد الأربع — **تُقاس من القاعدة لا من الكود**، فالشاشة تقول ما تبقّى فعلاً:
   * ملفّ المنشأة من `tenants`، والفرع والدليل ممّا جهّزته `provisionOrgDefaults`، وأول
   * فاتورة من `sales_invoices`. والقراءة في معاملة مستأجرٍ (`withTenantTx`) لا بترقيةٍ إلى
   * منصة المنصة: كل ما نقرأه بيانات المنشأة نفسها، فلا حاجة إلى سلطةٍ أعلى منها.
   */
  private async setupTasks(tenantId: string): Promise<SignupSetupTask[]> {
    const counts = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = await tx.execute(sql`
        SELECT
          -- أعمدة المنشأة في هذا المستودع is_active + حذفٌ ناعم (deleted_at)، لا status:
          -- فرعٌ أُغلق أو حُذف لا يُحتسب «فرعاً جاهزاً» في لوحة الترحيب.
          (SELECT count(*) FROM branches
            WHERE tenant_id = ${tenantId} AND is_active AND deleted_at IS NULL)::int AS branches,
          (SELECT count(*) FROM accounts
            WHERE tenant_id = ${tenantId} AND deleted_at IS NULL)::int AS accounts,
          -- وفاتورةٌ واحدة تكفي — مسودّةٌ أيضاً: المقصود أن الترقيم والترحيل يعملان.
          (SELECT count(*) FROM sales_invoices WHERE tenant_id = ${tenantId})::int AS invoices,
          (SELECT count(*) FROM tenants
            WHERE id = ${tenantId}
              AND length(trim(name)) >= 2
              AND length(trim(base_currency)) = 3
              AND length(trim(country_code)) = 2
              AND length(trim(timezone)) >= 3)::int AS profile
      `);
      const first = (row.rows[0] ?? {}) as Record<string, unknown>;
      return {
        branches: Number(first.branches ?? 0),
        accounts: Number(first.accounts ?? 0),
        invoices: Number(first.invoices ?? 0),
        profile: Number(first.profile ?? 0),
      };
    });

    const measured: Record<string, { done: boolean; count: number | null }> = {
      company: { done: counts.profile > 0, count: null },
      branch: { done: counts.branches > 0, count: counts.branches },
      chart: { done: counts.accounts > 0, count: counts.accounts },
      invoice: { done: counts.invoices > 0, count: counts.invoices },
    };

    return signupSetupTaskDefinitions.map((definition) => ({
      ...definition,
      done: measured[definition.key]?.done ?? false,
      count: measured[definition.key]?.count ?? null,
    }));
  }

  /** حالة الاشتراك كما يراها العميل: ترخيصٌ فعّال، أو طلبٌ في الطابور. */
  private async subscriptionStatus(tenantId: string): Promise<'pending' | 'active'> {
    const row = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT
          (SELECT count(*) FROM tenant_subscriptions
            WHERE tenant_id = ${tenantId} AND status IN ('active', 'trialing'))::int AS live,
          (SELECT count(*) FROM activation_requests
            WHERE tenant_id = ${tenantId} AND status = 'pending')::int AS pending
      `),
    );
    const first = (row.rows[0] ?? {}) as Record<string, unknown>;
    return Number(first.live ?? 0) > 0 ? 'active' : 'pending';
  }

  // ═══════════════════════════════════════════════════ أدوات داخلية

  /** صفّ التسجيل بالرمز المميّز — أو **404** (وهو الجواب نفسه للعنوان المجهول). */
  private async requireRow(email: string, token: string): Promise<Record<string, unknown>> {
    const result = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT * FROM signup_verifications
         WHERE lower(email) = ${email} AND token_hash = ${digest(token)}
         ORDER BY created_at DESC LIMIT 1
      `),
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new DomainError(errorCodes.SIGNUP_TOKEN_INVALID, 'لا يوجد تسجيلٌ بهذا البريد والرمز.', 404);
    }
    return row;
  }

  private async assertEmailIsFree(email: string): Promise<void> {
    const result = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT u.id,
               (SELECT count(*) FROM memberships m WHERE m.user_id = u.id AND m.status = 'active')::int AS memberships
          FROM users u WHERE lower(u.email) = ${email} LIMIT 1
      `),
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row && Number(row.memberships ?? 0) > 0) {
      throw new DomainError(
        errorCodes.SIGNUP_EMAIL_TAKEN,
        'هذا البريد يملك منشأةً بالفعل. سجّل الدخول، أو استعمل بريداً آخر، أو أنشئ ملفاً ثانياً من داخل التطبيق.',
        409,
      );
    }
  }

  /** باقةٌ مختارة → الشكل القصير الذي تعرضه الشاشة (من نفس مصدر صفحة الأسعار). */
  private async planChoice(planId: string) {
    const plans = await this.plans.listActive();
    const plan = plans.find((entry) => entry.id === planId);
    if (!plan) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'الباقة المختارة غير معروضة (موقوفة أو غير موجودة). اختر باقةً من القائمة.',
        422,
        { planId },
      );
    }
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      interval: plan.interval,
      amount: plan.amount,
      currency: plan.currency,
    };
  }

  /** الفترة التجريبية من إعدادات المنصة (`billing.trial_days`) — لا من رقمٍ في الكود. */
  private async trialDays(): Promise<number> {
    const row = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT value::text AS raw FROM platform_settings
         WHERE key = 'billing.trial_days' AND tenant_id IS NULL LIMIT 1
      `),
    );
    const raw = (row.rows[0] as { raw?: string } | undefined)?.raw;
    const stored = raw === undefined ? undefined : (JSON.parse(raw) as unknown);
    const definition = findPlatformSettingDefinition('billing.trial_days');
    const days = Number(stored ?? definition?.defaultValue ?? 0);
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  }

  private verificationView(input: {
    state: SignupVerificationState;
    email: string;
    sentAt: Date | string;
    expiresAt: Date | string;
    attempts: number;
    sends: number;
  }): SignupVerificationView {
    return {
      state: input.state,
      email: input.email,
      emailMasked: maskSignupEmail(input.email),
      sentAt: toInstant(input.sentAt).toISOString(),
      expiresAt: toInstant(input.expiresAt).toISOString(),
      attemptsRemaining: Math.max(0, SIGNUP_MAX_ATTEMPTS - input.attempts),
      sendsRemaining: Math.max(0, SIGNUP_MAX_SENDS - input.sends),
      resendWaitSeconds: signupResendWaitSeconds(input.sentAt),
    };
  }

  /**
   * إرسال الرمز — **ولا يُسقط التسجيل إن فشل**. القالب من سجلّ البريد (P-C6) بلغة الزائر،
   * والحدث `signup.verify` نطاقه `platform` فلا يُحتسب على حصّة عميل (لا عميل بعد).
   */
  private async sendCode(input: {
    email: string;
    ownerName: string;
    companyName: string;
    code: string;
    expiresAt: Date;
    locale: 'ar' | 'en';
  }): Promise<void> {
    try {
      await this.email.send({
        tenantId: null,
        event: 'signup.verify',
        to: input.email,
        toName: input.ownerName || input.companyName,
        locale: input.locale,
        variables: signupEmailVariables({
          ownerName: input.ownerName || input.companyName,
          companyName: input.companyName,
          code: input.code,
          expiresAt: input.expiresAt,
        }),
      });
    } catch (error) {
      this.logger.warn(
        `signup verification mail failed for ${maskSignupEmail(input.email)}: ${(error as Error).message}`,
      );
    }
  }

}

// ═══════════════════════════════════════════════════ دوالّ حرة

/**
 * ستة أرقام من مولّدٍ عشوائي تشفيري (`randomInt`) لا من `Math.random`: الرمز سرٌّ قصير،
 * وحيّزٌ لا يقبل تخميناً.
 */
function randomCode(): string {
  let code = '';
  for (let index = 0; index < SIGNUP_CODE_LENGTH; index += 1) code += String(randomInt(0, 10));
  return code;
}

/**
 * طابع زمني **مضمون** كـ`Date`: نتائج `tx.execute` الخام تُعيد أعمدة `timestamptz` نصّاً
 * بصيغة PostgreSQL (`YYYY-MM-DD HH:mm:ss.ffffff+00`)، لا كائنَ `Date`. و`new Date` في V8
 * تتساهل مع هذه الصيغة، لكن التساهل ليس عقداً — فتُحوَّل الصيغة صراحةً.
 */
function toInstant(value: Date | string): Date {
  if (value instanceof Date) return value;
  const normalized = value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date(value) : parsed;
}

/** sha256 سداسي عشري — ما يُخزَّن في القاعدة لِما يُرسل بالبريد. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
