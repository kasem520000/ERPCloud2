import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { detectSallaDiff, encryptSallaSecret, decryptSallaSecret, verifySallaSignature } from './salla-utils.js';
describe('Salla utilities', () => {
  it('detects legacy view diff flags', () => { expect(detectSallaDiff({ name: 'A', price: '10', cost: '7', qty: '2' }, { name: 'A', price: '9', cost: '7', qty: '1' })).toEqual(['price', 'qty']); });
  it('encrypts tokens and verifies webhook HMAC', () => { const secret = decryptSallaSecret(encryptSallaSecret('hook-secret')); const body = '{"event":"order.created"}'; const sig = createHmac('sha256', secret).update(body).digest('hex'); expect(verifySallaSignature(body, sig, secret)).toBe(true); expect(verifySallaSignature(body, 'bad', secret)).toBe(false); });
});
