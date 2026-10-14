import { Injectable } from '@nestjs/common';

/**
 * Token-bucket rate limiter (SECURITY_ARCHITECTURE §8).
 *
 * In-process on purpose: it is correct for a single replica and keeps PHASE_03 free of a
 * Redis dependency. TODO(phase:23): move the counters to Redis so the buckets are shared
 * across replicas; the interface below is already shaped for that swap.
 */

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type Bucket = { tokens: number; updatedAt: number };

@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    const refillPerMs = limit / windowMs;
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, { tokens: limit - 1, updatedAt: now });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs);

    if (tokens < 1) {
      const missing = 1 - tokens;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerMs / 1000)),
      };
    }

    bucket.tokens = tokens - 1;
    bucket.updatedAt = now;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  /** Test helper — clears every bucket. */
  reset(): void {
    this.buckets.clear();
  }
}
