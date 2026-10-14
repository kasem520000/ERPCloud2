import { describe, expect, it } from 'vitest';

import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with the frozen Argon2id parameters (PROJECT_CONTRACT §9: m=64 MiB, t=3, p=4)', async () => {
    const hash = await service.hash('Tr0ubador&Horse9');

    // PHC string format: $argon2id$v=19$m=<KiB>,t=<iterations>,p=<lanes>$<salt>$<digest>
    expect(hash.startsWith('$argon2id$')).toBe(true);
    const params = hash.split('$')[3] ?? '';
    expect(params).toContain('m=65536');
    expect(params).toContain('t=3');
    expect(params).toContain('p=4');
  }, 60_000);

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await service.hash('Tr0ubador&Horse9');

    await expect(service.verify(hash, 'Tr0ubador&Horse9')).resolves.toBe(true);
    await expect(service.verify(hash, 'Tr0ubador&Horse8')).resolves.toBe(false);
  }, 60_000);

  it('produces a different hash per call (random salt) and never stores the plaintext', async () => {
    const first = await service.hash('Tr0ubador&Horse9');
    const second = await service.hash('Tr0ubador&Horse9');

    expect(first).not.toBe(second);
    expect(first).not.toContain('Tr0ubador');
  }, 60_000);

  it('treats a missing hash (invited user) as a failed verification', async () => {
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
    await expect(service.verify('not-a-phc-string', 'anything')).resolves.toBe(false);
  });

  it('enforces the policy before hashing', () => {
    expect(() => service.assertPolicy('short')).toThrow(/password policy/i);
    expect(() => service.assertPolicy('Tr0ubador&Horse9')).not.toThrow();
  });
});
