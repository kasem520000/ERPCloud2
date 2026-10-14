import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from './einvoicing.service.js';

describe('e-invoicing credential storage', () => {
  it('encrypts secrets and fails closed with the wrong key', () => {
    const encrypted = encryptSecret('super-secret-csid', 'key-a');
    expect(encrypted).not.toContain('super-secret-csid');
    expect(decryptSecret(encrypted, 'key-a')).toBe('super-secret-csid');
    expect(() => decryptSecret(encrypted, 'key-b')).toThrow();
  });

  it('rejects a payload that is not in the versioned envelope', () => {
    expect(() => decryptSecret('garbage')).toThrow();
  });
});

// The document itself — UBL, hash chain, QR and signing — is covered by `zatca/zatca.spec.ts`.
