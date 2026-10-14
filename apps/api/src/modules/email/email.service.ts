import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  buildMeta,
  DomainError,
  emailAuditActions,
  emailEventDefinition,
  errorCodes,
  renderEmailTemplate,
  type EmailEvent,
  type EmailLocale,
  type EmailMessage,
  type EmailMessageListQuery,
  type EmailMessageListResponse,
  jobTypes,
  type EmailSendInput,
  type EmailSuppression,
  type EmailSuppressionReason,
  type EmailTestResult,
} from '@erp/contracts';
import {
  newId,
  withPlatformAdminTx,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { OutboxService } from '../platform-services/jobs/outbox.service.js';
import { QUEUE_PORT, type QueuePort } from '../platform-services/jobs/queue.service.js';
import { UsageService } from '../usage/usage.service.js';

import { platformActorLabel } from './actor-label.js';
import { EMAIL_MAILER_FACTORY, type EmailMailerFactory } from './email-mailer.factory.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * P-C6 — مُرسِل البريد: القالب، ثم الحجر، ثم الحصّتان، ثم الطابور، ثم التسليم.
 *
 * الترتيب مقصود، وكل خطوة تُسقِط ما بعدها:
 *
 *   1. **القالب يُصيَّر أولاً** — متغيّرٌ ناقص يفشل هنا (400 بخطوة `missing`) قبل أن يُكتب
 *      صفٌّ في السجلّ، فلا يُترك أثر «رسالةٍ لم تُقصد».
 *   2. **الحجر يمنع قبل الطابور** (نصّ الخطة §7.5): العنوان المحجوب لا ينتهي في الطابور أصلاً،
 *      ويُسجَّل صفٌّ بحالة `suppressed` لأن الصمت غير مقبول — الشاشة تقول «محجوب» لا «مُرسَل».
 *   3. **حصّتان لا واحدة.** حصّة P-C5 المطبَّقة (`limits.max_emails_per_month` عبر
 *      `usage_counters`) ترفض بـ409 وتُسجَّل في تدقيق العميل؛ وسقفا `email_settings`
 *      (يومي/شهري) يرفضان بـ429 ويحميان مزوّد البريد من إغراقنا. والاختبارات (`isTest`) لا
 *      تُحتسب على العميل: رسالة اختبارٍ من اللوحة ليست استهلاكاً.
 *   4. **التسليم ثم الطابور**: كل إرسال = مهمّة `outbox_jobs` من النوع `email.send` في **نفس
 *      معاملة** صفّ الرسالة، فلا توجد رسالةٌ بلا مهمّة ولا مهمّةٌ بلا رسالة. والمحاولة الأولى
 *      تقع في المسار نفسه بعد الالتزام (`inline`) — إلا إن كانت الرسالة **مؤجَّلة** (`sendAt`
 *      في المستقبل) فتبقى `queue` حتى يحين وقتها. لماذا لا ننتظر العامل؟ لأن انتظاره يعني
 *      رسالةً لا تخرج في تثبيتٍ بلا Redis أو بلا عامل (`WORKER=0`)، والطابور هنا **شبكة أمان**
 *      لا شرط خروج: المهمّة تبقى شاهدةً، والمحاولة الثانية والتراجع يُجدَّلان عليها، والتسليم
 *      idempotent فلا تُرسل رسالةٌ مرتين إن عمل العامل بعد ذلك.
 *
 * **سلّم التراجع 1د · 5د · 30د** يُكتب في `next_attempt_at`، ويُعاد جدولة مهمّةٍ جديدة بوقتها.
 * وفي بيئةٍ بلا طابور تبقى الرسالة `queued` بـ`next_attempt_at` مستقبليّ — يظهر في السجلّ،
 * ويعيد المشغّل المحاولة يدوياً فوراً إن أراد.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /** سلّم التراجع بالدقائق — الأرقام نفسها المنصوصة في §7.2 من الخطة. */
  private static readonly RETRY_LADDER_MINUTES = [1, 5, 30] as const;

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(EMAIL_MAILER_FACTORY) private readonly mailerFactory: EmailMailerFactory,
    private readonly templates: EmailTemplatesService,
    private readonly settings: EmailSettingsService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
  ) {}

  // ══════════════════════════════════════════════════ الإرسال

  /**
   * إرسال بريدٍ من حدث: يُصيَّر نصّه الفعّال ثم يُتبع مسار الحجر/الحصّة/الطابور.
   * تُنادى من معالج الطابور ومن أي وحدةٍ أخرى تحتاج بريداً (دعوة · فاتورة · تنبيه).
   */
  async send(
    input: EmailSendInput & {
      tenantId: string | null;
      isTest?: boolean;
      /**
       * P-M7 — نسخة HTML وترويسات امتثال. لا تُقبل من مسارٍ عامّ (المخطّط العلني
       * `emailSendInputSchema` لم يتغيّر): من يحتاجهما هو مُرسِل داخليّ يعرف ما يفعل —
       * اليوم حملةٌ تحتاج بكسلَ فتحٍ و`List-Unsubscribe`.
       */
      html?: string;
      headers?: Record<string, string>;
    },
  ): Promise<EmailMessage> {
    const definition = emailEventDefinition(input.event);
    const locale: EmailLocale = input.locale ?? 'ar';
    const variables = { ...(input.variables ?? {}) };
    if (input.toName && variables.name === undefined) variables.name = input.toName;

    const template = await this.templates.resolve(input.tenantId, input.event, locale);
    const subject = renderEmailTemplate(template.subject, variables, input.event);
    const body = renderEmailTemplate(template.body, variables, input.event);

    const isTest = input.isTest ?? false;
    return this.queueMessage({
      tenantId: input.tenantId,
      event: input.event,
      locale,
      to: input.to,
      toName: input.toName ?? null,
      subject,
      body,
      templateId: template.templateId,
      templateSource: template.source,
      html: input.html ?? null,
      headers: input.headers ?? null,
      isTest,
      // يُحتسب على حصّة العميل إلا إن كان اختباراً أو حدثاً منصّياً (بلا عميل أصلاً).
      charged: definition.scope === 'tenant' && !isTest && input.tenantId !== null,
      ...(input.sendAt ? { sendAt: new Date(input.sendAt) } : {}),
    });
  }

  /**
   * التسليم الفعلي — يُنادى من الطابور (`deliverFromJob`) أو مباشرةً حين لا طابور.
   * **idempotent**: رسالةٌ ليست `queued` تُعاد كما هي، فوصول المهمّة مرتين لا يُرسل مرتين.
   */
  async deliver(messageId: string, mode: 'queue' | 'inline'): Promise<EmailMessage> {
    const row = await this.loadMessage(messageId);
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الرسالة غير موجودة', 404);
    if (row.status !== 'queued') return row;

    const settings = await this.settings.effective(row.tenantId);
    const credentials = await this.settings.credentialsFor(row.tenantId);
    const mailer = this.mailerFactory(settings.provider, credentials);
    const attempt = row.attempts + 1;

    try {
      await mailer.send({
        to: row.toEmail,
        subject: row.subject,
        text: row.body,
        tenantId: row.tenantId,
        from: settings.fromEmail,
        fromName: settings.fromName,
        replyTo: settings.replyTo,
        // P-M7: نسخة HTML وترويسات الامتثال تُسلَّم كما خُزِّنت مع الرسالة.
        ...(row.html ? { html: row.html } : {}),
        ...(row.headers ? { headers: row.headers } : {}),
      });
      const updated = await this.markSent(row, settings.provider, mode, attempt);
      if (row.charged && row.tenantId) {
        // حصّة P-C5 تُحتسب عند **النجاح** لا عند الإنشاء: رسالةٌ فشلت لم تُستهلك من العميل.
        await this.usage.record(row.tenantId, 'email_sends_per_month').catch((error: unknown) => {
          this.logger.warn(`usage counter failed for ${row.tenantId}: ${(error as Error).message}`);
        });
      }
      return updated;
    } catch (error) {
      return this.markFailed(row, attempt, error instanceof Error ? error.message : String(error));
    }
  }

  /** معالج الطابور: مهمّة `email.send` تحمل معرّف الرسالة وحده. */
  async deliverFromJob(context: { payload: Record<string, unknown> }): Promise<void> {
    const messageId = context.payload.messageId;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      this.logger.warn('email.send job without a messageId');
      return;
    }
    await this.deliver(messageId, 'queue');
  }

  /** `POST /platform/email/messages/:id/retry` — إعادة محاولة يدوية فورية مع سبب. */
  async retry(messageId: string, reason: string): Promise<EmailMessage> {
    const row = await this.loadMessage(messageId);
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الرسالة غير موجودة', 404);
    if (row.status === 'sent') {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'الرسالة أُرسلت فعلاً — لا تُعاد', 422, {
        status: row.status,
      });
    }
    if (row.status === 'suppressed') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'العنوان في قائمة الحجر — ارفع الحجر ثم أعد المحاولة',
        422,
        { status: row.status },
      );
    }

    // إعادة الجدولة: صفٌّ يعود إلى `queued` ومهمّةٌ جديدة بوقتها، فالمحاولة اليدوية تسلك
    // مسار المحاولة التلقائية تماماً — لا مسار خاصّ يسهل نسيانه.
    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        UPDATE email_messages
           SET status = 'queued', next_attempt_at = now(), updated_at = now()
         WHERE id = ${messageId}
      `);
      const jobId = await this.outbox.enqueueInTx(tx, {
        tenantId: row.tenantId ?? (await this.platformTenantIdInTx(tx)),
        queue: 'notifications',
        type: jobTypes.EMAIL_SEND,
        payload: { messageId },
      });
      await tx.execute(sql`
        UPDATE email_messages SET outbox_job_id = ${jobId} WHERE id = ${messageId}
      `);
      await this.audit.recordInTx(tx, {
        tenantId: row.tenantId,
        actorUserId: tryGetAuthContext()?.userId ?? null,
        actorLabel: await platformActorLabel(tx, tryGetAuthContext()?.userId ?? null),
        action: emailAuditActions.messageRetry,
        entity: 'email_message',
        entityId: messageId,
        before: { status: row.status, attempts: row.attempts, lastError: row.lastError },
        after: { status: 'queued' },
        meta: { scope: 'platform_console', reason },
      });
    });

    if (!this.queue.isEnabled()) return this.deliver(messageId, 'inline');
    return (await this.loadMessage(messageId)) ?? row;
  }

  // ══════════════════════════════════════════════════ السجلّ

  /** سجلّ الرسائل: المنصة ترى الكلّ (أو عميلاً بعينه)، والعميل يرى رسائله هو. */
  async list(
    query: EmailMessageListQuery,
    scope: { tenantId: string | null },
  ): Promise<EmailMessageListResponse> {
    const read = async (tx: DrizzleTx): Promise<EmailMessageListResponse> => {
      const filters = [sql`true`];
      if (scope.tenantId) filters.push(sql`m.tenant_id = ${scope.tenantId}`);
      else if (query.tenantId) filters.push(sql`m.tenant_id = ${query.tenantId}`);
      if (query.event) filters.push(sql`m.event = ${query.event}`);
      if (query.status) filters.push(sql`m.status = ${query.status}`);
      if (query.search) {
        const pattern = `%${query.search.toLowerCase()}%`;
        filters.push(sql`(lower(m.to_email) LIKE ${pattern} OR lower(m.subject) LIKE ${pattern})`);
      }
      // الرمز `t` مستعارٌ للعملاء في كل الاستعلامات الثلاثة، فلا يُكتب الشرط مرتين.
      const where = sql.join(filters, sql` AND `);

      const rows = await tx.execute(sql`
        SELECT m.id, m.tenant_id, t.code AS tenant_code, m.event, m.locale, m.to_email, m.to_name,
               m.subject, m.status, m.provider, m.delivery_mode, m.attempts, m.last_error,
               m.provider_message_id, m.queued_at, m.sent_at, m.created_at, m.is_test
          FROM email_messages m
          LEFT JOIN tenants t ON t.id = m.tenant_id
         WHERE ${where}
         ORDER BY m.created_at DESC
         LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      const rowCount = await tx.execute(sql`
        SELECT count(*)::int AS n
          FROM email_messages m
          LEFT JOIN tenants t ON t.id = m.tenant_id
         WHERE ${where}
      `);
      const counts = await tx.execute(sql`
        SELECT m.status, count(*)::int AS n
          FROM email_messages m
          LEFT JOIN tenants t ON t.id = m.tenant_id
         WHERE ${where}
         GROUP BY m.status
      `);

      const byStatus: Record<string, number> = {};
      for (const row of counts.rows) byStatus[String(row.status)] = Number(row.n);

      return {
        data: rows.rows.map((row) => this.toDto(row)),
        meta: buildMeta(Number(rowCount.rows[0]?.n ?? 0), query),
        counts: byStatus,
      };
    };

    return scope.tenantId
      ? withTenantTx(this.database.db, scope.tenantId, read)
      : withPlatformAdminTx(this.database.db, read);
  }

  // ══════════════════════════════════════════════════ الحجر

  async suppressions(scope: { tenantId: string | null }): Promise<EmailSuppression[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, tenant_id, email, reason, note, created_by, created_at
          FROM email_suppressions
         WHERE ${scope.tenantId ? sql`tenant_id IS NULL OR tenant_id = ${scope.tenantId}` : sql`true`}
         ORDER BY created_at DESC
         LIMIT 200
      `);
      return rows.rows.map((row) => ({
        id: String(row.id),
        tenantId: row.tenant_id === null ? null : String(row.tenant_id),
        email: String(row.email),
        reason: String(row.reason) as EmailSuppressionReason,
        note: row.note === null ? null : String(row.note),
        createdBy: row.created_by === null ? null : String(row.created_by),
        createdAt: new Date(row.created_at as string).toISOString(),
      }));
    });
  }

  /**
   * إضافة حجر. وحجرُ ارتدادٍ (`bounce`/`complaint`) يُسجَّل أيضاً على آخر رسالةٍ **أُرسلت**
   * لذلك العنوان (`bounced`): الحجر بلا اتهامٍ للسجلّ يترك السؤال معلّقاً «هل وصلت؟»، ولا
   * مزوّد ويب يُخبرنا بعد اليوم (P-C11)، فالتسجيل اليدوي أصدق ما يُتاح الآن.
   */
  async addSuppression(input: {
    email: string;
    reason: EmailSuppressionReason;
    tenantId?: string | null;
    note?: string;
  }): Promise<EmailSuppression> {
    const email = input.email.trim().toLowerCase();
    const tenantId = input.tenantId ?? null;
    const actorUserId = tryGetAuthContext()?.userId ?? null;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const id = newId();
      const existing = (
        await tx.execute(sql`
          SELECT id FROM email_suppressions
           WHERE email = ${email}
             AND ${tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}`}
           LIMIT 1
        `)
      ).rows[0];
      if (existing) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'العنوان محجوب بالفعل بهذا النطاق', 422, {
          email,
          tenantId,
        });
      }

      await tx.execute(sql`
        INSERT INTO email_suppressions (id, tenant_id, email, reason, note, created_by)
        VALUES (${id}, ${tenantId}, ${email}, ${input.reason}, ${input.note ?? null}, ${actorUserId})
      `);

      let bouncedMessageId: string | null = null;
      if (input.reason === 'bounce' || input.reason === 'complaint') {
        const latest = (
          await tx.execute(sql`
            SELECT id FROM email_messages
             WHERE lower(to_email) = ${email} AND status = 'sent'
             ORDER BY sent_at DESC NULLS LAST LIMIT 1
          `)
        ).rows[0];
        if (latest) {
          bouncedMessageId = String(latest.id);
          await tx.execute(sql`
            UPDATE email_messages SET status = 'bounced', updated_at = now()
             WHERE id = ${bouncedMessageId}
          `);
        }
      }

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: emailAuditActions.suppressionAdd,
        entity: 'email_suppression',
        entityId: id,
        after: { email, reason: input.reason, note: input.note ?? null, bouncedMessageId },
        meta: { scope: 'platform_console' },
      });

      return {
        id,
        tenantId,
        email,
        reason: input.reason,
        note: input.note ?? null,
        createdBy: actorUserId,
        createdAt: new Date().toISOString(),
      };
    });
  }

  async removeSuppression(id: string): Promise<void> {
    const actorUserId = tryGetAuthContext()?.userId ?? null;
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const row = (
        await tx.execute(sql`
          SELECT id, tenant_id, email, reason FROM email_suppressions WHERE id = ${id} LIMIT 1
        `)
      ).rows[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الحجر غير موجود', 404);
      await tx.execute(sql`DELETE FROM email_suppressions WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        tenantId: row.tenant_id === null ? null : String(row.tenant_id),
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: emailAuditActions.suppressionRemove,
        entity: 'email_suppression',
        entityId: id,
        before: { email: String(row.email), reason: String(row.reason) },
        after: null,
        meta: { scope: 'platform_console' },
      });
    });
  }

  // ══════════════════════════════════════════════════ الاختبار

  /** اختبار قالبٍ من اللوحة: **نصّ القالب نفسه**، بصفٍّ في السجلّ كي يُشخَّص لا ليُبتلع. */
  async testTemplate(
    templateId: string,
    input: { to: string; locale: EmailLocale; variables: Record<string, string | number> },
  ): Promise<EmailTestResult> {
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const found = await tx.execute(sql`
        SELECT id, tenant_id, event, locale, subject, body FROM email_templates
         WHERE id = ${templateId} LIMIT 1
      `);
      return found.rows[0];
    });
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'القالب غير موجود', 404);

    const event = String(row.event) as EmailEvent;
    const variables = { ...input.variables };
    if (variables.name === undefined) variables.name = 'عميل تجريبي';
    const tenantId = row.tenant_id === null ? null : String(row.tenant_id);

    return this.sendTestMessage({
      tenantId,
      event,
      locale: input.locale,
      to: input.to,
      subject: renderEmailTemplate(String(row.subject), variables, event),
      body: renderEmailTemplate(String(row.body), variables, event),
      templateId: String(row.id),
      templateSource: tenantId ? 'tenant' : 'platform',
    });
  }

  /** اختبار الإعدادات: رسالة واحدة بنصٍّ ثابت — المُختبَر هو المُرسِل لا القالب. */
  async testSettings(input: { to: string; locale: EmailLocale; tenantId?: string | null }): Promise<EmailTestResult> {
    const targetTenantId = input.tenantId ?? null;
    const settings = await this.settings.effective(targetTenantId);
    const subject = targetTenantId
      ? 'اختبار إعدادات البريد من لوحة المنشأة'
      : 'اختبار إعدادات البريد من لوحة المنصة';
    const body = [
      'هذه رسالة اختبار لإعدادات خدمة البريد الإلكتروني.',
      '',
      `المزوّد: ${settings.provider}`,
      `المُرسِل: ${settings.fromName} <${settings.fromEmail}>`,
      `النطاق: ${settings.sendingDomain ?? 'غير محدَّد'}`,
      `الوقت: ${new Date().toISOString()}`,
      '',
      'إن وصلتك هذه الرسالة فإعدادات الإرسال تعمل بنجاح.',
    ].join('\n');

    return this.sendTestMessage({
      tenantId: targetTenantId,
      event: 'announcement',
      locale: input.locale,
      to: input.to,
      subject,
      body,
      templateId: null,
      templateSource: targetTenantId ? 'tenant' : 'platform',
    });
  }

  // ══════════════════════════════════════════════════ داخلي

  /**
   * رسالة اختبار: تحترم الحجر (فيُرى الحاجز كما هو ولا يُوعَد بتسليمٍ لم يحدث) ولا تُحتسب
   * على الحصّة (ليست استهلاك عميل)، وتُوسَم `isTest` في السجلّ والشاشة.
   */
  private async sendTestMessage(input: {
    tenantId: string | null;
    event: EmailEvent;
    locale: EmailLocale;
    to: string;
    subject: string;
    body: string;
    templateId: string | null;
    templateSource: 'seed' | 'platform' | 'tenant';
  }): Promise<EmailTestResult> {
    const suppression = await this.suppressionFor(input.to, input.tenantId);
    const message = await this.insertMessage({
      ...input,
      toName: null,
      isTest: true,
      suppressedReason: suppression?.reason ?? null,
    });

    if (suppression) {
      return {
        messageId: message.id,
        provider: this.asProvider(message.provider),
        to: message.toEmail,
        subject: message.subject,
        deliveredAt: null,
        status: message.status,
        suppressionReason: suppression.reason,
      };
    }

    const delivered = await this.deliver(message.id, 'inline');
    return {
      messageId: delivered.id,
      provider: this.asProvider(delivered.provider),
      to: delivered.toEmail,
      subject: delivered.subject,
      deliveredAt: delivered.sentAt,
      status: delivered.status,
      suppressionReason: null,
    };
  }

  /** القالب → الحجر → الحصّتان → صفّ + مهمّة (+ تسليمٌ فوري إن لم يكن طابور). */
  private async queueMessage(input: {
    tenantId: string | null;
    event: EmailEvent;
    locale: EmailLocale;
    to: string;
    toName: string | null;
    subject: string;
    body: string;
    templateId: string | null;
    templateSource: 'seed' | 'platform' | 'tenant';
    /** P-M7 — نسخة HTML وترويسات امتثال: تُحفظ مع الرسالة وتُسلَّم كما ذهبت. */
    html?: string | null;
    headers?: Record<string, string> | null;
    isTest: boolean;
    charged: boolean;
    sendAt?: Date;
  }): Promise<EmailMessage> {
    const suppression = await this.suppressionFor(input.to, input.tenantId);
    if (!suppression) await this.assertWithinCaps(input.tenantId, input.charged);

    const message = await this.insertMessage({
      ...input,
      suppressedReason: suppression?.reason ?? null,
    });
    if (suppression) return message;
    if (isDeferred(input.sendAt)) return message;
    return this.deliver(message.id, 'inline');
  }

  /**
   * حصّتان لا واحدة:
   *
   *   - `limits.max_emails_per_month` عقدٌ مع العميل: يُرفض بـ`USAGE_LIMIT_REACHED` (409)
   *     ويُسجَّل الرفض في تدقيق العميل (P-C5 هو من يملك هذا القرار).
   *   - `email_settings.daily_limit/monthly_limit` سياسة مُرسِلٍ تحمي مزوّد البريد من
   *     إغراقنا: `RATE_LIMITED` (429) بلا احتساب على العميل.
   *
   * وترتيبهما مقصود: القياس على رسائل **المُرسَل** لا المُنشَأ، فالإعدادات لا تُحاسِب على
   * رسالةٍ لم تخرج بعد.
   */
  private async assertWithinCaps(tenantId: string | null, charged: boolean): Promise<void> {
    if (charged && tenantId) {
      await this.usage.assertWithinLimit(tenantId, 'email_sends_per_month');
    }

    const caps = await this.settings.limitsFor(tenantId);
    if (caps.daily === null && caps.monthly === null) return;

    const counts = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE sent_at >= date_trunc('day', now()))::int   AS today,
          count(*) FILTER (WHERE sent_at >= date_trunc('month', now()))::int AS month
          FROM email_messages
         WHERE status IN ('sent', 'bounced') AND is_test = false
           AND tenant_id IS NOT DISTINCT FROM ${tenantId}
      `);
      return { today: Number(rows.rows[0]?.today ?? 0), month: Number(rows.rows[0]?.month ?? 0) };
    });

    if (caps.daily !== null && counts.today >= caps.daily) {
      throw new DomainError(
        errorCodes.RATE_LIMITED,
        `بلغ المُرسِل سقفه اليومي (${counts.today} من ${caps.daily}) — يُصفَّر السقف مع بداية اليوم`,
        429,
        { scope: 'email_daily', used: counts.today, limit: caps.daily },
      );
    }
    if (caps.monthly !== null && counts.month >= caps.monthly) {
      throw new DomainError(
        errorCodes.RATE_LIMITED,
        `بلغ المُرسِل سقفه الشهري (${counts.month} من ${caps.monthly})`,
        429,
        { scope: 'email_monthly', used: counts.month, limit: caps.monthly },
      );
    }
  }

  /** صفّ الرسالة ومهمّة الطابور في معاملةٍ واحدة — والتسليم بعدها لا داخلها. */
  private async insertMessage(input: {
    tenantId: string | null;
    event: EmailEvent;
    locale: EmailLocale;
    to: string;
    toName: string | null;
    subject: string;
    body: string;
    templateId: string | null;
    templateSource: 'seed' | 'platform' | 'tenant';
    html?: string | null;
    headers?: Record<string, string> | null;
    isTest: boolean;
    sendAt?: Date;
    suppressedReason: EmailSuppressionReason | null;
  }): Promise<EmailMessage> {
    const id = newId();
    const status = input.suppressedReason ? 'suppressed' : 'queued';
    const settings = await this.settings.effective(input.tenantId);
    const actorUserId = tryGetAuthContext()?.userId ?? null;

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO email_messages (
          id, tenant_id, event, locale, template_id, template_source, to_email, to_name,
          subject, body, html, headers, status, provider, delivery_mode, attempts, max_attempts,
          queued_at, is_test
        ) VALUES (
          ${id}, ${input.tenantId}, ${input.event}, ${input.locale}, ${input.templateId},
          ${input.templateSource}, ${input.to.trim().toLowerCase()}, ${input.toName},
          ${input.subject}, ${input.body}, ${input.html ?? null},
          ${input.headers ? JSON.stringify(input.headers) : null}::jsonb, ${status}, ${settings.provider}::text,
          ${isDeferred(input.sendAt) ? 'queue' : 'inline'}, 0, 3, now(), ${input.isTest}
        )
      `);

      if (status === 'suppressed') {
        await this.audit.recordInTx(tx, {
          tenantId: input.tenantId,
          actorUserId,
          actorLabel: await platformActorLabel(tx, actorUserId),
          action: emailAuditActions.messageSuppressed,
          entity: 'email_message',
          entityId: id,
          after: { to: input.to, event: input.event, reason: input.suppressedReason },
          meta: { scope: 'email_service' },
        });
        return;
      }

      const jobId = await this.outbox.enqueueInTx(tx, {
        tenantId: input.tenantId ?? (await this.platformTenantIdInTx(tx)),
        queue: 'notifications',
        type: jobTypes.EMAIL_SEND,
        payload: { messageId: id },
        ...(input.sendAt ? { runAt: input.sendAt } : {}),
      });
      await tx.execute(sql`UPDATE email_messages SET outbox_job_id = ${jobId} WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        tenantId: input.tenantId,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: emailAuditActions.messageQueued,
        entity: 'email_message',
        entityId: id,
        after: {
          to: input.to,
          event: input.event,
          locale: input.locale,
          isTest: input.isTest,
          outboxJobId: jobId,
        },
        meta: { scope: 'email_service' },
      });
    });

    const message = await this.loadMessage(id);
    if (!message) throw new DomainError(errorCodes.INTERNAL, 'تعذّر إنشاء رسالة البريد', 500);
    return message;
  }

  private async loadMessage(id: string): Promise<EmailMessageDetail | null> {
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT m.id, m.tenant_id, t.code AS tenant_code, m.event, m.locale, m.to_email, m.to_name,
               m.subject, m.body, m.html, m.headers, m.status, m.provider, m.delivery_mode, m.attempts,
               m.max_attempts, m.last_error, m.provider_message_id, m.queued_at, m.sent_at,
               m.next_attempt_at, m.created_at, m.is_test
          FROM email_messages m
          LEFT JOIN tenants t ON t.id = m.tenant_id
         WHERE m.id = ${id} LIMIT 1
      `);
      return rows.rows[0];
    });
    return row ? this.mapDetail(row) : null;
  }

  private async markSent(
    row: EmailMessageDetail,
    provider: string,
    mode: 'queue' | 'inline',
    attempt: number,
  ): Promise<EmailMessage> {
    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        UPDATE email_messages
           SET status = 'sent', sent_at = now(), failed_at = NULL, next_attempt_at = NULL,
               attempts = ${attempt}, provider = ${provider}, delivery_mode = ${mode},
               provider_message_id = ${`${provider}:${row.id}`},
               last_error = NULL, updated_at = now()
         WHERE id = ${row.id}
      `);
      await this.audit.recordInTx(tx, {
        tenantId: row.tenantId,
        actorUserId: null,
        action: emailAuditActions.messageSent,
        entity: 'email_message',
        entityId: row.id,
        after: {
          to: row.toEmail,
          event: row.event,
          provider,
          mode,
          attempt,
          isTest: row.isTest,
        },
        meta: { scope: 'email_service' },
      });
    });
    const message = await this.loadMessage(row.id);
    if (!message) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة الرسالة', 500);
    return message;
  }

  /** فشل محاولة: إمّا جدولة تالية بالسلّم (1د · 5د · 30د) وإمّا فشل نهائيّ بعد السقف. */
  private async markFailed(row: EmailMessageDetail, attempt: number, error: string): Promise<EmailMessage> {
    const ladder = EmailService.RETRY_LADDER_MINUTES;
    const delayMinutes = ladder[Math.min(attempt - 1, ladder.length - 1)] ?? 30;
    const willRetry = attempt < row.maxAttempts;

    await withPlatformAdminTx(this.database.db, async (tx) => {
      if (willRetry) {
        await tx.execute(sql`
          UPDATE email_messages
             SET status = 'queued', attempts = ${attempt}, last_error = ${error},
                 next_attempt_at = now() + ${`${delayMinutes} minutes`}::interval, updated_at = now()
           WHERE id = ${row.id}
        `);
        // مهمّةٌ جديدة بوقت المحاولة القادمة — ولا تُجدَّل في بيئةٍ بلا طابور: الرسالة تبقى
        // `queued` و`next_attempt_at` يُظهر للمشغّل متى كانت المحاولة التالية.
        if (this.queue.isEnabled()) {
          const jobId = await this.outbox.enqueueInTx(tx, {
            tenantId: row.tenantId ?? (await this.platformTenantIdInTx(tx)),
            queue: 'notifications',
            type: jobTypes.EMAIL_SEND,
            payload: { messageId: row.id },
            runAt: new Date(Date.now() + delayMinutes * 60_000),
          });
          await tx.execute(sql`
            UPDATE email_messages SET outbox_job_id = ${jobId} WHERE id = ${row.id}
          `);
        }
      } else {
        await tx.execute(sql`
          UPDATE email_messages
             SET status = 'failed', attempts = ${attempt}, last_error = ${error},
                 failed_at = now(), next_attempt_at = NULL, updated_at = now()
           WHERE id = ${row.id}
        `);
      }

      await this.audit.recordInTx(tx, {
        tenantId: row.tenantId,
        actorUserId: null,
        action: emailAuditActions.messageFailed,
        entity: 'email_message',
        entityId: row.id,
        after: {
          to: row.toEmail,
          event: row.event,
          attempt,
          error,
          willRetry,
          retryInMinutes: willRetry ? delayMinutes : null,
        },
        meta: { scope: 'email_service' },
      });
    });

    const message = await this.loadMessage(row.id);
    if (!message) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة الرسالة', 500);
    return message;
  }

  /** الحجر يسري على النطاقين: العامّ (كل العملاء) والخاصّ بالمستأجر. */
  private async suppressionFor(
    email: string,
    tenantId: string | null,
  ): Promise<{ reason: EmailSuppressionReason } | null> {
    const normalised = email.trim().toLowerCase();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT reason FROM email_suppressions
         WHERE email = ${normalised}
           AND (tenant_id IS NULL ${tenantId ? sql`OR tenant_id = ${tenantId}` : sql``})
         ORDER BY tenant_id NULLS LAST
         LIMIT 1
      `);
      const row = rows.rows[0];
      return row ? { reason: String(row.reason) as EmailSuppressionReason } : null;
    });
  }

  /** معرّف منشأة المشغّلين — مهمّات بريد المنصة تُسجَّل فيها (`outbox_jobs.tenant_id` غير فارغ). */
  private async platformTenantIdInTx(tx: DrizzleTx): Promise<string> {
    const rows = await tx.execute(sql`
      SELECT id FROM tenants WHERE code = ${process.env.PLATFORM_TENANT_CODE ?? 'platform'} LIMIT 1
    `);
    const id = rows.rows[0]?.id;
    if (!id) {
      throw new DomainError(
        errorCodes.NOT_FOUND,
        'لم تُوجد منشأة المشغّلين — راجع PLATFORM_TENANT_CODE',
        500,
      );
    }
    return String(id);
  }

  private asProvider(value: string): 'console' | 'smtp' | 'resend' | 'http' {
    if (value === 'smtp' || value === 'resend' || value === 'http') return value;
    return 'console';
  }

  /** صفٌّ داخليّ: حقول العقد نفسها، مضافاً إليها ما يخصّ المحاولة والحصّة (لا يُصدَّر). */
  private mapDetail(row: Record<string, unknown>): EmailMessageDetail {
    return {
      ...this.toDto(row),
      body: row.body === undefined ? '' : String(row.body),
      html: row.html === null || row.html === undefined ? null : String(row.html),
      headers:
        row.headers === null || row.headers === undefined
          ? null
          : (row.headers as Record<string, string>),
      maxAttempts: Number(row.max_attempts ?? 3),
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string).toISOString() : null,
      // يُحتسب على حصّة العميل فقط إن كان بريد عميلٍ حقيقيّاً (لا اختباراً) وحدثُه حدث عميل.
      charged:
        row.tenant_id !== null &&
        row.tenant_id !== undefined &&
        !row.is_test &&
        emailEventDefinition(String(row.event) as EmailEvent).scope === 'tenant',
    };
  }

  private toDto(row: Record<string, unknown>): EmailMessage {
    const event = String(row.event) as EmailEvent;
    return {
      id: String(row.id),
      tenantId: row.tenant_id === null ? null : String(row.tenant_id),
      tenantCode:
        row.tenant_code === null || row.tenant_code === undefined ? null : String(row.tenant_code),
      event,
      eventLabelAr: emailEventDefinition(event).labelAr,
      locale: String(row.locale) as EmailLocale,
      toEmail: String(row.to_email),
      toName: row.to_name === null || row.to_name === undefined ? null : String(row.to_name),
      subject: String(row.subject),
      status: String(row.status) as EmailMessage['status'],
      provider: String(row.provider),
      deliveryMode: String(row.delivery_mode) as 'queue' | 'inline',
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      providerMessageId:
        row.provider_message_id === null || row.provider_message_id === undefined
          ? null
          : String(row.provider_message_id),
      queuedAt: new Date(row.queued_at as string).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at as string).toISOString() : null,
      createdAt: new Date(row.created_at as string).toISOString(),
      isTest: Boolean(row.is_test),
    };
  }
}

/** رسالةٌ مؤجَّلة: `sendAt` في المستقبل — تُترك للطابور حتى يحين وقتها. */
function isDeferred(sendAt?: Date): boolean {
  return sendAt instanceof Date && sendAt.getTime() > Date.now() + 1_000;
}

/** صفّ الرسالة داخلياً — حقول العقد مضافاً إليها الجسم وما يخصّ المحاولة والحصّة. */
type EmailMessageDetail = EmailMessage & {
  body: string;
  /** P-M7 — نسخة HTML (قد تكون `null`)، وترويسات الامتثال التي خرجت مع الرسالة. */
  html: string | null;
  headers: Record<string, string> | null;
  maxAttempts: number;
  nextAttemptAt: string | null;
  charged: boolean;
};
