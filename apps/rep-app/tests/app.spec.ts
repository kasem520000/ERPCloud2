import { describe, expect, it } from 'vitest';

import { matchesPrefix } from '../lib/surface-routing';
import { REP_STRINGS, translate } from '../lib/i18n';
import { SCREENS, primaryScreens, visibleScreens } from '../lib/navigation';

/**
 * M5 — the rep app's invariants, same family as the accounting app's `tests/app.spec.ts`
 * (M3): the permission map hides what the session cannot do, the dictionary is fully
 * bilingual, and the app keeps zero public surfaces (AUD-13 whole-segment rule).
 */

const allowAll = () => true;
const allowViewOnly = (permission: string) => permission === 'van_sales.view';

describe('navigation', () => {
  it('shows every screen to a fully-licensed rep', () => {
    expect(visibleScreens(allowAll).map((screen) => screen.href)).toEqual(
      SCREENS.map((screen) => screen.href),
    );
  });

  it('hides the write screens from a view-only session (the same codes the API checks)', () => {
    const visible = visibleScreens(allowViewOnly).map((screen) => screen.href);
    expect(visible).toEqual(['/', '/customers', '/stock', '/queue', '/sync']);
    // The four write screens sit behind exactly the codes the M4 routes require.
    expect(SCREENS.filter((screen) => screen.permission !== 'van_sales.view').map((screen) => screen.permission)).toEqual([
      'van_sales.invoice.create',
      'van_sales.collection.create',
      'van_sales.invoice.create',
      'van_sales.closing.submit',
    ]);
  });

  it('keeps the bottom bar at five primary tabs', () => {
    expect(primaryScreens(allowAll)).toHaveLength(5);
    expect(primaryScreens(allowAll).map((screen) => screen.href)).toEqual(['/', '/customers', '/stock', '/invoice', '/queue']);
  });
});

describe('i18n', () => {
  it('is bilingual for every dictionary entry (no missing side)', () => {
    for (const [key, entry] of Object.entries(REP_STRINGS)) {
      expect(entry.ar.length, `${key}.ar`).toBeGreaterThan(0);
      expect(entry.en.length, `${key}.en`).toBeGreaterThan(0);
    }
  });

  it('translates the shell strings and falls back to the key for unknowns', () => {
    expect(translate('app.name', 'ar')).toBe('تطبيق المندوب');
    expect(translate('app.name', 'en')).toBe('Rep App');
    expect(translate('no.such.key', 'ar')).toBe('no.such.key');
  });

  it('labels every screen in both languages', () => {
    for (const screen of SCREENS) {
      expect(screen.labelAr.length).toBeGreaterThan(0);
      expect(screen.labelEn.length).toBeGreaterThan(0);
    }
  });
});

describe('surface routing (AUD-13)', () => {
  it('has no public surfaces: no route escapes the session gate', () => {
    // The rep app is a field tool — every route is private. The whole-segment rule
    // rejects partial prefixes, which is exactly what a per-route hole would need.
    expect(matchesPrefix('/queue', '/queue')).toBe(true);
    expect(matchesPrefix('/queue/xyz', '/queue')).toBe(true);
    expect(matchesPrefix('/queueX', '/queue')).toBe(false);
    expect(matchesPrefix('/queuing', '/queue')).toBe(false);
  });
});
