import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  IMPERSONATION_MAX_MINUTES,
  TICKET_FILTERS,
  buildMeta,
  errorCodes,
  parseFilters,
  supportAuditActions,
  ticketOpenStatuses,
  ticketSlaHours,
  type ImpersonationSession,
  type ImpersonationStartResult,
  type ListEnvelope,
  type SupportTicket,
  type TicketCreate,
  type TicketDetail,
  type TicketListQueryDto,
  type TicketMessage,
  type TicketPriority,
  type TicketReply,
  type TicketStatus,
  type TicketUpdate,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { TokenService } from '../platform/auth/token.service.js';
import { platformActorLabel } from '../email/actor-label.js';

/**
 * P-C8 — «مكتب الدعم والدخول المؤقّت» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * قسمان:
 *
 *   1. **التذاكر** — صندوقٌ واحد لكل ما يقوله العملاء: التذكرة على منشأةٍ بعينها، ورسائلها
 *      بين «عميل» و«مشغّل» و«ملاحظة داخلية» لا تُرسل، ومهلةٌ تُحسب من الأولوية لحظة الفتح.
 *   2. **الدخول المؤقّت** — `break-glass`: المشغّل يدخل **بعين العميل** لا بهويّته. يُصدر
 *      الرمزُ بـ`mid` عضوية مالك المنشأة (لا عضوية للمشغّل فيها)، ويحمل `imp` = معرّف الجلسة،
 *      وعمره `min(عمر الرمز, ما تبقّى من الجلسة)`، ويُرفض فور إنهاء الجلسة.
 *
 * وثلاثة قرارات ظاهرة في الكود:
 *
 *   * **السبب يسافر مع الرمز لا مع الشاشة**: يُكتب في `support_sessions` و`audit_log`، ويظهر
 *     للعميل في سجلّه، ويُقرأ لحظةَ كل طلبٍ من الحارس — فسحب الرمز يقع فوراً.
 *   * **ما لا يُفعل أثناء الدخول المؤقّت مكتوبٌ في العقد** (`impersonationBlockedPaths` +
 *     منع الحذف)، و`ImpersonationGuard` هو من يفرضه — لا الشاشة.
 *   * **الملاحظة الداخلية صفٌّ بعلامة**: `is_internal` — تُقرأ للمشغّلين، وتُستثنى في أي
 *     مسارٍ موجَّه إلى العميل. لا «قناة سرّية» بل عمودٌ يُفلتر به.
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
  ) {}

  // ══════════════════════════════════════════════════ التذاكر

  async list(query: TicketListQueryDto): Promise<ListEnvelope<SupportTicket>> {
    const filters = parseFilters(query.filter, TICKET_FILTERS);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const conditions: SQL[] = [];
      if (filters.status) conditions.push(sql`t.status = ${filters.status}`);
      if (filters.priority) conditions.push(sql`t.priority = ${filters.priority}`);
      if (filters.tenantId) conditions.push(sql`t.tenant_id = ${filters.tenantId}::uuid`);
      if (filters.assignedTo) {
        conditions.push(
          filters.assignedTo === 'none'
            ? sql`t.assigned_to IS NULL`
            : sql`t.assigned_to = ${filters.assignedTo}::uuid`,
        );
      }
      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const totalRow = await tx.execute(sql`SELECT count(*)::int AS value FROM support_tickets t ${where}`);
      const rows = await tx.execute(sql`
        SELECT t.id, t.tenant_id, tn.code AS tenant_code, tn.name AS tenant_name, t.subject,
               t.status, t.priority, t.category, t.assigned_to, t.created_at, t.updated_at,
               t.first_response_at, t.resolved_at, t.closed_at, t.sla_due_at,
               (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
               (SELECT max(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
          FROM support_tickets t
          LEFT JOIN tenants tn ON tn.id = t.tenant_id
          ${where}
         ORDER BY
           CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.created_at DESC
         LIMIT ${query.limit} OFFSET ${query.offset}
      `);

      const labels = await this.actorLabels(
        tx,
        rows.rows.flatMap((row) => [row.assigned_to as string | null]),
      );
      const data = rows.rows.map((row) =>
        toTicket(row as Record<string, unknown>, labels.get(String(row.assigned_to)) ?? null),
      );
      return {
        data,
        meta: buildMeta(Number((totalRow.rows[0] as { value?: number })?.value ?? 0), query),
      };
    });
  }

  async get(id: string): Promise<TicketDetail> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const row = await this.loadTicket(tx, id);
      const messages = await tx.execute(sql`
        SELECT m.id, m.ticket_id, m.author_user_id, m.author_kind, m.body, m.is_internal, m.created_at,
               COALESCE(u.full_name, u.email) AS author_label
          FROM ticket_messages m
          LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.ticket_id = ${id}
         ORDER BY m.created_at ASC
      `);
      const labels = await this.actorLabels(tx, [
        (row.assigned_to as string | null) ?? null,
        (row.opened_by as string | null) ?? null,
      ]);
      return {
        ...toTicket(
          row,
          labels.get(String(row.assigned_to)) ?? null,
          labels.get(String(row.opened_by)) ?? null,
        ),
        messages: messages.rows.map((message) => toMessage(message as Record<string, unknown>)),
      };
    });
  }

  /** تذكرةٌ جديدة + رسالتها الأولى، ومهلتها من أولويتها. */
  async create(input: TicketCreate): Promise<TicketDetail> {
    const actorUserId = this.actorUserId();
    const id = newId();
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants WHERE id = ${input.tenantId} LIMIT 1`);
      if (tenant.rows.length === 0) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'منشأةٌ غير موجودة', 422, {
          field: 'tenantId',
        });
      }
      const slaHours = ticketSlaHours[input.priority];
      await tx.execute(sql`
        INSERT INTO support_tickets (id, tenant_id, subject, status, priority, category, assigned_to,
                                     opened_by, sla_due_at, created_at)
        VALUES (${id}, ${input.tenantId}, ${input.subject}, 'open', ${input.priority},
                ${input.category ?? null}, ${input.assignedTo ?? null}, ${actorUserId},
                now() + ${`${slaHours} hours`}::interval, now())
      `);
      await this.insertMessage(tx, {
        ticketId: id,
        tenantId: input.tenantId,
        authorUserId: actorUserId,
        authorKind: 'customer',
        isInternal: false,
        body: input.body,
      });
      await this.audit.recordInTx(tx, {
        tenantId: input.tenantId,
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: supportAuditActions.ticketCreate,
        entity: 'support_ticket',
        entityId: id,
        after: { subject: input.subject, priority: input.priority, slaHours },
        meta: { reason: input.reason },
      });
    });
    return this.get(id);
  }

  /** تعديل الحالة/الأولوية/الإسناد — كلٌّ منها بانتقالٍ معروف وسببٍ مكتوب. */
  async update(id: string, input: TicketUpdate): Promise<TicketDetail> {
    const actorUserId = this.actorUserId();
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.loadTicket(tx, id);
      const before = { status: current.status, priority: current.priority, assignedTo: current.assigned_to };

      const pieces = [sql`updated_at = now()`];
      if (input.status) {
        if (current.status === 'closed' && input.status !== 'closed') {
          throw new DomainError(errorCodes.VALIDATION_FAILED, 'التذكرة المغلقة لا تُعاد فتحها', 422, {
            field: 'status',
          });
        }
        pieces.push(sql`status = ${input.status}`);
        pieces.push(sql`resolved_at = ${input.status === 'resolved' ? sql`now()` : sql`resolved_at`}`);
        pieces.push(sql`closed_at = ${input.status === 'closed' ? sql`now()` : sql`closed_at`}`);
      }
      if (input.priority) {
        const slaHours = ticketSlaHours[input.priority];
        pieces.push(sql`priority = ${input.priority}`);
        // المهلة تُعاد حسابها من لحظة الترقية: تذكرةٌ صارت «عاجلة» الآن تُقاس من الآن.
        pieces.push(sql`sla_due_at = ${sql`created_at + ${`${slaHours} hours`}::interval`}`);
      }
      if (input.assignedTo !== undefined) pieces.push(sql`assigned_to = ${input.assignedTo}`);
      if (input.category !== undefined) pieces.push(sql`category = ${input.category}`);

      await tx.execute(sql`UPDATE support_tickets SET ${sql.join(pieces, sql`, `)} WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        tenantId: String(current.tenant_id),
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: supportAuditActions.ticketUpdate,
        entity: 'support_ticket',
        entityId: id,
        before,
        after: { ...before, ...input },
        meta: { reason: input.reason },
      });
    });
    return this.get(id);
  }

  /**
   * ردٌّ أو ملاحظة داخلية. الردّ العام **أول ردٍّ من مشغّل** يثبّت `first_response_at`
   * (مقياس SLA)، والملاحظة الداخلية لا تثبّته ولا تُرسل. والردّ على تذكرةٍ مفتوحة ينقلها
   * إلى `pending` («بانتظار العميل») — وهي الحالة التي تعنيها فعلاً.
   */
  async reply(id: string, input: TicketReply): Promise<TicketDetail> {
    const actorUserId = this.actorUserId();
    let notifyTenantId = '';
    let notifySubject = '';
    let notifyOpenedBy: string | null = null;
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.loadTicket(tx, id);
      if (current.status === 'closed') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'التذكرة المغلقة لا تُردّ عليها', 422, {
          field: 'status',
        });
      }
      notifyTenantId = String(current.tenant_id);
      notifySubject = String(current.subject ?? '');
      notifyOpenedBy = current.opened_by ? String(current.opened_by) : null;
      await this.insertMessage(tx, {
        ticketId: id,
        tenantId: String(current.tenant_id),
        authorUserId: actorUserId,
        authorKind: 'operator',
        isInternal: input.isInternal,
        body: input.body,
      });
      const pieces = [sql`updated_at = now()`];
      if (!input.isInternal && current.first_response_at === null)
        pieces.push(sql`first_response_at = now()`);
      if (!input.isInternal && current.status === 'open') pieces.push(sql`status = 'pending'`);
      await tx.execute(sql`UPDATE support_tickets SET ${sql.join(pieces, sql`, `)} WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        tenantId: String(current.tenant_id),
        actorUserId,
        actorLabel: await platformActorLabel(tx, actorUserId),
        action: supportAuditActions.ticketReply,
        entity: 'support_ticket',
        entityId: id,
        after: { isInternal: input.isInternal, status: input.isInternal ? current.status : 'pending' },
        meta: { reason: input.reason ?? (input.isInternal ? 'ملاحظة داخلية' : 'ردٌّ على العميل') },
      });
    });

    if (!input.isInternal && notifyTenantId) {
      await withTenantTx(this.database.db, notifyTenantId, async (tx) => {
        const recipients = await tx.execute(sql`
          SELECT id::text AS membership_id
          FROM memberships
          WHERE tenant_id = ${notifyTenantId}::uuid
            AND deleted_at IS NULL
            AND status = 'active'
            AND (is_owner = true OR user_id = ${notifyOpenedBy}::uuid)
          LIMIT 10
        `);
        const title = `رد جديد من الدعم الفني: ${notifySubject}`;
        const preview = input.body.slice(0, 200);
        for (const row of recipients.rows as Array<{ membership_id: string }>) {
          await tx.execute(sql`
            INSERT INTO notifications (id, tenant_id, membership_id, type, payload)
            VALUES (
              ${newId()}::uuid,
              ${notifyTenantId}::uuid,
              ${row.membership_id}::uuid,
              'support_ticket_reply',
              ${JSON.stringify({ title, body: preview, ticketId: id, href: '/support/help' })}::jsonb
            )
          `);
        }
      }).catch(() => undefined);
    }

    return this.get(id);
  }

  // ══════════════════════════════════════════ الدخول المؤقّت

  /**
   * `POST /platform/impersonate` — يُصدر رمزاً قصير العمر ليدخل المشغّل **بعين** مالك المنشأة.
   *
   * المدّة تُقصّ عند `IMPERSONATION_MAX_MINUTES` (60) في العقد أيضاً، والسبب إلزامي (≥10).
   * والرمز يحمل `imp` = معرّف الجلسة، وعمره لا يتجاوز ما تبقّى منها — فلا رمزَ يبقى صالحاً
   * بعد انتهاء الوقت الذي سمح به المشغّل لنفسه.
   */
  async startImpersonation(input: {
    tenantId: string;
    reason: string;
    minutes: number;
  }): Promise<ImpersonationStartResult> {
    const operatorUserId = this.actorUserId();
    const minutes = Math.min(input.minutes, IMPERSONATION_MAX_MINUTES);
    const sessionId = newId();

    const created = await withPlatformAdminTx(this.database.db, async (tx) => {
      const owner = await tx.execute(sql`
        SELECT m.id AS membership_id, m.user_id, COALESCE(u.full_name, u.email) AS user_label,
               t.code AS tenant_code, t.name AS tenant_name, t.status AS tenant_status
          FROM memberships m
          JOIN users u ON u.id = m.user_id
          JOIN tenants t ON t.id = m.tenant_id
         WHERE m.tenant_id = ${input.tenantId}
           AND m.is_owner = true
           AND m.status = 'active'
           AND m.deleted_at IS NULL
         ORDER BY m.created_at ASC
         LIMIT 1
      `);
      const row = owner.rows[0] as
        | {
            membership_id: string;
            user_id: string;
            user_label: string | null;
            tenant_code: string;
            tenant_name: string;
            tenant_status: string;
          }
        | undefined;
      if (!row) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'لا مالكٌ نشطٌ لهذه المنشأة — الدخول المؤقّت يحتاج عضويةً يدخل باسمها',
          422,
          { field: 'tenantId' },
        );
      }
      if (row.tenant_status !== 'active') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'المنشأة ليست نشطة — الدخول المؤقّت للمنشآت النشطة',
          422,
          { field: 'tenantId' },
        );
      }

      await tx.execute(sql`
        INSERT INTO support_sessions (id, tenant_id, operator_user_id, as_membership_id, reason,
                                      started_at, expires_at)
        VALUES (${sessionId}, ${input.tenantId}, ${operatorUserId}, ${row.membership_id},
                ${input.reason}, now(), now() + ${`${minutes} minutes`}::interval)
      `);
      const sessionRows = await tx.execute(sql`
        SELECT s.id, s.tenant_id, t.code AS tenant_code, t.name AS tenant_name,
               s.operator_user_id, s.reason, s.started_at, s.expires_at, s.ended_at,
               COALESCE(op.full_name, op.email) AS operator_label,
               COALESCE(as_u.full_name, as_u.email) AS as_user_label
          FROM support_sessions s
          LEFT JOIN tenants t ON t.id = s.tenant_id
          LEFT JOIN users op ON op.id = s.operator_user_id
          LEFT JOIN memberships m ON m.id = s.as_membership_id
          LEFT JOIN users as_u ON as_u.id = m.user_id
         WHERE s.id = ${sessionId}
         LIMIT 1
      `);
      await this.audit.recordInTx(tx, {
        tenantId: input.tenantId,
        actorUserId: operatorUserId,
        actorLabel: await platformActorLabel(tx, operatorUserId),
        action: supportAuditActions.impersonateStart,
        entity: 'support_session',
        entityId: sessionId,
        after: { asUserId: row.user_id, minutes, asUserLabel: row.user_label },
        meta: { reason: input.reason, mode: 'break_glass' },
      });

      return { ...row, sessionRow: sessionRows.rows[0] as Record<string, unknown> | undefined };
    });

    const token = await this.tokens.signAccessToken(
      {
        sub: created.user_id,
        tid: input.tenantId,
        mid: created.membership_id,
        scope: ['erp'],
        imp: sessionId,
      },
      // عمر الرمز = ما تبقّى من الجلسة؛ و`signAccessToken` تقصّه عند عمر الرمز المعتاد
      // فلا يعيش رمزُ دعمٍ أطول من رمزٍ عادي.
      { ttlSeconds: minutes * 60 },
    );

    const session = toSession(created.sessionRow ?? {});
    return {
      session,
      accessToken: token.token,
      expiresIn: minutes * 60,
    };
  }

  async listImpersonationSessions(): Promise<ImpersonationSession[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT s.id, s.tenant_id, t.code AS tenant_code, t.name AS tenant_name,
               s.operator_user_id, s.reason, s.started_at, s.expires_at, s.ended_at,
               COALESCE(op.full_name, op.email) AS operator_label,
               COALESCE(as_u.full_name, as_u.email) AS as_user_label
          FROM support_sessions s
          LEFT JOIN tenants t ON t.id = s.tenant_id
          LEFT JOIN users op ON op.id = s.operator_user_id
          LEFT JOIN memberships m ON m.id = s.as_membership_id
          LEFT JOIN users as_u ON as_u.id = m.user_id
         ORDER BY s.started_at DESC
         LIMIT 100
      `);
      return rows.rows.map((row) => toSession(row as Record<string, unknown>));
    });
  }

  /** إنهاء الجلسة: الرمز يسقط من اللحظة التالية لأن الحارس يقرأ الصفّ في كل طلب. */
  async endImpersonation(id: string, reason: string): Promise<ImpersonationSession> {
    const actorUserId = this.actorUserId();
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const found = await tx.execute(sql`
        SELECT s.tenant_id, s.operator_user_id, s.ended_at FROM support_sessions s WHERE s.id = ${id} LIMIT 1
      `);
      const row = found.rows[0] as { tenant_id: string; ended_at: Date | null } | undefined;
      if (!row) {
        throw new DomainError(errorCodes.NOT_FOUND, 'جلسة دعمٍ غير موجودة', 404);
      }
      if (!row.ended_at) {
        await tx.execute(sql`UPDATE support_sessions SET ended_at = now() WHERE id = ${id}`);
        await this.audit.recordInTx(tx, {
          tenantId: row.tenant_id,
          actorUserId,
          actorLabel: await platformActorLabel(tx, actorUserId),
          action: supportAuditActions.impersonateEnd,
          entity: 'support_session',
          entityId: id,
          meta: { reason },
        });
      }
    });

    const all = await this.listImpersonationSessions();
    const result = all.find((entry) => entry.id === id);
    if (!result) {
      throw new DomainError(errorCodes.NOT_FOUND, 'جلسة دعمٍ غير موجودة', 404);
    }
    return result;
  }

  // ══════════════════════════════════════════════════ الحارس

  /**
   * يقرأه `ImpersonationGuard` في كل طلبٍ يحمل `imp`: هل الجلسة ما زالت مفتوحة؟ صفٌّ واحد
   * بمفتاحه الأساسي، وقراءةٌ لا تحدث إلا لرموز الدخول المؤقّت — فلا كلفة على المسار العادي.
   */
  async isImpersonationActive(sessionId: string): Promise<boolean> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT 1 FROM support_sessions
         WHERE id = ${sessionId} AND ended_at IS NULL AND expires_at > now()
         LIMIT 1
      `);
      return rows.rows.length > 0;
    });
  }

  // ══════════════════════════════════════════════════ أدوات

  /**
   * تذاكر عميلٍ بعينه **من سياق العميل** — يُستعمل من سطح العميل (وشاشةُ الدعم في staff
   * لاحقاً). تُفلتر الملاحظات الداخلية هنا: العميل لا يراها وإن كانت صفّه.
   */
  async listForTenant(tenantId: string): Promise<SupportTicket[]> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT t.id, t.tenant_id, t.subject, t.status, t.priority, t.category, t.assigned_to,
               t.created_at, t.updated_at, t.first_response_at, t.resolved_at, t.closed_at, t.sla_due_at,
               (SELECT count(*)::int FROM ticket_messages m
                 WHERE m.ticket_id = t.id AND m.is_internal = false) AS message_count,
               (SELECT max(m.created_at) FROM ticket_messages m
                 WHERE m.ticket_id = t.id AND m.is_internal = false) AS last_message_at
          FROM support_tickets t
         WHERE t.tenant_id = ${tenantId}
         ORDER BY t.created_at DESC
         LIMIT 100
      `);
      return rows.rows.map((row) => toTicket(row as Record<string, unknown>));
    });
  }

  async getForTenant(tenantId: string, id: string): Promise<TicketDetail> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const found = await tx.execute(sql`
        SELECT t.id, t.tenant_id, t.subject, t.status, t.priority, t.category, t.assigned_to,
               t.opened_by, t.created_at, t.updated_at, t.first_response_at, t.resolved_at,
               t.closed_at, t.sla_due_at,
               (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND m.is_internal = false) AS message_count,
               (SELECT max(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.is_internal = false) AS last_message_at
          FROM support_tickets t
         WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${id}::uuid
         LIMIT 1
      `);
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'تذكرةٌ غير موجودة', 404);
      const messages = await tx.execute(sql`
        SELECT m.id, m.ticket_id, m.author_user_id, m.author_kind, m.body, m.is_internal, m.created_at,
               COALESCE(u.full_name, u.email) AS author_label
          FROM ticket_messages m
          LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.ticket_id = ${id}::uuid
           AND m.tenant_id = ${tenantId}::uuid
           AND m.is_internal = false
         ORDER BY m.created_at ASC
      `);
      return {
        ...toTicket(row),
        messages: messages.rows.map((message) => toMessage(message as Record<string, unknown>)),
      };
    });
  }

  async createFromTenant(
    tenantId: string,
    userId: string,
    input: { subject?: string; body?: string; priority?: string; category?: string },
  ): Promise<TicketDetail> {
    const subject = String(input.subject ?? '').trim();
    const body = String(input.body ?? '').trim();
    if (subject.length < 3 || subject.length > 200) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'عنوان الطلب يجب أن يكون بين 3 و200 حرف', 422, {
        field: 'subject',
      });
    }
    if (body.length < 3 || body.length > 5000) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'تفاصيل الطلب مطلوبة', 422, {
        field: 'body',
      });
    }
    const priority: TicketPriority =
      input.priority === 'urgent' || input.priority === 'high' || input.priority === 'low'
        ? input.priority
        : 'normal';
    const category = input.category?.trim() ? input.category.trim().slice(0, 60) : null;
    const slaHours = ticketSlaHours[priority];
    const id = newId();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO support_tickets (id, tenant_id, subject, status, priority, category, opened_by, sla_due_at, created_at)
        VALUES (
          ${id}::uuid, ${tenantId}::uuid, ${subject}, 'open', ${priority},
          ${category}, ${userId}::uuid, now() + ${`${slaHours} hours`}::interval, now()
        )
      `);
      await this.insertMessage(tx, {
        ticketId: id,
        tenantId,
        authorUserId: userId,
        authorKind: 'customer',
        isInternal: false,
        body,
      });
      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: userId,
        actorLabel: await platformActorLabel(tx, userId),
        action: supportAuditActions.ticketCreate,
        entity: 'support_ticket',
        entityId: id,
        after: { subject, priority, category, slaHours },
        meta: { reason: 'طلب مساعدة جديد من لوحة العميل' },
      });
    });
    return this.getForTenant(tenantId, id);
  }

  async replyFromTenant(
    tenantId: string,
    userId: string,
    id: string,
    bodyText?: string,
  ): Promise<TicketDetail> {
    const body = String(bodyText ?? '').trim();
    if (body.length < 1 || body.length > 5000) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'اكتب نص الرد', 422, { field: 'body' });
    }
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const found = await tx.execute(sql`
        SELECT id, status FROM support_tickets
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
        LIMIT 1
      `);
      const row = found.rows[0] as { id: string; status: string } | undefined;
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'تذكرةٌ غير موجودة', 404);
      if (row.status === 'closed') {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'التذكرة المغلقة لا تُردّ عليها', 422);
      }
      await this.insertMessage(tx, {
        ticketId: id,
        tenantId,
        authorUserId: userId,
        authorKind: 'customer',
        isInternal: false,
        body,
      });
      await tx.execute(sql`
        UPDATE support_tickets
        SET status = 'open', resolved_at = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
      `);
      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: userId,
        actorLabel: await platformActorLabel(tx, userId),
        action: supportAuditActions.ticketReply,
        entity: 'support_ticket',
        entityId: id,
        after: { status: 'open', authorKind: 'customer' },
        meta: { reason: 'رد من العميل على تذكرة الدعم' },
      });
    });
    return this.getForTenant(tenantId, id);
  }

  private actorUserId(): string {
    const auth = tryGetAuthContext();
    if (!auth) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'لا جلسة', 401);
    }
    return auth.userId;
  }

  private async loadTicket(tx: DrizzleTx, id: string): Promise<Record<string, unknown>> {
    const rows = await tx.execute(sql`
      SELECT t.id, t.tenant_id, tn.code AS tenant_code, tn.name AS tenant_name, t.subject,
             t.status, t.priority, t.category, t.assigned_to, t.opened_by, t.created_at, t.updated_at,
             t.first_response_at, t.resolved_at, t.closed_at, t.sla_due_at,
             (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
             (SELECT max(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
        FROM support_tickets t
        LEFT JOIN tenants tn ON tn.id = t.tenant_id
       WHERE t.id = ${id}
       LIMIT 1
    `);
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new DomainError(errorCodes.NOT_FOUND, 'تذكرةٌ غير موجودة', 404);
    }
    return row;
  }

  private async insertMessage(
    tx: DrizzleTx,
    input: {
      ticketId: string;
      tenantId: string;
      authorUserId: string | null;
      authorKind: 'operator' | 'customer' | 'system';
      isInternal: boolean;
      body: string;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO ticket_messages (id, ticket_id, tenant_id, author_user_id, author_kind, is_internal, body)
      VALUES (${newId()}, ${input.ticketId}, ${input.tenantId}, ${input.authorUserId},
              ${input.authorKind}, ${input.isInternal}, ${input.body})
    `);
  }

  /** خريطة معرّف → وسمٌ مقروء لكتّاب التذاكر والمكلَّفين بها. */
  private async actorLabels(tx: DrizzleTx, ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return new Map();
    const rows = await tx.execute(sql`
      SELECT id, COALESCE(full_name, email) AS label FROM users
       WHERE id IN (${sql.join(
         unique.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
    return new Map(
      rows.rows.map((row) => [String((row as { id: string }).id), String((row as { label: string }).label)]),
    );
  }

  /** يُستعمل من الاختبار والتحقّق: هل التذكرة مفتوحة؟ */
  static isOpen(status: TicketStatus): boolean {
    return ticketOpenStatuses.includes(status);
  }
}

/**
 * `pg` يعيد `timestamptz` كـ`Date` في المسارات المُعدّة، وكنصٍّ بصيغته النصّية في
 * `execute` الخام (`2026-09-17 11:33:13.892886+00`). العقد يَعِد بـISO، فيُطبَّع هنا مرةً
 * واحدة — بدل أن تتعامل كل واجهة مع صيغتين.
 */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

function toTicket(
  row: Record<string, unknown>,
  assignedLabel: string | null = null,
  openedLabel: string | null = null,
): SupportTicket {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantCode: (row.tenant_code as string | null) ?? null,
    tenantName: (row.tenant_name as string | null) ?? null,
    subject: String(row.subject),
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    category: (row.category as string | null) ?? null,
    assignedTo: (row.assigned_to as string | null) ?? null,
    assignedToLabel: assignedLabel,
    openedByLabel: openedLabel,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? iso(row.created_at) ?? new Date().toISOString(),
    firstResponseAt: iso(row.first_response_at),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    slaDueAt: iso(row.sla_due_at),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: iso(row.last_message_at),
  };
}

function toMessage(row: Record<string, unknown>): TicketMessage {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    authorUserId: (row.author_user_id as string | null) ?? null,
    authorLabel: (row.author_label as string | null) ?? null,
    authorKind: row.author_kind as TicketMessage['authorKind'],
    body: String(row.body),
    isInternal: row.is_internal === true,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

function toSession(row: Record<string, unknown>): ImpersonationSession {
  const endedAt = iso(row.ended_at);
  const expiresAt = iso(row.expires_at) ?? new Date().toISOString();
  const status = endedAt ? 'ended' : new Date(expiresAt).getTime() > Date.now() ? 'active' : 'expired';
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantCode: (row.tenant_code as string | null) ?? null,
    tenantName: (row.tenant_name as string | null) ?? null,
    operatorUserId: String(row.operator_user_id),
    operatorLabel: (row.operator_label as string | null) ?? null,
    reason: String(row.reason),
    startedAt: iso(row.started_at) ?? new Date().toISOString(),
    expiresAt,
    endedAt,
    status,
    asUserLabel: (row.as_user_label as string | null) ?? null,
  };
}
