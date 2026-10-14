import { describe, expect, it } from 'vitest';

import { code128Bars, sanitizeBarcode } from './barcode.js';

describe('code128Bars', () => {
  it('drops characters the symbology cannot carry', () => {
    expect(sanitizeBarcode('ABC-١٢٣')).toBe('ABC-');
  });

  it('emits nothing for an empty payload', () => {
    expect(code128Bars('')).toEqual({ bars: [], width: 0 });
  });

  it('brackets the data with the start-B and stop patterns', () => {
    const { bars, width } = code128Bars('A');
    // start-B (211214) + 'A' (111323) + checksum + stop (2331112) = 4 symbols.
    expect(bars.length).toBe(3 + 3 + 3 + 4);
    // 11 modules per symbol for the first three, 13 for the stop pattern.
    expect(width).toBe(11 * 3 + 13);
    expect(bars[0]).toEqual({ x: 0, width: 2 });
  });

  it('places the modulo-103 check symbol after the data', () => {
    // 'HI' → start 104, H=40, I=41; (104 + 40*1 + 41*2) % 103 = 20 → pattern '221231'.
    const { bars } = code128Bars('HI');
    const checkStart = 11 * 3;
    const checkBars = bars.filter((bar) => bar.x >= checkStart && bar.x < checkStart + 11);
    expect(checkBars.map((bar) => bar.width)).toEqual([2, 1, 3]);
  });
});
