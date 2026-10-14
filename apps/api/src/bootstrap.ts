import { RequestMethod, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { env } from '@erp/config';

/**
 * Shared HTTP configuration, used by both `main.ts` and the OpenAPI exporter so the
 * published document always describes the real pipeline.
 */
export function applyHttpConfiguration(app: INestApplication): void {
  // Express 4.20+/5 default to the `simple` query parser, which does not understand the
  // bracket syntax the contract documents (`filter[field]=`, API_ARCHITECTURE §3).
  const instance = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
  };
  instance.set?.('query parser', 'extended');

  app.use(helmet());

  const origins = env.CORS_ALLOWED_ORIGINS;
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Branch-Id', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // `/health/*` are ops endpoints and stay outside the versioned contract (PHASE_02 §7).
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ERP SaaS API')
    .setDescription(
      'Cloud multi-tenant ERP. Errors are RFC 9457 application/problem+json with a stable ' +
        '`code` from @erp/contracts. Tenant context always comes from the access token.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Branch-Id', in: 'header' }, 'branchScope')
    .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'idempotencyKey')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function registerOpenApi(app: INestApplication, document: OpenAPIObject): void {
  if (!env.OPENAPI_ENABLED) return;
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });
}
