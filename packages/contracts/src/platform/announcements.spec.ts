import { describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_FILTERS,
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  announcementAudiences,
  announcementChannels,
  announcementCreateSchema,
  announcementReadRowSchema,
  announcementStatsSchema,
  announcementStatuses,
  announcementTargetStatuses,
  announcementUpdateSchema,
} from './announcements.js';

/**
 * عقد الإعلانات (P-C7). ما يُختبَر هنا **ما لا يحتاج قاعدة**: النصّان الإلزاميان، وتماسك
 * الاستهداف، ومعنى `null` في التعديل، والحالات المسموحة، وصفّ المتابعة. أما السلوك
 * (توزيعٌ فعليّ، وإعادةٌ لا تُضاعف، وقراءةٌ تُقاس) ففي
 * `apps/api/test/platform-announcements.spec.ts`.
 */

const full = {
  titleAr: 'صيانة مجدولة',
  titleEn: 'Scheduled maintenance',
  bodyAr: 'سنوقف الخدمة ساعةً يوم الجمعة لإجراء تحديث.',
  bodyEn: 'The service will be paused for an hour on Friday for an update.',
  reason: 'كتابة إعلانٍ من الاختبار',
};

describe('announcement contract (P-C7)', () => {
  it('freezes the enumerations the plan lists', () => {
    expect(announcementAudiences).toEqual(['all', 'plan', 'status']);
    expect(announcementChannels).toEqual(['in_app', 'email']);
    expect(announcementStatuses).toEqual(['draft', 'scheduled', 'published']);
    expect(announcementTargetStatuses).toEqual(['active', 'suspended', 'archived']);
    expect(ANNOUNCEMENT_FILTERS).toEqual(['status', 'audience']);
    expect(ANNOUNCEMENT_NOTIFICATION_TYPE).toBe('announcement');
  });

  it('requires both texts and a reason', () => {
    expect(announcementCreateSchema.safeParse(full).success).toBe(true);
    // نصٌّ بلغةٍ واحدة ليس إعلاناً: مَن يقرأ بالإنجليزية لا يصله شيء.
    expect(
      announcementCreateSchema.safeParse({ titleAr: full.titleAr, bodyAr: full.bodyAr, reason: full.reason })
        .success,
    ).toBe(false);
    expect(announcementCreateSchema.safeParse({ ...full, reason: '' }).success).toBe(false);
  });

  it('keeps the audience coherent: a plan needs a code, and «all» refuses one', () => {
    expect(announcementCreateSchema.safeParse({ ...full, audience: 'plan' }).success).toBe(false);
    expect(
      announcementCreateSchema.safeParse({ ...full, audience: 'plan', planCode: 'growth' }).success,
    ).toBe(true);
    expect(announcementCreateSchema.safeParse({ ...full, audience: 'all', planCode: 'growth' }).success).toBe(
      false,
    );
    expect(
      announcementCreateSchema.safeParse({ ...full, audience: 'status', tenantStatus: 'suspended' }).success,
    ).toBe(true);
    expect(announcementCreateSchema.safeParse({ ...full, audience: 'status' }).success).toBe(false);
    expect(announcementCreateSchema.safeParse({ ...full, audience: 'plan', planCode: null }).success).toBe(
      false,
    );
  });

  it('defaults the channels to both, and refuses an empty set', () => {
    const parsed = announcementCreateSchema.parse(full);
    expect(parsed.channels).toEqual(['in_app', 'email']);
    expect(announcementCreateSchema.safeParse({ ...full, channels: [] }).success).toBe(false);
    expect(announcementCreateSchema.safeParse({ ...full, channels: ['sms'] }).success).toBe(false);
  });

  it('takes a future instant as a schedule and refuses a bare date', () => {
    expect(
      announcementCreateSchema.safeParse({ ...full, publishAt: '2026-10-01T09:00:00.000Z' }).success,
    ).toBe(true);
    expect(announcementCreateSchema.safeParse({ ...full, publishAt: '2026-10-01' }).success).toBe(false);
  });

  it('treats null in an update as «cancel» and requires a reason', () => {
    const cleared = announcementUpdateSchema.parse({ publishAt: null, reason: full.reason });
    expect(cleared.publishAt).toBeNull();
    // `reason` وحدها إلزامية — تعديلُ حقلٍ واحد لا يطلب إعادة كتابة النصّين.
    expect(
      announcementUpdateSchema.parse({ titleAr: 'عنوانٌ جديد للإعلان', reason: full.reason }).titleAr,
    ).toBe('عنوانٌ جديد للإعلان');
    expect(announcementUpdateSchema.safeParse({ titleAr: 'عنوانٌ جديد للإعلان' }).success).toBe(false);
    expect(announcementUpdateSchema.safeParse({ nothing: true, reason: full.reason }).success).toBe(false);
  });

  it('counts four numbers in the delivery ledger, none of them negative', () => {
    expect(announcementStatsSchema.parse({ tenants: 3, inApp: 7, emails: 3, reads: 1 })).toEqual({
      tenants: 3,
      inApp: 7,
      emails: 3,
      reads: 1,
    });
    expect(announcementStatsSchema.safeParse({ tenants: -1, inApp: 0, emails: 0, reads: 0 }).success).toBe(
      false,
    );
    expect(
      announcementReadRowSchema.safeParse({
        tenantId: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a10',
        tenantCode: 'demo',
        tenantName: 'شركة تجريبية',
        inApp: 2,
        emails: 1,
        reads: 0,
        lastReadAt: null,
      }).success,
    ).toBe(true);
    // القراءات لا تزيد على ما وُزّع في التطبيق — يمنعها صفٌّ من صفّ… والحقل يقبل الأعداد فقط.
    expect(
      announcementReadRowSchema.safeParse({
        tenantId: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a10',
        tenantCode: 'demo',
        tenantName: 'شركة تجريبية',
        inApp: 2,
        emails: 1,
        reads: 'اثنتان',
        lastReadAt: null,
      }).success,
    ).toBe(false);
  });
});
