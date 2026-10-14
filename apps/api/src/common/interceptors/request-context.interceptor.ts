import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';

import { getTraceId } from '../../request-context/request-context.js';

/**
 * Publishes the AsyncLocalStorage `traceId` onto the request object so downstream
 * handlers and logs can read it without re-entering the store
 * (API_ARCHITECTURE §2, stage 1–2).
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { traceId?: string }>();
    request.traceId = getTraceId();
    return next.handle();
  }
}
