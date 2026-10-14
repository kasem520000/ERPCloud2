import { Inject, Injectable, Logger } from '@nestjs/common';
import { env } from '@erp/config';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  CommentRuleError,
  assertAuthor,
  assertBody,
  assertEntityType,
  assertReplyParent,
  extractNameMentions,
  extractUuidMentions,
  resolveNameMentions,
  resolveOpenComment,
  suggestMentions,
  threadComments,
  withTenantTx,
  type CommentEntityType,
  type DatabaseHandle,
  type DrizzleTx,
  type MentionCandidate,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { EmailService } from '../email/email.service.js';
import { NotificationsService } from '../platform-services/notifications/notifications.service.js';
import { getTenantContext } from '../platform/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTITY_TABLE: Record<CommentEntityType, string> = {
  sales_invoice: 'sales_invoices',
  purchase_invoice: 'purchase_invoices',
  party: 'parties',
  employee: 'employees',
  project: 'projects',
  project_task: 'project_tasks',
};

const ENTITY_PERMISSION: Record<CommentEntityType, string> = {
  sales_invoice: 'sales.view',
  purchase_invoice: 'purchase.view',
  party: 'parties.view',
  employee: 'hrm.view',
  project: 'projects.view',
  project_task: 'projects.tasks.view',
};

const ENTITY_HREF: Record<CommentEntityType, (id: string) => string> = {
  sales_invoice: (id) => `/sales/invoices/${id}`,
  purchase_invoice: (id) => `/purchases/invoices/${id}`,
  party: () => '/sales/customers',
  employee: () => '/hrm/employees',
  project: (id) => `/projects/${id}`,
  project_task: (id) => `/projects/tasks/${id}`,
};

type Colleague = MentionCandidate & { email: string; membershipId: string };

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  async list(tenantId: string, entityTypeRaw: string, entityId: string, openOnly: boolean) {
    const entityType = this.rules(() => assertEntityType(entityTypeRaw));
    this.uuid(entityId, 'المستند غير موجود');
    this.assertCanSee(entityType);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertEntity(tx, tenantId, entityType, entityId);
      const found = rows(await tx.execute(sql`
        SELECT c.id, c.body, c.user_id, c.parent_id, c.is_resolved, c.deleted_at, c.created_at, c.edited_at,
               u.full_name AS author_name
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.tenant_id = ${tenantId}::uuid AND c.entity_type = ${entityType} AND c.entity_id = ${entityId}::uuid
        ORDER BY c.created_at
      `)).map(toComment);
      const visible = openOnly
        ? found
            .filter((comment) => !comment.parentId && !comment.isResolved && !comment.deleted)
            .flatMap((root) => [root, ...found.filter((reply) => reply.parentId === root.id)])
        : found;
      const threaded = threadComments(visible);
      return {
        count: found.filter((comment) => !comment.deleted).length,
        openCount: found.filter((comment) => !comment.parentId && !comment.isResolved && !comment.deleted).length,
        comments: threaded,
      };
    });
  }

  async suggest(tenantId: string, query: string) {
    const needle = query.trim();
    if (!needle) return [];
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const people = await this.colleagues(tx, tenantId, needle, 8);
      return suggestMentions(people, needle).map((person) => ({ id: person.id, name: person.name }));
    });
  }

  async mentions(tenantId: string, userId: string, unreadOnly: boolean) {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rows(await tx.execute(sql`
        SELECT m.id, m.comment_id, m.is_read, m.created_at, c.entity_type, c.entity_id, c.body, u.full_name AS author_name
        FROM comment_mentions m
        JOIN comments c ON c.id = m.comment_id
        LEFT JOIN users u ON u.id = c.user_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.mentioned_user_id = ${userId}::uuid
          AND (${unreadOnly}::boolean = false OR m.is_read = false)
          AND c.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 100
      `)).map((row) => ({
        id: str(row.id),
        commentId: str(row.comment_id),
        isRead: flag(row.is_read),
        createdAt: iso(row.created_at),
        entityType: str(row.entity_type),
        entityId: str(row.entity_id),
        authorName: str(row.author_name) || 'زميل',
        excerpt: str(row.body).slice(0, 160),
        href: hrefOf(str(row.entity_type), str(row.entity_id)),
      })),
    );
  }

  async markRead(tenantId: string, userId: string, id: string) {
    this.uuid(id, 'الإشارة غير موجودة');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const updated = rows(await tx.execute(sql`
        UPDATE comment_mentions
        SET is_read = true, read_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid AND mentioned_user_id = ${userId}::uuid
        RETURNING id
      `));
      if (!updated[0]) throw new DomainError(errorCodes.NOT_FOUND, 'الإشارة غير موجودة', 404);
      return { id, isRead: true };
    });
  }

  async create(tenantId: string, userId: string, input: Record<string, unknown>) {
    const entityType = this.rules(() => assertEntityType(String(input.entityType ?? input.entity_type ?? '')));
    const entityId = this.uuid(String(input.entityId ?? input.entity_id ?? ''), 'المستند غير موجود');
    const body = this.rules(() => assertBody(String(input.body ?? '')));
    const parentId = optionalUuid(input.parentId ?? input.parent_id);
    this.assertCanSee(entityType);
    const saved = await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertEntity(tx, tenantId, entityType, entityId);
      if (parentId) {
        const parent = await this.commentRow(tx, tenantId, parentId);
        if (parent.entityType !== entityType || parent.entityId !== entityId) {
          throw new DomainError(errorCodes.VALIDATION_FAILED, 'الرد يجب أن يكون على نفس المستند', 422);
        }
        if (parent.deleted) throw new DomainError(errorCodes.VALIDATION_FAILED, 'التعليق محذوف', 422);
        this.rules(() => assertReplyParent({ parentId: parent.parentId, isResolved: parent.isResolved }));
      }
      const mentioned = await this.mentionedPeople(tx, tenantId, body, userId);
      const id = newId();
      await tx.execute(sql`
        INSERT INTO comments (id, tenant_id, entity_type, entity_id, user_id, body, parent_id)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${entityType}, ${entityId}::uuid, ${userId}::uuid, ${body}, ${parentId}::uuid)
      `);
      const authorName = (await this.colleaguesByIds(tx, tenantId, [userId]))[0]?.name || 'زميل';
      const notices = await this.storeMentions(tx, tenantId, id, entityType, entityId, body, authorName, mentioned);
      return { id, notices };
    });
    await this.sendMentionMail(tenantId, saved.notices);
    return this.one(tenantId, saved.id);
  }

  async update(tenantId: string, userId: string, id: string, bodyRaw: string) {
    this.uuid(id, 'التعليق غير موجود');
    const body = this.rules(() => assertBody(bodyRaw));
    const saved = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.commentRow(tx, tenantId, id);
      this.assertCanSee(current.entityType);
      if (current.deleted) throw new DomainError(errorCodes.VALIDATION_FAILED, 'التعليق محذوف', 422);
      this.rules(() => assertAuthor(current.userId, userId));
      await tx.execute(sql`
        UPDATE comments SET body = ${body}, edited_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      await tx.execute(sql`DELETE FROM comment_mentions WHERE comment_id = ${id}::uuid AND tenant_id = ${tenantId}::uuid`);
      const mentioned = await this.mentionedPeople(tx, tenantId, body, userId);
      const authorName = (await this.colleaguesByIds(tx, tenantId, [userId]))[0]?.name || 'زميل';
      const notices = await this.storeMentions(tx, tenantId, id, current.entityType, current.entityId, body, authorName, mentioned);
      return { notices };
    });
    await this.sendMentionMail(tenantId, saved.notices);
    return this.one(tenantId, id);
  }

  async resolve(tenantId: string, userId: string, id: string) {
    this.uuid(id, 'التعليق غير موجود');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.commentRow(tx, tenantId, id);
      this.assertCanSee(current.entityType);
      if (current.deleted) throw new DomainError(errorCodes.VALIDATION_FAILED, 'التعليق محذوف', 422);
      if (current.parentId) throw new DomainError(errorCodes.VALIDATION_FAILED, 'يُحل التعليق الأصلي لا الرد', 422);
      this.rules(() => resolveOpenComment(current));
      await tx.execute(sql`
        UPDATE comments
        SET is_resolved = true, resolved_at = now(), resolved_by = ${userId}::uuid, updated_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      return this.oneInside(tx, tenantId, id);
    });
  }

  async remove(tenantId: string, userId: string, id: string) {
    this.uuid(id, 'التعليق غير موجود');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.commentRow(tx, tenantId, id);
      this.assertCanSee(current.entityType);
      this.rules(() => assertAuthor(current.userId, userId));
      await tx.execute(sql`
        UPDATE comments
        SET deleted_at = now(), body = 'حُذف هذا التعليق', updated_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      return { id, deleted: true };
    });
  }

  private async one(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.oneInside(tx, tenantId, id));
  }

  private async oneInside(tx: DrizzleTx, tenantId: string, id: string) {
    const row = first(await tx.execute(sql`
      SELECT c.id, c.body, c.user_id, c.parent_id, c.is_resolved, c.deleted_at, c.created_at, c.edited_at,
             u.full_name AS author_name
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ${id}::uuid AND c.tenant_id = ${tenantId}::uuid
    `));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'التعليق غير موجود', 404);
    return toComment(row);
  }

  private async commentRow(tx: DrizzleTx, tenantId: string, id: string) {
    const row = first(await tx.execute(sql`
      SELECT id, entity_type, entity_id, user_id, parent_id, is_resolved, deleted_at
      FROM comments WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
    `));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'التعليق غير موجود', 404);
    const entityType = this.rules(() => assertEntityType(str(row.entity_type)));
    return {
      entityType,
      entityId: str(row.entity_id),
      userId: str(row.user_id),
      parentId: str(row.parent_id) || null,
      isResolved: flag(row.is_resolved),
      deleted: Boolean(row.deleted_at),
    };
  }

  private async assertEntity(tx: DrizzleTx, tenantId: string, entityType: CommentEntityType, entityId: string) {
    const table = ENTITY_TABLE[entityType];
    const found = first(await tx.execute(sql`
      SELECT id FROM ${sql.raw(table)} WHERE id = ${entityId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1
    `));
    if (!found) throw new DomainError(errorCodes.NOT_FOUND, 'المستند غير موجود', 404);
  }

  private async colleagues(tx: DrizzleTx, tenantId: string, needle: string, limit: number): Promise<Colleague[]> {
    return rows(await tx.execute(sql`
      SELECT u.id, u.full_name, u.email, m.id AS membership_id
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ${tenantId}::uuid
        AND m.status = 'active'
        AND m.kind = 'staff'
        AND m.deleted_at IS NULL
        AND u.status = 'active'
        AND u.full_name ILIKE ${'%' + needle + '%'}
      ORDER BY u.full_name
      LIMIT ${limit}
    `)).map(toColleague);
  }

  private async colleaguesByIds(tx: DrizzleTx, tenantId: string, ids: string[]): Promise<Colleague[]> {
    if (ids.length === 0) return [];
    return rows(await tx.execute(sql`
      SELECT u.id, u.full_name, u.email, m.id AS membership_id
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ${tenantId}::uuid
        AND m.status = 'active'
        AND m.kind = 'staff'
        AND m.deleted_at IS NULL
        AND u.status = 'active'
        AND u.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `)).map(toColleague);
  }

  private async mentionedPeople(tx: DrizzleTx, tenantId: string, body: string, authorId: string): Promise<Colleague[]> {
    const byId = new Map<string, Colleague>();
    const ids = extractUuidMentions(body).filter((id) => id !== authorId);
    for (const person of await this.colleaguesByIds(tx, tenantId, ids)) {
      if (person.id !== authorId) byId.set(person.id, person);
    }
    for (const name of extractNameMentions(body)) {
      const matches = await this.colleagues(tx, tenantId, name, 2);
      const resolved = resolveNameMentions(matches, [name]).filter((id) => id !== authorId);
      const only = resolved.length === 1 ? matches.find((person) => person.id === resolved[0]) : undefined;
      if (only) byId.set(only.id, only);
    }
    return [...byId.values()];
  }

  private async storeMentions(
    tx: DrizzleTx,
    tenantId: string,
    commentId: string,
    entityType: CommentEntityType,
    entityId: string,
    body: string,
    authorName: string,
    mentioned: Colleague[],
  ) {
    const notices: Array<{ email: string; name: string; authorName: string; excerpt: string; link: string }> = [];
    const href = hrefOf(entityType, entityId);
    for (const person of mentioned) {
      await tx.execute(sql`
        INSERT INTO comment_mentions (id, tenant_id, comment_id, mentioned_user_id)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${commentId}::uuid, ${person.id}::uuid)
        ON CONFLICT (comment_id, mentioned_user_id) DO NOTHING
      `);
      await this.notifications.createInTx(tx, {
        tenantId,
        membershipId: person.membershipId,
        type: 'comment.mention',
        payload: {
          title: 'إشارة في تعليق',
          message: `${authorName} أشار إليك: ${body.slice(0, 160)}`,
          href,
          commentId,
          authorName,
        },
      });
      if (person.email) {
        notices.push({
          email: person.email,
          name: person.name,
          authorName,
          excerpt: body.slice(0, 160),
          link: absoluteStaffHref(href),
        });
      }
    }
    return notices;
  }

  private async sendMentionMail(
    tenantId: string,
    notices: Array<{ email: string; name: string; authorName: string; excerpt: string; link: string }>,
  ) {
    for (const notice of notices) {
      try {
        await this.email.send({
          tenantId,
          event: 'comment.mention',
          to: notice.email,
          toName: notice.name,
          locale: 'ar',
          variables: {
            name: notice.name,
            author: notice.authorName,
            excerpt: notice.excerpt,
            link: notice.link,
          },
        });
      } catch (error) {
        this.logger.warn(`comment mention email skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private assertCanSee(entityType: CommentEntityType) {
    const permissions = getTenantContext().permissions;
    if (permissions.includes('*') || permissions.includes(ENTITY_PERMISSION[entityType])) return;
    throw new DomainError(errorCodes.FORBIDDEN, 'لا يمكنك رؤية هذا المستند', 403);
  }

  private uuid(value: string, message: string) {
    if (!UUID.test(value)) throw new DomainError(errorCodes.NOT_FOUND, message, 404);
    return value;
  }

  private rules<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof CommentRuleError) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, ruleMessage(error.rule), 422);
      }
      throw error;
    }
  }
}

function absoluteStaffHref(path: string): string {
  const base = (process.env.STAFF_PUBLIC_URL || env.STAFF_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

function toColleague(row: Record<string, unknown>): Colleague {
  return {
    id: str(row.id),
    name: str(row.full_name),
    email: str(row.email),
    membershipId: str(row.membership_id),
  };
}

function hrefOf(entityType: string, entityId: string): string {
  const builder = ENTITY_HREF[entityType as CommentEntityType];
  return builder ? builder(entityId) : '/comments/mentions';
}

function toComment(row: Record<string, unknown>) {
  const deleted = Boolean(row.deleted_at);
  return {
    id: str(row.id),
    body: deleted ? 'حُذف هذا التعليق' : str(row.body),
    authorId: str(row.user_id),
    authorName: str(row.author_name) || 'زميل',
    parentId: str(row.parent_id) || null,
    isResolved: flag(row.is_resolved),
    deleted,
    editedAt: row.edited_at ? iso(row.edited_at) : null,
    createdAt: iso(row.created_at),
  };
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!UUID.test(text)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'الرد غير صالح', 422);
  return text;
}

function ruleMessage(rule: string): string {
  if (rule === 'BODY') return 'التعليق بين حرف و4000 حرف';
  if (rule === 'ENTITY') return 'نوع المستند غير مدعوم';
  if (rule === 'PARENT') return 'التعليق الأصلي غير موجود';
  if (rule === 'DEPTH') return 'الرد مستوى واحد فقط';
  if (rule === 'RESOLVED') return 'التعليق محلول';
  return 'لا يعدّل التعليق إلا كاتبه';
}

function flag(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

function first(result: unknown): Record<string, unknown> | undefined {
  return rows(result)[0];
}
