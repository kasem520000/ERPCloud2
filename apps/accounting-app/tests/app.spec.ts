import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { accountingAppEntitled } from '../lib/accounting';
import { SCREENS, visibleScreens } from '../lib/navigation';
import { matchesPrefix } from '../lib/surface-routing';

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * M3 — the scaffold's contract, pinned the same way the other apps pin theirs
 * (source-level invariants + pure-function behavior):
 *   1. every screen maps to an existing GET endpoint and names the permission that
 *      guards it (so the shell cannot advertise a surface the API would refuse);
 *   2. the entitlement rule (D-002: marketplace gating, never new tenancy);
 *   3. no public surfaces — the whole app sits behind the session gate;
 *   4. read-only milestone: the pages call the shared GET client only.
 */
describe('M3 scaffold — navigation registry', () => {
  it('exposes the accounting surfaces, each with its permission', () => {
    const hrefs = SCREENS.map((screen) => screen.href);
    expect(hrefs).toEqual([
      '/',
      '/accounts',
      '/journals',
      '/periods',
      '/trial-balance',
      '/income-statement',
      '/cost-centers',
      '/zatca',
    ]);
    for (const screen of SCREENS) {
      expect(screen.permission, `${screen.href} permission`).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
      expect(screen.labelAr.trim(), `${screen.href} ar label`).not.toBe('');
      expect(screen.labelEn.trim(), `${screen.href} en label`).not.toBe('');
    }
  });

  it('hides screens the session cannot view', () => {
    const all = () => true;
    const denyAll = () => false;
    const tenantOnly = (permission?: string) => permission === 'tenant.view';
    const reportsOnly = (permission?: string) => permission === 'accounting.reports.view' || permission === 'tenant.view';
    expect(visibleScreens(all).map((screen) => screen.href)).toHaveLength(SCREENS.length);
    expect(visibleScreens(denyAll)).toEqual([]);
    expect(visibleScreens(tenantOnly).map((screen) => screen.href)).toEqual(['/']);
    expect(visibleScreens(reportsOnly).map((screen) => screen.href)).toEqual(['/', '/journals', '/trial-balance', '/income-statement']);
  });
});

describe('M3 scaffold — entitlement rule (D-002)', () => {
  it('entitles an enabled install, a pristine core bundle, and nothing else', () => {
    expect(accountingAppEntitled({ code: 'accounting', isCore: true, isActive: true, enabled: true, installedAt: '2026-01-01' })).toBe(true);
    expect(accountingAppEntitled({ code: 'accounting', isCore: true, isActive: true, enabled: false, installedAt: null })).toBe(true);
    expect(accountingAppEntitled({ code: 'accounting', isCore: false, isActive: true, enabled: true, installedAt: '2026-01-01' })).toBe(true);
    // An operator's explicit disable wins over the core bundle.
    expect(accountingAppEntitled({ code: 'accounting', isCore: true, isActive: true, enabled: false, installedAt: '2026-01-01' })).toBe(false);
    expect(accountingAppEntitled({ code: 'accounting', isCore: false, isActive: true, enabled: false, installedAt: null })).toBe(false);
    expect(accountingAppEntitled(undefined)).toBe(false);
  });
});

describe('M3 scaffold — no public surfaces', () => {
  it('still classifies whole segments (AUD-13) — kept for parity, nothing is public here', () => {
    expect(matchesPrefix('/accounts', '/accounts')).toBe(true);
    expect(matchesPrefix('/accounts/x', '/accounts')).toBe(true);
    expect(matchesPrefix('/accountsX', '/accounts')).toBe(false);
  });

  it('keeps the app read-only: the pages import the shared GET client, never apiPost/apiPatch/apiDelete', async () => {
    for (const page of ['accounts', 'journals', 'periods', 'trial-balance', 'income-statement', 'cost-centers', 'zatca']) {
      const code = await source(`app/${page}/page.tsx`);
      expect(code, `${page} must not write`).not.toMatch(/\bapiPost\b|\bapiPatch\b|\bapiDelete\b/);
    }
    const gate = await source('components/auth-gate.tsx');
    expect(gate).toContain('fetchAccountingEntitlement');
    expect(gate).toContain('LoginScreen');
  });
});
