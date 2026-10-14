import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { env } from '@erp/config';
import { DomainError, errorCodes } from '@erp/contracts';

import { RATE_LIMIT_KEY, type RateLimitRule } from '../decorators/rate-limit.decorator.js';
import { RateLimiterService } from '../rate-limit/rate-limiter.service.js';

/**
 * Pipeline position: after helmet/CORS and **before** AuthGuard (API_ARCHITECTURE §2).
 * Default bucket is 600/min per client; `@RateLimit()` narrows it per route —
 * login 10/min, register/forgot 5/min (SECURITY_ARCHITECTURE §8).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const rule: RateLimitRule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? {
      name: 'default',
      limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
      windowMs: 60_000,
    };

    const clientKey = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const key = `${rule.name}:${clientKey}`;
    const decision = this.limiter.consume(key, rule.limit, rule.windowMs);

    response.setHeader('X-RateLimit-Limit', String(rule.limit));
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new DomainError(
        errorCodes.RATE_LIMITED,
        `Rate limit exceeded for ${rule.name}; retry in ${decision.retryAfterSeconds}s`,
        429,
      );
    }

    return true;
  }
}
