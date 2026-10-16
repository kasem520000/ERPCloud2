import { describe, expect, it } from 'vitest';

import {
  ASSET_STATUS_LABELS,
  currentPeriod,
  isValidPeriod,
  previewMonthlyAmount,
  statusLabelOf,
} from '../lib/assets';

/**
 * M6.1 — the fixed-assets client helpers, pinned as pure functions:
 *   • the instalment preview must mirror the service's math —
 *     (cost − salvage) / life, HALF-UP, 4 decimals — or the form would promise
 *     numbers the run would not post;
 *   • the period format the run endpoint demands (`YYYY-MM`) is validated
 *     client-side before the POST;
 *   • the status labels cover every `status` the register can return.
 */
describe('M6.1 — instalment preview (straight line, HALF-UP, 4dp)', () => {
  it('divides the depreciable base evenly', () => {
    // (240000 − 30000) / 60 = 3500 exactly.
    expect(previewMonthlyAmount('240000', '30000', 60)).toBe('3500.0000');
    expect(previewMonthlyAmount('48000', '0', 24)).toBe('2000.0000');
  });

  it('rounds the repeating decimals HALF-UP to the server scale', () => {
    // (1000 − 0) / 3 = 333.33333… → 333.3333 (4dp).
    expect(previewMonthlyAmount('1000', '0', 3)).toBe('333.3333');
    // (100 − 0) / 6 = 16.66666… → 16.6667 — HALF-UP, not truncation.
    expect(previewMonthlyAmount('100', '0', 6)).toBe('16.6667');
    // (10 − 1) / 8 = 1.125 exactly at 4dp.
    expect(previewMonthlyAmount('10', '1', 8)).toBe('1.1250');
  });

  it('refuses nonsense inputs instead of inventing a number', () => {
    expect(previewMonthlyAmount('30000', '40000', 60)).toBeNull(); // salvage above cost
    expect(previewMonthlyAmount('5000', '5000', 60)).toBeNull(); // nothing to depreciate
    expect(previewMonthlyAmount('240000', '0', 0)).toBeNull(); // no life
    expect(previewMonthlyAmount('240000', '0', -12)).toBeNull(); // negative life
    expect(previewMonthlyAmount('abc', '0', 60)).toBeNull(); // not a number
    expect(previewMonthlyAmount('', '0', 60)).toBeNull(); // empty form field
  });
});

describe('M6.1 — run period format', () => {
  it('accepts only YYYY-MM with a real month', () => {
    expect(isValidPeriod('2026-01')).toBe(true);
    expect(isValidPeriod('2026-12')).toBe(true);
    expect(isValidPeriod('2026-1')).toBe(false); // no zero padding
    expect(isValidPeriod('2026-00')).toBe(false); // no month 0
    expect(isValidPeriod('2026-13')).toBe(false); // no month 13
    expect(isValidPeriod('26-01')).toBe(false); // two-digit year
    expect(isValidPeriod('')).toBe(false);
  });

  it('defaults the form to the current month, zero-padded', () => {
    expect(currentPeriod(new Date('2026-01-05T09:00:00Z'))).toBe('2026-01');
    expect(currentPeriod(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(currentPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('M6.1 — register status labels', () => {
  it('labels every status the register can return, and falls back to the raw code', () => {
    expect(Object.keys(ASSET_STATUS_LABELS).sort()).toEqual(['active', 'disposed', 'fully_depreciated']);
    expect(statusLabelOf({ id: 'a', code: 'VAN-001', status: 'active' })).toBe('نشِط');
    expect(statusLabelOf({ id: 'a', code: 'VAN-001', status: 'fully_depreciated' })).toBe('مستوفى عمره');
    expect(statusLabelOf({ id: 'a', code: 'VAN-001', status: 'disposed' })).toBe('مُتخلَّص منه');
    expect(statusLabelOf({ id: 'a', code: 'VAN-001' })).toBe('نشِط'); // default
    expect(statusLabelOf({ id: 'a', code: 'VAN-001', status: 'weird' })).toBe('weird'); // fallback
  });
});
