import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { assertRuntimeEnv, describeEnvSources, env, envIssues } from '@erp/config';
import { runMigrations } from '@erp/database';

import { AppModule } from './app.module.js';
import { applyHttpConfiguration, buildOpenApiDocument, registerOpenApi } from './bootstrap.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { verifySecretBoxRoundTrip } from './modules/platform/auth/secret-box.js';
import { WorkerRunner } from './modules/platform-services/index.js';

/**
 * Worker role — PHASE_04 §5.5: "worker bootstrap in apps/api behind flag `WORKER=1`".
 *
 * Same image, same DI graph, no HTTP listener: an application *context* rather than an
 * HTTP server. Running the consumers in-process during development is intentional; in
 * production this is a separate deployment of the same container with `WORKER=1` set.
 */
async function bootstrapWorker(): Promise<void> {
  assertRuntimeEnv();
  // R-04 — fail at startup, not on the first secret the worker tries to read.
  verifySecretBoxRoundTrip();

  const context = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  context.useLogger(context.get(Logger));
  context.enableShutdownHooks();

  const runner = context.get(WorkerRunner);
  await runner.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`erp-worker received ${signal}; draining`);
    await runner.stop();
    await context.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`erp-worker started (${env.NODE_ENV})`);
}

async function bootstrap(): Promise<void> {
  // Say out loud where the configuration came from — the single most common support
  // question was "the API does not see my .env".
  console.log(`erp-api env sources: ${describeEnvSources()}`);
  if (envIssues.length > 0) console.warn(`erp-api env warnings: ${envIssues.join('; ')}`);

  // PHASE_02 §8: fail fast on a missing runtime variable instead of degrading silently.
  assertRuntimeEnv();
  // R-04 — fail at startup, not on the first MFA enrolment or e-invoice credential read.
  verifySecretBoxRoundTrip();

  try {
    const outcome = await runMigrations();
    if (outcome.applied.length > 0) {
      console.log(`erp-api auto-migrated ${outcome.applied.length} migration(s): ${outcome.applied.join(', ')}`);
    }
  } catch (err) {
    console.warn(`erp-api auto-migrate skipped/warned: ${err instanceof Error ? err.message : String(err)}`);
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  app.use(RequestIdMiddleware);
  applyHttpConfiguration(app);
  app.useLogger(app.get(Logger));

  registerOpenApi(app, buildOpenApiDocument(app));

  await app.listen(env.PORT, env.API_HOST);

  console.log(`erp-api listening on http://${env.API_HOST}:${env.PORT} (${env.NODE_ENV})`);
}

void (env.WORKER ? bootstrapWorker() : bootstrap());
