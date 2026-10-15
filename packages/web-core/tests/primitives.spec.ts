import { describe, expect, it } from 'vitest';

import { createI18n, dirFor } from '../src/i18n';
import { matchesPrefix } from '../src/surface-routing';

/**
 * M2 — the pure primitives: the AUD-13 whole-segment prefix rule and the i18n factory's
 * dictionary semantics (provider rendering itself is covered by the apps' own suites).
 */
describe('matchesPrefix — AUD-13 whole-segment matching', () => {
  it('matches the exact prefix and any path under it', () => {
    expect(matchesPrefix('/m', '/m')).toBe(true);
    expect(matchesPrefix('/m/', '/m')).toBe(true);
    expect(matchesPrefix('/m/sales', '/m')).toBe(true);
    expect(matchesPrefix('/esign/doc/1', '/esign')).toBe(true);
  });

  it('never matches a longer path that merely starts with the prefix text', () => {
    // The original bug: startsWith('/m') wrapped /marina, /migration, /manufacturing
    // in the employee shell, and startsWith('/esign') let /esign-evil past the gate.
    expect(matchesPrefix('/marina', '/m')).toBe(false);
    expect(matchesPrefix('/migration', '/m')).toBe(false);
    expect(matchesPrefix('/manufacturing', '/m')).toBe(false);
    expect(matchesPrefix('/esign-evil', '/esign')).toBe(false);
    expect(matchesPrefix('/m2', '/m')).toBe(false);
  });
});

describe('createI18n — dictionary semantics', () => {
  const i18n = createI18n({
    'app.name': { ar: 'النظام', en: 'The System' },
    'only.ar': { ar: 'عربي فقط', en: '' },
  });

  it('translates both directions and falls back to the key when a language value is missing', () => {
    expect(i18n.translate('app.name', 'ar')).toBe('النظام');
    expect(i18n.translate('app.name', 'en')).toBe('The System');
    expect(i18n.translate('unknown.key', 'ar')).toBe('unknown.key');
  });

  it('keeps RTL/LTR direction derived from the language', () => {
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
  });
});
