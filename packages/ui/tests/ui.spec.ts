import { describe, expect, it } from 'vitest';

import { cn } from '../src/lib/cn';
import {
  formatCompactMoney,
  formatMoney,
  formatPercent,
  formatPosition,
  groupDigits,
  toWesternDigits,
} from '../src/lib/format';
import { initials } from '../src/components/avatar';
import { normalizeArabic } from '../src/components/input';
import { statusTone, STATUS_TONES } from '../src/components/status';
import {
  isThemeChoice,
  nextThemeChoice,
  resolveTheme,
  themeInitScript,
  THEME_STORAGE_KEY,
} from '../src/theme/theme';

describe('cn', () => {
  it('drops falsy values and keeps order', () => {
    expect(cn('a', false, undefined, null, 'b', 0, 'c')).toBe('a b c');
  });
});

describe('theme resolution', () => {
  it('uses exactly one storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('erp.theme');
  });

  it('resolves system against the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('cycles light → dark → system', () => {
    expect(nextThemeChoice('light')).toBe('dark');
    expect(nextThemeChoice('dark')).toBe('system');
    expect(nextThemeChoice('system')).toBe('light');
  });

  it('rejects an unknown stored value instead of trusting it', () => {
    expect(isThemeChoice('light')).toBe(true);
    expect(isThemeChoice('sepia')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });

  it('emits a blocking script that never leaves a stale dark class', () => {
    const script = themeInitScript('dark');
    // It must be self-contained: no imports, no globals beyond window/document.
    expect(script).toContain("classList.toggle('dark'");
    expect(script).toContain('localStorage');
    expect(script).not.toContain('import');
  });
});

describe('digits and money', () => {
  it('maps Eastern-Arabic digits to Western ones', () => {
    expect(toWesternDigits('١٢٣٤٥')).toBe('12345');
    expect(toWesternDigits('۱۲۳')).toBe('123');
  });

  it('groups the integer part only', () => {
    expect(groupDigits('1234567.89')).toBe('1,234,567.89');
    expect(groupDigits('-999')).toBe('-999');
  });

  it('renders money without ever rounding the value itself', () => {
    expect(formatMoney('1250.5', { currency: 'ر.س' })).toBe('1,250.50 ر.س');
    expect(formatMoney('-42', { currency: 'ر.س' })).toBe('-42.00 ر.س');
    expect(formatMoney('abc')).toBe('—');
  });

  it('compacts large amounts for axes', () => {
    expect(formatCompactMoney('1500000')).toBe('1.5M');
    // one decimal below 10K (an axis tick must stay short), rounded above it
    expect(formatCompactMoney('1240')).toBe('1.2K');
    expect(formatCompactMoney('12400')).toBe('12K');
  });

  it('always signs a KPI delta', () => {
    expect(formatPercent(12.44)).toBe('+12.4%');
    expect(formatPercent(-3)).toBe('-3.0%');
  });

  it('renders the desktop’s «n من m»', () => {
    expect(formatPosition(3, 12)).toBe('3 من 12');
    expect(formatPosition(0, 0)).toBe('—');
  });
});

describe('Arabic search normalisation', () => {
  it('matches a hamza-less query against a hamza-ful label', () => {
    expect(normalizeArabic('احمد')).toBe(normalizeArabic('أحمد'));
  });

  it('matches a ta-marbuta against a ha', () => {
    expect(normalizeArabic('فاتوره')).toBe(normalizeArabic('فاتورة'));
  });

  it('strips diacritics', () => {
    expect(normalizeArabic('مَبِيع')).toBe(normalizeArabic('مبيع'));
  });
});

describe('status vocabulary', () => {
  it('keeps the desktop accounting states distinct', () => {
    expect(statusTone('posted')).toBe('ok');
    expect(statusTone('draft')).toBe('warn');
    expect(statusTone('voided')).toBe('danger');
  });

  it('knows the POS tender-match answer', () => {
    expect(statusTone('مطابق')).toBe('ok');
    expect(statusTone('زيادة')).toBe('danger');
    expect(statusTone('ناقص')).toBe('warn');
  });

  it('falls back to neutral rather than guessing', () => {
    expect(statusTone('something-new')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });

  it('has no duplicate keys across tones', () => {
    const keys = Object.keys(STATUS_TONES);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('avatar initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('أحمد الشمري')).toBe('أا');
  });

  it('handles a single word and an empty name', () => {
    expect(initials('Sara')).toBe('Sa');
    expect(initials('   ')).toBe('؟');
  });
});
