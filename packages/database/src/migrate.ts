import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { env } from '@erp/config';

/**
 * Migration runner (PHASE_02 §5.5 "drizzle-kit config + migration folder convention;
 * `db:migrate` runs", extended by PHASE_03 §6 "Migration must be idempotent and
 * reversible").
 *
 * Migrations are hand-written, reviewed SQL files in `packages/database/migrations`
 * (AI_DEVELOPMENT_PROTOCOL §5: "review SQL before applying"). Each file is applied once
 * inside a single transaction and recorded with a SHA-256 checksum in `erp_migrations`;
 * re-running is a no-op, and editing an applied file is a hard error.
 */

export const MIGRATIONS_TABLE = 'erp_migrations';

export type MigrationFile = {
  name: string;
  sql: string;
  checksum: string;
};

export type MigrationOutcome = {
  applied: string[];
  skipped: string[];
};

export type MigrationLogger = (message: string) => void;

export function migrationsDirectory(): string {
  const override = process.env.DATABASE_MIGRATIONS_DIR;
  if (override && override.length > 0) return path.resolve(override);
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

export async function readMigrationFiles(directory = migrationsDirectory()): Promise<MigrationFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    migrations.push({ name, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name       text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** Applies every pending migration in filename order. Safe to run repeatedly. */
export async function runMigrations(
  connectionString?: string,
  options: { migrationsDir?: string; log?: MigrationLogger } = {},
): Promise<MigrationOutcome> {
  const log = options.log ?? (() => undefined);
  const pool = new Pool({
    connectionString: connectionString ?? env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });
  const outcome: MigrationOutcome = { applied: [], skipped: [] };

  // One dedicated client for the whole run: `pool.end()` waits for every checked-out
  // client to be released, so a leaked `pool.connect()` would hang the process forever.
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const migrations = await readMigrationFiles(options.migrationsDir);

    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
        [migration.name],
      );
      const recorded = existing.rows[0];

      if (recorded) {
        if (recorded.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} was modified after it was applied ` +
              `(recorded ${recorded.checksum.slice(0, 12)}…, file ${migration.checksum.slice(0, 12)}…). ` +
              'Applied migrations are immutable — add a new migration instead.',
          );
        }
        outcome.skipped.push(migration.name);
        log(`skip  ${migration.name} (already applied)`);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      outcome.applied.push(migration.name);
      log(`apply ${migration.name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  return outcome;
}

/** Applies the `down/` counterpart of the most recently applied migrations. */
export async function runMigrationsDown(
  connectionString?: string,
  options: { steps?: number; migrationsDir?: string; log?: MigrationLogger } = {},
): Promise<MigrationOutcome> {
  const log = options.log ?? (() => undefined);
  const steps = options.steps ?? 1;
  const directory = options.migrationsDir ?? migrationsDirectory();
  const downDirectory = path.join(directory, 'down');
  const pool = new Pool({
    connectionString: connectionString ?? env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });
  const outcome: MigrationOutcome = { applied: [], skipped: [] };

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const applied = await client.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name DESC LIMIT $1`,
      [steps],
    );

    for (const row of applied.rows) {
      const downName = row.name.replace(/\.sql$/, '.down.sql');
      const downPath = path.join(downDirectory, downName);
      const sql = await fs.readFile(downPath, 'utf8').catch(() => {
        throw new Error(`No down migration found for ${row.name} (expected ${downPath}).`);
      });

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [row.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      outcome.applied.push(downName);
      log(`down  ${downName}`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  return outcome;
}

/**
 * Grants LOGIN and sets the password for the API and migrator roles from the
 * environment (PHASE_03 §5.1). The migration file itself creates them NOLOGIN so that
 * no credential is ever written into SQL (PROJECT_CONTRACT §10).
 */
export async function configureDatabaseRoles(
  connectionString?: string,
  options: {
    appRole?: string;
    appPassword?: string;
    migratorRole?: string;
    migratorPassword?: string;
    log?: MigrationLogger;
  } = {},
): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const appRole = options.appRole ?? env.DATABASE_APP_ROLE;
  const migratorRole = options.migratorRole ?? env.DATABASE_MIGRATOR_ROLE;
  const pool = new Pool({
    connectionString: connectionString ?? env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });
  const touched: string[] = [];

  const client = await pool.connect();
  try {
    await client.query(`ALTER ROLE ${quoteIdent(appRole)} NOBYPASSRLS`);
    // ⚠️ كلمة المرور **حرفٌ في الجملة لا وسيط** (`$1`): `ALTER ROLE` جملةُ تعريفٍ لا يقبل
    // فيها PostgreSQL معاملاتٍ مُعاملة — و`PASSWORD $1` تُرفض بسyntax error، فيبدو الأمر
    // كأنه «فشل صلاحيات». ولهذا تُقتبس الكلمة اقتباساً حرفياً (بمضاعفة الفاصلة المفردة)،
    // ويبقى الحقل مقتبساً لا مُدرَجاً كما هو (SECURITY_ARCHITECTURE §6).
    if (options.appPassword) {
      await client.query(
        `ALTER ROLE ${quoteIdent(appRole)} LOGIN PASSWORD ${quoteLiteral(options.appPassword)}`,
      );
      touched.push(appRole);
      log(`role  ${appRole}: LOGIN, NOBYPASSRLS`);
    }
    if (options.migratorPassword) {
      await client.query(
        `ALTER ROLE ${quoteIdent(migratorRole)} LOGIN BYPASSRLS PASSWORD ${quoteLiteral(options.migratorPassword)}`,
      );
      touched.push(migratorRole);
      log(`role  ${migratorRole}: LOGIN, BYPASSRLS`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  return touched;
}

/** Role names are operator-controlled identifiers; quoting keeps them injection-safe. */
export function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Refusing to use '${identifier}' as a role name: not a plain SQL identifier.`);
  }
  return `"${identifier}"`;
}

/**
 * اقتباس نصٍّ حرفياً لكلمة مرور: مضاعفة الفاصلة المفردة هي طريقة PostgreSQL الوحيدة
 * للهروب داخل `'…'`. وكلمة المرور تأتي من `.env` (بيئةُ المشغّل لا مدخلات المستخدم)،
 * ومع ذلك تُقتبس — لأن «المصدر موثوق» ليست قاعدةً في كتابة SQL.
 *
 * ولماذا لا وسيطاً مُعاملَاً (`$1`)؟ لأن `ALTER ROLE … PASSWORD` جملةُ تعريفٍ لا يقبل
 * فيها PostgreSQL المعاملات، فيصل `$1` حرفياً ويُرفض بسyntax error — ويبدو الخطأ كأنه
 * «صلاحيات» لا «اقتباس».
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
