import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  hotp,
  normaliseRecoveryCode,
  otpauthUrl,
  totp,
  verifyTotp,
} from './totp.js';

/**
 * RFC 6238 Appendix B test vectors — the seed is the ASCII string "12345678901234567890"
 * (20 bytes, HMAC-SHA1 mode). The RFC lists 8-digit codes; the 6-digit mode every
 * authenticator app uses is the same value truncated to 6 digits.
 */
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');

const RFC_VECTORS: Array<[timeSeconds: number, eightDigits: string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('totp', () => {
  it('matches every RFC 6238 vector (8-digit and truncated 6-digit)', () => {
    for (const [timeSeconds, eightDigits] of RFC_VECTORS) {
      const time = timeSeconds * 1000;
      expect(hotp(RFC_SEED, Math.floor(timeSeconds / 30), 8)).toBe(eightDigits);
      expect(totp(RFC_SEED, { time, digits: 6 })).toBe(eightDigits.slice(-6));
    }
  });

  it('verifies the current code and one step of clock skew either way', () => {
    const time = 59_000;
    const current = totp(RFC_SEED, { time });
    const previous = totp(RFC_SEED, { time: time - 30_000 });
    const next = totp(RFC_SEED, { time: time + 30_000 });

    expect(verifyTotp(RFC_SEED, current, { time })).toBe(true);
    expect(verifyTotp(RFC_SEED, previous, { time })).toBe(true);
    expect(verifyTotp(RFC_SEED, next, { time })).toBe(true);
  });

  it('rejects codes further than one step away, malformed codes and wrong secrets', () => {
    const time = 300_000; // counter 10 — far enough from the epoch to age a code out
    const tooOld = totp(RFC_SEED, { time: time - 90_000 }); // counter 7: three steps back
    expect(verifyTotp(RFC_SEED, tooOld, { time })).toBe(false);
    expect(verifyTotp(RFC_SEED, '12345', { time })).toBe(false);
    expect(verifyTotp(RFC_SEED, 'abcdef', { time })).toBe(false);
    expect(verifyTotp(Buffer.from('a different secret!!'), totp(RFC_SEED, { time }), { time })).toBe(false);
  });

  it('base32 round-trips and tolerates human input', () => {
    const encoded = base32Encode(RFC_SEED);
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(encoded)).toEqual(RFC_SEED);
    expect(base32Decode(encoded.toLowerCase())).toEqual(RFC_SEED);
    expect(base32Decode(`${encoded.slice(0, 8)} ${encoded.slice(8)}`)).toEqual(RFC_SEED);
    expect(() => base32Decode('0189')).toThrow();
  });

  it('builds a provisioning URI authenticator apps accept', () => {
    const url = otpauthUrl('SECRET234', 'owner@demo.test');
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=SECRET234');
    expect(url).toContain('issuer=Cloud%20SaaS%20ERP');
    expect(url).toContain(encodeURIComponent('owner@demo.test'));
    expect(url).toContain('digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('generates unique XXXX-XXXX codes without ambiguous glyphs', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    }
  });

  it('normalisation ignores case, dashes and spaces', () => {
    const code = generateRecoveryCode();
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(normaliseRecoveryCode(code));
    expect(normaliseRecoveryCode(code.replace('-', ' '))).toBe(normaliseRecoveryCode(code));
  });
});
