import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import {
  DomainError,
  REQUEST_ID_HEADER,
  createProblemDetails,
  errorCodes,
  problemFromZodError,
  type ProblemDetails,
} from '@erp/contracts';

import { getTraceId } from '../../request-context/request-context.js';
import { ZodValidationException } from '../pipes/zod-validation.pipe.js';

/**
 * Global exception filter — API_CONTRACT §0 / API_ARCHITECTURE §3.
 *
 * Every 4xx/5xx becomes `application/problem+json` with a stable `code` from
 * `@erp/contracts` and the request `traceId`. Stack traces and internal messages never
 * reach the client (PROJECT_CONTRACT §10); unexpected errors are logged server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const headerTraceId = request?.headers?.[REQUEST_ID_HEADER];
    const traceId = getTraceId() !== 'local-request' ? getTraceId() : String(headerTraceId ?? 'unknown');

    const problem = this.toProblem(exception, traceId);

    if (problem.status >= 500) {
      this.logger.error(
        {
          err:
            exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception,
          traceId,
          code: problem.code,
        },
        'Unhandled exception',
      );
    }

    response.status(problem.status).type('application/problem+json').send(JSON.stringify(problem));
  }

  private toProblem(exception: unknown, traceId: string): ProblemDetails {
    if (exception instanceof ZodValidationException) {
      return problemFromZodError(exception.zodError, traceId);
    }

    // 🔑 R6 — معرّفٌ ليس UUID وصل إلى استعلام: `UuidParamPipe` يحرس **مسار** الرابط، وهذا
    // يلتقط ما جاء في **جسم** الطلب أو في مرشّح الاستعلام (حيث لا يعرف الحارس اسم الحقل
    // ولا الصيغة المتوقّعة). Postgres يسمّي العطب `22P02`؛ ونحن نسمّيه `INVALID_ID` 400 —
    // لأن الطلب المعطوب ليس عيباً في الخادم، ولا يصحّ أن يُسجَّل تتبّعُه كخطأٍ داخلي.
    if (isPostgresUuidSyntaxError(exception)) {
      return createProblemDetails(
        new DomainError(
          errorCodes.INVALID_ID,
          'An identifier in this request is not a valid UUID',
          HttpStatus.BAD_REQUEST,
        ),
        traceId,
      );
    }

    // Controllers that call `schema.parse(body)` inline throw the raw ZodError; without this
    // branch a plain "field is required" would reach the user as an opaque 500.
    if (exception instanceof ZodError) {
      return problemFromZodError(exception, traceId);
    }

    if (exception instanceof DomainError) {
      return createProblemDetails(exception, traceId);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const detail =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return createProblemDetails(
        new DomainError(
          codeForStatus(status),
          Array.isArray(detail) ? detail.join('; ') : String(detail),
          status,
        ),
        traceId,
      );
    }

    return createProblemDetails(
      new DomainError(errorCodes.INTERNAL, 'An unexpected error occurred', HttpStatus.INTERNAL_SERVER_ERROR),
      traceId,
    );
  }
}

/** Maps a Nest `HttpException` status onto the stable registry (API_CONTRACT §0). */
export function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return errorCodes.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return errorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return errorCodes.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return errorCodes.VERSION_CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return errorCodes.RATE_LIMITED;
    case HttpStatus.BAD_REQUEST:
    case 422:
      return errorCodes.VALIDATION_FAILED;
    default:
      return status >= 500 ? errorCodes.INTERNAL : errorCodes.VALIDATION_FAILED;
  }
}

/**
 * هل السبب `invalid input syntax for type uuid` (`22P02`)؟ يُبحث في سلسلة `cause` لأن
 * Drizzle يلفّ خطأ `pg` في `DrizzleQueryError` ويُبقي الأصل في `cause` (وقد يتكرّر اللفّ).
 */
export function isPostgresUuidSyntaxError(exception: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = exception;
  let depth = 0;
  while (current && typeof current === 'object' && depth < 8 && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === '22P02' && typeof candidate.message === 'string') {
      if (/invalid input syntax for type uuid/i.test(candidate.message)) return true;
    }
    if (
      typeof candidate.message === 'string' &&
      /invalid input syntax for type uuid/i.test(candidate.message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
