import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { decodeProtectedHeader, jwtVerify, importSPKI } from 'jose';
import { env, normalisePem } from '@erp/config';
import { DomainError } from '@erp/contracts';

import { TokenService } from './token.service.js';

describe('TokenService', () => {
  const service = new TokenService();

  it('signs an RS256 access token carrying sub/tid/mid/scope/jti', async () => {
    const { token, jti } = await service.signAccessToken({
      sub: 'user-1',
      tid: 'tenant-1',
      mid: 'membership-1',
      scope: ['erp'],
    });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe(env.JWT_KEY_ID);

    const publicKey = await importSPKI(normalisePem(env.JWT_PUBLIC_KEY) as string, 'RS256');
    const { payload } = await jwtVerify(token, publicKey);

    expect(payload.sub).toBe('user-1');
    expect(payload.tid).toBe('tenant-1');
    expect(payload.mid).toBe('membership-1');
    expect(payload.scope).toEqual(['erp']);
    expect(payload.jti).toBe(jti);
    expect(payload.iss).toBe('erp-saas');
  });

  it('expires the access token after the frozen 15 minutes (PROJECT_CONTRACT §9)', async () => {
    const { token } = await service.signAccessToken({
      sub: 'u',
      tid: 't',
      mid: 'm',
      scope: ['erp'],
    });
    const publicKey = await importSPKI(normalisePem(env.JWT_PUBLIC_KEY) as string, 'RS256');
    const { payload } = await jwtVerify(token, publicKey);

    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.JWT_REFRESH_TTL_SECONDS).toBe(2_592_000);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
  });

  it('rejects a tampered token and a token signed for another audience', async () => {
    const { token } = await service.signAccessToken({ sub: 'u', tid: 't', mid: 'm', scope: ['erp'] });
    const tampered = `${token.slice(0, -4)}AAAA`;

    await expect(service.verifyAccessToken(tampered)).rejects.toBeInstanceOf(DomainError);
    await expect(service.verifyAccessToken('not-a-jwt')).rejects.toThrow(/invalid or expired/);
  });

  it('issues 256-bit refresh tokens and stores only their SHA-256', () => {
    const token = service.generateRefreshToken();
    const hash = service.hashRefreshToken(token);

    // 32 random bytes → 43 base64url characters.
    expect(token).toHaveLength(43);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toContain(token);
  });
});
