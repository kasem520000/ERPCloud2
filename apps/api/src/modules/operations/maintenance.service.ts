import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { maintenanceRuns, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

/**
 * Operational logs are the only thing rotation is allowed to delete. Financial documents
 * are never purged here: the desktop habit of "rotating" invoices out of the file is what
 * a new company file is for, and a system that can silently delete a posted invoice is
 * not an accounting system.
 *
 * `audit_log` is absent by necessity as much as by choice — migration 0001 revokes DELETE
 * on it from the application role, so the audit trail survives even a compromised tenant
 * admin. Trimming it is a DBA retention job, not a button in الإعدادات.
 */
const ROTATABLE = [
  { table: 'notifications', column: 'created_at', labelAr: 'الإشعارات' },
  { table: 'outbox_jobs', column: 'created_at', labelAr: 'مهام الإرسال' },
  { table: 'idempotency_keys', column: 'created_at', labelAr: 'مفاتيح منع التكرار' },
] as const;

/** Documents counted for information only — rotation never touches them. */
const PRESERVED = [
  { table: 'sales_invoices', column: 'created_at', labelAr: 'فواتير المبيعات' },
  { table: 'purchase_invoices', column: 'created_at', labelAr: 'فواتير المشتريات' },
  { table: 'vouchers', column: 'date', labelAr: 'السندات' },
  { table: 'journal_entries', column: 'date', labelAr: 'القيود' },
  { table: 'inventory_transactions', column: 'occurred_at', labelAr: 'حركات المخزون' },
] as const;

/** Anything newer than this is still in daily use; rotating it is data loss, not hygiene. */
const MIN_ROTATION_AGE_DAYS = 90;

const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/**
 * تدوير البيانات و صيانة الفواتير.
 *
 * Both are the same shape: a **preview** that only counts, and an **apply** that only
 * performs the subset of repairs that cannot destroy information. What each one refuses
 * to do is the important part —
 *
 * * rotation deletes operational logs and nothing else, and only past a 90-day floor;
 * * maintenance recomputes the totals of **draft** invoices only. A posted invoice whose
 *   stored total disagrees with its lines is reported, never rewritten: it has been sent
 *   to a customer and possibly to ZATCA, so the fix is a credit note, not a silent edit.
 */
@Injectable()
export class MaintenanceService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async listRuns(tenantId: string, kind?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(maintenanceRuns)
        .where(and(eq(maintenanceRuns.tenantId, tenantId), kind ? eq(maintenanceRuns.kind, kind) : undefined))
        .orderBy(desc(maintenanceRuns.createdAt))
        .limit(100));
  }

  // ------------------------------------------------------------- data rotation

  async rotation(tenantId: string, input: { cutoffDate: string; mode?: 'preview' | 'apply'; confirm?: boolean; backupId?: string }) {
    const mode = input.mode ?? 'preview';
    if (!input.cutoffDate) throw new DomainError('ROTATION_CUTOFF_REQUIRED', 'A cutoff date is required', 422);
    const cutoff = new Date(`${input.cutoffDate}T00:00:00.000Z`);
    if (Number.isNaN(cutoff.getTime())) throw new DomainError('ROTATION_CUTOFF_INVALID', 'The cutoff date is not a date', 422);
    const age = daysBetween(cutoff, new Date());
    if (age < MIN_ROTATION_AGE_DAYS) {
      throw new DomainError('ROTATION_CUTOFF_TOO_RECENT', `The cutoff must be at least ${MIN_ROTATION_AGE_DAYS} days in the past; this one is ${age}`, 422);
    }

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rotatable: Record<string, { labelAr: string; rows: number }> = {};
      for (const target of ROTATABLE) {
        const result = await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(target.table)} WHERE ${sql.identifier(target.column)} < ${input.cutoffDate}::date`);
        rotatable[target.table] = { labelAr: target.labelAr, rows: Number((result.rows[0] as { count: number }).count) };
      }
      const preserved: Record<string, { labelAr: string; rows: number }> = {};
      for (const target of PRESERVED) {
        const result = await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(target.table)} WHERE ${sql.identifier(target.column)} < ${input.cutoffDate}::date`);
        preserved[target.table] = { labelAr: target.labelAr, rows: Number((result.rows[0] as { count: number }).count) };
      }

      const findings = {
        cutoffDate: input.cutoffDate,
        rotatable,
        preserved,
        retainedByDesign: { audit_log: { labelAr: 'سجل التدقيق', reasonAr: 'سجل التدقيق غير قابل للحذف من التطبيق (append-only)' } },
      };
      const applied: Record<string, number> = {};
      if (mode === 'apply') {
        if (!input.confirm) throw new DomainError('ROTATION_CONFIRMATION_REQUIRED', 'Rotation deletes operational logs; confirm the run explicitly', 422);
        for (const target of ROTATABLE) {
          const result = await tx.execute(sql`DELETE FROM ${sql.identifier(target.table)} WHERE ${sql.identifier(target.column)} < ${input.cutoffDate}::date`);
          applied[target.table] = result.rowCount ?? 0;
        }
      }

      const id = newId();
      await tx.insert(maintenanceRuns).values({
        id, tenantId, kind: 'data_rotation', mode, status: 'ready',
        cutoffDate: input.cutoffDate, backupId: input.backupId, findings, applied,
        createdBy: tryGetAuthContext()?.userId,
      });
      const [row] = await tx.select().from(maintenanceRuns).where(and(eq(maintenanceRuns.tenantId, tenantId), eq(maintenanceRuns.id, id)));
      return row;
    });
  }

  // -------------------------------------------------------- invoice maintenance

  async invoiceMaintenance(tenantId: string, input: { mode?: 'preview' | 'apply'; staleDraftDays?: number } = {}) {
    const mode = input.mode ?? 'preview';
    const staleDays = input.staleDraftDays ?? 30;

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      // 1. Stored header totals that disagree with the sum of their own lines.
      const mismatched = (await tx.execute(sql`
        SELECT si.id, si.number, si.status, si.kind, si.total::text AS stored_total,
               coalesce(sum(line.total), 0)::text AS line_total
        FROM sales_invoices si
        LEFT JOIN sales_invoice_lines line ON line.invoice_id = si.id
        GROUP BY si.id, si.number, si.status, si.kind, si.total
        HAVING abs(si.total - coalesce(sum(line.total), 0)) > 0.005
        ORDER BY si.created_at DESC
        LIMIT 200
      `)).rows as Array<{ id: string; number: string | null; status: string; kind: string; stored_total: string; line_total: string }>;

      // 2. Posted invoices with no journal entry behind them.
      const unposted = (await tx.execute(sql`
        SELECT si.id, si.number, si.status, si.total::text AS total
        FROM sales_invoices si
        WHERE si.status = 'posted'
          AND NOT EXISTS (
            SELECT 1 FROM journal_entries je
            WHERE je.tenant_id = si.tenant_id AND je.source_type = 'sales_invoice' AND je.source_id = si.id
          )
        ORDER BY si.posted_at DESC NULLS LAST
        LIMIT 200
      `)).rows as Array<{ id: string; number: string | null; status: string; total: string }>;

      // 3. Gaps in a numbering series — the classic sign of a document that vanished.
      const gaps = (await tx.execute(sql`
        WITH numbered AS (
          SELECT substring(number from '^[A-Z]+-') AS prefix,
                 nullif(regexp_replace(number, '^[A-Z]+-', ''), '')::bigint AS seq
          FROM sales_invoices
          WHERE number IS NOT NULL AND number ~ '^[A-Z]+-[0-9]+$'
        )
        SELECT prefix, min(seq)::text AS first_seq, max(seq)::text AS last_seq,
               count(*)::int AS issued, (max(seq) - min(seq) + 1 - count(*))::int AS missing
        FROM numbered
        GROUP BY prefix
        HAVING (max(seq) - min(seq) + 1 - count(*)) > 0
      `)).rows as Array<{ prefix: string; first_seq: string; last_seq: string; issued: number; missing: number }>;

      // 4. Drafts nobody came back to.
      const stale = (await tx.execute(sql`
        SELECT id, number, created_at, total::text AS total
        FROM sales_invoices
        WHERE status = 'draft' AND created_at < now() - (${staleDays}::text || ' days')::interval
        ORDER BY created_at
        LIMIT 200
      `)).rows as Array<{ id: string; number: string | null; created_at: string; total: string }>;

      const repairable = mismatched.filter((row) => row.status === 'draft');
      const findings = {
        totalsMismatch: mismatched.map((row) => ({ ...row, repairable: row.status === 'draft' })),
        postedWithoutJournal: unposted,
        numberingGaps: gaps,
        staleDrafts: stale,
        counts: {
          totalsMismatch: mismatched.length,
          repairableTotals: repairable.length,
          postedWithoutJournal: unposted.length,
          numberingGaps: gaps.reduce((sum, row) => sum + Number(row.missing), 0),
          staleDrafts: stale.length,
        },
      };

      const applied: Record<string, unknown> = {};
      if (mode === 'apply') {
        const repaired: Array<{ id: string; from: string; to: string }> = [];
        for (const row of repairable) {
          const recomputed = new Decimal(row.line_total);
          await tx.execute(sql`
            UPDATE sales_invoices
            SET subtotal = (SELECT coalesce(sum(net), 0) FROM sales_invoice_lines WHERE invoice_id = ${row.id}),
                tax_total = (SELECT coalesce(sum(tax), 0) FROM sales_invoice_lines WHERE invoice_id = ${row.id}),
                total = ${recomputed.toFixed(4)},
                updated_at = now()
            WHERE id = ${row.id} AND status = 'draft'
          `);
          repaired.push({ id: row.id, from: row.stored_total, to: recomputed.toFixed(4) });
        }
        applied.repairedDraftTotals = repaired;
        // Everything else is reported, not touched: a posted document is evidence.
        applied.leftForReview = {
          postedTotalsMismatch: mismatched.length - repairable.length,
          postedWithoutJournal: unposted.length,
          numberingGaps: findings.counts.numberingGaps,
        };
      }

      const id = newId();
      await tx.insert(maintenanceRuns).values({
        id, tenantId, kind: 'invoice_maintenance', mode, status: 'ready', findings, applied,
        createdBy: tryGetAuthContext()?.userId,
      });
      const [row] = await tx.select().from(maintenanceRuns).where(and(eq(maintenanceRuns.tenantId, tenantId), eq(maintenanceRuns.id, id)));
      return row;
    });
  }
}
