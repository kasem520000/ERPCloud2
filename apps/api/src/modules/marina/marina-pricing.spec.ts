import { describe, expect, it } from 'vitest';

import { calculateMarinaPeriod } from './marina-pricing.js';
describe('calculateMarinaPeriod', () => {
  it('rounds partial periods to half-hour buckets', () => { expect(calculateMarinaPeriod({ startsAt: '2026-01-01T10:00:00Z', endsAt: '2026-01-01T11:20:00Z', hourlyPrice: '100', halfHourPrice: '60' })).toBe('160.0000'); });
  it('uses offer price when configured', () => { expect(calculateMarinaPeriod({ startsAt: '2026-01-01T10:00:00Z', endsAt: '2026-01-01T14:00:00Z', hourlyPrice: '100', offerPrice: '250' })).toBe('250.0000'); });
});
