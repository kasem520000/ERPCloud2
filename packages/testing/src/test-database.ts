import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { env } from '@erp/config';
import { runMigrations, seedPermissionRegistry } from '@erp/database';

/**
 * Test database provisioning (TESTING_STRATEGY §1: "integration (supertest +
 * Testcontainers PG: API ↔ DB real)").
 *
 * Two modes:
 *  - `TEST_DATABASE_URL` set → use that server (CI / local docker-compose / Testcontainers).
 *  - otherwise → boot an **embedded PostgreSQL 16** (dev dependency) so `pnpm verify`
 *    is self-contained on machines without Docker. Recorded in docs/STATUS.md.
 *
 * Migrations always run through the superuser/owner connection; the API under test
 * connects as `erp_api` (NOBYPASSRLS) so RLS is genuinely enforced in tests.
 */

export const APP_ROLE = env.DATABASE_APP_ROLE;
export const MIGRATOR_ROLE = env.DATABASE_MIGRATOR_ROLE;

export type TestDatabaseServer = {
  /** Superuser/owner URL for the default maintenance database. */
  superUserUrl: string;
  rolePassword: string;
  superUserUrlFor(database: string): string;
  appRoleUrlFor(database: string): string;
  migratorRoleUrlFor(database: string): string;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
  mode: 'external' | 'embedded';
};

export type StartOptions = {
  /** Directory for the embedded cluster. Defaults to a temp dir. */
  dataDir?: string;
  port?: number;
  log?: (message: string) => void;
};

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteDatabaseName(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to create database '${name}': not a safe identifier.`);
  }
  return `"${name}"`;
}

async function exec(url: string, statements: string[]): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

/** Starts (or attaches to) the PostgreSQL server that integration tests run against. */
export async function startTestDatabaseServer(options: StartOptions = {}): Promise<TestDatabaseServer> {
  const log = options.log ?? (() => undefined);
  // A password already issued for this server (e.g. by the vitest global setup) is reused
  // so that a second `startTestDatabaseServer()` call cannot rotate it under other suites.
  const rolePassword = process.env.TEST_DATABASE_ROLE_PASSWORD ?? randomBytes(18).toString('base64url');

  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    if (!process.env.TEST_DATABASE_ROLE_PASSWORD) {
      await ensureRoles(external, rolePassword);
    }
    return {
      mode: 'external',
      superUserUrl: external,
      rolePassword,
      superUserUrlFor: (database) => withDatabase(external, database),
      appRoleUrlFor: (database) => withRole(withDatabase(external, database), APP_ROLE, rolePassword),
      migratorRoleUrlFor: (database) =>
        withRole(withDatabase(external, database), MIGRATOR_ROLE, rolePassword),
      createDatabase: (name) =>
        exec(external, [dropIfExists(name), `CREATE DATABASE ${quoteDatabaseName(name)}`]),
      dropDatabase: (name) => exec(external, [terminate(name), dropIfExists(name)]),
      stop: async () => undefined,
    };
  }

  const beforeImport = {
    exit: new Set(process.listeners('exit')),
    beforeExit: new Set(process.listeners('beforeExit')),
  };
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = options.port ?? (await freePort());
  const dataDir =
    options.dataDir ?? path.join(os.tmpdir(), `erp-pg-${process.pid}-${randomBytes(4).toString('hex')}`);

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await server.initialise();
  await server.start();
  /**
   * R-19 — `embedded-postgres` registers `async-exit-hook` at import time, and that
   * library's `beforeExit` handler force-calls `process.exit(0)` once its hooks are done.
   * Vitest reports failures by setting `process.exitCode = 1` and letting the process end
   * naturally — which fires `beforeExit` — so the hook silently turned every red run
   * green for the shell (reproduced: `vitest run` with one failing test exited 0 whenever
   * the embedded server had been started, and exited 1 without it; the repository's own
   * sole CI run "succeeded" on a commit with a failing spec).
   *
   * Both process-exit listeners the library installs are removed here:
   * - `beforeExit` — the one that masked the exit code (it exits hard with a literal 0).
   * - `exit` — it runs the library's async shutdown hook *synchronously* with no callback,
   *   which can only end in `TypeError: done is not a function`; async work cannot run
   *   inside the `exit` event anyway, so this listener never actually cleaned anything up.
   *
   * Nothing is lost by removing them:
   * - Normal runs stop the cluster through the deterministic teardown returned below
   *   (vitest always calls the global-setup teardown).
   * - The library's SIGINT/SIGTERM/SIGHUP/SIGBREAK hooks are left in place, so an
   *   interrupted run still shuts its cluster down (that path works, because the signal
   *   handlers drive the process to `process.exit` themselves).
   */
  for (const listener of process.listeners('exit')) {
    if (!beforeImport.exit.has(listener)) process.removeListener('exit', listener);
  }
  for (const listener of process.listeners('beforeExit')) {
    if (!beforeImport.beforeExit.has(listener)) process.removeListener('beforeExit', listener);
  }
  const superUserUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  log(`embedded postgres listening on 127.0.0.1:${port}`);

  await ensureRoles(superUserUrl, rolePassword);

  return {
    mode: 'embedded',
    superUserUrl,
    rolePassword,
    superUserUrlFor: (database) => withDatabase(superUserUrl, database),
    appRoleUrlFor: (database) => withRole(withDatabase(superUserUrl, database), APP_ROLE, rolePassword),
    migratorRoleUrlFor: (database) =>
      withRole(withDatabase(superUserUrl, database), MIGRATOR_ROLE, rolePassword),
    createDatabase: (name) =>
      exec(superUserUrl, [dropIfExists(name), `CREATE DATABASE ${quoteDatabaseName(name)}`]),
    dropDatabase: (name) => exec(superUserUrl, [terminate(name), dropIfExists(name)]),
    stop: async () => {
      await server.stop();
    },
  };
}

function withRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

function dropIfExists(name: string): string {
  return `DROP DATABASE IF EXISTS ${quoteDatabaseName(name)} WITH (FORCE)`;
}

function terminate(name: string): string {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name.replace(/'/g, "''")}'`;
}

/**
 * Creates the NOLOGIN-by-migration roles with LOGIN + a generated password. Runs before
 * any migration so both the migration (owner) and the app role are usable.
 */
async function ensureRoles(superUserUrl: string, rolePassword: string): Promise<void> {
  await exec(superUserUrl, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN CREATE ROLE ${MIGRATOR_ROLE} NOLOGIN BYPASSRLS; END IF; END $$`,
    `ALTER ROLE ${APP_ROLE} LOGIN NOBYPASSRLS PASSWORD '${rolePassword.replace(/'/g, "''")}'`,
    `ALTER ROLE ${MIGRATOR_ROLE} LOGIN BYPASSRLS PASSWORD '${rolePassword.replace(/'/g, "''")}'`,
  ]);
}

export type ProvisionedDatabase = {
  name: string;
  /** Owner/superuser connection — used for fixtures and cross-tenant setup. */
  ownerUrl: string;
  /** `erp_api` connection — what the application under test uses (RLS enforced). */
  appUrl: string;
  /** `erp_migrator` connection — BYPASSRLS, for the RLS negative probe. */
  migratorUrl: string;
};

/**
 * Creates an isolated database, applies all migrations and returns the three
 * connection strings the isolation harness needs.
 */
export async function provisionTestDatabase(
  server: TestDatabaseServer,
  name: string,
): Promise<ProvisionedDatabase> {
  await server.createDatabase(name);
  await runMigrations(server.superUserUrlFor(name));
  // `role_permissions.permission_code` references `permissions`, so the code-list
  // registry must exist before any fixture can attach a permission to a role.
  await seedPermissionRegistry(server.superUserUrlFor(name));
  return {
    name,
    ownerUrl: server.superUserUrlFor(name),
    appUrl: server.appRoleUrlFor(name),
    migratorUrl: server.migratorRoleUrlFor(name),
  };
}
