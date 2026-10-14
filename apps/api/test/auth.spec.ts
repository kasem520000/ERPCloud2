import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RateLimiterService, TokenService } from '../src/modules/platform/index.js';

import { createActor, hashPassword, setTenantStatusFixture } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Authentication flows against a real PostgreSQL — API_CONTRACT §1,
 * SECURITY_ARCHITECTURE §2, PHASE_03 §9 (token rotation + reuse kill-chain,
 * Argon2id parameters, lockout, forged claim, suspended tenant).
 */

const PASSWORD = 'Tr0ubador&Horse9';

describe('auth (API_CONTRACT §1)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp('auth');
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  // The login bucket is 10/min per IP (SECURITY_ARCHITECTURE §8); reset it so each test
  // starts from a full bucket instead of inheriting the previous test's attempts.
  beforeEach(() => {
    ctx.app.get(RateLimiterService).reset();
  });

  async function actorWithPassword(tenantCode: string, email: string) {
    return createActor(ctx, { tenantCode, email, password: PASSWORD });
  }

  it('logs in with e-mail + tenant code and returns an access/refresh pair', async () => {
    const actor = await actorWithPassword('acme', 'owner@acme.test');

    const response = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@acme.test', password: PASSWORD, tenantCode: 'acme' },
    });

    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');
    expect(data.tokenType).toBe('Bearer');
    expect(data.expiresIn).toBe(900);
    expect((data.user as Record<string, unknown>).email).toBe('owner@acme.test');
    expect(Array.isArray(data.memberships)).toBe(true);

    const me = await api(ctx.server, 'get', '/api/v1/me', { token: data.accessToken as string });
    expect(me.status).toBe(200);
    expect((me.body.data as Record<string, unknown>).user).toMatchObject({ email: actor.email });
  });

  it('answers every credential failure with the same opaque 401 (no account enumeration)', async () => {
    await actorWithPassword('globex', 'owner@globex.test');

    const wrongPassword = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@globex.test', password: 'WrongPassword123!', tenantCode: 'globex' },
    });
    const unknownEmail = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'nobody@globex.test', password: PASSWORD, tenantCode: 'globex' },
    });
    const unknownTenant = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@globex.test', password: PASSWORD, tenantCode: 'no-such-tenant' },
    });

    for (const response of [wrongPassword, unknownEmail, unknownTenant]) {
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(response.body.detail).toBe('Invalid e-mail, tenant or password');
    }
  });

  it('locks the account after repeated failures and answers with RATE_LIMITED', async () => {
    await actorWithPassword('initech', 'owner@initech.test');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api(ctx.server, 'post', '/api/v1/auth/login', {
        body: { email: 'owner@initech.test', password: 'WrongPassword123!', tenantCode: 'initech' },
      });
      expect(response.status, `attempt ${attempt + 1}`).toBe(401);
    }

    const locked = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@initech.test', password: PASSWORD, tenantCode: 'initech' },
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('RATE_LIMITED');
    expect(String(locked.body.detail)).toMatch(/locked/i);
  });

  it('enforces the 10/min login bucket and returns Retry-After', async () => {
    await actorWithPassword('umbrella', 'owner@umbrella.test');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await api(ctx.server, 'post', '/api/v1/auth/login', {
        body: { email: 'owner@umbrella.test', password: PASSWORD, tenantCode: 'umbrella' },
      });
      expect(response.status, `attempt ${attempt + 1}`).toBe(200);
    }

    const throttled = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@umbrella.test', password: PASSWORD, tenantCode: 'umbrella' },
    });
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe('RATE_LIMITED');
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('rotates the refresh token and revokes the whole family on reuse', async () => {
    await actorWithPassword('soylent', 'owner@soylent.test');

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@soylent.test', password: PASSWORD, tenantCode: 'soylent' },
    });
    const first = (login.body.data as { refreshToken: string }).refreshToken;

    const rotated = await api(ctx.server, 'post', '/api/v1/auth/refresh', {
      body: { refreshToken: first },
    });
    expect(rotated.status).toBe(200);
    const second = (rotated.body.data as { refreshToken: string }).refreshToken;
    expect(second).not.toBe(first);

    // Reuse of the rotated-out token must kill the family, not just reject the call.
    const replay = await api(ctx.server, 'post', '/api/v1/auth/refresh', {
      body: { refreshToken: first },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('UNAUTHENTICATED');
    expect(String(replay.body.detail)).toMatch(/reuse/i);

    const afterReplay = await api(ctx.server, 'post', '/api/v1/auth/refresh', {
      body: { refreshToken: second },
    });
    expect(afterReplay.status, 'the whole family must be revoked').toBe(401);
  });

  it('revokes sessions on logout', async () => {
    await actorWithPassword('hooli', 'owner@hooli.test');

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@hooli.test', password: PASSWORD, tenantCode: 'hooli' },
    });
    const { accessToken, refreshToken } = login.body.data as {
      accessToken: string;
      refreshToken: string;
    };

    const logout = await api(ctx.server, 'post', '/api/v1/auth/logout', {
      token: accessToken,
      body: {},
    });
    expect(logout.status).toBe(204);

    const refresh = await api(ctx.server, 'post', '/api/v1/auth/refresh', {
      body: { refreshToken },
    });
    expect(refresh.status).toBe(401);
  });

  it('changes the password, invalidates existing sessions and rejects the old one', async () => {
    await actorWithPassword('vandelay', 'owner@vandelay.test');
    const nextPassword = 'N3w-Rotation!Pass';

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@vandelay.test', password: PASSWORD, tenantCode: 'vandelay' },
    });
    const { accessToken, refreshToken } = login.body.data as {
      accessToken: string;
      refreshToken: string;
    };

    const weak = await api(ctx.server, 'post', '/api/v1/auth/change-password', {
      token: accessToken,
      body: { current: PASSWORD, new: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_FAILED');

    const wrongCurrent = await api(ctx.server, 'post', '/api/v1/auth/change-password', {
      token: accessToken,
      body: { current: 'NotThePassword1!', new: nextPassword },
    });
    expect(wrongCurrent.status).toBe(400);

    const changed = await api(ctx.server, 'post', '/api/v1/auth/change-password', {
      token: accessToken,
      body: { current: PASSWORD, new: nextPassword },
    });
    expect(changed.status).toBe(204);

    const oldLogin = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@vandelay.test', password: PASSWORD, tenantCode: 'vandelay' },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@vandelay.test', password: nextPassword, tenantCode: 'vandelay' },
    });
    expect(newLogin.status).toBe(200);

    const refresh = await api(ctx.server, 'post', '/api/v1/auth/refresh', {
      body: { refreshToken },
    });
    expect(refresh.status, 'a password change must revoke existing sessions').toBe(401);
  });

  it('rejects a suspended tenant with 423 TENANT_SUSPENDED on login and on requests', async () => {
    const actor = await createActor(ctx, {
      tenantCode: 'wayne',
      email: 'owner@wayne.test',
      password: PASSWORD,
    });

    await setTenantStatusFixture(ctx.db.ownerUrl, actor.tenantId, 'suspended');

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'owner@wayne.test', password: PASSWORD, tenantCode: 'wayne' },
    });
    expect(login.status).toBe(423);
    expect(login.body.code).toBe('TENANT_SUSPENDED');

    const me = await api(ctx.server, 'get', '/api/v1/me', { token: actor.token });
    expect(me.status).toBe(423);
    expect(me.body.code).toBe('TENANT_SUSPENDED');
  });

  it('rejects a forged tid claim with 403 FORBIDDEN (MULTI_TENANCY §4 hard block)', async () => {
    const alice = await createActor(ctx, { tenantCode: 'stark', email: 'owner@stark.test' });
    const bob = await createActor(ctx, { tenantCode: 'lannister', email: 'owner@lannister.test' });

    // A token that claims Bob's tenant but Alice's membership.
    const forged = await ctx.app
      .get(TokenService)
      .signAccessToken({ sub: alice.userId, tid: bob.tenantId, mid: alice.membershipId, scope: ['erp'] });

    const me = await api(ctx.server, 'get', '/api/v1/me', { token: forged.token });
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('FORBIDDEN');
  });

  it('rejects requests without a usable bearer token', async () => {
    const missing = await api(ctx.server, 'get', '/api/v1/me');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('UNAUTHENTICATED');

    const malformed = await api(ctx.server, 'get', '/api/v1/me', { token: 'not-a-jwt' });
    expect(malformed.status).toBe(401);
  });

  it('answers a malformed body with problem+json and a field list', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email: 'nope', tenantCode: '' },
    });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.traceId).toBeDefined();
    expect(Array.isArray(response.body.errors)).toBe(true);
  });

  it('stores the password only as an Argon2id hash with the frozen parameters', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash.split('$')[3]).toContain('m=65536,t=3,p=4');
  }, 60_000);
});
