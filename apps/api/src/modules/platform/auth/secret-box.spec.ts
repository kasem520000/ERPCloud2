import { describe, expect, it } from 'vitest';
import { TEST_DATA_ENC_KEY, decideDataEncryptionKey } from '@erp/config';

import { openSecret, resealSecret, sealSecret } from './secret-box.js';

const KEY = 'unit-test-data-encryption-key';

describe('secret-box', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('my totp secret', KEY);
    expect(openSecret(sealed, KEY).toString('utf8')).toBe('my totp secret');
  });

  it('produces a fresh IV per seal, so identical plaintexts differ', () => {
    expect(sealSecret('same', KEY)).not.toBe(sealSecret('same', KEY));
  });

  it('refuses a wrong key', () => {
    const sealed = sealSecret('payload', KEY);
    expect(() => openSecret(sealed, 'another-key')).toThrow();
  });

  /**
   * AUD-16 — التدوير: مظروفٌ مختوم بالمفتاح القديم لا يُفتح بالمفتاح الجديد (GCM يرفض)،
   * فالانتقال يعني إعادة الختم لكل صفّ. الاختبار يثبّت الدورة الكاملة حتى لا يُظنّ أن
   * تغيير `DATA_ENC_KEY` وحده كافٍ.
   */
  it('AUD-16 rotation: the old envelope fails under the new key and must be re-sealed', () => {
    const oldKey = 'rotation-old-key-0123456789abcdef';
    const newKey = 'rotation-new-key-0123456789abcdef';

    const sealed = sealSecret('totp-secret', oldKey);
    expect(() => openSecret(sealed, newKey)).toThrow();

    const firstPass = resealSecret(sealed, oldKey, newKey);
    expect(firstPass.status).toBe('rotated');
    expect(openSecret(firstPass.payload, newKey).toString('utf8')).toBe('totp-secret');
    expect(() => openSecret(firstPass.payload, oldKey)).toThrow();

    // Idempotent second pass on an already-rotated envelope:
    const secondPass = resealSecret(firstPass.payload, oldKey, newKey);
    expect(secondPass.status).toBe('already_current');
    expect(secondPass.payload).toBe(firstPass.payload);

    // Fails closed if neither key matches:
    expect(() => resealSecret(sealed, 'wrong-old-key-0123456789abcdef0000', newKey)).toThrow();
  });

  it('AUD-16: لا مفتاح افتراضي معروف — والاختبار يستعمل مفتاحاً معزولاً', () => {
    expect(TEST_DATA_ENC_KEY).not.toBe('local-development-data-key');
    expect(() => decideDataEncryptionKey(undefined, 'production')).toThrow(/DATA_ENC_KEY/);

    // بلا أي مفتاح مضبوط، وختمٌ بالمفتاح الافتراضي: داخل الاختبارات يعمل بالمفتاح المعزول
    // (fail-closed everywhere else — يغطّيه spec الإعداد).
    const sealed = sealSecret('default-path');
    expect(openSecret(sealed).toString('utf8')).toBe('default-path');
  });

  it('refuses tampered ciphertext and malformed envelopes', () => {
    const sealed = sealSecret('payload', KEY);
    const [, iv, tag, data] = sealed.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(() => openSecret(`v1:${iv}:${tag}:${flipped.toString('base64')}`, KEY)).toThrow();
    expect(() => openSecret('not-an-envelope', KEY)).toThrow();
    expect(() => openSecret('v2:aa:bb:cc', KEY)).toThrow();
  });
});
