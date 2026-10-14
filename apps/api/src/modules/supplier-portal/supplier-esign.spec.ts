import { describe, expect, it } from 'vitest';

import {
  PortalRuleError,
  acceptSignature,
  assertSignable,
  loginDecision,
  newSecret,
  respondToRfq,
  scopeToken,
  sha256,
  signedPdf,
  splitScopedToken,
  visibleToParty,
} from './supplier-esign.js';

const party = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

describe('supplier portal and simple e-sign', () => {
  it('shows a supplier only their own invoices', () => {
    const rows = [
      { id: 'a', partyId: party },
      { id: 'b', partyId: other },
    ];
    expect(visibleToParty(rows, party).map((row) => row.id)).toEqual(['a']);
  });

  it('hides a foreign invoice instead of confirming it exists', () => {
    expect(visibleToParty([{ id: 'b', partyId: other }], party)).toEqual([]);
  });

  it('rejects a login unless the account exists, is active, and the password matches', () => {
    expect(loginDecision({ found: true, active: true, passwordOk: false }).status).toBe(401);
    expect(loginDecision({ found: false, active: true, passwordOk: true }).status).toBe(401);
    expect(loginDecision({ found: true, active: false, passwordOk: true }).status).toBe(401);
    expect(loginDecision({ found: true, active: true, passwordOk: true }).ok).toBe(true);
  });

  it('records an electronic offer on an open request', () => {
    expect(respondToRfq({ status: 'open', partyId: party }, party, { offer: '150', note: 'تسليم أسبوع' })).toEqual({
      status: 'responded',
      offer: '150.0000',
      note: 'تسليم أسبوع',
    });
  });

  it('rejects a second response to the same request', () => {
    expect(() => respondToRfq({ status: 'responded', partyId: party }, party, { offer: '10', note: '' })).toThrow(PortalRuleError);
  });

  it('issues a 48-character secret whose hash does not contain the secret', () => {
    const secret = newSecret(48);
    const token = scopeToken(party, secret);
    expect(secret).toHaveLength(48);
    expect(sha256(secret).includes(secret)).toBe(false);
    expect(splitScopedToken(token)?.secret).toBe(secret);
  });

  it('treats an expired signature link as gone', () => {
    expect(() => assertSignable({ status: 'sent', expiresAt: '2020-01-01T00:00:00.000Z' }, new Date('2026-01-01T00:00:00.000Z'))).toThrow(
      PortalRuleError,
    );
    try {
      assertSignable({ status: 'viewed', expiresAt: '2020-01-01T00:00:00.000Z' }, new Date('2026-01-01T00:00:00.000Z'));
    } catch (error) {
      expect((error as PortalRuleError).status).toBe(410);
    }
  });

  it('signs with the one-time code and writes a PDF, and rejects a wrong code', () => {
    const otp = '123456';
    const signed = acceptSignature({ otp, expectedOtpHash: sha256(otp), signatureData: 'data:image/png;base64,aaaa' });
    expect(signed.status).toBe('signed');
    expect(signedPdf({ number: 'Q-1', signer: 'buyer@example.com', signedAt: '2026-09-29T00:00:00.000Z' }).subarray(0, 5).toString()).toBe('%PDF-');
    expect(() => acceptSignature({ otp: '000000', expectedOtpHash: sha256(otp), signatureData: 'data:image/png;base64,aaaa' })).toThrow(
      PortalRuleError,
    );
  });
});
