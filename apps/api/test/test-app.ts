import type { Server } from 'node:http';

import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createDatabase, type DatabaseHandle } from '@erp/database';
import {
  provisionTestDatabase,
  startTestDatabaseServer,
  type ProvisionedDatabase,
} from '@erp/testing/database';

import { AppModule } from '../src/app.module.js';
import { applyHttpConfiguration } from '../src/bootstrap.js';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware.js';
import { DATABASE_HANDLE } from '../src/database/database.module.js';

/**
 * Boots the real application against a freshly migrated database, connected as
 * `erp_api` (NOBYPASSRLS) so RLS is genuinely enforced under test
 * (TESTING_STRATEGY §1: "integration … API ↔ DB real").
 */
export type TestApp = {
  app: INestApplication;
  server: Server;
  db: ProvisionedDatabase;
  handle: DatabaseHandle;
  close(): Promise<void>;
};

let sequence = 0;

/**
 * `pool.end()` resolves as soon as the clients are removed from the pool's bookkeeping,
 * but pg-pool does **not** wait for the underlying sockets to finish closing
 * (`_remove` filters `_clients` synchronously and only *then* calls the async
 * `client.end()`, whose callback is what emits the pool's `'remove'` event). Dropping
 * the database right after `app.close()` therefore races `pg_terminate_backend`
 * against sockets that are still draining: the dying client receives FATAL 57P01,
 * pg-pool re-emits it on the pool, and (before `createPool` learned to log those) it
 * surfaced as an unhandled error that failed the whole vitest run while every test
 * had passed. Attach **before** closing, then wait for every removed client's
 * end-callback before the drop. The timeout is a safety valve: a pathological close
 * can never hang the suite — it only degrades to the old race (now merely logged).
 */
function trackPoolDrain(pool: Pool, timeoutMs = 5_000): Promise<void> {
  const remaining = pool.totalCount;
  if (remaining === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let left = remaining;
    const onRemove = () => {
      left -= 1;
      if (left <= 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      pool.off('remove', onRemove);
      resolve();
    }
    pool.on('remove', onRemove);
  });
}

/**
 * `configure` lets a suite swap a port for a fake before the module compiles — e.g. the
 * files suite binds an in-memory `OBJECT_STORAGE` so the presign→finalize→download flow
 * is exercised end to end without MinIO.
 */
export async function createTestApp(
  nameHint = 'suite',
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  process.env.TEST_DATABASE_URL = inject('testDatabaseSuperUserUrl');
  process.env.TEST_DATABASE_ROLE_PASSWORD = inject('testDatabaseRolePassword');

  const server = await startTestDatabaseServer();
  sequence += 1;
  const dbName = `erp_test_${nameHint.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${process.pid}_${sequence}`;
  const db = await provisionTestDatabase(server, dbName.slice(0, 60));

  const handle = createDatabase(db.appUrl, 5);

  const base = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(handle);
  const moduleRef = await (configure ? configure(base) : base).compile();

  // `TEST_LOGS=1` يُظهر سجلّ التطبيق — يُستعمل عند تشخيص فشلٍ لا يقول الجسم سببه
  // (المعالج العام يحوّل 500 إلى نصٍّ عام). والافتراضي صامت كما كان.
  // `rawBody: true` mirrors `main.ts`: provider webhooks (Stripe · Salla) verify their HMAC
  // over the exact bytes the provider signed, so tests must exercise the same parser.
  const app = moduleRef.createNestApplication({ logger: process.env.TEST_LOGS === '1', rawBody: true });
  app.use(RequestIdMiddleware);
  applyHttpConfiguration(app);
  await app.init();

  return {
    app,
    server: app.getHttpServer() as Server,
    db,
    handle,
    close: async () => {
      const drained = trackPoolDrain(handle.pool);
      await app.close(); // DatabaseLifecycle ends the overridden handle's pool here
      await drained; // …but its sockets may still be closing — see trackPoolDrain
      await server.dropDatabase(db.name);
    },
  };
}
