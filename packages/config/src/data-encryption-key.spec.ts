import { describe, expect, it } from 'vitest';

import {
  TEST_DATA_ENC_KEY,
  assertRuntimeEnv,
  decideDataEncryptionKey,
  env,
  resolveDataEncryptionKey,
  type AppEnv,
} from './env.js';

/**
 * AUD-16 — مفتاح التشفير الساكن.
 *
 * كان كل مسارٍ للتشفير يستعمل `process.env.DATA_ENC_KEY ?? 'local-development-data-key'`
 * في أي بيئة غير الإنتاج، أي أن أي staging يحمل أسراراً حقيقية كان يشفّرها بمفتاحٍ
 * منشور في المستودع. الشرط الآن: لا مفتاح افتراضي معروف خارج الاختبارات، والاختبارات
 * تستعمل مفتاحاً معزولاً بالاسم، وغياب المفتاح خارج الاختبارات يفشل بدل أن يمرّ بصمت.
 */
describe('AUD-16 — مفتاح تشفير ساكن بلا افتراضي معروف', () => {
  const LEGACY_DEV_DEFAULT = 'local-development-data-key';

  it('يستعمل القيمة المضبوطة كما هي (مع التنقية)', () => {
    expect(decideDataEncryptionKey('  configured-key-1234  ', 'production')).toBe('configured-key-1234');
  });

  it('يفشل في الإنتاج وstaging/أي بيئة غير اختبارية عند غياب المفتاح', () => {
    for (const nodeEnv of ['production', 'development', 'staging']) {
      expect(() => decideDataEncryptionKey(undefined, nodeEnv)).toThrow(/DATA_ENC_KEY is required/);
      expect(() => decideDataEncryptionKey('   ', nodeEnv)).toThrow(/DATA_ENC_KEY is required/);
    }
  });

  it('يعيد مفتاح اختبار معزولاً داخل الاختبارات فقط — وليس الافتراضي القديم', () => {
    expect(decideDataEncryptionKey(undefined, 'test')).toBe(TEST_DATA_ENC_KEY);
    expect(TEST_DATA_ENC_KEY).not.toBe(LEGACY_DEV_DEFAULT);
  });

  it('resolveDataEncryptionKey يقرأ المرشَّح الصريح ثم البيئة', () => {
    expect(resolveDataEncryptionKey({ DATA_ENC_KEY: 'explicit-key-123456' }, 'production')).toBe('explicit-key-123456');
    expect(resolveDataEncryptionKey(undefined, 'test')).toBe(TEST_DATA_ENC_KEY);
  });

  it('بيئة الاختبار المحمّلة (`env`) تحمل مفتاحاً غير معروف للنشر', () => {
    expect(typeof env.DATA_ENC_KEY).toBe('string');
    expect(env.DATA_ENC_KEY).not.toBe(LEGACY_DEV_DEFAULT);
    expect(env.DATA_ENC_KEY?.length ?? 0).toBeGreaterThanOrEqual(16);
  });

  it('assertRuntimeEnv: الإنتاج بلا مفتاح يُرفض، ومعه يمرّ', () => {
    const base: AppEnv = {
      ...env,
      DATABASE_URL: 'postgres://user:pass@localhost:5432/erp',
      JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
      JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----',
      // AUD-09 أضاف سرًّا إنتاجيًّا ثانيًا بنفس المنطق: `COMPAT_KEY_PEPPER`. الإنتاج
      // يرفض النقص في أَيّهما، والموجب هنا يضبط الاثنين.
      COMPAT_KEY_PEPPER: 'compat-pepper-123456',
    };

    expect(() => assertRuntimeEnv({ ...base, NODE_ENV: 'production', DATA_ENC_KEY: undefined })).toThrow(/DATA_ENC_KEY/);
    // ولا يمرّ إنتاجٌ بلا الـpepper حتى لو ضُبط مفتاح التشفير.
    expect(() => assertRuntimeEnv({ ...base, NODE_ENV: 'production', COMPAT_KEY_PEPPER: undefined })).toThrow(
      /COMPAT_KEY_PEPPER/,
    );
    const booted = assertRuntimeEnv({ ...base, NODE_ENV: 'production', DATA_ENC_KEY: 'production-key-1234' });
    expect(booted.DATA_ENC_KEY).toBe('production-key-1234');
    expect(booted.COMPAT_KEY_PEPPER).toBe('compat-pepper-123456');
  });
});
