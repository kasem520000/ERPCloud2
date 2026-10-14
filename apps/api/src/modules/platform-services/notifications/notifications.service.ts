import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  buildMeta,
  DomainError,
  errorCodes,
  NOTIFICATION_FILTERS,
  NOTIFICATION_SORT_COLUMNS,
  parseFilters,
  parseSort,
  type ListEnvelope,
  type NotificationCreate,
  type NotificationDto,
  type PaginationQuery,
} from '@erp/contracts';
import {
  memberships,
  newId,
  notifications,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

/**
 * In-app notifications — API_CONTRACT §2, DATABASE_DESIGN §4,
 * TARGET_ARCHITECTURE §8 ("Notifications: in-app table + email (SMTP/SES port)").
 *
 * A notification is addressed to a *membership*, not to a user: the same person in two
 * tenants must not see one inbox. Listing is therefore always filtered to the calling
 * membership, on top of the RLS tenant scope.
 */

export type NotificationListQuery = PaginationQuery & {
  filter?: Record<string, unknown>;
  sort?: string;
};

export type NotificationInput = {
  tenantId: string;
  membershipId: string;
  type: string;
  payload?: Record<string, unknown>;
};

@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** Creates a notification on its own transaction. */
  async create(input: NotificationInput): Promise<NotificationDto> {
    return withTenantTx(this.database.db, input.tenantId, (tx) => this.createInTx(tx, input));
  }

  /** Same, inside a business transaction — the notification then shares its fate. */
  async createInTx(tx: DrizzleTx, input: NotificationInput): Promise<NotificationDto> {
    await this.assertMembershipExists(tx, input.membershipId);

    const [row] = await tx
      .insert(notifications)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        type: input.type,
        payload: input.payload ?? {},
      })
      .returning();

    return toNotificationDto(row as NotificationRow);
  }

  /** `POST /notifications` — `platform.notification.manage` (CR-005). */
  async createForTenant(
    tenantId: string,
    callerMembershipId: string,
    input: NotificationCreate,
  ): Promise<NotificationDto> {
    return this.create({
      tenantId,
      membershipId: input.membershipId ?? callerMembershipId,
      type: input.type,
      payload: input.payload,
    });
  }

  /** `GET /notifications` — the caller's own inbox. */
  async list(
    tenantId: string,
    membershipId: string,
    query: NotificationListQuery,
  ): Promise<ListEnvelope<NotificationDto>> {
    const filters = parseFilters(query.filter, NOTIFICATION_FILTERS);
    const sort = parseSort(query.sort, NOTIFICATION_SORT_COLUMNS);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: (SQL | undefined)[] = [
        eq(notifications.tenantId, tenantId),
        eq(notifications.membershipId, membershipId),
      ];
      if (filters.type) conditions.push(eq(notifications.type, filters.type));
      if (filters.read === 'true') conditions.push(isNotNull(notifications.readAt));
      if (filters.read === 'false') conditions.push(isNull(notifications.readAt));

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(notifications).where(where);

      const ascending = sort[0]?.direction === 'asc';
      const rows = await tx
        .select()
        .from(notifications)
        .where(where)
        .orderBy(ascending ? sql`${notifications.createdAt} ASC` : desc(notifications.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toNotificationDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, membershipId: string, id: string): Promise<NotificationDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toNotificationDto(await this.loadOwned(tx, tenantId, membershipId, id)),
    );
  }

  /** `POST /notifications/{id}/read` — idempotent: re-reading keeps the first timestamp. */
  async markRead(tenantId: string, membershipId: string, id: string): Promise<NotificationDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.loadOwned(tx, tenantId, membershipId, id);
      if (current.readAt) return toNotificationDto(current);

      const [updated] = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, id), eq(notifications.tenantId, tenantId)))
        .returning();

      // P-C7: الإعلان يقيس قراءته من هنا — العلامة تُوسم على صفّ التسليم نفسه، فلا رقمان
      // لسؤالٍ واحد (`announcement_reads` هو مصدر الحقيقة)، والوسم idempotent مثله.
      await tx.execute(sql`
        UPDATE announcement_reads SET read_at = now()
         WHERE notification_id = ${id} AND read_at IS NULL
      `);

      return toNotificationDto((updated ?? current) as NotificationRow);
    });
  }

  async unreadCount(tenantId: string, membershipId: string): Promise<number> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({ value: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.membershipId, membershipId),
            isNull(notifications.readAt),
          ),
        );
      return row?.value ?? 0;
    });
  }

  private async loadOwned(
    tx: DrizzleTx,
    tenantId: string,
    membershipId: string,
    id: string,
  ): Promise<NotificationRow> {
    const [row] = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.tenantId, tenantId),
          eq(notifications.membershipId, membershipId),
        ),
      )
      .limit(1);

    // Another member's notification is as invisible as another tenant's (MULTI_TENANCY §7.1).
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, `No notification with id ${id}`, 404);
    return row;
  }

  private async assertMembershipExists(tx: DrizzleTx, membershipId: string): Promise<void> {
    const [row] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.id, membershipId))
      .limit(1);

    if (!row) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `No membership with id ${membershipId} in this tenant`,
        422,
        { field: 'membershipId' },
      );
    }
  }
}

type NotificationRow = typeof notifications.$inferSelect;

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    membershipId: row.membershipId,
    type: row.type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
