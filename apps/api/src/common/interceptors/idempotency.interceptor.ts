import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EMPTY, catchError, from, mergeMap, tap, throwError, type Observable } from 'rxjs';
import { DomainError, errorCodes, IDEMPOTENCY_KEY_HEADER } from '@erp/contracts';

import { getRequestContext } from '../../request-context/request-context.js';
import {
  hashRequestPayload,
  IdempotencyStore,
} from '../../modules/platform-services/idempotency/idempotency.store.js';

/**
 * `Idempotency-Key` handling — API_CONTRACT §0, DATABASE_DESIGN §4.
 *
 * PHASE_02 shipped an in-memory map with a `TODO(phase:04)`; this is that replacement.
 * State now lives in `idempotency_keys`, so a replay survives a restart and is shared by
 * every replica. The wire contract is unchanged: the first response is returned verbatim
 * with `Idempotency-Replayed: true`.
 *
 * Scope decisions:
 *
 * - Only `POST/PUT/PATCH` with a key header are considered; `GET`/`DELETE` are already
 *   idempotent by HTTP semantics.
 * - A request **without a tenant context** (a public route such as login) passes through
 *   untouched: the table is tenant-scoped by RLS, there is no tenant to store it under,
 *   and giving anonymous callers a shared keyspace would be a cross-tenant channel.
 * - The stored fingerprint covers endpoint + body, so reusing a key with a different
 *   payload is a 409 `IDEMPOTENCY_REPLAY` instead of a wrong, cached answer.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH']);
const MAX_KEY_LENGTH = 200;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: IdempotencyStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key.length === 0 || !MUTATING.has(request.method.toUpperCase())) {
      return next.handle();
    }
    if (key.length > MAX_KEY_LENGTH) {
      return throwError(
        () =>
          new DomainError(
            errorCodes.VALIDATION_FAILED,
            `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
            400,
            { field: IDEMPOTENCY_KEY_HEADER },
          ),
      );
    }

    const tenantId = getRequestContext().tenant?.tenantId;
    if (!tenantId) return next.handle();

    const endpoint = `${request.method.toUpperCase()} ${routePath(request)}`;
    const requestHash = hashRequestPayload(endpoint, request.body);

    return from(this.store.begin(tenantId, key, endpoint, requestHash)).pipe(
      mergeMap((claim) => {
        if (claim.outcome === 'replay') {
          // Written straight to the socket: re-serialising the parsed body would
          // reorder keys and break the byte-identical promise of API_CONTRACT §0.
          // Returning EMPTY means Nest never emits a value of its own for this request.
          response.setHeader('Idempotency-Replayed', 'true');
          response.status(claim.statusCode).type('application/json').send(claim.response);
          return EMPTY;
        }
        if (claim.outcome === 'in_progress') {
          return throwError(
            () =>
              new DomainError(
                errorCodes.IDEMPOTENCY_REPLAY,
                'A request with this Idempotency-Key is still in flight',
                409,
                { field: IDEMPOTENCY_KEY_HEADER },
              ),
          );
        }
        if (claim.outcome === 'conflict') {
          return throwError(
            () =>
              new DomainError(
                errorCodes.IDEMPOTENCY_REPLAY,
                `Idempotency-Key was already used on ${claim.endpoint} with a different payload`,
                409,
                { field: IDEMPOTENCY_KEY_HEADER },
              ),
          );
        }

        return next.handle().pipe(
          tap((body) => {
            // `JSON.stringify` is exactly what Express applies to the returned value,
            // so this is the byte sequence the client received.
            void this.store.complete(
              tenantId,
              key,
              response.statusCode,
              JSON.stringify(body ?? null),
            );
          }),
          catchError((error: unknown) => {
            // The handler failed, so nothing happened — free the key for a retry.
            void this.store.release(tenantId, key);
            return throwError(() => error);
          }),
        );
      }),
    );
  }
}

/** Path without the query string; the key is scoped to the endpoint, not to its filters. */
function routePath(request: Request): string {
  const url = request.originalUrl ?? request.url ?? '';
  return url.split('?')[0] ?? '';
}
