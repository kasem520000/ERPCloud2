import { describe, expect, it } from 'vitest';

import { decodeZatcaQr } from './qr';

/** Builds a TLV payload the way the API's zatca/qr.ts does, so the decoder is tested against the real shape. */
function encode(fields: Array<[number, string]>): string {
  const parts: number[] = [];
  for (const [tag, value] of fields) {
    const bytes = Array.from(new TextEncoder().encode(value));
    parts.push(tag, bytes.length, ...bytes);
  }
  return Buffer.from(Uint8Array.from(parts)).toString('base64');
}

describe('zatca qr decoding', () => {
  const simplified = encode([
    [1, 'مؤسسة الأفق للتجارة'],
    [2, '310000000000003'],
    [3, '2026-03-01T10:15:00Z'],
    [4, '172.50'],
    [5, '22.50'],
  ]);

  it('reads the five human-readable tags including Arabic seller names', () => {
    const decoded = decodeZatcaQr(simplified);
    expect(decoded.sellerName).toBe('مؤسسة الأفق للتجارة');
    expect(decoded.vatNumber).toBe('310000000000003');
    expect(decoded.total).toBe('172.50');
    expect(decoded.vatTotal).toBe('22.50');
    expect(decoded.signed).toBe(false);
    expect(decoded.tags).toHaveLength(5);
  });

  it('flags a stamped invoice once hash and signature tags are present', () => {
    const stamped = encode([
      [1, 'Al Ufuq'],
      [2, '310000000000003'],
      [3, '2026-03-01T10:15:00Z'],
      [4, '172.50'],
      [5, '22.50'],
      [6, 'hash-value'],
      [7, 'signature-value'],
      [8, 'public-key'],
    ]);
    expect(decodeZatcaQr(stamped).signed).toBe(true);
  });

  it('rejects payloads that are not TLV', () => {
    expect(() => decodeZatcaQr(Buffer.from('hello there, not a qr').toString('base64'))).toThrow();
    expect(() => decodeZatcaQr('QQ==')).toThrow();
  });
});
