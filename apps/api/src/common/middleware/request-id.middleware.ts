import type { NextFunction, Request, Response } from 'express';
import { newRequestId } from '@erp/contracts';

import { requestContextStorage } from '../../request-context/request-context.js';

/**
 * Inbound ids come from a gateway (or a client), so they are bounded and character-
 * checked before they are trusted: at most 128 chars of `[A-Za-z0-9._-]`. Anything else
 * is replaced with a freshly minted id rather than echoed into logs and RFC 9457
 * `traceId` values.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * O-04 — W3C Trace Context (`traceparent: 00-<32-hex-trace-id>-<16-hex-parent-id>-<2-hex-flags>`).
 * Per the W3C specification, version `ff` is invalid and neither `trace-id` nor `parent-id`
 * may be all-zero. When no explicit `X-Request-Id` is provided, a valid `traceparent`
 * supplies its 32-hex trace-id so upstream distributed traces correlate cleanly with
 * `x-request-id`, `traceId`, and `audit_log.meta.traceId`.
 */
const W3C_TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function normaliseRequestId(header: unknown): string {
  if (Array.isArray(header)) header = header[0];
  if (typeof header !== 'string') return '';
  return SAFE_REQUEST_ID.test(header) ? header : '';
}

export function extractW3cTraceId(header: unknown): string {
  if (Array.isArray(header)) header = header[0];
  if (typeof header !== 'string') return '';
  const match = W3C_TRACEPARENT.exec(header.trim());
  if (!match) return '';
  const version = match[1]!.toLowerCase();
  const traceId = match[2]!.toLowerCase();
  const parentId = match[3]!.toLowerCase();
  if (version === 'ff') return '';
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return '';
  return traceId;
}

/**
 * First stage of the request pipeline (API_ARCHITECTURE §2).
 *
 * - A gateway-supplied `X-Request-Id` is kept so traces survive the edge.
 * - Otherwise a valid W3C `traceparent` header contributes its 32-hex trace-id (O-04).
 * - Otherwise a UUIDv7 is minted, the id shape the rest of the system uses
 *   (`packages/contracts/src/request-id.ts`, PROJECT_CONTRACT §2).
 * - The id is echoed back on the response and published on the `AsyncLocalStorage`
 *   store, which is what `AllExceptionsFilter` reports as RFC 9457 `traceId`.
 * - Client ip and user agent are captured here too: PHASE_04 writes them into
 *   `audit_log.meta` (SECURITY_ARCHITECTURE §10) and nothing further down the pipeline
 *   should have to reach for the raw request again.
 */
export function RequestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId =
    normaliseRequestId(req.headers['x-request-id']) ||
    extractW3cTraceId(req.headers['traceparent']) ||
    newRequestId();

  req.headers['x-request-id'] = traceId;
  res.setHeader('x-request-id', traceId);

  const userAgent = req.headers['user-agent'];
  requestContextStorage.run(
    {
      traceId,
      startTime: Date.now(),
      clientIp: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 256) : undefined,
    },
    () => next(),
  );
}
