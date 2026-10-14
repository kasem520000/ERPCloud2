import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { dataEncryptionKey } from '@erp/config';

/**
 * AES-256-GCM envelope shared by all provider credentials. Deployments set DATA_ENC_KEY
 * from the secret manager; AUD-16 removed the repository-known fallback — resolution is
 * fail-closed outside tests (`@erp/config`). The key never leaves this module.
 */
function keyBytes(secret = dataEncryptionKey()): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptEcommerceSecret(plain: string, secret?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptEcommerceSecret(payload: string, secret?: string): string {
  const [version, iv64, tag64, data64] = payload.split(':');
  if (version !== 'v1' || !iv64 || !tag64 || !data64) throw new Error('Invalid encrypted e-commerce secret');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(secret), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}

/** Accepts hex, base64, and the common `sha256=` prefix used by providers. */
export function verifyEcommerceSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const supplied = signature.replace(/^sha256=/i, '').trim();
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hex = createHmac('sha256', secret).update(raw).digest('hex');
  const base64 = createHmac('sha256', secret).update(raw).digest('base64');
  return safeEqual(supplied.toLowerCase(), hex) || safeEqual(supplied, base64);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskSecret(value: string | null | undefined): string {
  return value ? '****' : '—';
}
