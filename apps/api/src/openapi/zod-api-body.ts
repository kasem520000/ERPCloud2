import { ApiBody } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Bridges the zod DTOs of `@erp/contracts` into the generated OpenAPI document
 * (API_ARCHITECTURE §6: "OpenAPI generated from zod DTOs"). One source of truth: the
 * same schema validates the request and describes it.
 */
export function zodApiBody(schema: ZodTypeAny, description?: string): MethodDecorator {
  const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
  return ApiBody({
    schema: jsonSchema as Record<string, unknown>,
    ...(description ? { description } : {}),
  });
}
