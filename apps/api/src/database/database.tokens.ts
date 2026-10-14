import { env } from '@erp/config';
import { createDatabase, type DatabaseHandle } from '@erp/database';

/**
 * Injection token for the Drizzle handle.
 *
 * It lives in its own module — not in `database.module.ts` — so that services and the
 * module can both import it without creating an import cycle. A cycle here leaves the
 * token `undefined` while the module file is still being evaluated, which NestJS reports
 * as an unresolvable constructor dependency.
 *
 * Integration tests override this token with a handle connected as `erp_api`
 * (NOBYPASSRLS), so RLS is genuinely enforced under test.
 */
export const DATABASE_HANDLE = 'ERP_DATABASE_HANDLE';

export function createDatabaseHandle(connectionString?: string): DatabaseHandle {
  return createDatabase(connectionString ?? env.DATABASE_URL, env.DATABASE_POOL_MAX);
}
