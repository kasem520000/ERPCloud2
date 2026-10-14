import { startTestDatabaseServer } from '@erp/testing/database';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * Starts ONE PostgreSQL server for the whole vitest run and hands its coordinates to the
 * test files through `inject()`.
 *
 * With `TEST_DATABASE_URL` set (CI / docker-compose) the external server is used;
 * otherwise an embedded PostgreSQL 16 cluster is booted so `pnpm verify` needs no Docker.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const server = await startTestDatabaseServer({
    log: (message) => console.log(`[test-db] ${message}`),
  });

  provide('testDatabaseSuperUserUrl', server.superUserUrl);
  provide('testDatabaseRolePassword', server.rolePassword);

  return async () => {
    await server.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseSuperUserUrl: string;
    testDatabaseRolePassword: string;
  }
}
