import { describe, expect, it } from 'vitest';
import { DomainError } from '@erp/contracts';

import { combineRates, invertRate } from '../currencies/fx.service.js';

import { assertVersion, isUniqueViolation, isoOf, isoOrNull } from './org-support.js';

/**
 * The pure halves of the organization services — the parts that must be right
 * regardless of what the database returns (TESTING_STRATEGY §1, ADR-006 money math).
 */

describe('FX arithmetic', () => {
  it('inverts a rate at the stored scale without floating-point drift', () => {
    // 1/3.75 is exact; 1/3 is not, and must round HALF_UP at 10 decimals.
    expect(invertRate('3.75')).toBe('0.2666666667');
    expect(invertRate('3')).toBe('0.3333333333');
    expect(invertRate('0.2666666667')).toBe('3.7499999995');
  });

  it('multiplies triangulation legs and rounds once, at the end', () => {
    // A round trip through a 10-dp inverse is lossy by design, and visibly so.
    expect(combineRates('3.75', '0.2666666667')).toBe('1.0000000001');
    expect(combineRates('1.1', '1.1')).toBe('1.21');
    // 0.1 + 0.2 style drift would surface here if the maths used IEEE doubles.
    expect(combineRates('0.1', '3')).toBe('0.3');
  });

  it('keeps a canonical string per value (no trailing zeros)', () => {
    expect(combineRates('2.5000000000', '2')).toBe('5');
  });
});

describe('assertVersion', () => {
  it('passes when the client did not send a version', () => {
    expect(() => assertVersion(3, undefined)).not.toThrow();
  });

  it('passes when the version matches', () => {
    expect(() => assertVersion(3, 3)).not.toThrow();
  });

  it('raises VERSION_CONFLICT with a 409 when the client read a stale row', () => {
    try {
      assertVersion(4, 3);
      expect.unreachable('a stale version must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('VERSION_CONFLICT');
      expect(domainError.status).toBe(409);
    }
  });
});

describe('isUniqueViolation', () => {
  it('recognises SQLSTATE 23505, optionally for a named constraint', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23505', constraint: 'branches_tenant_code_key' }, 'branches_tenant_code_key')).toBe(
      true,
    );
    expect(isUniqueViolation({ code: '23505', constraint: 'other' }, 'branches_tenant_code_key')).toBe(false);
  });

  it('ignores anything that is not a unique violation', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('timestamp helpers', () => {
  it('serialises dates as ISO-8601 and preserves null', () => {
    expect(isoOf(new Date('2026-02-03T04:05:06.000Z'))).toBe('2026-02-03T04:05:06.000Z');
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull('2026-02-03T04:05:06.000Z')).toBe('2026-02-03T04:05:06.000Z');
  });
});
