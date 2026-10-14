import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@erp/contracts';

import {
  requestContextStorage,
  type AuthContextValue,
} from '../../../request-context/request-context.js';
import type { AuditService } from '../../platform-services/audit/audit.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRED_PLATFORM_PERMISSION_KEY } from '../decorators/requires-platform-role.decorator.js';
import type { PlatformRolePermissionsService } from '../identity/platform-role-permissions.service.js';

import { PlatformAdminGuard } from './platform-admin.guard.js';

/**
 * The guard now reads the role-permission overrides on every guarded request (P-C3), so the
 * spec supplies them instead of a database: `{}` = «nothing overridden, the catalogue rules».
 */
function rolePermissionsFor(overrides: Record<string, string[]> = {}): PlatformRolePermissionsService {
  return {
    overrides: vi.fn(async () => overrides),
  } as unknown as PlatformRolePermissionsService;
}

function guardWith(
  metadata: Record<string, unknown>,
  overrides: Record<string, string[]> = {},
  audit?: AuditService,
): PlatformAdminGuard {
  return new PlatformAdminGuard(reflectorFor(metadata), rolePermissionsFor(overrides), audit);
}

function contextWith(request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorFor(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: vi.fn((key: string) => metadata[key]),
  } as unknown as Reflector;
}

function withAuth(auth: Partial<AuthContextValue>, run: () => void | Promise<void>): void | Promise<void> {
  const full: AuthContextValue = {
    userId: 'u1',
    claimedTenantId: 't1',
    membershipId: 'm1',
    scope: ['erp'],
    tokenId: 'jti',
    isPlatformAdmin: false,
    platformRoles: [],
    ...auth,
  };
  requestContextStorage.run({ traceId: 'trace', startTime: 0, auth: full }, run);
}

describe('PlatformAdminGuard', () => {
  const context = contextWith();

  it('denies a tenant user without platform access', async () => {
    const guard = guardWith({});
    await withAuth({ isPlatformAdmin: false, platformRoles: [] }, async () => {
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(DomainError);
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('admits an effective platform administrator on unscoped routes (legacy rule)', async () => {
    const guard = guardWith({});
    await withAuth({ isPlatformAdmin: true, platformRoles: [] }, async () => {
      expect(await guard.canActivate(context)).toBe(true);
    });
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_support'] }, async () => {
      expect(await guard.canActivate(context)).toBe(true);
    });
  });

  it('enforces @RequiresPlatformRole against the token platform roles', async () => {
    const metadata = { [REQUIRED_PLATFORM_PERMISSION_KEY]: 'console.users.manage' };
    const guard = guardWith(metadata);
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_owner'] }, async () => {
      expect(await guard.canActivate(context)).toBe(true);
    });
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_support'] }, async () => {
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'platform permission console.users.manage required',
      });
    });
  });

  it('honours a written override over the catalogue (P-C3)', async () => {
    const metadata = { [REQUIRED_PLATFORM_PERMISSION_KEY]: 'console.users.manage' };
    // «دعم المنصة» does not carry the code in the catalogue…
    const guarded = guardWith(metadata, {});
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_support'] }, async () => {
      await expect(guarded.canActivate(context)).rejects.toBeInstanceOf(DomainError);
    });
    // …but an override written through `PUT /platform/roles/:code/permissions` admits it,
    // and one that *removes* a catalogue code closes the door on the same token.
    const extended = guardWith(metadata, {
      platform_support: ['console.tenants.view', 'console.users.manage'],
    });
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_support'] }, async () => {
      expect(await extended.canActivate(context)).toBe(true);
    });
    const narrowed = guardWith(metadata, { platform_owner: ['console.tenants.view'] });
    await withAuth({ isPlatformAdmin: true, platformRoles: ['platform_owner'] }, async () => {
      await expect(narrowed.canActivate(context)).rejects.toBeInstanceOf(DomainError);
    });
  });

  it('skips public routes', async () => {
    const guard = guardWith({ [IS_PUBLIC_KEY]: true });
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('SH-07: records break-glass audit (actor, reason, targetTenantId) without secrets and never on 403', async () => {
    const record = vi.fn(async () => 'audit-1');
    const audit = { record } as unknown as AuditService;
    const metadata = { [REQUIRED_PLATFORM_PERMISSION_KEY]: 'console.tenants.view' };
    const guard = guardWith(metadata, {}, audit);
    const targetTenantId = '11111111-1111-4111-8111-111111111111';

    await withAuth({ isPlatformAdmin: false, platformRoles: [] }, async () => {
      await expect(
        guard.canActivate(
          contextWith({
            method: 'GET',
            url: `/api/v1/platform/tenants/${targetTenantId}`,
            headers: { 'x-break-glass-reason': 'INC-402customer outage' },
          }),
        ),
      ).rejects.toBeInstanceOf(DomainError);
    });
    expect(record).not.toHaveBeenCalled();

    await withAuth({ userId: 'ops-1', isPlatformAdmin: true, platformRoles: ['platform_owner'] }, async () => {
      const ok = await guard.canActivate(
        contextWith({
          method: 'GET',
          url: `/api/v1/platform/tenants/${targetTenantId}`,
          headers: {
            authorization: 'Bearer secret-jwt-never-log',
            'x-break-glass-reason': 'INC-402 investigate billing lock',
          },
        }),
      );
      expect(ok).toBe(true);
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: null,
        actorUserId: 'ops-1',
        action: 'platform.break_glass.access',
        entity: 'platform_admin_plane',
        entityId: targetTenantId,
        meta: expect.objectContaining({
          reason: 'INC-402 investigate billing lock',
          targetTenantId,
          requiredPermission: 'console.tenants.view',
        }),
      }),
    );
    const logged = JSON.stringify(record.mock.calls[0]);
    expect(logged).not.toContain('secret-jwt-never-log');
  });
});
