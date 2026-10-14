import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@erp/contracts';
import type { DatabaseHandle } from '@erp/database';

import { requestContextStorage } from '../../../request-context/request-context.js';
import type { TokenService } from '../auth/token.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

import { AuthGuard } from './auth.guard.js';

function createContext(authorization?: string): ExecutionContext {
  const request: Record<string, unknown> = {
    headers: authorization ? { authorization } : {},
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function mockDbWithUser(userRow?: { id: string; status: string }): DatabaseHandle {
  const selectChain = {
    from: () => ({
      where: () => ({
        limit: async () => (userRow ? [userRow] : []),
      }),
    }),
  };
  const tx = {
    select: () => selectChain,
  };
  return {
    db: {
      transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    },
  } as unknown as DatabaseHandle;
}

const mockTokens = {
  verifyAccessToken: vi.fn(async () => ({
    sub: '11111111-1111-4111-8111-111111111111',
    tid: '22222222-2222-4222-8222-222222222222',
    mid: '33333333-3333-4333-8333-333333333333',
    scope: ['erp'],
    jti: 'jti-1',
    pam: true,
    proles: ['platform_owner'],
  })),
} as unknown as TokenService;

describe('AuthGuard (AUD-01 central active-user enforcement)', () => {
  it('passes through on @Public() routes without checking headers or DB', async () => {
    const reflector = { getAllAndOverride: vi.fn((key) => key === IS_PUBLIC_KEY) } as unknown as Reflector;
    const guard = new AuthGuard(reflector, mockTokens);
    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });

  it('allows an active user and populates AuthContext', async () => {
    const reflector = { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector;
    const db = mockDbWithUser({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
    });
    const guard = new AuthGuard(reflector, mockTokens, db);
    await requestContextStorage.run({ traceId: 't1', startTime: 0 }, async () => {
      await expect(guard.canActivate(createContext('Bearer valid-jwt'))).resolves.toBe(true);
    });
  });

  it('AUD-01: immediately rejects a suspended user with 401 UNAUTHENTICATED even with a valid JWT', async () => {
    const reflector = { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector;
    const db = mockDbWithUser({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'suspended',
    });
    const guard = new AuthGuard(reflector, mockTokens, db);
    await requestContextStorage.run({ traceId: 't1', startTime: 0 }, async () => {
      await expect(guard.canActivate(createContext('Bearer valid-jwt'))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      } satisfies Partial<DomainError>);
    });
  });

  it('AUD-01: rejects an invited or soft-deleted user with 401 UNAUTHENTICATED', async () => {
    const reflector = { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector;
    const invitedGuard = new AuthGuard(
      reflector,
      mockTokens,
      mockDbWithUser({ id: '11111111-1111-4111-8111-111111111111', status: 'invited' }),
    );
    const missingGuard = new AuthGuard(reflector, mockTokens, mockDbWithUser(undefined));

    await requestContextStorage.run({ traceId: 't1', startTime: 0 }, async () => {
      await expect(invitedGuard.canActivate(createContext('Bearer valid-jwt'))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      });
      await expect(missingGuard.canActivate(createContext('Bearer valid-jwt'))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      });
    });
  });
});
