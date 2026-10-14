import { SetMetadata } from '@nestjs/common';

/** Per-route token bucket (SECURITY_ARCHITECTURE §8). */
export const RATE_LIMIT_KEY = 'erp:rateLimit';

export type RateLimitRule = {
  /** Bucket name — shared by every route using the same name. */
  name: string;
  limit: number;
  windowMs: number;
};

export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_KEY, rule);
