import type { Server } from 'node:http';

import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { inject } from 'vitest';
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
      await app.close();
      await server.dropDatabase(db.name);
    },
  };
}
