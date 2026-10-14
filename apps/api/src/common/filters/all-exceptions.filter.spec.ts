import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { DomainError, errorCodes } from '@erp/contracts';

import { ZodValidationException } from '../pipes/zod-validation.pipe.js';

import {
  AllExceptionsFilter,
  codeForStatus,
  isPostgresUuidSyntaxError,
} from './all-exceptions.filter.js';

type SentResponse = { status: number; contentType: string; body: string };

function runFilter(exception: unknown): SentResponse {
  const filter = new AllExceptionsFilter();
  let sent: SentResponse | undefined;

  const response = {
    status(code: number) {
      sent = { status: code, contentType: '', body: '' };
      return {
        type(value: string) {
          if (sent) sent.contentType = value;
          return {
            send(payload: string) {
              if (sent) sent.body = payload;
              return this;
            },
          };
        },
      };
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ headers: { 'x-request-id': 'trace-abc' } }),
    }),
  };

  filter.catch(exception, host as never);
  if (!sent) throw new Error('filter did not respond');
  return sent;
}

describe('AllExceptionsFilter', () => {
  it('emits application/problem+json with the stable code and traceId', () => {
    const sent = runFilter(
      new DomainError(errorCodes.FORBIDDEN, 'permission sales.invoice.post required', 403),
    );
    const body = JSON.parse(sent.body) as Record<string, unknown>;

    expect(sent.contentType).toBe('application/problem+json');
    expect(sent.status).toBe(403);
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      detail: 'permission sales.invoice.post required',
      traceId: 'trace-abc',
    });
  });

  it('maps zod failures to VALIDATION_FAILED with a field list', () => {
    const result = z.object({ email: z.string().email() }).safeParse({ email: 'nope' });
    expect(result.success).toBe(false);
    const sent = runFilter(new ZodValidationException(result.error as ZodError));
    const body = JSON.parse(sent.body) as { code: string; status: number; errors: unknown[] };

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.status).toBe(400);
    expect(body.errors).toEqual([{ field: 'email', message: expect.any(String) }]);
  });

  it('maps Nest HTTP exceptions onto the registry and never leaks internals on 5xx', () => {
    const notFound = JSON.parse(runFilter(new NotFoundException('nope')).body) as Record<string, unknown>;
    expect(notFound).toMatchObject({ status: 404, code: 'NOT_FOUND' });

    const badRequest = JSON.parse(runFilter(new BadRequestException('bad')).body) as Record<string, unknown>;
    expect(badRequest).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    const boom = JSON.parse(runFilter(new Error('connection string leaked')).body) as Record<string, unknown>;
    expect(boom).toMatchObject({ status: 500, code: 'INTERNAL', detail: 'An unexpected error occurred' });
    expect(JSON.stringify(boom)).not.toContain('connection string leaked');
  });

  it('maps statuses to stable codes', () => {
    expect(codeForStatus(401)).toBe('UNAUTHENTICATED');
    expect(codeForStatus(403)).toBe('FORBIDDEN');
    expect(codeForStatus(404)).toBe('NOT_FOUND');
    expect(codeForStatus(409)).toBe('VERSION_CONFLICT');
    expect(codeForStatus(429)).toBe('RATE_LIMITED');
    expect(codeForStatus(422)).toBe('VALIDATION_FAILED');
    expect(codeForStatus(503)).toBe('INTERNAL');
  });

  it('never puts a stack trace into the response body', () => {
    const error = new Error('secret detail');
    const sent = runFilter(error);
    expect(sent.body).not.toContain('stack');
    expect(sent.body).not.toContain('secret detail');
  });

  it('turns a raw ZodError from an inline schema.parse into a 422-style validation problem', () => {
    const schema = z.object({ categoryId: z.string().uuid(), baseUnitId: z.string().uuid() });
    const result = schema.safeParse({ categoryId: 'not-a-uuid' });
    expect(result.success).toBe(false);

    const sent = runFilter((result as { error: ZodError }).error);
    const body = JSON.parse(sent.body) as { code: string; errors?: Array<{ field: string }> };
    expect(body.code).toBe(errorCodes.VALIDATION_FAILED);
    expect(sent.contentType).toBe('application/problem+json');
    expect(body.errors?.map((entry) => entry.field)).toEqual(['categoryId', 'baseUnitId']);
  });

  /**
   * 🔑 R6 — الطبقة الثانية من الحارس: معرّفٌ معطوب جاء في **جسم** الطلب أو في مرشّح
   * استعلام (حيث لا يعرف `UuidParamPipe` اسم الحقل) يصل إلى Postgres فيردّ `22P02`.
   * كان ذلك يخرج 500 «خطأ غير متوقّع»؛ والصواب 400: الطلب هو المعطوب.
   */
  it('يترجم `invalid input syntax for type uuid` إلى `INVALID_ID` 400 بلا تسريب الاستعلام', () => {
    const drizzleWrapped = new Error(
      'Failed query: select "id" from "sales_invoices" where "id" = $2\nparams: 01a0…,not-a-uuid',
      {
        cause: Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
          code: '22P02',
        }),
      },
    );
    const sent = runFilter(drizzleWrapped);
    const body = JSON.parse(sent.body) as Record<string, unknown>;

    expect(sent.status).toBe(400);
    expect(body).toMatchObject({
      status: 400,
      code: errorCodes.INVALID_ID,
      title: 'Identifier is not a valid UUID',
    });
    expect(sent.body).not.toContain('select');
    expect(sent.body).not.toContain('not-a-uuid');
    expect(sent.body).not.toContain('22P02');
  });

  it('ولا يوسّع الترجمة: أخطاء البيانات الأخرى تبقى أعطالاً داخلية', () => {
    const integer = Object.assign(new Error('invalid input syntax for type integer: "abc"'), {
      code: '22P02',
    });
    expect(isPostgresUuidSyntaxError(integer)).toBe(false);
    expect(JSON.parse(runFilter(integer).body)).toMatchObject({ status: 500, code: 'INTERNAL' });

    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    expect(isPostgresUuidSyntaxError(unique)).toBe(false);

    // والسبب يُقرأ من سلسلة `cause` لا من الطبقة العليا وحدها.
    expect(isPostgresUuidSyntaxError(new Error('wrapped', { cause: integer }))).toBe(false);
    expect(
      isPostgresUuidSyntaxError(
        new Error('outer', {
          cause: new Error('inner', {
            cause: Object.assign(new Error('invalid input syntax for type uuid: "x"'), {
              code: '22P02',
            }),
          }),
        }),
      ),
    ).toBe(true);
  });
});
