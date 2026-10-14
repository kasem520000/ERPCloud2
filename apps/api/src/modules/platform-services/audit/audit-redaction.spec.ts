import { describe, expect, it } from 'vitest';

import { REDACTED_MARKER, isSensitiveKey, redactAuditPayload, redactKeyedValue } from './audit-redaction.js';

/**
 * SECURITY_ARCHITECTURE §9–§10: an audit row is written for every mutation, so the
 * redaction list is the only thing standing between "we log what changed" and "we log
 * credentials in a table nobody can delete from".
 */
describe('audit redaction', () => {
  it('recognises the sensitive key shapes, regardless of casing or separators', () => {
    for (const key of [
      'password',
      'passwordHash',
      'password_hash',
      'Secret',
      'clientSecret',
      'apiKey',
      'api_key',
      'token',
      'refreshToken',
      'authorization',
      'privateKey',
      'DATA_ENC_KEY',
    ]) {
      expect(isSensitiveKey(key), `${key} must be treated as sensitive`).toBe(true);
    }

    // `key` itself is the tenant-settings column name, and the object/idempotency key
    // names are opaque identifiers, not secrets.
    for (const key of ['name', 'email', 'description', 'status', 'key', 'objectKey', 'idempotency_key']) {
      expect(isSensitiveKey(key), `${key} must not be redacted`).toBe(false);
    }
  });

  it('replaces sensitive values at any depth while keeping the shape', () => {
    const redacted = redactAuditPayload({
      name: 'Acme',
      password: 'hunter2',
      nested: { apiKey: 'k-1', keep: 7, deeper: [{ token: 't-1', label: 'ok' }] },
    }) as Record<string, unknown>;

    expect(redacted.name).toBe('Acme');
    expect(redacted.password).toBe(REDACTED_MARKER);
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe(REDACTED_MARKER);
    expect(nested.keep).toBe(7);
    const deeper = nested.deeper as Array<Record<string, unknown>>;
    expect(deeper[0]?.token).toBe(REDACTED_MARKER);
    expect(deeper[0]?.label).toBe('ok');
  });

  it('never returns the original object (no accidental aliasing of the caller state)', () => {
    const original = { password: 'hunter2', keep: 1 };
    const redacted = redactAuditPayload(original) as Record<string, unknown>;
    expect(redacted).not.toBe(original);
    expect(original.password).toBe('hunter2');
  });

  it('passes scalars and dates through untouched', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(redactAuditPayload(42)).toBe(42);
    expect(redactAuditPayload('plain')).toBe('plain');
    expect(redactAuditPayload(null)).toBe(null);
    // Dates are normalised to ISO strings: jsonb has no date type.
    expect(redactAuditPayload(now)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('redacts a single key/value pair for callers that log one field at a time', () => {
    expect(redactKeyedValue('password', 'hunter2')).toEqual({ key: 'password', value: REDACTED_MARKER });
    expect(redactKeyedValue('city', 'Riyadh')).toEqual({ key: 'city', value: 'Riyadh' });
  });
});
