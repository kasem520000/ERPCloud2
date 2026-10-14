import { describe, expect, it } from 'vitest';

import { STRINGS, dirFor, translate } from './i18n.js';
import { allScreens, modules } from './navigation.js';

describe('i18n dictionary', () => {
  it('has a non-empty Arabic and English value for every key', () => {
    const entries = Object.entries(STRINGS);
    expect(entries.length).toBeGreaterThan(20);
    for (const [key, value] of entries) {
      expect(value.ar.trim(), `${key}.ar`).not.toBe('');
      expect(value.en.trim(), `${key}.en`).not.toBe('');
    }
  });

  it('translates known keys and falls back to the key itself for unknown ones', () => {
    expect(translate('nav.home', 'ar')).toBe('الرئيسية');
    expect(translate('nav.home', 'en')).toBe('Home');
    expect(translate('does.not.exist', 'en')).toBe('does.not.exist');
  });

  it('maps Arabic to RTL and English to LTR', () => {
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
  });
});

describe('navigation bilingual parity', () => {
  it('gives every module, group and screen both an Arabic and an English label', () => {
    for (const module of modules) {
      expect(module.labelAr.trim(), module.key).not.toBe('');
      expect(module.labelEn.trim(), module.key).not.toBe('');
      for (const group of module.groups) {
        expect(group.labelAr.trim(), group.key).not.toBe('');
        expect(group.labelEn.trim(), group.key).not.toBe('');
        for (const screen of group.items) {
          expect(screen.labelAr.trim(), screen.key).not.toBe('');
          expect(screen.labelEn.trim(), screen.key).not.toBe('');
        }
      }
    }
  });

  it('registers the language and two-factor settings screens as ready', () => {
    const keys = allScreens.map((screen) => screen.key);
    expect(keys).toContain('language');
    expect(keys).toContain('two-factor');
    for (const key of ['language', 'two-factor']) {
      const screen = allScreens.find((entry) => entry.key === key);
      expect(screen?.status).toBe('ready');
    }
  });
});
