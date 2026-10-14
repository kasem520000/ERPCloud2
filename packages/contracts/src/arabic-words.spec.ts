import { describe, expect, it } from 'vitest';

import { amountInArabicWords, integerInArabicWords } from './arabic-words.js';

/**
 * Tafqeet is printed on every voucher and invoice, so it is worth pinning: an amount that
 * reads wrong in words is the one thing a customer notices before the numbers.
 */
describe('integerInArabicWords', () => {
  it('writes zero and the single digits', () => {
    expect(integerInArabicWords(0)).toBe('صفر');
    expect(integerInArabicWords(1)).toBe('واحد');
    expect(integerInArabicWords(9)).toBe('تسعة');
  });

  it('writes the teens and the tens with the unit first', () => {
    expect(integerInArabicWords(11)).toBe('أحد عشر');
    expect(integerInArabicWords(20)).toBe('عشرون');
    expect(integerInArabicWords(21)).toBe('واحد وعشرون');
    expect(integerInArabicWords(99)).toBe('تسعة وتسعون');
  });

  it('uses the dual and plural forms of the hundreds and thousands', () => {
    expect(integerInArabicWords(100)).toBe('مائة');
    expect(integerInArabicWords(200)).toBe('مائتان');
    expect(integerInArabicWords(300)).toBe('ثلاثمائة');
    expect(integerInArabicWords(1000)).toBe('ألف');
    expect(integerInArabicWords(2000)).toBe('ألفان');
    expect(integerInArabicWords(3000)).toBe('ثلاثة آلاف');
    expect(integerInArabicWords(11000)).toBe('أحد عشر ألفاً');
  });

  it('joins the scales with و in descending order', () => {
    expect(integerInArabicWords(5700)).toBe('خمسة آلاف وسبعمائة');
    expect(integerInArabicWords(1234)).toBe('ألف ومائتان وأربعة وثلاثون');
    expect(integerInArabicWords(2_000_000)).toBe('مليونان');
  });
});

describe('amountInArabicWords', () => {
  it('names the currency and the fraction', () => {
    expect(amountInArabicWords('5700.50', 'SAR')).toBe('خمسة آلاف وسبعمائة ريال وخمسون هللة لا غير');
    expect(amountInArabicWords('1.00', 'SAR')).toBe('واحد ريال لا غير');
  });

  it('switches the currency to the accusative plural above ten', () => {
    expect(amountInArabicWords('15.00', 'SAR')).toBe('خمسة عشر ريالاً لا غير');
  });

  it('rounds the fraction to two places and drops it when it is zero', () => {
    expect(amountInArabicWords('10.004', 'SAR')).toBe('عشرة ريال لا غير');
    expect(amountInArabicWords('10.006', 'SAR')).toContain('هللة');
  });

  it('keeps unknown currency codes as written', () => {
    expect(amountInArabicWords('3.00', 'XYZ')).toBe('ثلاثة XYZ لا غير');
  });

  it('marks a negative amount instead of hiding the sign', () => {
    expect(amountInArabicWords('-5.00', 'SAR')).toBe('سالب خمسة ريال لا غير');
  });
});
