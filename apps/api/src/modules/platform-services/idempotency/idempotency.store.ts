import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { idempotencyKeys, tenants, withTenantTx, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

/**
 * Idempotency-key storage — PHASE_04 §5.7 ("Replace P02 in-memory idempotency with
 * `idempotency_keys` storage"), DATABASE_DESIGN §4.
 *
 * Semantics, in the order they are checked:
 *
 * | situation                                   | result                                  |
 * | ------------------------------------------- | ----------------------------------------- |
 * | key unseen                                  | `started` — the handler runs             |
 * | key seen, same payload, response stored     | `replay` — byte-identical response       |
 * | key seen, same payload, still running       | `in_progress` — 409, caller retries      |
 * | key seen, **different** payload or endpoint | `conflict` — 409 `IDEMPOTENCY_REPLAY`    |
 * | key expired (> `IDEMPOTENCY_TTL_HOURS`)     | treated as unseen and overwritten        |
 *
 * The row is claimed *before* the handler runs, inside its own transaction, so two
 * concurrent requests with the same key cannot both execute the handler.
 */

export type BeginResult =
  | { outcome: 'started' }
  /** `response` is the raw serialised body of the first call, replayed verbatim. */
  | { outcome: 'replay'; statusCode: number; response: string }
  | { outcome: 'in_progress' }
  | { outcome: 'conflict'; endpoint: string };

export function hashRequestPayload(endpoint: string, body: unknown): string {
  const serialised = body === undefined ? '' : JSON.stringify(body ?? null);
  return createHash('sha256').update(`${endpoint}\n${serialised}`).digest('hex');
}

@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async begin(
    tenantId: string,
    key: string,
    endpoint: string,
    requestHash: string,
    now = new Date(),
  ): Promise<BeginResult> {
    const expiresAt = new Date(now.getTime() + env.IDEMPOTENCY_TTL_HOURS * 3_600_000);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      // Claim: insert, or take over a row that has already expired.
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({ tenantId, key, endpoint, requestHash, expiresAt })
        .onConflictDoUpdate({
          target: [idempotencyKeys.tenantId, idempotencyKeys.key],
          set: {
            endpoint,
            requestHash,
            expiresAt,
            createdAt: now,
            statusCode: null,
            response: null,
            completedAt: null,
          },
          setWhere: lt(idempotencyKeys.expiresAt, now),
        })
        .returning({ key: idempotencyKeys.key });

      if (inserted.length > 0) return { outcome: 'started' };

      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
        .limit(1);

      if (!existing) return { outcome: 'started' };
      if (existing.requestHash !== requestHash) {
        return { outcome: 'conflict', endpoint: existing.endpoint };
      }
      if (existing.completedAt === null) return { outcome: 'in_progress' };

      return {
        outcome: 'replay',
        statusCode: existing.statusCode ?? 200,
        response: existing.response ?? '',
      };
    });
  }

  /** Stores the serialised response so a later replay is byte-identical. */
  async complete(tenantId: string, key: string, statusCode: number, response: string): Promise<void> {
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx
          .update(idempotencyKeys)
          .set({ statusCode, response, completedAt: new Date() })
          .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)));
      });
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error), key },
        'failed to store idempotent response',
      );
    }
  }

  /**
   * Releases the claim when the handler failed. Without this a transient 500 would
   * poison the key for 24 h and the client could never retry.
   */
  async release(tenantId: string, key: string): Promise<void> {
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        await tx
          .delete(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, tenantId),
              eq(idempotencyKeys.key, key),
              sql`${idempotencyKeys.completedAt} IS NULL`,
            ),
          );
      });
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), key },
        'failed to release idempotency claim',
      );
    }
  }

  /**
   * Maintenance job (`idempotency.gc`).
   *
   * `idempotency_keys` carries FORCE RLS, so a sweep without a tenant GUC would match
   * zero rows — silently. The job therefore walks the tenants (a platform table, no RLS)
   * and purges each one under its own context, exactly like `OutboxPublisher`: no
   * component of the running system ever needs BYPASSRLS (PROJECT_CONTRACT §13.4).
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const tenantIds = await withTx(this.database.db, async (tx) =>
      (await tx.select({ id: tenants.id }).from(tenants)).map((row) => row.id),
    );

    let purged = 0;
    for (const tenantId of tenantIds) {
      purged += await withTenantTx(this.database.db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.tenantId, tenantId), lt(idempotencyKeys.expiresAt, now)))
          .returning({ key: idempotencyKeys.key });
        return deleted.length;
      });
    }
    return purged;
  }
}
