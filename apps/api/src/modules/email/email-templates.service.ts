import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DomainError,
  emailAuditActions,
  emailEventDefinition,
  emailEvents,
  emailTemplateSeed,
  emailTemplateSeeds,
  emailVariablesIn,
  errorCodes,
  type EmailEvent,
  type EmailLocale,
  type EmailTemplate,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { AuditService } from '../platform-services/audit/audit.service.js';

import { platformActorLabel } from './actor-label.js';

/**
 * P-C6 — القوالب: القالب العامّ الذي تحرّره المنصة، وتجاوز العميل الذي يكتب نصّه.
 *
 * ثلاث قواعد:
 *
 * 1. **الفهرس في الكود، والنصّ في الجدول.** `emailEventRegistry` هو ما يعرف الأحداث
 *    ومتغيّراتها؛ والجدول يحمل النصّ القابل للتحرير. ولذلك كل كتابة تُفحص على الفهرس:
 *    `{{متغيّر}}` لا يعرفه الحدث يُرفض عند الحفظ لا عند الإرسال.
 * 2. **التجاوز نصٌّ لا منشور.** `POST/PUT` من العميل يكتبان `subject`/`body` فقط — لا حدثاً
 *    ولا لغةً ولا حالة إرسال. هذا نصّ الخطة حرفياً: «تجاوز لكل مستأجر (نصّه فقط، لا كود)».
 * 3. **قراءة القالب العامّ من سطح العميل تعبر إلى الطائرة الإدارية** — قراءةً لا غير — لأن
 *    صفوف `tenant_id IS NULL` يخفيها RLS عن جلسة المستأجر (نفس حالة حدود P-C5). البديل كان
 *    تكرار نصوص المنصة في كل منشأة، وهو ما يجعل تصحيح خطأ مطبعيّ ملفّاً لا كتابة.
 *
 * و**البذور في الكود لا في الترحيل**: القالب نصٌّ يتطوّر مع الفهرس، وملف ترحيلٍ يحمل نصّاً
 * يتقادم أول تعديل. تُزرع عند إقلاع الوحدة (`INSERT … ON CONFLICT DO NOTHING`) ويُرجَع إليها
 * احتياطاً إن غاب الصفّ، فلا تُرسل رسالةٌ بلا نصّ أبداً.
 */
@Injectable()
export class EmailTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(EmailTemplatesService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // لا يُسقط الإقلاع إن فشلت البذور (قاعدةٌ لم تُرحَّل بعد، أو تراجع): القالب يُقرأ من
    // الكود عند الحاجة، فالبذرة راحةٌ للمشغّل لا شرطٌ للإرسال.
    try {
      await this.seedDefaults();
    } catch (error) {
      this.logger.warn(`email template seeding skipped: ${(error as Error).message}`);
    }
  }

  /** صفٌّ عامّ لكل (حدث، لغة) — idempotent: لا يلمس نصّاً حرّره المشغّل. */
  async seedDefaults(): Promise<number> {
    let inserted = 0;
    await withPlatformAdminTx(this.database.db, async (tx) => {
      for (const seed of emailTemplateSeeds) {
        const result = await tx.execute(sql`
          INSERT INTO email_templates (id, tenant_id, event, locale, subject, body, version, is_active)
          VALUES (${newId()}, NULL, ${seed.event}, ${seed.locale}, ${seed.subject}, ${seed.body}, 1, true)
          ON CONFLICT DO NOTHING
        `);
        inserted += result.rowCount ?? 0;
      }
    });
    if (inserted > 0) this.logger.log({ inserted }, 'seeded platform e-mail templates');
    return inserted;
  }

  /**
   * القوالب الفعّالة: تجاوز العميل إن وُجد، وإلّا نصّ المنصة، وإلّا بذرة الكود — لكل
   * (حدث، لغة). و`source` تقول من أين جاء النصّ فعلاً، فلا يُخمَّن في الشاشة.
   */
  async effective(
    tenantId: string | null,
    filter: { event?: EmailEvent; locale?: EmailLocale } = {},
  ): Promise<EmailTemplate[]> {
    const events = filter.event ? [filter.event] : emailEventKeys();
    const locales: EmailLocale[] = filter.locale ? [filter.locale] : ['ar', 'en'];

    const rows = await withPlatformAdminTx(this.database.db, async (tx) => {
      const platformRows = await tx.execute(sql`
        SELECT id, tenant_id, event, locale, subject, body, version, updated_at, updated_by
          FROM email_templates WHERE tenant_id IS NULL
      `);
      const tenantRows = tenantId
        ? await tx.execute(sql`
            SELECT id, tenant_id, event, locale, subject, body, version, updated_at, updated_by
              FROM email_templates WHERE tenant_id = ${tenantId}
          `)
        : { rows: [] as Record<string, unknown>[] };
      return { platformRows: platformRows.rows, tenantRows: tenantRows.rows };
    });

    const out: EmailTemplate[] = [];
    for (const event of events) {
      for (const locale of locales) {
        const override = rows.tenantRows.find(
          (row) => String(row.event) === event && String(row.locale) === locale,
        );
        const platform = rows.platformRows.find(
          (row) => String(row.event) === event && String(row.locale) === locale,
        );
        const seed = emailTemplateSeed(event, locale);
        const row = override ?? platform;
        const subject = row ? String(row.subject) : (seed?.subject ?? '');
        const body = row ? String(row.body) : (seed?.body ?? '');
        out.push(
          this.toDto({
            id: row ? String(row.id) : null,
            tenantId: override ? tenantId : null,
            event,
            locale,
            subject,
            body,
            version: row ? Number(row.version) : 0,
            source: override ? 'tenant' : platform ? 'platform' : 'seed',
            updatedAt: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
            updatedBy: row?.updated_by ? String(row.updated_by) : null,
          }),
        );
      }
    }
    return out;
  }

  /** النصّ الذي سيُرسَل فعلاً — يُنادى لحظة الإرسال، لا عند الحفظ. */
  async resolve(
    tenantId: string | null,
    event: EmailEvent,
    locale: EmailLocale,
  ): Promise<{
    templateId: string | null;
    subject: string;
    body: string;
    source: 'seed' | 'platform' | 'tenant';
  }> {
    const [template] = await this.effective(tenantId, { event, locale });
    if (!template) {
      throw new DomainError(errorCodes.NOT_FOUND, `لا قالب للحدث ${event} باللغة ${locale}`, 404);
    }
    return {
      templateId: template.id,
      subject: template.subject,
      body: template.body,
      source: template.source,
    };
  }

  /** `POST /platform/email/templates` — إنشاءٌ لا تعديل: الموجود يُرفض بـ422. */
  async create(input: {
    event: EmailEvent;
    locale: EmailLocale;
    subject: string;
    body: string;
    tenantId?: string | null;
    reason: string;
  }): Promise<EmailTemplate> {
    this.assertTextUsesKnownVariables(input.event, input.subject, input.body);
    const tenantId = input.tenantId ?? null;
    const id = newId();

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = await tx.execute(sql`
        SELECT id FROM email_templates
         WHERE event = ${input.event} AND locale = ${input.locale}
           AND ${tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}`}
         LIMIT 1
      `);
      if (existing.rows.length > 0) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'القالب موجود — استعمل PUT لتعديله', 422, {
          event: input.event,
          locale: input.locale,
          tenantId,
        });
      }

      await tx.execute(sql`
        INSERT INTO email_templates (id, tenant_id, event, locale, subject, body, version, is_active, updated_by)
        VALUES (${id}, ${tenantId}, ${input.event}, ${input.locale}, ${input.subject}, ${input.body}, 1, true, ${getAuthContext().userId})
      `);

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: getAuthContext().userId,
        actorLabel: await platformActorLabel(tx, getAuthContext().userId),
        action: emailAuditActions.templateUpdate,
        entity: 'email_template',
        entityId: id,
        after: { event: input.event, locale: input.locale, subject: input.subject, tenantId },
        meta: { scope: tenantId ? 'platform_console_tenant' : 'platform_console', reason: input.reason },
      });
    });

    // القراءة **بعد** الالتزام: `effective` يفتح معاملةً أخرى على اتصالٍ آخر، فلو قُرئ داخل
    // معاملة الإنشاء لرأى الحالة السابقة (READ COMMITTED) — وهذا خطأ وقع وأثبته الاختبار.
    const [created] = await this.effective(tenantId, { event: input.event, locale: input.locale });
    if (!created) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة القالب بعد إنشائه', 500);
    return created;
  }

  /** تعديل نصّ — من اللوحة (صفٌّ عامّ أو تجاوز عميل) أو من العميل (صفّه هو فقط). */
  async update(
    id: string,
    input: { subject: string; body: string; reason?: string },
    options: { tenantId: string | null },
  ): Promise<EmailTemplate> {
    const scopeTenant = options.tenantId;

    const target = await withPlatformAdminTx(this.database.db, async (tx) => {
      const found = await tx.execute(sql`
        SELECT id, tenant_id, event, locale, subject, body, version
          FROM email_templates WHERE id = ${id} LIMIT 1
      `);
      const row = found.rows[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'القالب غير موجود', 404);
      const rowTenant = row.tenant_id === null ? null : String(row.tenant_id);
      // العميل لا يعدّل قالب المنصة ولا قالب عميلٍ آخر — والفحص هنا لا في المتحكّم، لأن
      // الخدمة تُنادى من مسارين (لوحة/سطح عميل) وواحدٌ منهما فقط مقيَّد بالرمز.
      if (scopeTenant !== null && rowTenant !== scopeTenant) {
        throw new DomainError(errorCodes.NOT_FOUND, 'القالب غير موجود', 404);
      }
      this.assertTextUsesKnownVariables(String(row.event) as EmailEvent, input.subject, input.body);

      await tx.execute(sql`
        UPDATE email_templates
           SET subject = ${input.subject},
               body = ${input.body},
               version = version + 1,
               updated_at = now(),
               updated_by = ${getAuthContext().userId}
         WHERE id = ${id}
      `);

      await this.audit.recordInTx(tx, {
        tenantId: rowTenant,
        actorUserId: getAuthContext().userId,
        actorLabel: await platformActorLabel(tx, getAuthContext().userId),
        action: emailAuditActions.templateUpdate,
        entity: 'email_template',
        entityId: id,
        before: { subject: String(row.subject), body: String(row.body), version: Number(row.version) },
        after: { subject: input.subject, body: input.body, version: Number(row.version) + 1 },
        meta: {
          scope: scopeTenant === null ? 'platform_console' : 'tenant',
          reason: input.reason ?? null,
        },
      });

      return {
        event: String(row.event) as EmailEvent,
        locale: String(row.locale) as EmailLocale,
        tenantId: rowTenant,
      };
    });

    // القراءة بعد الالتزام (انظر التعليق في `create`).
    const [updated] = await this.effective(target.tenantId, {
      event: target.event,
      locale: target.locale,
    });
    if (!updated) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة القالب بعد تعديله', 500);
    return updated;
  }

  /**
   * تجاوز العميل: upsert على صفّه هو.
   *
   * **`null` يعني «أعِد نصّ المنصة لذلك الحقل»** — لا «اتركه كما هو». والفرق يظهر في
   * الحالة التي يكون فيها العميل قد كتب تجاوزاً ثم أراد التراجع عن موضوعه وحده: لو قرأنا
   * `null` كـ«لا تغيير» لعاد النصّ إلى تجاوز العميل نفسه، وهو ما لا يقصده أحد. وحين يعود
   * الحقلان معاً إلى نصّ المنصة يُحذف الصفّ كله (`source` تصير `platform`) لأن صفّاً بنصّ
   * المنصة ليس تجاوزاً، بل نسخةً تُصان بلا سبب.
   */
  async upsertTenantOverride(
    tenantId: string,
    event: EmailEvent,
    locale: EmailLocale,
    input: { subject?: string | null; body?: string | null; reason?: string },
  ): Promise<EmailTemplate> {
    const [platformTemplate] = await this.effective(null, { event, locale });
    const [current] = await this.effective(tenantId, { event, locale });
    if (!platformTemplate || !current) {
      throw new DomainError(errorCodes.NOT_FOUND, 'لا قالب لهذا الحدث', 404, { event, locale });
    }

    // P-C7: نصّ المنصة ليس نصّ العميل. أحداث `platform` (دعوة، إعلان، تفعيل) يكتبها
    // المشغّل وحده — ولو جاز للعميل تجاوزها لأمكن لعميلٍ أن يعيد صياغة إعلان المنصة إليه.
    if (emailEventDefinition(event).scope !== 'tenant') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'نصّ هذا الحدث نصّ المنصة — لا يُتجاوز من سطح العميل',
        422,
        { event },
      );
    }

    const subject = input.subject === null ? platformTemplate.subject : (input.subject ?? current.subject);
    const body = input.body === null ? platformTemplate.body : (input.body ?? current.body);
    this.assertTextUsesKnownVariables(event, subject, body);

    const reverted = subject === platformTemplate.subject && body === platformTemplate.body;
    const actorUserId = getAuthContext().userId;

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = (
        await tx.execute(sql`
          SELECT id, subject, body FROM email_templates
           WHERE tenant_id = ${tenantId} AND event = ${event} AND locale = ${locale} LIMIT 1
        `)
      ).rows[0];

      if (existing && reverted) {
        await tx.execute(sql`DELETE FROM email_templates WHERE id = ${String(existing.id)}`);
        await this.audit.recordInTx(tx, {
          tenantId,
          actorUserId,
          actorLabel: await platformActorLabel(tx, actorUserId),
          action: emailAuditActions.templateReset,
          entity: 'email_template',
          entityId: String(existing.id),
          before: { subject: String(existing.subject), body: String(existing.body) },
          after: { revertedTo: 'platform', event, locale },
          meta: { scope: 'tenant', reason: input.reason ?? null },
        });
        return;
      }
      if (reverted) return; // لا صفّ ولا تجاوز: لا شيء يُفعل، والنتيجة نصّ المنصة.

      if (existing) {
        await tx.execute(sql`
          UPDATE email_templates
             SET subject = ${subject}, body = ${body}, version = version + 1,
                 updated_at = now(), updated_by = ${actorUserId}
           WHERE id = ${String(existing.id)}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO email_templates
            (id, tenant_id, event, locale, subject, body, version, is_active, updated_by)
          VALUES (${newId()}, ${tenantId}, ${event}, ${locale}, ${subject}, ${body}, 1, true, ${actorUserId})
        `);
      }

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: emailAuditActions.tenantTemplateUpdate,
        entity: 'email_template',
        entityId: existing ? String(existing.id) : null,
        before: existing ? { subject: String(existing.subject), body: String(existing.body) } : null,
        after: { event, locale, subject, body, platformSubject: platformTemplate.subject },
        meta: { scope: 'tenant', reason: input.reason ?? null },
      });
    });

    const [updated] = await this.effective(tenantId, { event, locale });
    if (!updated) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة القالب', 500);
    return updated;
  }

  /**
   * حذف تجاوز عميلٍ من اللوحة (يعود نصّ المنصة) — وصفّ المنصة **لا يُحذف**: حذفه يترك
   * الحدث بلا نصّ، والبذرة في الكود تُنقذه لكن شاشة المشغّل كانت ستقول «حُذف» عن شيءٍ
   * ما زال يُرسَل. فالحذف هنا مقيَّد بصفوف التجاوز وحدها.
   */
  async clearOverride(id: string): Promise<EmailTemplate> {
    const tenantId = await withPlatformAdminTx(this.database.db, async (tx) => {
      const row = (
        await tx.execute(sql`
          SELECT id, tenant_id, event, locale, subject, body FROM email_templates WHERE id = ${id} LIMIT 1
        `)
      ).rows[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'القالب غير موجود', 404);
      if (row.tenant_id === null) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'قالب المنصة لا يُحذف — حرّره أو أعِد نصّه',
          422,
          { templateId: id },
        );
      }
      const actorUserId = getAuthContext().userId;
      await tx.execute(sql`DELETE FROM email_templates WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        tenantId: String(row.tenant_id),
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: emailAuditActions.templateReset,
        entity: 'email_template',
        entityId: id,
        before: { subject: String(row.subject), body: String(row.body) },
        after: { revertedTo: 'platform', event: String(row.event), locale: String(row.locale) },
        meta: { scope: 'platform_console' },
      });
      return {
        tenantId: String(row.tenant_id),
        event: String(row.event) as EmailEvent,
        locale: String(row.locale) as EmailLocale,
      };
    });

    const [reverted] = await this.effective(tenantId.tenantId, {
      event: tenantId.event,
      locale: tenantId.locale,
    });
    if (!reverted) throw new DomainError(errorCodes.INTERNAL, 'تعذّر قراءة القالب', 500);
    return reverted;
  }

  // ══════════════════════════════════════════════════ داخلي

  private toDto(input: {
    id: string | null;
    tenantId: string | null;
    event: EmailEvent;
    locale: EmailLocale;
    subject: string;
    body: string;
    version: number;
    source: 'seed' | 'platform' | 'tenant';
    updatedAt: string | null;
    updatedBy: string | null;
  }): EmailTemplate {
    const definition = emailEventDefinition(input.event);
    const used = emailVariablesIn(input.subject, input.body);
    return {
      id: input.id,
      tenantId: input.tenantId,
      event: input.event,
      labelAr: definition.labelAr,
      locale: input.locale,
      subject: input.subject,
      body: input.body,
      version: input.version,
      source: input.source,
      variables: [...definition.variables],
      // متغيّراتٌ معلنة لا يستعملها النصّ: الشاشة تحذّر بها، والإرسال يفشل إن نقص فعلٌا.
      missingVariables: definition.variables.filter((name) => !used.includes(name)),
      updatedAt: input.updatedAt,
      updatedBy: input.updatedBy,
    };
  }

  /** متغيّرٌ في النصّ لا يعرفه الحدث يُرفض **قبل الحفظ**: خطأ المطبعيّ لا يُنتظر به إرسال. */
  private assertTextUsesKnownVariables(event: EmailEvent, subject: string, body: string): void {
    const allowed = new Set(emailEventDefinition(event).variables);
    const unknown = emailVariablesIn(subject, body).filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `متغيّرات لا يعرفها الحدث ${event}: ${unknown.map((name) => `{{${name}}}`).join(' · ')}`,
        400,
        { event, unknown },
      );
    }
  }

  /**
   * فحص النصّ قبل الكتابة يقع **داخل المعاملة** بعد قراءة الصفّ: `PUT /…/:id` لا يعرف
   * الحدث من الجسم (الجسم نصّان فقط)، والحدث يُقرأ من الصفّ. ولكل حدثٍ متغيّراته، فخطأ
   * المطبعيّ (`{{amoutn}}`) يُرفض عندما يُعرف الحدث — لا قبل ذلك.
   */
}

/** مفاتيح الأحداث من الفهرس وحده: جدول القوالب قد ينقصه صفّ، والفهرس لا ينقصه حدث. */
function emailEventKeys(): EmailEvent[] {
  return emailEvents.filter((event, index, all) => all.indexOf(event) === index);
}
