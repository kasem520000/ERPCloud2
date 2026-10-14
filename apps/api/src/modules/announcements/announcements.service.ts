import { Inject, Injectable } from '@nestjs/common';
import { env } from '@erp/config';
import { sql } from 'drizzle-orm';
import {
  ANNOUNCEMENT_FILTERS,
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  announcementAuditActions,
  buildMeta,
  DomainError,
  errorCodes,
  parseFilters,
  type Announcement,
  type AnnouncementCreate,
  type AnnouncementListQuery,
  type AnnouncementReadRow,
  type AnnouncementReadsQuery,
  type AnnouncementStats,
  type AnnouncementUpdate,
  jobTypes,
  type ListEnvelope,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';
import { EmailService } from '../email/email.service.js';
import { NotificationsService } from '../platform-services/notifications/notifications.service.js';
import { OutboxService } from '../platform-services/jobs/outbox.service.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { platformActorLabel } from '../email/actor-label.js';

/**
 * P-C7 — الإعلانات: كتابةٌ، واستهدافٌ، ونشرٌ يوزّع على التطبيق والبريد، ثم متابعة قراءة.
 *
 * القرارات التي تحكم هذا الملف:
 *
 *   1. **الجمهور يُحلّ لحظة النشر ويُكتب** في `announcement_reads`. فلا يتغيّر جمهور إعلانٍ
 *      نُشر لأن عميلاً غيّر باقته غداً، والسؤال «مَن استهدفه؟» له جوابٌ محفوظ لا استعلامٌ حيّ.
 *   2. **النشر idempotent**: صفّ التسليم فريد لكل (إعلان · عميل · عضو · قناة) و`ON CONFLICT
 *      DO NOTHING`، فإعادة النداء (بعد انقطاعٍ في المنتصف، أو بخطأ عرض) تُكمل الناقص فقط —
 *      وهذا هو مسار الإصلاح، ولهذا لا يوجد «نشر مرتين» بل نشرٌ ناقص يُكمَل.
 *   3. **البريد إلى مالك المنشأة وحده** (عضويات `is_owner` النشطة): رسالة المنصة إلى موظفي
 *      العميل ليست إعلاناً بل إزعاج. أما الإشعار داخل التطبيق فيذهب إلى **كل عضو نشط**، لأن
 *      الجرس لا يكلف شيئاً ولا يخرج من التطبيق.
 *   4. **بريد الإعلان لا يُحتسب على حصّة العميل**: حدث `announcement` نطاقه `platform`
 *      (انظر `emailEventDefinition`)، والرسالة تُكتب بـ`tenant_id` العميل كي يراها في سجلّه
 *      (شفافية) بلا أن تُخصم من عدّاده — وهذا مصدر الحقيقة الوحيد لحصص البريد (P-C5/P-C6).
 *   5. **لا عامل ⇒ لا جدولة ميّتة**: المجدولة تُنشر عند أول قراءةٍ للقائمة (`list`) — المسح
 *      `publishDue()` — وكذلك يناديها معالج المهمّة إن عمل العامل. فلا يبقى إعلانٌ مجدول
 *      حبيساً في تثبيتٍ بلا Redis (وهو حال هذا المستودع).
 *   6. **المنشور لا يُعدَّل** (422)، والمجدولة والمسودّة تُعدَّلان. تعديل ما قيل ليس تعديلاً بل
 *      رسالةٌ ثانية، والتصحيح يكون بإعلانٍ جديد — هكذا لا يختلف ما قرأه عميلٌ عمّا في السجلّ.
 */

export type AnnouncementRow = {
  id: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  audience: string;
  plan_code: string | null;
  tenant_status: string | null;
  channels: string[];
  status: string;
  publish_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by_label: string | null;
  tenants?: number;
  in_app?: number;
  emails?: number;
  reads?: number;
};

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string).toISOString();

function toAnnouncement(row: AnnouncementRow): Announcement {
  const stats: AnnouncementStats = {
    tenants: Number(row.tenants ?? 0),
    inApp: Number(row.in_app ?? 0),
    emails: Number(row.emails ?? 0),
    reads: Number(row.reads ?? 0),
  };
  return {
    id: String(row.id),
    titleAr: String(row.title_ar),
    titleEn: String(row.title_en),
    bodyAr: String(row.body_ar),
    bodyEn: String(row.body_en),
    audience: String(row.audience) as Announcement['audience'],
    planCode: row.plan_code === null ? null : String(row.plan_code),
    tenantStatus:
      row.tenant_status === null
        ? null
        : (String(row.tenant_status) as NonNullable<Announcement['tenantStatus']>),
    channels: (row.channels ?? []).map((channel) => String(channel)) as Announcement['channels'],
    status: String(row.status) as Announcement['status'],
    publishAt: iso(row.publish_at),
    publishedAt: iso(row.published_at),
    createdByLabel: row.created_by_label === null ? null : String(row.created_by_label),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    stats,
  };
}

/** استعلام المنصة: الصفّ + الإحصاءات المحسوبة من سجلّ التسليم (مصدرٌ واحد). */
const ANNOUNCEMENT_SELECT = sql`
  SELECT a.*,
         (SELECT COUNT(DISTINCT r.tenant_id) FROM announcement_reads r
           WHERE r.announcement_id = a.id)                                   AS tenants,
         (SELECT COUNT(*) FROM announcement_reads r
           WHERE r.announcement_id = a.id AND r.channel = 'in_app')          AS in_app,
         (SELECT COUNT(*) FROM announcement_reads r
           WHERE r.announcement_id = a.id AND r.channel = 'email')           AS emails,
         (SELECT COUNT(*) FROM announcement_reads r
           WHERE r.announcement_id = a.id AND r.read_at IS NOT NULL)         AS reads,
         (SELECT COALESCE(u.full_name, u.email)
            FROM users u WHERE u.id = a.created_by)                          AS created_by_label
    FROM announcements a
`;

@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  // ══════════════════════════════════════════════════ القراءة

  async list(query: AnnouncementListQuery): Promise<ListEnvelope<Announcement>> {
    // مجدولةٌ استحقّت الآن تُنشر قبل القراءة — لا عامل في هذا التثبيت (القرار 5).
    await this.publishDue();

    const filters = parseFilters(query.filter, ANNOUNCEMENT_FILTERS);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const where = [sql`true`];
      if (filters.status) where.push(sql`a.status = ${filters.status}`);
      if (filters.audience) where.push(sql`a.audience = ${filters.audience}`);
      const condition = sql.join(where, sql` AND `);

      const rows = await tx.execute(sql`
        ${ANNOUNCEMENT_SELECT}
        WHERE ${condition}
        ORDER BY a.created_at DESC
        LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      const counted = await tx.execute(sql`
        SELECT COUNT(*)::int AS total FROM announcements a WHERE ${condition}
      `);
      return {
        data: (rows.rows as unknown as AnnouncementRow[]).map(toAnnouncement),
        meta: buildMeta(Number(counted.rows[0]?.total ?? 0), query),
      };
    });
  }

  async get(id: string): Promise<Announcement> {
    return withPlatformAdminTx(this.database.db, async (tx) => this.loadOr404(tx, id));
  }

  /** صفوف المتابعة: عميلٌ لكل سطر — كم إشعاراً وكم بريداً وكم قراءة. */
  async reads(id: string, query: AnnouncementReadsQuery): Promise<ListEnvelope<AnnouncementReadRow>> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      await this.loadOr404(tx, id);
      const rows = await tx.execute(sql`
        SELECT t.id AS tenant_id, t.code AS tenant_code, t.name AS tenant_name,
               COUNT(*) FILTER (WHERE r.channel = 'in_app')          AS in_app,
               COUNT(*) FILTER (WHERE r.channel = 'email')           AS emails,
               COUNT(*) FILTER (WHERE r.read_at IS NOT NULL)         AS reads,
               MAX(r.read_at)                                        AS last_read_at
          FROM announcement_reads r
          JOIN tenants t ON t.id = r.tenant_id
         WHERE r.announcement_id = ${id}
         GROUP BY t.id, t.code, t.name
         ORDER BY t.code
         LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      const counted = await tx.execute(sql`
        SELECT COUNT(DISTINCT r.tenant_id)::int AS total
          FROM announcement_reads r WHERE r.announcement_id = ${id}
      `);
      return {
        data: (rows.rows as Array<Record<string, unknown>>).map((row) => ({
          tenantId: String(row.tenant_id),
          tenantCode: String(row.tenant_code),
          tenantName: String(row.tenant_name),
          inApp: Number(row.in_app ?? 0),
          emails: Number(row.emails ?? 0),
          reads: Number(row.reads ?? 0),
          lastReadAt: iso(row.last_read_at),
        })),
        meta: buildMeta(Number(counted.rows[0]?.total ?? 0), query),
      };
    });
  }

  // ══════════════════════════════════════════════════ الكتابة

  async create(input: AnnouncementCreate): Promise<Announcement> {
    const actorUserId = tryGetAuthContext()?.userId ?? null;
    const publishAt = this.futureOrNull(input.publishAt);
    const status = publishAt ? 'scheduled' : 'draft';

    const id = await withPlatformAdminTx(this.database.db, async (tx) => {
      if (input.audience === 'plan') await this.assertPlanExists(tx, input.planCode as string);
      const announcementId = newId();
      await tx.execute(sql`
        INSERT INTO announcements (id, title_ar, title_en, body_ar, body_en, audience,
                                   plan_code, tenant_status, channels, status, publish_at, created_by)
        VALUES (${announcementId}, ${input.titleAr}, ${input.titleEn}, ${input.bodyAr}, ${input.bodyEn},
                ${input.audience}, ${input.planCode ?? null}, ${input.tenantStatus ?? null},
                ${sql.raw(`ARRAY[${input.channels.map((channel) => `'${channel}'`).join(',')}]::text[]`)},
                ${status}, ${publishAt}, ${actorUserId})
      `);
      if (publishAt) {
        // مهمّةٌ بوقتها: مع عاملٍ يُنشر في وقته، وبلا عاملٍ يكفله مسح `list` (idempotent).
        await this.outbox.enqueueInTx(tx, {
          tenantId: await this.platformTenantIdInTx(tx),
          queue: 'notifications',
          type: jobTypes.ANNOUNCEMENT_PUBLISH,
          payload: { announcementId },
          runAt: publishAt,
        });
      }
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: announcementAuditActions.create,
        entity: 'announcement',
        entityId: announcementId,
        after: {
          titleAr: input.titleAr,
          audience: input.audience,
          planCode: input.planCode ?? null,
          tenantStatus: input.tenantStatus ?? null,
          channels: input.channels,
          status,
        },
        meta: { scope: 'platform_console', reason: input.reason },
      });
      return announcementId;
    });

    return this.get(id);
  }

  async update(id: string, input: AnnouncementUpdate): Promise<Announcement> {
    const actorUserId = tryGetAuthContext()?.userId ?? null;

    await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = await this.loadRowOr404(tx, id);
      if (before.status === 'published') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'الإعلان المنشور لا يُعدَّل — اصنع إعلاناً جديداً',
          422,
          { id, status: before.status },
        );
      }

      const audience = input.audience ?? (before.audience as AnnouncementCreate['audience']);
      const planCode = input.planCode === undefined ? before.plan_code : input.planCode;
      const tenantStatus = input.tenantStatus === undefined ? before.tenant_status : input.tenantStatus;
      this.assertAudienceTarget(audience, planCode, tenantStatus);
      if (audience === 'plan') await this.assertPlanExists(tx, String(planCode));

      const publishAt =
        input.publishAt === undefined ? before.publish_at : this.futureOrNull(input.publishAt);
      const status = publishAt ? 'scheduled' : 'draft';

      await tx.execute(sql`
        UPDATE announcements
           SET title_ar = ${input.titleAr ?? before.title_ar},
               title_en = ${input.titleEn ?? before.title_en},
               body_ar = ${input.bodyAr ?? before.body_ar},
               body_en = ${input.bodyEn ?? before.body_en},
               audience = ${audience},
               plan_code = ${planCode},
               tenant_status = ${tenantStatus},
               channels = ${sql.raw(
                 `ARRAY[${(input.channels ?? before.channels).map((channel) => `'${channel}'`).join(',')}]::text[]`,
               )},
               status = ${status},
               publish_at = ${publishAt},
               updated_at = now()
         WHERE id = ${id}
      `);

      if (publishAt) {
        await this.outbox.enqueueInTx(tx, {
          tenantId: await this.platformTenantIdInTx(tx),
          queue: 'notifications',
          type: jobTypes.ANNOUNCEMENT_PUBLISH,
          payload: { announcementId: id, rescheduled: true },
          runAt: publishAt,
        });
      }
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: announcementAuditActions.update,
        entity: 'announcement',
        entityId: id,
        before: {
          titleAr: before.title_ar,
          audience: before.audience,
          status: before.status,
          publishAt: iso(before.publish_at),
        },
        after: {
          titleAr: input.titleAr ?? before.title_ar,
          audience,
          status,
          publishAt: iso(publishAt),
        },
        meta: { scope: 'platform_console', reason: input.reason },
      });
    });

    return this.get(id);
  }

  /**
   * `POST /platform/announcements/:id/publish` — يُنشر ويُوزَّع.
   * idempotent: إعادة النداء تُكمل الصفوف الناقصة (انظر القرار 2).
   */
  async publish(id: string, reason: string): Promise<Announcement> {
    const actorUserId = tryGetAuthContext()?.userId ?? null;

    const outcome = await withPlatformAdminTx(this.database.db, async (tx) => {
      const before = await this.loadRowOr404(tx, id);
      const replayed = before.status === 'published';
      const audience = before.audience as AnnouncementCreate['audience'];

      // الجمهور يُحلّ **قبل** وسم النشر، لأن الوسم يجعل الحالة `published` فيخرج الصفّ من
      // مرشّح المجدولة — فلا بدّ من قائمةٍ محسوبة بلا اعتماد على الحالة.
      const targets = await this.resolveAudience(tx, audience, before.plan_code, before.tenant_status);

      if (!replayed) {
        await tx.execute(sql`
          UPDATE announcements
             SET status = 'published',
                 published_at = now(),
                 publish_at = COALESCE(publish_at, now()),
                 updated_at = now()
           WHERE id = ${id}
        `);
        await this.audit.recordInTx(tx, {
          tenantId: null,
          actorUserId,
          actorLabel: await platformActorLabel(tx, actorUserId),
          action: announcementAuditActions.publish,
          entity: 'announcement',
          entityId: id,
          before: { status: before.status, publishAt: iso(before.publish_at) },
          after: { status: 'published', tenants: targets.length },
          meta: { scope: 'platform_console', reason, replayed: false },
        });
      } else {
        await this.audit.recordInTx(tx, {
          tenantId: null,
          actorUserId,
          actorLabel: await platformActorLabel(tx, actorUserId),
          action: announcementAuditActions.publish,
          entity: 'announcement',
          entityId: id,
          after: { status: 'published', tenants: targets.length },
          meta: { scope: 'platform_console', reason, replayed: true },
        });
      }

      return { targets, replayed };
    });

    await this.deliver(id, outcome.targets);

    return this.get(id);
  }

  /**
   * نشر ما استحقّ — يُنادى من `list` ومن معالج المهمّة. يعيد عدد ما نُشر.
   * لا يرمي: فشل إعلانٍ واحد لا يُسقط قراءة القائمة (ويُطبع في سجلّ الخدمة).
   */
  async publishDue(now = new Date()): Promise<number> {
    const due = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id FROM announcements
         WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ${now}
         ORDER BY publish_at
         LIMIT 20
      `);
      return (rows.rows as Array<{ id: string }>).map((row) => String(row.id));
    });

    let published = 0;
    for (const id of due) {
      try {
        await this.publish(id, 'نشرٌ مجدول استحقّ وقته');
        published += 1;
      } catch (error) {
        // يُترك مجدولاً كي يُعاد في المسح التالي؛ والسطر في السجلّ يكفي للتشخيص.

        console.warn(
          `[announcements] scheduled publish failed for ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return published;
  }

  /**
   * مدخل معالج المهمّة (`announcement.publish`): ينشر إعلاناً مجدولاً في وقته.
   * الرسالة قد تصل متأخّرة أو مكرّرة — والنشر idempotent فلا يهمّ أيّهما.
   */
  async publishFromJob(context: { payload: Record<string, unknown> }): Promise<void> {
    const announcementId = context.payload.announcementId;
    if (typeof announcementId !== 'string' || announcementId.length === 0) return;
    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const found = await tx.execute(sql`
        SELECT status FROM announcements WHERE id = ${announcementId} LIMIT 1
      `);
      return found.rows[0] as { status?: string } | undefined;
    });
    if (!row) return;
    if (row.status === 'published') return; // سبق نشره: لا عملَ للمهمّة.
    await this.publish(announcementId, 'نشرٌ مجدول استحقّ وقته');
  }

  // ══════════════════════════════════════════════════ التوزيع

  /**
   * توزيع إعلانٍ منشور على قائمة عملائه: إشعارٌ لكل عضو نشط، وبريدٌ لمالك المنشأة.
   * كل عميل في معاملته: نجاحه وقع، وفشله لا يمنع غيره.
   */
  async deliver(
    announcementId: string,
    targets: Array<{ id: string; code: string }>,
  ): Promise<{ inApp: number; emails: number; failed: number }> {
    const full = await this.get(announcementId);
    let inApp = 0;
    let emails = 0;
    let failed = 0;

    for (const tenant of targets) {
      try {
        const result = await withTenantTx(this.database.db, tenant.id, async (tx) => {
          const members = await tx.execute(sql`
            SELECT m.id, COALESCE(u.full_name, u.email) AS name, u.email, m.is_owner
              FROM memberships m
              JOIN users u ON u.id = m.user_id
             WHERE m.tenant_id = ${tenant.id}
               AND m.status = 'active'
               AND m.kind = 'staff'
          `);
          let created = 0;
          for (const raw of members.rows as Array<Record<string, unknown>>) {
            const membershipId = String(raw.id);
            const ledgerId = await this.claim(tx, announcementId, tenant.id, membershipId, 'in_app');
            if (!ledgerId) continue; // سبق توزيعه على هذا العضو — لا تكرار.

            const notification = await this.notifications.createInTx(tx, {
              tenantId: tenant.id,
              membershipId,
              type: ANNOUNCEMENT_NOTIFICATION_TYPE,
              payload: {
                announcementId,
                titleAr: full.titleAr,
                titleEn: full.titleEn,
                bodyAr: full.bodyAr,
                bodyEn: full.bodyEn,
              },
            });
            await tx.execute(sql`
              UPDATE announcement_reads SET notification_id = ${notification.id} WHERE id = ${ledgerId}
            `);
            created += 1;
          }
          return created;
        });
        inApp += result;
      } catch (error) {
        failed += 1;

        console.warn(
          `[announcements] in-app delivery failed for tenant ${tenant.code}:`,
          error instanceof Error ? error.message : error,
        );
      }

      if (!full.channels.includes('email')) continue;

      try {
        const owners = await withTenantTx(this.database.db, tenant.id, async (tx) => {
          const rows = await tx.execute(sql`
            SELECT m.id, u.email, COALESCE(u.full_name, u.email) AS name
              FROM memberships m
              JOIN users u ON u.id = m.user_id
             WHERE m.tenant_id = ${tenant.id}
               AND m.status = 'active'
               AND m.is_owner = true
             ORDER BY m.created_at
          `);
          return rows.rows as Array<Record<string, unknown>>;
        });

        for (const owner of owners) {
          const membershipId = String(owner.id);
          const ledgerId = await withTenantTx(this.database.db, tenant.id, (tx) =>
            this.claim(tx, announcementId, tenant.id, membershipId, 'email'),
          );
          if (!ledgerId) continue;

          const message = await this.email.send({
            tenantId: tenant.id,
            event: 'announcement',
            to: String(owner.email),
            toName: String(owner.name),
            locale: 'ar',
            variables: {
              name: String(owner.name),
              title: full.titleAr,
              body: full.bodyAr,
              link: this.notificationCentreUrl(),
            },
          });
          await withTenantTx(this.database.db, tenant.id, (tx) =>
            tx.execute(sql`
              UPDATE announcement_reads SET email_message_id = ${message.id} WHERE id = ${ledgerId}
            `),
          );
          emails += 1;
        }
      } catch (error) {
        failed += 1;

        console.warn(
          `[announcements] e-mail delivery failed for tenant ${tenant.code}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { inApp, emails, failed };
  }

  /**
   * حجز صفّ التسليم لهذا (إعلان · عميل · عضو · قناة). يعيد المعرّف إن حُجز الآن،
   * و`null` إن كان محجوزاً سابقاً — وهذا هو ما يجعل التوزيع idempotent.
   */
  private async claim(
    tx: DrizzleTx,
    announcementId: string,
    tenantId: string,
    membershipId: string,
    channel: 'in_app' | 'email',
  ): Promise<string | null> {
    const id = newId();
    const inserted = await tx.execute(sql`
      INSERT INTO announcement_reads (id, announcement_id, tenant_id, membership_id, channel)
      VALUES (${id}, ${announcementId}, ${tenantId}, ${membershipId}, ${channel})
      ON CONFLICT (announcement_id, tenant_id, membership_id, channel) DO NOTHING
      RETURNING id
    `);
    return inserted.rows.length > 0 ? id : null;
  }

  /**
   * حلّ الجمهور إلى قائمة عملاء. **يُستثنى عميل المنصة نفسه**: إعلان المنصة ليس إليها.
   */
  private async resolveAudience(
    tx: DrizzleTx,
    audience: AnnouncementCreate['audience'],
    planCode: string | null,
    tenantStatus: string | null,
  ): Promise<Array<{ id: string; code: string }>> {
    const platformTenant = this.platformTenantCode();
    if (audience === 'status') {
      const rows = await tx.execute(sql`
        SELECT id, code FROM tenants
         WHERE status = ${tenantStatus} AND code <> ${platformTenant}
         ORDER BY code
      `);
      return (rows.rows as Array<{ id: string; code: string }>).map((row) => ({
        id: String(row.id),
        code: String(row.code),
      }));
    }

    if (audience === 'plan') {
      const rows = await tx.execute(sql`
        SELECT DISTINCT t.id, t.code
          FROM tenants t
          JOIN tenant_subscriptions s ON s.tenant_id = t.id
          JOIN billing_plans p ON p.id = s.plan_id
         WHERE p.code = ${planCode}
           AND s.status IN ('active', 'trialing', 'past_due')
           AND t.code <> ${platformTenant}
         ORDER BY t.code
      `);
      return (rows.rows as Array<{ id: string; code: string }>).map((row) => ({
        id: String(row.id),
        code: String(row.code),
      }));
    }

    const rows = await tx.execute(sql`
      SELECT id, code FROM tenants
       WHERE status = 'active' AND code <> ${platformTenant}
       ORDER BY code
    `);
    return (rows.rows as Array<{ id: string; code: string }>).map((row) => ({
      id: String(row.id),
      code: String(row.code),
    }));
  }

  // ══════════════════════════════════════════════════ أدوات

  /** مهمّة الـoutbox تحتاج منشأةً تحملها؛ ومهامّ المنصة تُنسب لمنشأة المشغّلين. */
  private async platformTenantIdInTx(tx: DrizzleTx): Promise<string> {
    const rows = await tx.execute(sql`
      SELECT id FROM tenants WHERE code = ${this.platformTenantCode()} LIMIT 1
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

  /**
   * وجهة `{{link}}` في رسالة الإعلان: مركز الإشعارات في تطبيق العميل. العنوان يُقرأ
   * وقت التنفيذ (كالعميل) لأن الاختبارات/alبيئات تضبطه بعد تحميل الإعدادات؛ وبلا عنوانٍ
   * عامّ يبقى المسار النسبي — رابطٌ ناقص النطاق أهون من رابطٍ ميّت أو متغيّرٍ ناقص يمنع الرسالة.
   */
  private notificationCentreUrl(): string {
    const base = (process.env.STAFF_PUBLIC_URL || env.STAFF_PUBLIC_URL || '').replace(/\/+$/, '');
    return `${base}/notifications`;
  }

  /** منشأة المشغّلين — إعلان المنصة لا يُرسل إلى المنصة نفسها. */
  private platformTenantCode(): string {
    return process.env.PLATFORM_TENANT_CODE?.trim() || 'platform';
  }

  private async loadOr404(tx: DrizzleTx, id: string): Promise<Announcement> {
    return toAnnouncement(await this.loadRowOr404(tx, id));
  }

  private async loadRowOr404(tx: DrizzleTx, id: string): Promise<AnnouncementRow> {
    const rows = await tx.execute(sql`${ANNOUNCEMENT_SELECT} WHERE a.id = ${id} LIMIT 1`);
    const row = rows.rows[0] as unknown as AnnouncementRow | undefined;
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الإعلان غير موجود', 404, { id });
    return row;
  }

  private async assertPlanExists(tx: DrizzleTx, planCode: string): Promise<void> {
    const rows = await tx.execute(sql`SELECT 1 FROM billing_plans WHERE code = ${planCode} LIMIT 1`);
    if (rows.rows.length === 0) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'لا باقة بهذا الكود', 422, {
        field: 'planCode',
        planCode,
      });
    }
  }

  /** استهدافٌ متماسك: `plan` مع كود، `status` مع حالة، و`all` بلا شيء. */
  private assertAudienceTarget(
    audience: AnnouncementCreate['audience'],
    planCode: string | null,
    tenantStatus: string | null,
  ): void {
    const ok =
      (audience === 'all' && planCode === null && tenantStatus === null) ||
      (audience === 'plan' && planCode !== null && tenantStatus === null) ||
      (audience === 'status' && planCode === null && tenantStatus !== null);
    if (!ok) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'استهدافٌ غير متماسك', 422, {
        audience,
        planCode,
        tenantStatus,
      });
    }
  }

  /**
   * زمن النشر: غائب ⇒ `null` (مسودّة)، ماضٍ ⇒ 422. «انشر الآن» فعلٌ صريح
   * (`POST …/publish`) — فلا يتحوّل خطأُ تاريخٍ إلى بريدٍ لعملاء لم يُقصد إزعاجهم.
   */
  private futureOrNull(publishAt: string | null | undefined): Date | null {
    if (publishAt === null || publishAt === undefined) return null;
    const when = new Date(publishAt);
    if (when.getTime() <= Date.now() + 1_000) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'زمن الجدولة يجب أن يكون مستقبلياً — أو انشر فوراً',
        422,
        { field: 'publishAt' },
      );
    }
    return when;
  }
}
