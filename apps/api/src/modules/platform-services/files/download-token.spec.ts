import { describe, expect, it } from 'vitest';

import { isExpired, resetFileUrlSigningSecret, signDownloadToken, verifyDownloadToken } from './download-token.js';
import { buildObjectKey } from './files.service.js';

/**
 * App-signed download links — PHASE_04 §5.3 ("app-signed download URL").
 *
 * The signature is the only authority the `/content` route has: it runs unauthenticated
 * so a browser can follow it. Everything that identifies the object — file id, tenant and
 * expiry — is therefore inside the signed payload.
 */
describe('download tokens', () => {
  const input = {
    fileId: '01a06e00-0000-7000-8000-000000000001',
    tenantId: '01a06e00-0000-7000-8000-0000000000aa',
    expiresAtEpochSeconds: 4_102_444_800, // 2100-01-01
  };

  it('verifies a token it just signed', () => {
    const signature = signDownloadToken(input);
    expect(signature.length).toBeGreaterThan(20);
    expect(verifyDownloadToken(input, signature)).toBe(true);
  });

  it('rejects a token whose file, tenant or expiry was altered', () => {
    const signature = signDownloadToken(input);

    expect(verifyDownloadToken({ ...input, fileId: '01a06e00-0000-7000-8000-000000000002' }, signature)).toBe(
      false,
    );
    expect(
      verifyDownloadToken({ ...input, tenantId: '01a06e00-0000-7000-8000-0000000000bb' }, signature),
    ).toBe(false);
    expect(verifyDownloadToken({ ...input, expiresAtEpochSeconds: input.expiresAtEpochSeconds + 1 }, signature)).toBe(
      false,
    );
  });

  it('rejects a malformed signature without throwing (timing-safe compare needs equal lengths)', () => {
    expect(verifyDownloadToken(input, '')).toBe(false);
    expect(verifyDownloadToken(input, 'short')).toBe(false);
    expect(verifyDownloadToken(input, '!'.repeat(43))).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isExpired(1_000_000_000)).toBe(true);
    expect(isExpired(4_102_444_800)).toBe(false);
    expect(isExpired(1_000, new Date(999_000))).toBe(false);
  });

  it('keeps the signing secret stable across calls in one process', () => {
    const first = signDownloadToken(input);
    expect(signDownloadToken(input)).toBe(first);
    resetFileUrlSigningSecret();
    // Without FILE_URL_SIGNING_SECRET the fallback is derived deterministically, so a
    // reset must not invalidate links that are still in flight.
    expect(signDownloadToken(input)).toBe(first);
  });
});

describe('object keys', () => {
  it('prefixes every object with its tenant and keeps the name safe', () => {
    const key = buildObjectKey(
      '01a06e00-0000-7000-8000-0000000000aa',
      '01a06e00-0000-7000-8000-000000000001',
      'Q1 report (final)/../../etc/passwd.pdf',
      new Date('2026-03-09T12:00:00.000Z'),
    );

    expect(key).toBe(
      'tenants/01a06e00-0000-7000-8000-0000000000aa/2026/03/' +
        '01a06e00-0000-7000-8000-000000000001/Q1_report__final__.._.._etc_passwd.pdf',
    );
    // No traversal survives, and the tenant prefix is first.
    expect(key).not.toContain('/../');
    expect(key.startsWith('tenants/01a06e00-0000-7000-8000-0000000000aa/')).toBe(true);
  });

  it('truncates absurd file names instead of rejecting the upload', () => {
    const key = buildObjectKey('t', 'f', `${'a'.repeat(400)}.pdf`);
    const name = key.split('/').at(-1) ?? '';
    expect(name.length).toBe(120);
  });
});
