import { describe, expect, it } from 'vitest';
import { DomainError, TENANT_WIDE_SCOPE_ID } from '@erp/contracts';

import type { RoleScopeValue } from '../../../request-context/request-context.js';

import { allowedScopeIds, assertScope, scopeAuthorises } from './scope-policy.js';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const W3 = '33333333-3333-4333-8333-333333333333';

function scope(roleId: string, scopeType: RoleScopeValue['scopeType'], scopeId: string): RoleScopeValue {
  return { roleId, scopeType, scopeId };
}

describe('scope policy', () => {
  it('AUD-03: denies implicit tenant-wide access when NO held role has rows for the scopeType', () => {
    expect(scopeAuthorises([], ['r1'], 'warehouse', W1)).toBe(false);
    expect(scopeAuthorises([scope('r1', 'branch', W1)], ['r1'], 'warehouse', W1)).toBe(false);
    expect(allowedScopeIds([], ['r1'], 'warehouse')).toEqual([]);
    expect(allowedScopeIds([], [], 'warehouse')).toEqual([]);
  });

  it('restricts a scoped grant to its listed scopes', () => {
    const scopes = [scope('r1', 'warehouse', W1)];
    expect(scopeAuthorises(scopes, ['r1'], 'warehouse', W1)).toBe(true);
    expect(scopeAuthorises(scopes, ['r1'], 'warehouse', W2)).toBe(false);
    expect(allowedScopeIds(scopes, ['r1'], 'warehouse')).toEqual([W1]);
  });

  it('AUD-03: an unconfigured second role does NOT cancel a restriction on another held role', () => {
    // r1 is restricted to W1; r2 has NO warehouse scope rows configured at all.
    const scopes = [scope('r1', 'warehouse', W1)];
    expect(scopeAuthorises(scopes, ['r1', 'r2'], 'warehouse', W1)).toBe(true);
    expect(scopeAuthorises(scopes, ['r1', 'r2'], 'warehouse', W2)).toBe(false);
    expect(allowedScopeIds(scopes, ['r1', 'r2'], 'warehouse')).toEqual([W1]);
  });

  it('AUD-03: combines explicit scope rows across multiple roles via UNION', () => {
    const scopes = [scope('r1', 'warehouse', W1), scope('r2', 'warehouse', W2)];
    expect(scopeAuthorises(scopes, ['r1', 'r2'], 'warehouse', W1)).toBe(true);
    expect(scopeAuthorises(scopes, ['r1', 'r2'], 'warehouse', W2)).toBe(true);
    expect(scopeAuthorises(scopes, ['r1', 'r2'], 'warehouse', W3)).toBe(false);
    expect(allowedScopeIds(scopes, ['r1', 'r2'], 'warehouse')).toEqual([W1, W2]);
  });

  it('AUD-03: grants tenant-wide access ONLY when a role is explicitly configured with TENANT_WIDE_SCOPE_ID', () => {
    const singleWide = [scope('r1', 'warehouse', TENANT_WIDE_SCOPE_ID)];
    expect(scopeAuthorises(singleWide, ['r1'], 'warehouse', W1)).toBe(true);
    expect(scopeAuthorises(singleWide, ['r1'], 'warehouse', W2)).toBe(true);
    expect(allowedScopeIds(singleWide, ['r1'], 'warehouse')).toBeUndefined();

    const multiWithWide = [
      scope('r1', 'warehouse', W1),
      scope('r2', 'warehouse', TENANT_WIDE_SCOPE_ID),
    ];
    expect(scopeAuthorises(multiWithWide, ['r1', 'r2'], 'warehouse', W1)).toBe(true);
    expect(scopeAuthorises(multiWithWide, ['r1', 'r2'], 'warehouse', W2)).toBe(true);
    expect(scopeAuthorises(multiWithWide, ['r1', 'r2'], 'warehouse', W3)).toBe(true);
    expect(allowedScopeIds(multiWithWide, ['r1', 'r2'], 'warehouse')).toBeUndefined();
  });

  it('throws FORBIDDEN naming the uncovered scope', () => {
    try {
      assertScope([scope('r1', 'cash_location', W1)], ['r1'], 'cash_location', W2);
      throw new Error('expected FORBIDDEN');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('FORBIDDEN');
      expect((error as DomainError).message).toBe(`role grant does not cover cash_location ${W2}`);
    }
  });
});
