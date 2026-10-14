import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { dataEncryptionKey, env } from '@erp/config';
import { DomainError, errorCodes } from '@erp/contracts';

/**
 * At-rest encryption for platform secrets — the MFA TOTP key in particular
 * (SECURITY_ARCHITECTURE §2: "`mfa_secret_enc` AES-GCM").
 *
 * Envelope format `v1:<iv b64>:<tag b64>:<ciphertext b64>` — deliberately identical to the
 * envelope used by the e-invoicing credentials, so one rotation procedure covers both. The
 * key is derived from `DATA_ENC_KEY` exactly the way those modules do (SHA-256 of the
 * configured secret). We never log the plaintext and never return it outside the module
 * that asked for it.
 */

/**
 * AUD-16 — لا مفتاح افتراضي معروف: المفتاح يُحلّ من `@erp/config` (fail-closed خارج
 * الاختبارات، ومفتاح اختبار معزول داخلها). تمرير `secret` صراحةً يبقى مدعوماً لاختبارات
 * التدوير.
 */
function keyBytes(secret?: string): Buffer {
  return createHash('sha256').update(secret ?? dataEncryptionKey()).digest();
}

/** AES-256-GCM seal. A fresh 12-byte IV per call; the auth tag is part of the envelope. */
export function sealSecret(plain: string | Buffer, key = env.DATA_ENC_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Opens a `v1:` envelope. Any tampering, a wrong key or a malformed payload throws — a
 * corrupted secret must never fail open into "no MFA".
 */
export function openSecret(payload: string, key = env.DATA_ENC_KEY): Buffer {
  const [version, iv64, tag64, data64] = payload.split(':');
  if (version !== 'v1' || !iv64 || !tag64 || !data64) {
    throw new DomainError(errorCodes.UNAUTHENTICATED, 'MFA secret is malformed', 401);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv64, 'base64'));
    decipher.setAuthTag(Buffer.from(tag64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]);
  } catch {
    throw new DomainError(errorCodes.UNAUTHENTICATED, 'MFA secret could not be decrypted', 401);
  }
}

export type ResealOutcome = {
  /** Re-encrypted (or unchanged) `v1:` envelope. */
  payload: string;
  /**
   * - `rotated`: decrypted with `oldKey` and re-sealed with a fresh IV under `newKey`.
   * - `already_current`: already decryptable with `newKey` (idempotent re-run).
   */
  status: 'rotated' | 'already_current';
};

/**
 * AUD-16 — Safe key rotation helper for `v1:<iv>:<tag>:<ciphertext>` envelopes.
 *
 * - Never logs or returns plaintext.
 * - Idempotent: if `payload` already opens under `newKey`, returns `already_current`
 *   without mutating the envelope, so interrupted batch migrations can be safely retried.
 * - Fails closed (`DomainError`) if neither `newKey` nor `oldKey` can authenticate the GCM tag.
 */
export function resealSecret(payload: string, oldKey: string, newKey = dataEncryptionKey()): ResealOutcome {
  if (!oldKey || oldKey.length < 32) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'oldKey must be at least 32 characters', 422);
  }
  if (!newKey || newKey.length < 32) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'newKey must be at least 32 characters', 422);
  }

  if (oldKey !== newKey) {
    try {
      openSecret(payload, newKey);
      return { payload, status: 'already_current' };
    } catch {
      // Not sealed with newKey yet — fall through to open with oldKey.
    }
  }

  const plain = openSecret(payload, oldKey);
  try {
    return {
      payload: sealSecret(plain, newKey),
      status: 'rotated',
    };
  } finally {
    plain.fill(0);
  }
}
