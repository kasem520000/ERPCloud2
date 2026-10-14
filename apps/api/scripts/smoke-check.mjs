/**
 * Entry-point smoke check (AI_DEVELOPMENT_PROTOCOL §8: `npm run verify` must reach the
 * running application, not just the compiler).
 *
 * It boots the *real* `AppModule` through the same `applyHttpConfiguration` that
 * `main.ts` uses and asserts the two things that must hold before any database exists:
 *
 *   1. `GET /health/live` → 200 (liveness is outside the `api/v1` prefix),
 *   2. `GET /api/v1/me` without a bearer token → 401 `UNAUTHENTICATED` rendered as
 *      RFC 9457 `application/problem+json` with a `traceId`, proving the global guard
 *      pipeline (API_ARCHITECTURE §2) and the exception filter are wired.
 *
 * No PostgreSQL is required: `DatabaseModule` only creates a lazy pool here, and neither
 * route touches it.
 *
 * It runs against `dist/`, not the TypeScript source: NestJS constructor injection needs
 * the `design:paramtypes` metadata that only `tsc` emits (`emitDecoratorMetadata`), so the
 * check has to exercise the same JavaScript that `pnpm start` runs. Hence
 * `test:smoke = tsc -p tsconfig.json && node ./scripts/smoke-check.mjs`.
 */
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';

import 'reflect-metadata';
import request from 'supertest';

// `@erp/config` parses the environment at import time, so the throwaway signing keys must
// exist before any `@erp/*` module is loaded.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://erp_api:smoke@127.0.0.1:5432/erp_smoke';
process.env.JWT_KEY_ID ??= 'smoke-key';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY ??= privateKey;
process.env.JWT_PUBLIC_KEY ??= publicKey;

const { AppModule } = await import('../dist/app.module.js');
const { applyHttpConfiguration } = await import('../dist/bootstrap.js');
const { RequestIdMiddleware } = await import('../dist/common/middleware/request-id.middleware.js');
const { NestFactory } = await import('@nestjs/core');

const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
app.use(RequestIdMiddleware);
applyHttpConfiguration(app);
await app.init();

try {
  const server = app.getHttpServer();

  const live = await request(server).get('/health/live');
  assert.equal(live.status, 200, `GET /health/live returned ${live.status}`);
  assert.equal(live.body.status, 'ok', 'GET /health/live must report status ok');

  const unauthenticated = await request(server).get('/api/v1/me');
  assert.equal(unauthenticated.status, 401, `GET /api/v1/me returned ${unauthenticated.status}`);
  assert.match(
    unauthenticated.headers['content-type'] ?? '',
    /application\/problem\+json/,
    'errors must be RFC 9457 problem+json',
  );
  assert.equal(unauthenticated.body.code, 'UNAUTHENTICATED', 'missing token must map to UNAUTHENTICATED');
  assert.ok(unauthenticated.body.traceId, 'problem+json must carry a traceId');
  assert.ok(unauthenticated.headers['x-request-id'], 'every response must echo X-Request-Id');

  console.log('smoke check passed: AppModule boots, /health/live is 200, guards emit problem+json 401');
} finally {
  await app.close();
}
