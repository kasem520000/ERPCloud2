/**
 * Pure rules for the supplier portal and a simple drawn signature.
 * No database. A supplier only ever sees rows that belong to their party.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class PortalRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PortalRuleError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newSecret(length = 48): string {
  const raw = randomBytes(length).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
  return raw.slice(0, length).padEnd(length, 'x');
}

/** The public token carries the tenant so RLS can be set before the row is read. */
export function scopeToken(tenantId: string, secret: string): string {
  return `${tenantId}.${secret}`;
}

export function splitScopedToken(token: string): { tenantId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const tenantId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(tenantId) || secret.length < 16) return null;
  return { tenantId, secret };
}

export function newOtp(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

export function loginDecision(input: { found: boolean; active: boolean; passwordOk: boolean }): { ok: boolean; status: number } {
  if (!input.found || !input.active || !input.passwordOk) return { ok: false, status: 401 };
  return { ok: true, status: 200 };
}

export function visibleToParty<T extends { partyId: string }>(rows: T[], partyId: string): T[] {
  return rows.filter((row) => row.partyId === partyId);
}

export function assertOwnParty(row: { partyId: string } | undefined, partyId: string): void {
  if (!row || row.partyId !== partyId) throw new PortalRuleError('NOT_FOUND', 'The document was not found', 404);
}

export function respondToRfq(
  rfq: { status: string; partyId: string },
  actorPartyId: string,
  input: { offer: string; note: string },
): { status: 'responded'; offer: string; note: string } {
  assertOwnParty(rfq, actorPartyId);
  if (rfq.status !== 'open') throw new PortalRuleError('RFQ_CLOSED', 'This request was already answered', 409);
  const offer = Number(input.offer);
  if (!Number.isFinite(offer) || offer <= 0) throw new PortalRuleError('OFFER_INVALID', 'The offer must be greater than zero', 422);
  return { status: 'responded', offer: offer.toFixed(4), note: input.note.trim() };
}

export type EsignStatus = 'sent' | 'viewed' | 'signed' | 'declined';

export function assertSignable(request: { status: EsignStatus; expiresAt: string }, now: Date): void {
  if (request.status === 'signed') throw new PortalRuleError('ALREADY_SIGNED', 'This document is already signed', 409);
  if (request.status === 'declined') throw new PortalRuleError('ESIGN_DECLINED', 'This signature request was declined', 409);
  if (new Date(request.expiresAt).getTime() <= now.getTime()) {
    throw new PortalRuleError('ESIGN_EXPIRED', 'This signature link has expired', 410);
  }
}

export function acceptSignature(input: { otp: string; expectedOtpHash: string; signatureData: string }): { status: 'signed' } {
  if (!input.signatureData || input.signatureData.trim().length < 8) {
    throw new PortalRuleError('SIGNATURE_REQUIRED', 'Draw a signature before sending', 422);
  }
  const given = Buffer.from(sha256(input.otp.trim()));
  const expected = Buffer.from(input.expectedOtpHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new PortalRuleError('OTP_INVALID', 'The one-time code is wrong', 422);
  }
  return { status: 'signed' };
}

/** A one-page PDF the signer and the clerk can download. Arabic stays in the payload. */
export function signedPdf(input: { number: string; signer: string; signedAt: string }): Buffer {
  const line = `Signed ${input.number} by ${input.signer} at ${input.signedAt}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 50 780 Td (${line}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += `${object}\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}
