#!/usr/bin/env node
/**
 * `pnpm db:local` — a PostgreSQL 16 server without Docker.
 *
 * `pnpm db:up` needs Docker, which is not available on every machine (and not in the
 * review sandbox). This script boots the same `embedded-postgres` binary the test suite
 * already uses, creates the two RLS roles and the application database exactly as the
 * compose file does, and then stays in the foreground until Ctrl-C.
 *
 * It reads the connection details from DATABASE_URL / DATABASE_MIGRATOR_URL in `.env`, so
 * after `pnpm env:setup` no extra configuration is needed:
 *
 *   pnpm db:local            # terminal 1 — keeps running
 *   pnpm db:migrate          # terminal 2
 *   pnpm db:seed
 *   pnpm dev
 *
 * Data lives under the OS temp dir by default (wiped on reboot). Set DB_LOCAL_DATA_DIR to
 * keep it, and DB_LOCAL_PERSIST=true to reuse an existing cluster.
 */
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

// `embedded-postgres` and `pg` are dev dependencies of @erp/testing, so resolve from there
// as well as from the root — whichever workspace happens to have them installed.
const requireRoot = createRequire(import.meta.url);
const requireTesting = createRequire(new URL('../packages/testing/package.json', import.meta.url));

function requireAny(name) {
  for (const resolver of [requireRoot, requireTesting]) {
    try {
      return resolver(name);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(
    `Cannot find "${name}". Run \`pnpm install\` at the repository root, or use \`pnpm db:up\` with Docker instead.`,
  );
}

function parse(url, label) {
  if (!url) throw new Error(`${label} is not set — run \`pnpm env:setup\` first.`);
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, '') || 'app',
  };
}

const app = parse(process.env.DATABASE_URL, 'DATABASE_URL');
const migrator = parse(process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL, 'DATABASE_MIGRATOR_URL');

const dataDir = process.env.DB_LOCAL_DATA_DIR ?? path.join(os.tmpdir(), 'erp-local-pg');
const persist = String(process.env.DB_LOCAL_PERSIST ?? 'false').toLowerCase() === 'true';
const alreadyInitialised = existsSync(path.join(dataDir, 'PG_VERSION'));

mkdirSync(dataDir, { recursive: true });

const { default: EmbeddedPostgres } = requireAny('embedded-postgres');
const { Client } = requireAny('pg');

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: app.port,
  persistent: persist || alreadyInitialised,
});

async function sqlExec(database, statements) {
  const client = new Client({
    host: '127.0.0.1',
    port: app.port,
    user: 'postgres',
    password: 'postgres',
    database,
  });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  if (!alreadyInitialised) {
    console.log(`[db:local] initialising a new cluster in ${dataDir}`);
    await server.initialise();
  } else {
    console.log(`[db:local] reusing the cluster in ${dataDir}`);
  }

  await server.start();
  console.log(`[db:local] postgres listening on 127.0.0.1:${app.port}`);

  // Roles: the app role must be NOBYPASSRLS (MULTI_TENANCY §3); the migrator owns the schema.
  await sqlExec('postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quote(app.user)})
       THEN CREATE ROLE ${app.user} LOGIN NOBYPASSRLS PASSWORD ${quote(app.password)}; END IF; END $$`,
    `ALTER ROLE ${app.user} LOGIN NOBYPASSRLS PASSWORD ${quote(app.password)}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quote(migrator.user)})
       THEN CREATE ROLE ${migrator.user} LOGIN SUPERUSER PASSWORD ${quote(migrator.password)}; END IF; END $$`,
    `ALTER ROLE ${migrator.user} LOGIN SUPERUSER PASSWORD ${quote(migrator.password)}`,
  ]);

  const exists = await (async () => {
    const client = new Client({
      host: '127.0.0.1',
      port: app.port,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    });
    await client.connect();
    try {
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [app.database]);
      return result.rowCount > 0;
    } finally {
      await client.end();
    }
  })();

  if (!exists) {
    await sqlExec('postgres', [`CREATE DATABASE "${app.database}" OWNER ${migrator.user}`]);
    console.log(`[db:local] created database ${app.database}`);
  }

  await sqlExec(app.database, [
    `GRANT ALL ON SCHEMA public TO ${migrator.user}`,
    `GRANT USAGE ON SCHEMA public TO ${app.user}`,
  ]);

  console.log('[db:local] ready. Next:  pnpm db:migrate  &&  pnpm db:seed  &&  pnpm dev');
  console.log('[db:local] press Ctrl-C to stop.');
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[db:local] ${signal} — stopping postgres…`);
  try {
    await server.stop();
  } catch (error) {
    console.error(`[db:local] stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (error) => {
  console.error(`[db:local] ${error instanceof Error ? error.message : String(error)}`);
  try {
    await server.stop();
  } catch {
    /* the server may never have started */
  }
  process.exit(1);
});

// Keep the event loop alive while postgres runs in the background.
setInterval(() => undefined, 1 << 30);
