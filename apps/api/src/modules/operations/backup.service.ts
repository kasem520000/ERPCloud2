import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { backupRuns, restoreRuns, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

/**
 * Tables a logical backup never carries.
 *
 * The backups themselves and the append-only operational logs are excluded on purpose:
 * a snapshot of a snapshot is noise, and restoring an audit log would let someone rewrite
 * the record of what they did. Identity (`users`, `memberships`, `roles`) is excluded too
 * — this is a **business-data** export, and re-importing credentials or role grants is a
 * privilege-escalation path, not a restore.
 */
const NEVER_BACKED_UP = new Set([
  'backup_runs', 'restore_runs', 'maintenance_runs', 'company_files',
  'audit_log', 'outbox_jobs', 'idempotency_keys', 'notifications',
  'users', 'memberships', 'membership_roles', 'roles', 'role_permissions', 'permissions',
  'tenants', 'tenant_subscriptions', 'activation_requests', 'schema_migrations',
  'refresh_tokens', 'sessions', 'password_reset_tokens', 'login_attempts',
]);

/** A logical export is not a database dump; past this size it is a false promise. */
const MAX_BACKUP_ROWS = 50_000;

type Snapshot = Record<string, Array<Record<string, unknown>>>;

const asJsonParam = (value: unknown) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

/**
 * النسخ الإحتياطي و إستعادة البيانات.
 *
 * This is a **logical, tenant-scoped** backup: every table that carries `tenant_id`,
 * read through RLS so it can only ever contain this tenant's rows, serialised to JSON with
 * a checksum. It is not a substitute for `pg_dump` and the service says so out loud by
 * refusing to produce one beyond `MAX_BACKUP_ROWS` rather than emitting a truncated file
 * that would fail silently at the worst possible moment.
 *
 * Restore is deliberately **additive**: rows are inserted where they are missing and
 * skipped where the primary key already exists. Nothing is ever deleted or overwritten.
 * A destructive "replace everything" restore belongs to a fresh company file, not to a
 * button inside a live one that somebody will press on a Thursday afternoon.
 */
@Injectable()
export class BackupService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async listBackups(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: backupRuns.id, kind: backupRuns.kind, status: backupRuns.status, note: backupRuns.note,
          tables: backupRuns.tables, rowCounts: backupRuns.rowCounts, totalRows: backupRuns.totalRows,
          sizeBytes: backupRuns.sizeBytes, checksum: backupRuns.checksum, failedReason: backupRuns.failedReason,
          completedAt: backupRuns.completedAt, createdAt: backupRuns.createdAt, createdBy: backupRuns.createdBy,
        })
        .from(backupRuns)
        .where(eq(backupRuns.tenantId, tenantId))
        .orderBy(desc(backupRuns.createdAt))
        .limit(100));
  }

  /** The payload is only ever handed out one backup at a time, never in a list. */
  async download(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(backupRuns).where(and(eq(backupRuns.tenantId, tenantId), eq(backupRuns.id, id))));
    if (!row) throw new DomainError('BACKUP_NOT_FOUND', 'Backup was not found', 404);
    if (row.status !== 'ready') throw new DomainError('BACKUP_NOT_READY', 'That backup did not complete', 409);
    return { id: row.id, checksum: row.checksum, tables: row.tables, rowCounts: row.rowCounts, totalRows: row.totalRows, createdAt: row.createdAt, payload: row.payload ?? {} };
  }

  async createBackup(tenantId: string, input: { note?: string } = {}) {
    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const tables = await this.tenantTables(tx);
      const snapshot: Snapshot = {};
      const rowCounts: Record<string, number> = {};
      let totalRows = 0;

      for (const table of tables) {
        const result = await tx.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t`);
        const rows = result.rows.map((row) => (row as { row: Record<string, unknown> }).row);
        if (!rows.length) continue;
        totalRows += rows.length;
        if (totalRows > MAX_BACKUP_ROWS) {
          throw new DomainError(
            'BACKUP_TOO_LARGE',
            `This file holds more than ${MAX_BACKUP_ROWS} rows; take a physical database backup (pg_dump) instead of a logical export`,
            422,
          );
        }
        snapshot[table] = rows;
        rowCounts[table] = rows.length;
      }

      const serialised = JSON.stringify(snapshot);
      const checksum = createHash('sha256').update(serialised).digest('hex');
      await tx.insert(backupRuns).values({
        id,
        tenantId,
        kind: 'full',
        status: 'ready',
        note: input.note,
        tables: Object.keys(snapshot),
        rowCounts,
        totalRows,
        sizeBytes: Buffer.byteLength(serialised, 'utf8'),
        checksum,
        payload: snapshot,
        completedAt: new Date(),
        createdBy: tryGetAuthContext()?.userId,
      });
      const [row] = await tx.select({
        id: backupRuns.id, status: backupRuns.status, tables: backupRuns.tables, rowCounts: backupRuns.rowCounts,
        totalRows: backupRuns.totalRows, sizeBytes: backupRuns.sizeBytes, checksum: backupRuns.checksum,
        note: backupRuns.note, completedAt: backupRuns.completedAt, createdAt: backupRuns.createdAt,
      }).from(backupRuns).where(and(eq(backupRuns.tenantId, tenantId), eq(backupRuns.id, id)));
      return row;
    });
  }

  async listRestores(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(restoreRuns).where(eq(restoreRuns.tenantId, tenantId)).orderBy(desc(restoreRuns.createdAt)).limit(100));
  }

  /**
   * Restore a snapshot into this tenant. `dry_run` reports what would land; `apply`
   * inserts the missing rows. Applying demands the tenant code typed back, because the
   * one mistake that cannot be undone here is restoring last year's file into this year's.
   */
  async restore(tenantId: string, input: { backupId?: string; payload?: Snapshot; checksum?: string; mode?: 'dry_run' | 'apply'; confirmTenantCode?: string }) {
    const mode = input.mode ?? 'dry_run';
    const snapshot = await this.resolveSnapshot(tenantId, input);

    if (mode === 'apply') {
      const [tenant] = await withTenantTx(this.database.db, tenantId, (tx) => tx.execute(sql`SELECT code FROM tenants WHERE id = ${tenantId}`).then((result) => result.rows as Array<{ code: string }>));
      if (!tenant) throw new DomainError('NOT_FOUND', 'Tenant was not found', 404);
      if ((input.confirmTenantCode ?? '').trim().toLowerCase() !== tenant.code.toLowerCase()) {
        throw new DomainError('RESTORE_CONFIRMATION_REQUIRED', `Type the file code "${tenant.code}" to confirm the restore`, 422);
      }
    }

    const summary: Record<string, { rows: number; inserted: number; skipped: number; error?: string }> = {};
    const tableNames = Object.keys(snapshot);
    let inserted = 0;
    let skipped = 0;

    if (mode === 'dry_run') {
      const existing = await withTenantTx(this.database.db, tenantId, async (tx) => {
        const counts: Record<string, number> = {};
        for (const table of tableNames) {
          const result = await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)}`);
          counts[table] = Number((result.rows[0] as { count: number }).count);
        }
        return counts;
      });
      for (const table of tableNames) summary[table] = { rows: snapshot[table]!.length, inserted: 0, skipped: 0 };
      return this.recordRestore(tenantId, input.backupId, 'dry_run', { tables: summary, existingRows: existing }, 0, 0);
    }

    // Foreign keys make table order matter, and the snapshot does not carry a dependency
    // graph. Rather than guess one, retry the tables that fail until a pass makes no
    // progress — the graph resolves itself and a genuinely broken table still reports.
    let pending = [...tableNames];
    for (let pass = 0; pass < 4 && pending.length; pass += 1) {
      const failed: string[] = [];
      for (const table of pending) {
        try {
          const result = await this.insertTable(tenantId, table, snapshot[table]!);
          inserted += result.inserted;
          skipped += result.skipped;
          summary[table] = { rows: snapshot[table]!.length, inserted: result.inserted, skipped: result.skipped };
        } catch (error) {
          failed.push(table);
          summary[table] = { rows: snapshot[table]!.length, inserted: 0, skipped: 0, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
        }
      }
      if (failed.length === pending.length) break;
      pending = failed;
    }

    return this.recordRestore(tenantId, input.backupId, 'apply', { tables: summary, unresolved: pending }, inserted, skipped);
  }

  // --------------------------------------------------------------------- helpers

  private async resolveSnapshot(tenantId: string, input: { backupId?: string; payload?: Snapshot; checksum?: string }): Promise<Snapshot> {
    if (input.backupId) {
      const backup = await this.download(tenantId, input.backupId);
      return (backup.payload ?? {}) as Snapshot;
    }
    if (!input.payload || typeof input.payload !== 'object') {
      throw new DomainError('RESTORE_SOURCE_REQUIRED', 'Provide a stored backup id or an uploaded snapshot', 422);
    }
    if (input.checksum) {
      const actual = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      if (actual !== input.checksum) throw new DomainError('RESTORE_CHECKSUM_MISMATCH', 'The uploaded snapshot does not match its checksum', 422);
    }
    return input.payload;
  }

  private async insertTable(tenantId: string, table: string, rows: Array<Record<string, unknown>>) {
    if (!rows.length) return { inserted: 0, skipped: 0 };
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const known = await this.tenantTables(tx);
      if (!known.includes(table)) throw new DomainError('RESTORE_UNKNOWN_TABLE', `Unknown table ${table}`, 422);
      const before = Number((((await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)}`)).rows[0]) as { count: number }).count);
      const columns = Object.keys(rows[0]!);
      const columnList = sql.join(columns.map((column) => sql.identifier(column)), sql`, `);
      for (const row of rows) {
        // Force the tenant: a snapshot from another file cannot smuggle rows across.
        const values = columns.map((column) => (column === 'tenant_id' ? tenantId : asJsonParam(row[column] ?? null)));
        await tx.execute(sql`
          INSERT INTO ${sql.identifier(table)} (${columnList})
          VALUES (${sql.join(values.map((value) => sql`${value}`), sql`, `)})
          ON CONFLICT DO NOTHING
        `);
      }
      const after = Number((((await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)}`)).rows[0]) as { count: number }).count);
      const insertedRows = after - before;
      return { inserted: insertedRows, skipped: rows.length - insertedRows };
    });
  }

  private async recordRestore(tenantId: string, backupId: string | undefined, mode: 'dry_run' | 'apply', summary: Record<string, unknown>, inserted: number, skipped: number) {
    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(restoreRuns).values({ id, tenantId, backupId, mode, status: 'ready', summary, insertedRows: inserted, skippedRows: skipped, createdBy: tryGetAuthContext()?.userId });
      const [row] = await tx.select().from(restoreRuns).where(and(eq(restoreRuns.tenantId, tenantId), eq(restoreRuns.id, id)));
      return row;
    });
  }

  /** Every tenant-scoped table, discovered from the catalog so new modules are covered. */
  private async tenantTables(tx: DrizzleTx) {
    const result = await tx.execute(sql`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name
    `);
    return (result.rows as Array<{ table_name: string }>).map((row) => row.table_name).filter((table) => !NEVER_BACKED_UP.has(table));
  }
}
