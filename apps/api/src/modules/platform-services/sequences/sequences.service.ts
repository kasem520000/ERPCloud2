import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  formatSequenceNumber,
  type SequenceAllocation,
} from '@erp/contracts';
import {
  documentSequences,
  newId,
  SEQUENCE_SCOPE_NIL_UUID,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

/**
 * Document numbering — DATABASE_DESIGN §3, BL-1:
 * "Allocation: `INSERT … ON CONFLICT DO UPDATE SET current_value = … RETURNING` under tx".
 *
 * How later modules use it:
 *
 * ```ts
 * await withTenantTx(db, tenantId, async (tx) => {
 *   const number = await sequences.next({ tenantId, docType: 'sales_invoice', branchId }, tx);
 *   await tx.insert(salesInvoices).values({ …, number: number.display });
 * });
 * ```
 *
 * Always pass the caller's `tx`: the allocation must share the fate of the document it
 * numbers, otherwise a rolled-back invoice burns a number (a gap an auditor will ask
 * about). The single upsert statement takes a row lock, so N concurrent allocations
 * queue on it and every caller gets a distinct, monotonic value — proven by the
 * 64-parallel test in `test/sequences.spec.ts`.
 */

export type SequenceScope = {
  tenantId: string;
  docType: string;
  /** NULL/omitted = tenant-wide numbering. */
  branchId?: string | null;
  /** NULL/omitted = the sequence does not restart per fiscal year. */
  fiscalYearId?: string | null;
};

export type SequenceOptions = {
  /** Used only when the sequence row is created; afterwards the stored value wins. */
  prefix?: string;
  padding?: number;
};

/** `bigint` columns come back as strings on some drivers; normalise once, here. */
function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DomainError(errorCodes.SEQUENCE_EXHAUSTED, 'Sequence value exceeded the safe integer range', 422);
  }
  return parsed;
}

@Injectable()
export class SequencesService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /**
   * Allocates the next number in the scope. Pass `tx` to join a business transaction
   * (the normal case); without it the allocation commits on its own.
   */
  async next(
    scope: SequenceScope,
    tx?: DrizzleTx,
    options: SequenceOptions = {},
  ): Promise<SequenceAllocation> {
    if (tx) return this.allocate(tx, scope, options);
    return withTenantTx(this.database.db, scope.tenantId, (own) => this.allocate(own, scope, options));
  }

  private async allocate(
    tx: DrizzleTx,
    scope: SequenceScope,
    options: SequenceOptions,
  ): Promise<SequenceAllocation> {
    const prefix = options.prefix ?? '';
    const padding = options.padding ?? 6;
    if (padding < 1 || padding > 18) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'padding must be between 1 and 18', 400, {
        field: 'padding',
      });
    }

    // One statement: insert the scope row or bump it, and return the allocated value.
    // The ON CONFLICT arbiter mirrors `document_sequences_scope_key` exactly — see
    // `SEQUENCE_SCOPE_NIL_UUID` in the schema for why COALESCE is involved.
    const result = await tx.execute(sql`
      INSERT INTO document_sequences (id, tenant_id, branch_id, doc_type, fiscal_year_id, prefix, padding, current_value, updated_at)
      VALUES (${newId()}, ${scope.tenantId}, ${scope.branchId ?? null}, ${scope.docType},
              ${scope.fiscalYearId ?? null}, ${prefix}, ${padding}, 1, now())
      ON CONFLICT (
        tenant_id,
        coalesce(branch_id, ${SEQUENCE_SCOPE_NIL_UUID}::uuid),
        doc_type,
        coalesce(fiscal_year_id, ${SEQUENCE_SCOPE_NIL_UUID}::uuid)
      )
      DO UPDATE SET current_value = document_sequences.current_value + 1, updated_at = now()
      RETURNING current_value, prefix, padding
    `);

    const row = rowsOf<{ current_value: string | number; prefix: string; padding: number }>(result)[0];
    if (!row) {
      throw new DomainError(errorCodes.SEQUENCE_EXHAUSTED, 'Sequence allocation returned no row', 422);
    }

    const value = toCount(row.current_value);
    return {
      value,
      prefix: row.prefix,
      padding: row.padding,
      display: formatSequenceNumber(value, row.prefix, row.padding),
    };
  }

  /** Current value without allocating — for admin screens and reconciliation. */
  async peek(scope: SequenceScope): Promise<SequenceAllocation | undefined> {
    return withTenantTx(this.database.db, scope.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(documentSequences)
        .where(this.scopePredicate(scope))
        .limit(1);

      if (!row) return undefined;
      const value = toCount(row.currentValue);
      return {
        value,
        prefix: row.prefix,
        padding: row.padding,
        display: formatSequenceNumber(value, row.prefix, row.padding),
      };
    });
  }

  /**
   * Sets the prefix/padding of a scope (ADMIN_PANEL §1 "Sequences/numbering admin").
   * `current_value` is never lowered here: rewinding a sequence would re-issue a number
   * that already exists on a posted document.
   */
  async configure(scope: SequenceScope, options: SequenceOptions): Promise<SequenceAllocation> {
    return withTenantTx(this.database.db, scope.tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(documentSequences)
        .where(this.scopePredicate(scope))
        .limit(1);

      if (!existing) {
        const id = newId();
        const [created] = await tx
          .insert(documentSequences)
          .values({
            id,
            tenantId: scope.tenantId,
            branchId: scope.branchId ?? null,
            docType: scope.docType,
            fiscalYearId: scope.fiscalYearId ?? null,
            prefix: options.prefix ?? '',
            padding: options.padding ?? 6,
            currentValue: 0,
          })
          .returning();
        const row = created as typeof documentSequences.$inferSelect;
        return {
          value: 0,
          prefix: row.prefix,
          padding: row.padding,
          display: formatSequenceNumber(0, row.prefix, row.padding),
        };
      }

      const [updated] = await tx
        .update(documentSequences)
        .set({
          prefix: options.prefix ?? existing.prefix,
          padding: options.padding ?? existing.padding,
          updatedAt: new Date(),
        })
        .where(eq(documentSequences.id, existing.id))
        .returning();

      const row = (updated ?? existing) as typeof documentSequences.$inferSelect;
      const value = toCount(row.currentValue);
      return {
        value,
        prefix: row.prefix,
        padding: row.padding,
        display: formatSequenceNumber(value, row.prefix, row.padding),
      };
    });
  }

  private scopePredicate(scope: SequenceScope) {
    return and(
      eq(documentSequences.tenantId, scope.tenantId),
      eq(documentSequences.docType, scope.docType),
      sql`coalesce(${documentSequences.branchId}, ${SEQUENCE_SCOPE_NIL_UUID}::uuid) = coalesce(${
        scope.branchId ?? null
      }::uuid, ${SEQUENCE_SCOPE_NIL_UUID}::uuid)`,
      sql`coalesce(${documentSequences.fiscalYearId}, ${SEQUENCE_SCOPE_NIL_UUID}::uuid) = coalesce(${
        scope.fiscalYearId ?? null
      }::uuid, ${SEQUENCE_SCOPE_NIL_UUID}::uuid)`,
    );
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}
