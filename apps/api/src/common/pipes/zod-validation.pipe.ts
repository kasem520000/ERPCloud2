import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodError, ZodTypeAny } from 'zod';

/** Thrown by `ZodValidationPipe`; mapped to problem+json by the exception filter. */
export class ZodValidationException extends Error {
  constructor(public readonly zodError: ZodError) {
    super('Request validation failed');
    this.name = 'ZodValidationException';
  }
}

/**
 * zod validation pipe (TARGET_ARCHITECTURE §2 "zod + pipes", SECURITY_ARCHITECTURE §6
 * "zod-validate every body/query/param … unknown keys rejected in writes").
 *
 * The DTO schemas live in `@erp/contracts` so the frontends validate with the exact same
 * rules. Usage: `@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest`.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform<
  unknown,
  TSchema['_output']
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): TSchema['_output'] {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationException(result.error);
    }
    return result.data;
  }
}
