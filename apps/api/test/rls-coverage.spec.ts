import { provisionTestDatabase, startTestDatabaseServer, type ProvisionedDatabase } from '@erp/testing/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

/**
 * P0-1 — catalog-driven RLS coverage (docs/IMPLEMENTATION_ROADMAP.md).
 *
 * The source of truth is the migrated catalog, not a hand-maintained list: every table in
 * `public` that carries a `tenant_id` column must have RLS ENABLED, FORCED (so the owner is
 * subject to it too) and at least one policy. A new tenant table that forgets any of the
 * three fails this suite.
 *
 * Tables that are intentionally outside tenant RLS must be listed in `CONTROL_PLANE_TABLES`
 * with the reason; the list is itself checked so a stale entry cannot linger.
 */
const CONTROL_PLANE_TABLES: Record<string, string> = {};

type TableSecurity = {
  table: string;
  enabled: boolean;
  forced: boolean;
  policies: number;
};

describe('RLS coverage — every tenant table is enabled, forced and has a policy', () => {
  let stop: (() => Promise<void>) | undefined;
  let db: ProvisionedDatabase;
  let pool: Pool;
  let rows: TableSecurity[] = [];

  beforeAll(async () => {
    process.env.TEST_DATABASE_URL = inject('testDatabaseSuperUserUrl');
    process.env.TEST_DATABASE_ROLE_PASSWORD = inject('testDatabaseRolePassword');
    const server = await startTestDatabaseServer();
    db = await provisionTestDatabase(server, `erp_test_rls_coverage_${process.pid}`);
    stop = () => server.dropDatabase(db.name);
    pool = new Pool({ connectionString: db.ownerUrl, max: 1 });

    const result = await pool.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
      policies: string;
    }>(`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
         )
       ORDER BY c.relname`);
    rows = result.rows.map((row) => ({ ...row, policies: Number(row.policies) }));
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await stop?.();
  });

  it('finds the tenant tables in the catalog', () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it('has no tenant table without ENABLE + FORCE RLS and a policy', () => {
    const gaps = rows
      .filter((row) => !(row.table in CONTROL_PLANE_TABLES))
      .filter((row) => !row.enabled || !row.forced || row.policies === 0)
      .map((row) => {
        const missing = [
          row.enabled ? null : 'ENABLE',
          row.forced ? null : 'FORCE',
          row.policies > 0 ? null : 'POLICY',
        ].filter(Boolean);
        return `${row.table}: missing ${missing.join(', ')}`;
      });
    expect(gaps).toEqual([]);
  });

  it('keeps the control-plane allow-list accurate', () => {
    const tenantTables = new Set(rows.map((row) => row.table));
    const stale = Object.keys(CONTROL_PLANE_TABLES).filter((table) => !tenantTables.has(table));
    expect(stale).toEqual([]);
  });
});
