import { describe, expect, it } from 'vitest';

import {
  baselineRoles,
  findTenantSetting,
  isTenantSettingKey,
  parseTenantSettingValue,
  resolveTenantSettings,
  tenantSettingsDefaults,
  tenantSettingsRegistry,
} from './index.js';

describe('tenant settings registry', () => {
  it('keeps the five Phase-01 keys (no silent deletion) and adds the typed P03 keys', () => {
    for (const legacyKey of [
      'allow_negative_stock',
      'default_currency_code',
      'fiscal_year_start_month',
      'timezone',
      'branding.primary_color',
    ]) {
      expect(isTenantSettingKey(legacyKey), legacyKey).toBe(true);
    }
    expect(isTenantSettingKey('money.rounding_digits')).toBe(true);
    expect(isTenantSettingKey('feature.pos')).toBe(true);
    expect(isTenantSettingKey('nope.not.a.key')).toBe(false);
  });

  it('defaults every registered key exactly once', () => {
    const keys = tenantSettingsRegistry.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of tenantSettingsRegistry) {
      expect(tenantSettingsDefaults[entry.key]).toBe(entry.defaultValue);
      expect(entry.module.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('validates values against the declared schema (MULTI_TENANCY §5)', () => {
    expect(parseTenantSettingValue('money.rounding_digits', 4)).toBe(4);
    expect(() => parseTenantSettingValue('money.rounding_digits', 9)).toThrow();
    expect(() => parseTenantSettingValue('money.rounding_digits', 'many')).toThrow();
    expect(parseTenantSettingValue('feature.pos', true)).toBe(true);
    expect(() => parseTenantSettingValue('feature.pos', 'yes')).toThrow();
    expect(() => parseTenantSettingValue('branding.primary_color', 'blue')).toThrow();
    expect(() => parseTenantSettingValue('unknown.key', 1)).toThrow(/Unknown tenant setting key/);
    // null resets to the declared default
    expect(parseTenantSettingValue('invoice.padding', null)).toBe(
      findTenantSetting('invoice.padding')?.defaultValue,
    );
  });

  it('merges stored rows over registry defaults', () => {
    const resolved = resolveTenantSettings(new Map([['money.rounding_digits', 3]]));
    expect(resolved['money.rounding_digits']).toBe(3);
    expect(resolved['invoice.number_prefix']).toBe('INV-');
    expect(Object.keys(resolved)).toHaveLength(tenantSettingsRegistry.length);
  });
});

describe('baseline role seed (DATABASE_DESIGN §17)', () => {
  it('seeds exactly owner, accountant and cashier as system roles', () => {
    expect(baselineRoles.map((role) => role.code)).toEqual(['owner', 'accountant', 'cashier']);
    expect(baselineRoles.every((role) => role.isSystem)).toBe(true);
  });

  it('grants the owner role the wildcard and gives the others an explicit list', () => {
    expect(baselineRoles[0]?.permissions).toEqual(['*']);
    for (const role of baselineRoles.slice(1)) {
      expect(role.permissions.length).toBeGreaterThan(0);
      expect(role.permissions).not.toContain('*');
    }
  });
});
