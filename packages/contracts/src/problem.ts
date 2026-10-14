import type { ZodError } from 'zod';

import { errorCodes, statusForCode, titleForCode } from './errors.js';

/**
 * Domain error. Thrown by services; mapped to `application/problem+json` by the global
 * exception filter (AI_DEVELOPMENT_PROTOCOL §4). Never leaks a stack to the client.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = statusForCode(code),
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export type ProblemError = {
  field?: string;
  message?: string;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
  errors?: ProblemError[];
};

export function createProblemDetails(error: DomainError | Error, traceId: string): ProblemDetails {
  const domainError =
    error instanceof DomainError ? error : new DomainError(errorCodes.INTERNAL, error.message, 500);

  const errors =
    domainError.details && typeof domainError.details === 'object'
      ? Array.isArray(domainError.details)
        ? (domainError.details as ProblemError[])
        : [domainError.details as ProblemError]
      : undefined;

  return {
    type: 'about:blank',
    title: titleForCode(domainError.code),
    status: domainError.status,
    code: domainError.code,
    detail: domainError.message,
    traceId,
    ...(errors ? { errors } : {}),
  };
}

/** Maps a zod failure to `VALIDATION_FAILED` with the field list (PHASE_02 §5.3). */
export function problemFromZodError(error: ZodError, traceId: string): ProblemDetails {
  const fields: ProblemError[] = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return createProblemDetails(
    new DomainError(errorCodes.VALIDATION_FAILED, 'Request validation failed', 400, fields),
    traceId,
  );
}
