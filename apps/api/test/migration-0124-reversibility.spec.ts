import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 قابلية عكس الترحيل `0124` — the settlement migration adds the columns that keep a custody
 * open while the official stock ledger disagrees with the physical count. Like every forward
 * migration here it has to be idempotent **and** reversible, and — because it widens two CHECK
 * constraints that `0120`/`0123` created — its rollback must never narrow a constraint while a
 * live row still depends on the newer value. That is the difference between a rollback and a
 * corrupted database.
 *
 * Runs the real SQL files against a throwaway test database (never production):
 *
 *   1. the harness already applied the up file ⇒ assert the new shape;
 *   2. apply the up file again ⇒ a no-op (idempotent);
 *   3. apply the down file on an empty table ⇒ the shape goes away, `0123` stays;
 *   4. put a row in the new state, apply the down file again ⇒ the constraint is **not**
 *      narrowed, so no live row becomes invalid;
 *   5. apply the up file again ⇒ the shape comes back exactly;
 *   6. `0123` and `0124` are byte-identical to what the runner recorded (no edited history).
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0124_van_sales_stock_and_custody_settlement.sql';
const DOWN_NAME = 'down/0124_van_sales_stock_and_custody_settlement.down.sql';
const PREVIOUS_NAME = '0123_van_sales_rep_workspace_and_receipt_workflow.sql';

const readSql = (relative: string): Promise<string> =>
  fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0124 — van-sales stock & custody settlement', () => {
  let ctx: TestApp;
  let pool: Pool;

  beforeAll(async () => {
    ctx = await createTestApp('migration_0124');
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

  const indexExists = async (index: string): Promise<boolean> => {
    const result = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [index]);
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

  it('creates the settlement shape and is idempotent when re-applied', async () => {
    for (const column of [
      'stock_adjustment_id',
      'remaining_action',
      'remaining_inventory_tx_id',
      'stock_settlement_status',
      'stock_settlement_note',
      'damage_journal_entry_id',
    ]) {
      expect(await columnExists('van_load_orders', column), `${column} must exist`).toBe(true);
    }
    expect(await indexExists('van_load_orders_settlement_idx')).toBe(true);

    // Widened, never narrowed: every state `0120`/`0123` allowed still survives.
    const status = await constraintDefinition('van_load_orders', 'van_load_orders_status_check');
    expect(status).toContain('pending_stock_settlement');
    for (const legacy of [
      'draft',
      'pending_receipt',
      'loaded',
      'in_route',
      'pending_closing',
      'settled',
      'reconciled',
      'rejected',
      'canceled',
    ]) {
      expect(status, `legacy status ${legacy} must survive`).toContain(legacy);
    }

    const movement = await constraintDefinition(
      'van_stock_movements',
      'van_stock_movements_movement_type_check',
    );
    for (const kind of [
      'van_receipt_rejected',
      'van_load_canceled',
      'van_transit_difference',
      'van_count_settlement',
      'van_load',
      'van_sale',
      'van_damage',
      'van_shortage',
      'collection_receipt',
    ]) {
      expect(movement, `movement type ${kind} must be allowed`).toContain(kind);
    }

    const settlement = await constraintDefinition(
      'van_load_orders',
      'van_load_orders_stock_settlement_status_check',
    );
    for (const state of [
      'not_required',
      'pending_transit_decision',
      'pending_count_decision',
      'blocked_missing_accounts',
      'settled_officially',
    ]) {
      expect(settlement, `settlement state ${state} must be allowed`).toContain(state);
    }

    // Re-applying the up file changes nothing and fails on nothing.
    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('van_load_orders', 'stock_adjustment_id')).toBe(true);
  });

  it('rolls back on an empty table and comes back through the up file', async () => {
    await pool.query(await readSql(DOWN_NAME));

    for (const column of [
      'stock_adjustment_id',
      'remaining_action',
      'remaining_inventory_tx_id',
      'stock_settlement_status',
      'stock_settlement_note',
      'damage_journal_entry_id',
    ]) {
      expect(await columnExists('van_load_orders', column), `${column} must be dropped`).toBe(false);
    }
    expect(await indexExists('van_load_orders_settlement_idx')).toBe(false);

    const movement = await constraintDefinition(
      'van_stock_movements',
      'van_stock_movements_movement_type_check',
    );
    expect(movement).not.toContain('van_count_settlement');
    expect(movement).toContain('van_load');

    // `0123`'s own additions are untouched by the rollback of `0124`.
    expect(await columnExists('van_load_orders', 'received_qty')).toBe(true);
    expect(await columnExists('van_load_orders', 'actual_remaining_qty')).toBe(true);
    expect(await columnExists('salesmen', 'warehouse_id')).toBe(true);
    const status = await constraintDefinition('van_load_orders', 'van_load_orders_status_check');
    expect(status).toContain('pending_receipt');
    expect(status).not.toContain('pending_stock_settlement');

    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('van_load_orders', 'stock_settlement_status')).toBe(true);
    expect(
      await constraintDefinition('van_load_orders', 'van_load_orders_status_check'),
    ).toContain('pending_stock_settlement');
  });

  it('never narrows the status constraint while a live row depends on the new state', async () => {
    // A custody that was approved but not settled yet — exactly the row `0124` exists for.
    await pool.query(`
      INSERT INTO tenants (id, code, name)
      VALUES ('11111111-1111-4111-8111-111111111111', 'mig-0124', 'منشأة اختبار الترحيل 0124')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO salesmen (id, tenant_id, name)
      VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'مندوب الاختبار')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO van_load_orders (
        id, tenant_id, salesman_id, number, status, loaded_qty,
        remaining_action, stock_settlement_status, stock_settlement_note
      ) VALUES (
        '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', 'VLO-0124', 'pending_stock_settlement', 20,
        'carry_over', 'pending_count_decision', 'فرق جرد 0.5 كجم بانتظار تسوية مخزنية'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await pool.query(await readSql(DOWN_NAME));

    // The row survived, still in its state: the rollback refused to narrow the constraint.
    const rows = await pool.query(
      `SELECT status FROM van_load_orders WHERE id = '33333333-3333-4333-8333-333333333333'`,
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { status: string }).status).toBe('pending_stock_settlement');
    const status = await constraintDefinition('van_load_orders', 'van_load_orders_status_check');
    expect(status).toContain('pending_stock_settlement');
    // The settlement columns are gone, but nothing was invalidated to get rid of them.
    expect(await columnExists('van_load_orders', 'stock_settlement_status')).toBe(false);

    // Forward again, then clean the fixture up.
    await pool.query(await readSql(UP_NAME));
    expect(await columnExists('van_load_orders', 'stock_settlement_status')).toBe(true);
    const restored = await pool.query(
      `SELECT status, stock_settlement_status FROM van_load_orders
       WHERE id = '33333333-3333-4333-8333-333333333333'`,
    );
    expect((restored.rows[0] as { status: string }).status).toBe('pending_stock_settlement');
    // A dropped column comes back at its default — the state itself has to be re-derived by the
    // settlement endpoint, which is why the order stays `pending_stock_settlement`.
    expect((restored.rows[0] as { stock_settlement_status: string }).stock_settlement_status).toBe(
      'not_required',
    );

    await pool.query(`DELETE FROM van_load_orders WHERE id = '33333333-3333-4333-8333-333333333333'`);
    await pool.query(`DELETE FROM salesmen WHERE id = '22222222-2222-4222-8222-222222222222'`);
    await pool.query(`DELETE FROM tenants WHERE id = '11111111-1111-4111-8111-111111111111'`);
  });

  it('leaves the historical migrations exactly as they were recorded', async () => {
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
