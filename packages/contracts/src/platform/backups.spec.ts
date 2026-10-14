import { describe, expect, it } from 'vitest';

import {
  backupAuditActions,
  defaultPlatformRetentionPolicy,
  platformBackupRunSchema,
  platformRetentionApplySchema,
  platformRetentionPolicySchema,
  platformRetentionUpdateSchema,
} from './backups.js';

/**
 * P-C10 — اختبارات العقود.
 *
 * القاعدة التي تحكم هذا الملف: كل حدٍّ في العقد يُقاس بمدخلٍ يقترب من الحدّ من الجهتين.
 * سياسةُ احتفاظٍ بلا حدود دنيا ليست سياسة (نافذةُ `idempotency` أقصر من مهلتها تُفسد
 * الطلبات المكرّرة)، وطلبُ نسخةٍ لمستأجرٍ بلا مستأجر ليس طلباً.
 */
describe('platform backups contracts (P-C10)', () => {
  describe('platformBackupRunSchema', () => {
    it('يفترض نطاق المنصّة حين لا يُذكر النطاق', () => {
      const parsed = platformBackupRunSchema.parse({});
      expect(parsed.scope).toBe('platform');
      expect(parsed.tenantId).toBeUndefined();
    });

    it('يرفض نسخةً لمستأجرٍ بلا معرّف مستأجر — 422 لا نسخةٌ فارغة', () => {
      const result = platformBackupRunSchema.safeParse({ scope: 'tenant' });
      expect(result.success).toBe(false);
      expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'tenantId',
      );
    });

    it('يقبل نسخة مستأجرٍ بمعرّف صالح، ويقصّ الملاحظة الطويلة', () => {
      const parsed = platformBackupRunSchema.parse({
        scope: 'tenant',
        tenantId: '2f1d9f6e-4a4b-4c1e-9f2a-6a5b3c7d8e9f',
        note: '  نسخة قبل الترقية  ',
      });
      expect(parsed.tenantId).toBe('2f1d9f6e-4a4b-4c1e-9f2a-6a5b3c7d8e9f');
      expect(parsed.note).toBe('نسخة قبل الترقية');
    });

    it('يرفض معرّف مستأجر ليس uuid', () => {
      expect(platformBackupRunSchema.safeParse({ scope: 'tenant', tenantId: 'not-a-uuid' }).success).toBe(
        false,
      );
    });
  });

  describe('سياسة الاحتفاظ', () => {
    it('نوافذها الافتراضية هي التي كانت مثبّتة في الكود قبل أن تُكتب', () => {
      expect(defaultPlatformRetentionPolicy).toEqual({
        auditArchiveDays: 365,
        idempotencyPurgeDays: 30,
        outboxPurgeDays: 90,
        fileOrphanPurgeDays: 2,
        artifactRetentionDays: 30,
      });
      expect(platformRetentionPolicySchema.parse(defaultPlatformRetentionPolicy)).toEqual(
        defaultPlatformRetentionPolicy,
      );
    });

    it('ترفض نافذة تدقيقٍ أقصر من 90 يوماً ونافذة idempotency أقصر من أسبوع', () => {
      const tooShortAudit = platformRetentionPolicySchema.safeParse({
        ...defaultPlatformRetentionPolicy,
        auditArchiveDays: 30,
      });
      const tooShortIdempotency = platformRetentionPolicySchema.safeParse({
        ...defaultPlatformRetentionPolicy,
        idempotencyPurgeDays: 1,
      });
      expect(tooShortAudit.success).toBe(false);
      expect(tooShortIdempotency.success).toBe(false);
    });

    it('ترفض نافذة ملفاتٍ يتيمة أطول من 90 يوماً، وتقبل التعديل الجزئي', () => {
      expect(
        platformRetentionPolicySchema.safeParse({
          ...defaultPlatformRetentionPolicy,
          fileOrphanPurgeDays: 400,
        }).success,
      ).toBe(false);
      const partial = platformRetentionUpdateSchema.parse({ outboxPurgeDays: 45 });
      expect(partial).toEqual({ outboxPurgeDays: 45 });
    });

    it('تطبيقٌ بلا نوافذ مرفوض (تعديلٌ فارغ ليس تعديلاً)', () => {
      expect(platformRetentionUpdateSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('platformRetentionApplySchema', () => {
    it('الوضع الافتراضي تجريبي — المسح يحتاج أن يُقال صراحةً', () => {
      const parsed = platformRetentionApplySchema.parse({ reason: 'تنظيف أسبوعي' });
      expect(parsed.mode).toBe('dry_run');
      expect(parsed.targets).toBeUndefined();
    });

    it('يرفض سبباً أقصر من خمسة أحرف وهدفاً غير معروف', () => {
      expect(platformRetentionApplySchema.safeParse({ reason: 'xy' }).success).toBe(false);
      expect(
        platformRetentionApplySchema.safeParse({ mode: 'apply', reason: 'تنظيف', targets: ['audit'] })
          .success,
      ).toBe(false);
    });
  });

  describe('backupAuditActions', () => {
    it('تسعة أفعال، كلّها في فضاء `platform.` وبلا تكرار', () => {
      const actions = Object.values(backupAuditActions);
      expect(actions).toHaveLength(9);
      expect(actions.every((action) => action.startsWith('platform.'))).toBe(true);
      expect(new Set(actions).size).toBe(actions.length);
    });
  });
});
