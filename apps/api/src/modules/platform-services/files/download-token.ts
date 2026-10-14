import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

import { env, normalisePem } from '@erp/config';

/**
 * App-signed download URLs (PHASE_04 §4: "download via app-signed URL").
 *
 * A browser cannot attach a bearer token to an `<img src>` or a download anchor, and
 * handing out the raw storage pre-signed URL would leak the bucket layout and outlive
 * the tenant check. Instead `GET /files/{id}/download` (authenticated, permissioned)
 * mints a short-lived HMAC over `fileId|tenantId|expiry`, and `GET /files/{id}/content`
 * verifies it and redirects to the storage URL.
 *
 * The signing secret is `FILE_URL_SIGNING_SECRET`; when unset it is derived from
 * `DATA_ENC_KEY`, and in development from the JWT private key, so a dev instance works
 * without extra setup while production still fails loudly if nothing is configured
 * (SECURITY_ARCHITECTURE §9: secrets via env only).
 */

export type DownloadTokenInput = {
  fileId: string;
  tenantId: string;
  expiresAtEpochSeconds: number;
};

let cachedSecret: string | undefined;

export function fileUrlSigningSecret(): string {
  if (cachedSecret) return cachedSecret;

  const configured = env.FILE_URL_SIGNING_SECRET ?? env.DATA_ENC_KEY;
  if (configured && configured.length >= 16) {
    cachedSecret = configured;
    return cachedSecret;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Invalid environment: FILE_URL_SIGNING_SECRET (or DATA_ENC_KEY) is required to sign file download URLs',
    );
  }

  const fallback = normalisePem(env.JWT_PRIVATE_KEY);
  if (!fallback) {
    throw new Error('Cannot sign file download URLs: set FILE_URL_SIGNING_SECRET or JWT_PRIVATE_KEY');
  }
  cachedSecret = createHash('sha256').update(fallback).digest('hex');
  return cachedSecret;
}

/** Test seam: the secret is cached, and a suite may rotate the environment. */
export function resetFileUrlSigningSecret(): void {
  cachedSecret = undefined;
}

export function signDownloadToken(input: DownloadTokenInput): string {
  return createHmac('sha256', fileUrlSigningSecret())
    .update(`${input.fileId}|${input.tenantId}|${input.expiresAtEpochSeconds}`)
    .digest('base64url');
}

export function verifyDownloadToken(input: DownloadTokenInput, signature: string): boolean {
  const expected = Buffer.from(signDownloadToken(input));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function isExpired(expiresAtEpochSeconds: number, now = new Date()): boolean {
  return expiresAtEpochSeconds * 1000 <= now.getTime();
}

/**
 * Browser-facing logo URL. A relative path works in the staff iframe (the rewrite
 * reaches the API). `API_PUBLIC_URL` makes a saved print file load the image too.
 * Signing can throw when no secret is configured; callers must treat that as "no logo".
 */
export function signedContentUrl(fileId: string, tenantId: string, ttlSeconds: number): string {
  const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signDownloadToken({ fileId, tenantId, expiresAtEpochSeconds });
  const path =
    `/api/v1/files/${fileId}/content?tenant=${encodeURIComponent(tenantId)}` +
    `&expires=${expiresAtEpochSeconds}&signature=${encodeURIComponent(signature)}`;
  const base = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}
