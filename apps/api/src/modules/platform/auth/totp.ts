import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226) — SHA-1, 6 digits, 30-second step, which is
 * what every mainstream authenticator app defaults to.
 *
 * Implemented locally on `node:crypto` instead of adding a dependency: the algorithm is
 * ~40 lines, fully covered by RFC test vectors in `totp.spec.ts`.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648, no padding — authenticator apps expect it that way. */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Tolerates lower case, padding and spaces so a hand-typed secret still decodes. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character '${char}'`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 §5.3 — HOTP with a dynamic truncation offset. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(BigInt(counter));
  // HMAC-SHA1 is always 20 bytes and offset ≤ 15, so the four reads below cannot
  // overflow the buffer; readUInt32BE spares us the index dance.
  const digest = createHmac('sha1', secret).update(block).digest();
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export type TotpOptions = {
  /** Unix milliseconds. Defaults to now. Tests pin it. */
  time?: number;
  /** Step in seconds (RFC default 30). */
  step?: number;
  digits?: number;
};

export function totp(secret: Buffer, options: TotpOptions = {}): string {
  const { time = Date.now(), step = 30, digits = 6 } = options;
  return hotp(secret, Math.floor(time / 1000 / step), digits);
}

/**
 * Verifies a code against the current step and ± `window` neighbours (clock skew).
 * Comparison is constant-time per candidate.
 */
export function verifyTotp(secret: Buffer, code: string, options: TotpOptions & { window?: number } = {}): boolean {
  const { time = Date.now(), step = 30, digits = 6, window = 1 } = options;
  const trimmed = code.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) return false;
  const counter = Math.floor(time / 1000 / step);
  const candidate = Buffer.from(trimmed);
  for (let offset = -window; offset <= window; offset += 1) {
    if (counter + offset < 0) continue; // counters are unsigned (RFC 4226 §5.2)
    const expected = Buffer.from(hotp(secret, counter + offset, digits));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) return true;
  }
  return false;
}

/** 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export const MFA_ISSUER = 'Cloud SaaS ERP';

/** Provisioning URI for authenticator apps (also the payload of a QR code). */
export function otpauthUrl(secretBase32: string, accountEmail: string): string {
  const label = encodeURIComponent(`${MFA_ISSUER}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(MFA_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Recovery codes — the fallback when the authenticator device is lost.
// ---------------------------------------------------------------------------

/** Alphabet without ambiguous glyphs (no 0/O, 1/I/L) — codes are read off a screen. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += RECOVERY_ALPHABET.charAt(bytes.readUInt8(index) % RECOVERY_ALPHABET.length);
    if (index === 3) code += '-';
  }
  return code;
}

/** Normalisation shared by generation and verification: case/space/dash-insensitive. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
