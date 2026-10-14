import { describe, expect, it } from 'vitest';

import { backoffDelayMs } from './outbox.publisher.js';
import { assertNoSecretsInPayload } from './queue.service.js';

/**
 * Outbox retry policy and the queue payload guard — PHASE_04 §5.5,
 * SECURITY_ARCHITECTURE §9 ("queue payloads carry no secrets").
 */
describe('outbox backoff', () => {
  it('grows exponentially from the configured base', () => {
    expect(backoffDelayMs(1, 1_000)).toBe(2_000);
    expect(backoffDelayMs(2, 1_000)).toBe(4_000);
    expect(backoffDelayMs(3, 1_000)).toBe(8_000);
    expect(backoffDelayMs(4, 1_000)).toBe(16_000);
  });

  it('is monotonic and capped at one hour, so a poison job cannot schedule itself into the year 3000', () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const delay = backoffDelayMs(attempt, 2_000);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(3_600_000);
      previous = delay;
    }
    expect(backoffDelayMs(40, 2_000)).toBe(3_600_000);
  });
});

describe('queue payload guard', () => {
  it('accepts an ordinary job payload', () => {
    expect(() =>
      assertNoSecretsInPayload({ invoiceId: 'inv-1', attempt: 2, nested: { branchId: 'b-1' } }),
    ).not.toThrow();
  });

  it('refuses a payload carrying a credential, at any depth, naming the offending path', () => {
    expect(() => assertNoSecretsInPayload({ password: 'hunter2' })).toThrow(
      /payload\.password: queue payloads must not carry secrets/,
    );
    expect(() => assertNoSecretsInPayload({ smtp: { apiKey: 'k' } })).toThrow(/payload\.smtp\.apiKey/);
    expect(() => assertNoSecretsInPayload({ a: { b: { refreshToken: 't' } } })).toThrow(
      /payload\.a\.b\.refreshToken/,
    );
  });

  it('does not choke on dates or arrays', () => {
    expect(() =>
      assertNoSecretsInPayload({ when: new Date(), rows: [{ id: 1 }, { id: 2 }] }),
    ).not.toThrow();
  });
});
