import { describe, expect, it } from 'vitest';

import {
  canonicalPermissionCodes,
  canonicalizePermissionCode,
  erpFunctionalRoleCatalog,
  isConsolePermissionCode,
  isKnownPermissionCode,
  isTenantGrantablePermissionCode,
  permissionAliases,
  permissionGrants,
  permissionRegistry,
  platformPermissionRegistry,
  platformPermissionsForRoles,
  platformRoleCatalog,
  seedablePermissionCodes,
  tenantAdminRoleCatalog,
} from './index.js';

/**
 * Namespace fix guard rails (2026-09 architecture/RBAC reorganisation).
 *
 * The `platform.*` → `tenant.*` reclassification must never break an existing
 * grant, and the new `console.*` namespace must never be reachable from a tenant
 * role or from the `*` wildcard.
 */
describe('permission namespaces', () => {
  it('resolves every legacy platform.* code to a canonical tenant.* code', () => {
    expect(Object.keys(permissionAliases)).toHaveLength(10);
    for (const [legacyCode, canonical] of Object.entries(permissionAliases)) {
      expect(legacyCode.startsWith('platform.')).toBe(true);
      expect(canonical.startsWith('tenant.')).toBe(true);
      expect(canonicalPermissionCodes).toContain(canonical);
      // Both spellings stay seeded so old role_permissions rows keep their FK target.
      expect(seedablePermissionCodes).toContain(legacyCode);
      expect(seedablePermissionCodes).toContain(canonical);
    }
  });

  it('marks legacy codes deprecated and canonical codes clean', () => {
    for (const entry of permissionRegistry) {
      if (entry.code.startsWith('platform.')) {
        expect(entry.deprecated).toBe(true);
        expect(entry.canonical).toBe(permissionAliases[entry.code]);
      } else {
        expect(entry.deprecated ?? false).toBe(false);
      }
    }
    expect(canonicalizePermissionCode('platform.role.manage')).toBe('tenant.role.manage');
    expect(canonicalizePermissionCode('tenant.role.manage')).toBe('tenant.role.manage');
    expect(canonicalizePermissionCode('sales.view')).toBe('sales.view');
  });

  it('keeps console.* out of the tenant registry', () => {
    const tenantCodes = new Set(permissionRegistry.map((entry) => entry.code));
    expect(platformPermissionRegistry.length).toBeGreaterThan(0);
    for (const entry of platformPermissionRegistry) {
      expect(entry.code.startsWith('console.')).toBe(true);
      expect(tenantCodes.has(entry.code)).toBe(false);
      expect(isConsolePermissionCode(entry.code)).toBe(true);
      expect(isTenantGrantablePermissionCode(entry.code)).toBe(false);
      expect(isKnownPermissionCode(entry.code)).toBe(true);
    }
    expect(isConsolePermissionCode('tenant.view')).toBe(false);
    expect(isTenantGrantablePermissionCode('tenant.view')).toBe(true);
    expect(isTenantGrantablePermissionCode('platform.tenant.view')).toBe(true);
    expect(isTenantGrantablePermissionCode('*')).toBe(false);
  });

  it('grants across the legacy/canonical spelling boundary in both directions', () => {
    expect(permissionGrants(['tenant.role.manage'], 'tenant.role.manage')).toBe(true);
    expect(permissionGrants(['platform.role.manage'], 'tenant.role.manage')).toBe(true);
    expect(permissionGrants(['tenant.role.manage'], 'platform.role.manage')).toBe(true);
    expect(permissionGrants(['platform.role.manage'], 'platform.role.manage')).toBe(true);
    expect(permissionGrants(['tenant.view'], 'tenant.manage')).toBe(false);
    expect(permissionGrants([], 'tenant.view')).toBe(false);
  });

  it('never lets the * wildcard grant a console permission', () => {
    expect(permissionGrants(['*'], 'tenant.manage')).toBe(true);
    expect(permissionGrants(['*'], 'sales.invoice.post')).toBe(true);
    for (const entry of platformPermissionRegistry) {
      expect(permissionGrants(['*'], entry.code)).toBe(false);
    }
    expect(permissionGrants(['tenant.manage'], 'console.tenants.view')).toBe(false);
  });
});

describe('role catalogues', () => {
  it('defines five platform roles over console.* permissions only', () => {
    expect(platformRoleCatalog.map((role) => role.code)).toEqual([
      'platform_owner',
      'platform_operations',
      'platform_billing',
      'platform_support',
      'platform_auditor',
    ]);
    for (const role of platformRoleCatalog) {
      expect(role.permissions.length).toBeGreaterThan(0);
      for (const code of role.permissions) {
        expect(isConsolePermissionCode(code)).toBe(true);
        expect(isKnownPermissionCode(code)).toBe(true);
      }
    }
    expect(platformPermissionsForRoles(['platform_owner'])).toHaveLength(
      platformPermissionRegistry.length,
    );
    expect(
      platformPermissionsForRoles(['platform_support', 'platform_auditor']),
    ).toContain('console.support.manage');
  });

  it('defines tenant administration roles scoped to one tenant', () => {
    expect(tenantAdminRoleCatalog.map((role) => role.code)).toEqual([
      'tenant_owner',
      'tenant_admin',
      'branch_manager',
      'device_manager',
      'security_admin',
      'tenant_auditor',
    ]);
    const owner = tenantAdminRoleCatalog.find((role) => role.code === 'tenant_owner');
    expect(owner?.permissions).toEqual(['*']);
    for (const role of tenantAdminRoleCatalog) {
      for (const code of role.permissions) {
        if (code === '*') continue;
        expect(isConsolePermissionCode(code)).toBe(false);
        expect(isKnownPermissionCode(code)).toBe(true);
      }
    }
  });

  it('defines ERP functional roles with known tenant permissions', () => {
    expect(erpFunctionalRoleCatalog.length).toBe(13);
    for (const role of erpFunctionalRoleCatalog) {
      expect(role.permissions.length).toBeGreaterThan(0);
      for (const code of role.permissions) {
        expect(isConsolePermissionCode(code)).toBe(false);
        expect(isKnownPermissionCode(code)).toBe(true);
      }
    }
  });
});
