import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@erp/config';

import { setPlatformAdminContext, setTenantContext } from './rls.js';
import * as schema from './schema/index.js';

/**
 * Drizzle client factory + transaction helpers.
 *
 * `withTenantTx` is the only sanctioned way to touch a tenant-scoped table: it opens a
 * transaction, binds `app.tenant_id` transaction-locally and then runs the work, so the
 * RLS policies of MULTI_TENANCY §3 apply to every statement inside
 * (AI_DEVELOPMENT_PROTOCOL §4: "financial ops inside one tx; never nest manual tx").
 */

export type DrizzleSchema = typeof schema;
export type DrizzleDb = NodePgDatabase<DrizzleSchema>;
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export const DEFAULT_DEV_DATABASE_URL = 'postgres://erp_api:app-dev-password@localhost:5432/app';

export type DatabaseHandle = {
  db: DrizzleDb;
  pool: Pool;
  close(): Promise<void>;
};

export function createPool(connectionString?: string, max?: number): Pool {
  return new Pool({
    connectionString: connectionString ?? env.DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    max: max ?? env.DATABASE_POOL_MAX,
  });
}

export function createDatabase(connectionString?: string, max?: number): DatabaseHandle {
  const pool = createPool(connectionString, max);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/** @deprecated prefer `createDatabase()` so the pool can be closed deterministically. */
export function createDbClient(connectionString?: string): DrizzleDb {
  return createDatabase(connectionString).db;
}

let singleton: DatabaseHandle | undefined;

export function getDatabase(): DatabaseHandle {
  if (!singleton) {
    singleton = createDatabase();
  }
  return singleton;
}

export function getDb(): DrizzleDb {
  return getDatabase().db;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
  }
}

/** Runs `work` inside a single transaction. Platform-scope only (no tenant GUC). */
export async function withTx<T>(db: DrizzleDb, work: (tx: DrizzleTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => work(tx));
}

/**
 * Runs `work` inside a transaction with the tenant bound to `app.tenant_id`
 * (MULTI_TENANCY §3.3). Required for every tenant-scoped read or write.
 */
export async function withTenantTx<T>(
  db: DrizzleDb,
  tenantId: string,
  work: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return work(tx);
  });
}

/**
 * Platform-admin (control plane) transaction — MULTI_TENANCY §4.
 *
 * Binds `app.is_platform_admin = 'on'` transaction-locally so the `platform_admin_plane`
 * policies of migration 0020 match. It deliberately does NOT set `app.tenant_id`: the
 * control plane reads across tenants, and leaving the tenant GUC unset means every
 * canonical isolation policy still evaluates to NULL = no rows. The elevated scope
 * disappears at COMMIT/ROLLBACK, so a pooled connection cannot leak it.
 *
 * The caller MUST have already proved `is_platform_admin` (PlatformAdminGuard).
 */
export async function withPlatformAdminTx<T>(
  db: DrizzleDb,
  work: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setPlatformAdminContext(tx, true);
    return work(tx);
  });
}

export { schema };
