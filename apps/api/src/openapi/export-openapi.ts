import 'reflect-metadata';

import fs from 'node:fs/promises';
import path from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { applyHttpConfiguration, buildOpenApiDocument } from '../bootstrap.js';

/**
 * Writes `packages/contracts/openapi.json` from the live Nest application
 * (API_ARCHITECTURE §6: "exported as packages/contracts/openapi.json in CI").
 * The exporter is part of `pnpm verify`, so a route added without DTO metadata shows up
 * as a diff in the artifact rather than as a silent contract gap.
 */
export async function writeOpenApiSpec(target?: string): Promise<string> {
  const outputPath = path.resolve(target ?? 'packages/contracts/openapi.json');

  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    applyHttpConfiguration(app);
    const document = buildOpenApiDocument(app);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } finally {
    await app.close();
  }

  return outputPath;
}
