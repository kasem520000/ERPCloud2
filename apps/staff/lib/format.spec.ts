import { describe, expect, it } from 'vitest';

import { moneyText, qtyText } from './format.js';

describe('admin formatting kit', () => {
  it('formats money from decimal strings', () => {
    expect(moneyText('12.345', 'SAR', 'en-US')).toContain('12.35');
  });
  it('formats quantities without floating point drift', () => {
    expect(qtyText('1.23456')).toBe('1.2346');
  });
});
