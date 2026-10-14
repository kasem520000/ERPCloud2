import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, TENANT_WIDE_SCOPE_ID } from '@erp/contracts';

import {
  getRequestContext,
  requestContextStorage,
  type RoleScopeValue,
  type TenantContextValue,
} from '../../../request-context/request-context.js';

import { BranchScopeGuard } from './branch-scope.guard.js';

const BRANCH_IN_SCOPE = '11111111-1111-7111-8111-111111111111';
const BRANCH_OUT_OF_SCOPE = '22222222-2222-7222-8222-222222222222';

function run(
  headers: Record<string, string>,
  branchScope: string[] | null,
  options?: { roleIds?: string[]; scopes?: RoleScopeValue[]; isOwner?: boolean },
): void {
  const reflector = { getAllAndOverride: vi.fn(() => undefined) } as unknown as Reflector;
  const guard = new BranchScopeGuard(reflector);
  const request = { headers } as Record<string, unknown>;
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const tenant: TenantContextValue = {
    tenantId: 't1',
    tenantCode: 'demo',
    tenantStatus: 'active',
    membershipId: 'm1',
    userId: 'u1',
    ...(options?.roleIds !== undefined ? { roleIds: options.roleIds } : {}),
    permissions: [],
    branchScope,
    isOwner: options?.isOwner ?? false,
    kind: 'staff',
    maxDiscountPct: null,
    maxDiscountAmount: null,
    scopes: options?.scopes ?? [],
  };

  requestContextStorage.run({ traceId: 'trace', startTime: 0, tenant }, () => {
    expect(guard.canActivate(context)).toBe(true);
    expect(getRequestContext().branchId).toBe(request.branchId);
  });
}

describe('BranchScopeGuard', () => {
  it('passes through when no X-Branch-Id is supplied', () => {
    expect(() => run({}, [BRANCH_IN_SCOPE])).not.toThrow();
  });

  it('accepts a branch inside the membership scope', () => {
    expect(() => run({ 'x-branch-id': BRANCH_IN_SCOPE }, [BRANCH_IN_SCOPE])).not.toThrow();
  });

  it('accepts any branch when the membership branchScope is null and roleIds are not evaluated', () => {
    expect(() => run({ 'x-branch-id': BRANCH_OUT_OF_SCOPE }, null)).not.toThrow();
  });

  it('rejects a branch outside the membership scope with FORBIDDEN', () => {
    expect(() => run({ 'x-branch-id': BRANCH_OUT_OF_SCOPE }, [BRANCH_IN_SCOPE])).toThrowError(DomainError);
    try {
      run({ 'x-branch-id': BRANCH_OUT_OF_SCOPE }, [BRANCH_IN_SCOPE]);
    } catch (error) {
      expect((error as DomainError).code).toBe('FORBIDDEN');
      expect((error as DomainError).status).toBe(403);
    }
  });

  it('AUD-03: rejects X-Branch-Id when non-owner roles have NO branch scope rows configured', () => {
    expect(() =>
      run({ 'x-branch-id': BRANCH_IN_SCOPE }, null, { roleIds: ['r1'], scopes: [] }),
    ).toThrowError(DomainError);
  });

  it('AUD-03: accepts X-Branch-Id only when covered by an explicit branch scope or TENANT_WIDE_SCOPE_ID', () => {
    expect(() =>
      run({ 'x-branch-id': BRANCH_IN_SCOPE }, null, {
        roleIds: ['r1'],
        scopes: [{ roleId: 'r1', scopeType: 'branch', scopeId: BRANCH_IN_SCOPE }],
      }),
    ).not.toThrow();

    expect(() =>
      run({ 'x-branch-id': BRANCH_OUT_OF_SCOPE }, null, {
        roleIds: ['r1'],
        scopes: [{ roleId: 'r1', scopeType: 'branch', scopeId: BRANCH_IN_SCOPE }],
      }),
    ).toThrowError(DomainError);

    expect(() =>
      run({ 'x-branch-id': BRANCH_OUT_OF_SCOPE }, null, {
        roleIds: ['r1'],
        scopes: [{ roleId: 'r1', scopeType: 'branch', scopeId: TENANT_WIDE_SCOPE_ID }],
      }),
    ).not.toThrow();
  });

  it('rejects a malformed branch id with VALIDATION_FAILED', () => {
    try {
      run({ 'x-branch-id': 'not-a-uuid' }, null);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('VALIDATION_FAILED');
    }
  });
});
