import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base32Decode, totp, verifyTotp } from '../src/modules/platform/auth/totp.js';

import { createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/** A 6-digit string guaranteed not to match the current TOTP window. */
function wrongCodeFor(secret: Buffer): string {
  const candidates = ['000000', '111111', '222222'];
  return candidates.find((candidate) => !verifyTotp(secret, candidate)) ?? '333333';
}

/**
 * Two-factor authentication — full lifecycle over HTTP.
 *
 * The security properties under test:
 *   1. 2FA is not enforced until the user *proves* their authenticator works (enable).
 *   2. Once enabled, a correct password alone returns MFA_REQUIRED, never a token.
 *   3. A wrong code is treated like a failed login (lockout counter advances).
 *   4. Recovery codes are one-time; replaying one fails.
 *   5. Disabling requires the password, and afterwards plain login works again.
 */

const PASSWORD = 'Correct-Horse-Battery-9';

describe('two-factor authentication (TOTP)', () => {
  let ctx: TestApp;
  let user: Actor;
  let secretBase32 = '';
  let recoveryCodes: string[] = [];

  const login = (body: Record<string, unknown>) => api(ctx.server, 'post', '/api/v1/auth/login', { body });
  const credentials = (mfaCode?: string) => ({
    email: user.email,
    password: PASSWORD,
    tenantCode: user.tenantCode,
    ...(mfaCode ? { mfaCode } : {}),
  });
  const data = (response: { body: Record<string, unknown> }) => response.body.data as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp('mfa');
    user = await createActor(ctx, {
      tenantCode: 'mfaco',
      email: 'secure@mfaco.test',
      password: PASSWORD,
      permissions: [],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('starts disabled with no secret', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: user.token });
    expect(response.status).toBe(200);
    expect(data(response)).toEqual({ enabled: false, enrolled: false, recoveryCodesLeft: 0 });
  });

  it('requires authentication', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/auth/mfa', {});
    expect(response.status).toBe(401);
  });

  it('enrolls: issues a base32 secret and an otpauth URL, without enforcing 2FA yet', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/auth/mfa/enroll', { token: user.token, body: {} });
    expect(response.status).toBe(201);
    const payload = data(response);
    secretBase32 = String(payload.secretBase32);
    expect(secretBase32).toMatch(/^[A-Z2-7]+=*$/);
    expect(String(payload.otpauthUrl)).toContain(`secret=${secretBase32}`);
    expect(String(payload.otpauthUrl)).toContain('issuer=Cloud%20SaaS%20ERP');

    const status = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: user.token });
    expect(data(status).enrolled).toBe(true);
    expect(data(status).enabled).toBe(false);
  });

  it('does not change login before enable', async () => {
    const response = await login(credentials());
    expect(response.status).toBe(200);
  });

  it('rejects enable with a wrong code', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/auth/mfa/enable', {
      token: user.token,
      body: { code: wrongCodeFor(base32Decode(secretBase32)) },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('enable with a valid code turns 2FA on and issues recovery codes exactly once', async () => {
    const code = totp(base32Decode(secretBase32));
    const response = await api(ctx.server, 'post', '/api/v1/auth/mfa/enable', { token: user.token, body: { code } });
    expect(response.status).toBe(200);
    recoveryCodes = (data(response).recoveryCodes as string[]) ?? [];
    expect(recoveryCodes).toHaveLength(8);
    for (const recovery of recoveryCodes) expect(recovery).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);

    const status = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: user.token });
    expect(data(status)).toEqual({ enabled: true, enrolled: true, recoveryCodesLeft: 8 });
  });

  it('now refuses a password-only login with MFA_REQUIRED', async () => {
    const response = await login(credentials());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('MFA_REQUIRED');
  });

  it('refuses a wrong authenticator code as a failed login', async () => {
    const response = await login(credentials(wrongCodeFor(base32Decode(secretBase32))));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('accepts the current TOTP code', async () => {
    const code = totp(base32Decode(secretBase32));
    const response = await login(credentials(code));
    expect(response.status).toBe(200);
    expect(String(data(response).accessToken)).not.toBe('');
  });

  it('accepts a recovery code exactly once', async () => {
    const [first] = recoveryCodes;
    const used = await login(credentials(first));
    expect(used.status).toBe(200);

    const replay = await login(credentials(first));
    expect(replay.status).toBe(401);

    const status = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: user.token });
    expect(data(status).recoveryCodesLeft).toBe(7);
  });

  it('disable demands the correct password', async () => {
    const wrong = await api(ctx.server, 'post', '/api/v1/auth/mfa/disable', {
      token: user.token,
      body: { password: 'not-the-password' },
    });
    expect(wrong.status).toBe(400);

    const right = await api(ctx.server, 'post', '/api/v1/auth/mfa/disable', {
      token: user.token,
      body: { password: PASSWORD },
    });
    expect(right.status).toBe(204);

    const status = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: user.token });
    expect(data(status)).toEqual({ enabled: false, enrolled: false, recoveryCodesLeft: 0 });
  });

  it('plain login works again after disable, and a stray code is rejected', async () => {
    const plain = await login(credentials());
    expect(plain.status).toBe(200);

    const stray = await login(credentials('123456'));
    expect(stray.status).toBe(400);
    expect(stray.body.code).toBe('VALIDATION_FAILED');
  });
});
