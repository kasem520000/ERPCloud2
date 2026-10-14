import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 قابلية عكس الترحيل `0123` — a forward migration is only acceptable when it is
 * idempotent **and** reversible (PHASE_03 §6), and `0123` widens two CHECK constraints that
 * earlier migrations created. This spec runs the real SQL files against a throwaway test
 * database — never a production one — in the order an operator would:
 *
 *   1. the up file is already applied by the harness ⇒ assert the new shape exists;
 *   2. apply the up file a second time ⇒ it must be a no-op (idempotent);
 *   3. apply the down file ⇒ the columns and the widened constraints go away;
 *   4. apply the up file again ⇒ the shape comes back exactly as before.
 *
 * It also asserts the historical file `0122` is byte-identical to what the runner recorded in
 * `erp_migrations`, because editing an applied migration is a hard error for the runner and a
 * silent corruption for every environment that already applied it.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0123_van_sales_rep_workspace_and_receipt_workflow.sql';
const DOWN_NAME = 'down/0123_van_sales_rep_workspace_and_receipt_workflow.down.sql';
const PREVIOUS_NAME = '0122_van_sales_core_integration_and_idempotency.sql';

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0123 — van-sales rep workspace & receipt workflow', () => {
  let ctx: TestApp;
  let pool: Pool;

  beforeAll(async () => {
    ctx = await createTestApp('migration_0123');
    // Owner (superuser) connection: DDL is not something the RLS-restricted app role may run.
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  const columnExists = async (table: string, column: string): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return result.rowCount === 1;
  };

  const constraintDefinition = async (table: string, constraint: string): Promise<string | null> => {
    const result = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = $1::regclass AND conname = $2`,
      [table, constraint],
    );
    return (result.rows[0] as { definition: string } | undefined)?.definition ?? null;
  };

  it('creates the receipt-workflow shape and is idempotent when re-applied', async () => {
    // 1. The harness already applied every migration, so the new shape must be there.
    expect(await columnExists('salesmen', 'warehouse_id')).toBe(true);
    expect(await columnExists('salesmen', 'vehicle_plate')).toBe(true);
    expect(await columnExists('factory_production_batches', 'branch_id')).toBe(true);
    expect(await columnExists('van_load_orders', 'received_qty')).toBe(true);
    expect(await columnExists('van_load_orders', 'discrepancy_qty')).toBe(true);
    expect(await columnExists('van_load_orders', 'actual_remaining_qty')).toBe(true);
    expect(await columnExists('van_load_orders', 'inventory_tx_id')).toBe(true);
    expect(await columnExists('van_sales_documents', 'document_kind')).toBe(true);
    expect(await columnExists('van_sales_documents', 'reference_document_id')).toBe(true);

    const status = await constraintDefinition('van_load_orders', 'van_load_orders_status_check');
    expect(status).toContain('pending_receipt');
    expect(status).toContain('rejected');
    // Widened, never narrowed: the pre-existing states survive.
    for (const legacy of ['draft', 'loaded', 'in_route', 'pending_closing', 'settled', 'reconciled', 'canceled']) {
      expect(status, `legacy status ${legacy} must survive`).toContain(legacy);
    }

    const movement = await constraintDefinition(
      'van_stock_movements',
      'van_stock_movements_movement_type_check',
    );
    for (const kind of [
      'production_in',
      'van_load',
      'van_sale',
      'van_bonus',
      'van_return',
      'van_damage',
      'van_shortage',
      'stocktake_adjustment',
      'collection_receipt',
      'van_receipt_confirmed',
      'van_receipt_discrepancy',
      'customer_return',
    ]) {
      expect(movement, `movement type ${kind} must be allowed`).toContain(kind);
    }

    // 2. Re-applying the up file changes nothing and fails on nothing.
    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('van_load_orders', 'received_qty')).toBe(true);
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    await pool.query(await readSql(DOWN_NAME));

    expect(await columnExists('salesmen', 'warehouse_id')).toBe(false);
    expect(await columnExists('salesmen', 'vehicle_plate')).toBe(false);
    expect(await columnExists('factory_production_batches', 'branch_id')).toBe(false);
    expect(await columnExists('van_load_orders', 'received_qty')).toBe(false);
    expect(await columnExists('van_load_orders', 'actual_remaining_qty')).toBe(false);
    expect(await columnExists('van_sales_documents', 'document_kind')).toBe(false);
    expect(await columnExists('van_sales_documents', 'reference_document_id')).toBe(false);

    // The rolled-back movement-type list is the one `0120` wrote.
    const movement = await constraintDefinition(
      'van_stock_movements',
      'van_stock_movements_movement_type_check',
    );
    expect(movement).not.toContain('van_receipt_confirmed');
    expect(movement).toContain('collection_receipt');

    // `0122`'s own additions are untouched by the rollback of `0123`.
    expect(await columnExists('van_load_orders', 'stock_transfer_id')).toBe(true);
    expect(await columnExists('van_load_orders', 'shortage_policy_status')).toBe(true);
    expect(await columnExists('van_stock_movements', 'inventory_transaction_id')).toBe(true);

    // 4. Forward again — the migration is reusable, not one-shot.
    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('van_load_orders', 'received_qty')).toBe(true);
    expect(await columnExists('salesmen', 'warehouse_id')).toBe(true);
    const status = await constraintDefinition('van_load_orders', 'van_load_orders_status_check');
    expect(status).toContain('pending_receipt');
  });

  it('leaves the historical migration 0122 exactly as it was recorded', async () => {
    const result = await pool.query(
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' ORDER BY name`,
    );
    const recorded = new Map(
      (result.rows as Array<{ name: string; checksum: string }>).map((row) => [row.name, row.checksum]),
    );

    for (const name of [PREVIOUS_NAME, UP_NAME]) {
      const onDisk = await readSql(name);
      expect(recorded.get(name), `${name} must be recorded as applied`).toBeTruthy();
      expect(sha256(onDisk), `${name} must not be edited after it was applied`).toBe(recorded.get(name));
    }
  });
});
