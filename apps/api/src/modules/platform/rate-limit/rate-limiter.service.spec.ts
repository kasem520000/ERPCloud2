import { describe, expect, it } from 'vitest';

import { RateLimiterService } from './rate-limiter.service.js';

describe('RateLimiterService', () => {
  it('allows up to the bucket size and then refuses', () => {
    const limiter = new RateLimiterService();
    let now = 1_000_000;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const decision = limiter.consume('login:127.0.0.1', 10, 60_000, now);
      expect(decision.allowed, `attempt ${attempt}`).toBe(true);
      expect(decision.remaining).toBe(10 - attempt);
    }

    const refused = limiter.consume('login:127.0.0.1', 10, 60_000, now);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills over time (token bucket, SECURITY_ARCHITECTURE §8)', () => {
    const limiter = new RateLimiterService();
    const start = 1_000_000;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.consume('login:ip', 10, 60_000, start);
    }
    expect(limiter.consume('login:ip', 10, 60_000, start).allowed).toBe(false);

    // 6 s at 10 tokens / 60 s = exactly one token back.
    expect(limiter.consume('login:ip', 10, 60_000, start + 6_000).allowed).toBe(true);
    expect(limiter.consume('login:ip', 10, 60_000, start + 6_000).allowed).toBe(false);
  });

  it('keeps buckets independent per key', () => {
    const limiter = new RateLimiterService();
    const now = 1_000_000;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.consume('login:alice', 5, 60_000, now);
    }
    expect(limiter.consume('login:alice', 5, 60_000, now).allowed).toBe(false);
    expect(limiter.consume('login:bob', 5, 60_000, now).allowed).toBe(true);
  });

  it('reset() clears every bucket (test hook)', () => {
    const limiter = new RateLimiterService();
    const now = 1_000_000;
    limiter.consume('login:ip', 1, 60_000, now);
    expect(limiter.consume('login:ip', 1, 60_000, now).allowed).toBe(false);

    limiter.reset();
    expect(limiter.consume('login:ip', 1, 60_000, now).allowed).toBe(true);
  });
});
