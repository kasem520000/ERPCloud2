import { describe, expect, it } from 'vitest';

import {
  PUBLIC_STATUS_NOTE_AR,
  publicComponentKeys,
  publicComponentLabels,
  publicStatusLevelLabels,
  publicStatusLevels,
  publicStatusRollUp,
  publicStatusRollUpLabels,
  type PublicStatus,
} from './status.js';

/**
 * P-M9 — حالة الخدمة العلنية: المفردات والترتيب والوعد.
 *
 * الاختبار يقيس ما يهمّ العميل: أن الحالات الأربع مكتوبةٌ كلّها، وأن «غير مُهيّأ» لا تُسقط
 * الحكم، وأن `down` تسقطه، وأن كل مكوّنٍ علنيّ له تسميةٌ وشرح — فلا تصل الشاشة إلى حالةٍ
 * بلا جملة، ولا يُعرض اسم مكوّنٍ داخلي.
 */
describe('P-M9 — حالة الخدمة العلنية', () => {
  it('الحالات أربع، ولكلٍّ تسميةٌ وشرحٌ بالعربية والإنجليزية', () => {
    expect(publicStatusLevels).toEqual(['up', 'degraded', 'down', 'not_configured']);
    for (const level of publicStatusLevels) {
      const label = publicStatusLevelLabels[level];
      expect(label.labelAr.length).toBeGreaterThan(1);
      expect(label.labelEn.length).toBeGreaterThan(1);
      expect(label.noteAr.length).toBeGreaterThan(10);
      expect(label.noteEn.length).toBeGreaterThan(10);
      expect(['ready', 'pending', 'failed', 'muted']).toContain(label.tone);
    }
  });

  it('«غير مُهيّأ» تقول إنها ليست عطلاً — الجملة محفوظةٌ لمنع التشويه لاحقاً', () => {
    expect(publicStatusLevelLabels.not_configured.noteAr).toContain('ليس هذا عطلاً');
    expect(publicStatusLevelLabels.not_configured.noteEn).toContain('not an outage');
  });

  it('الترتيب: `down` تسقط الحكم، و`degraded` تُبطّئه، و«غير مُهيّأ» لا تُسقط شيئاً', () => {
    expect(publicStatusRollUp(['up', 'up'])).toBe('up');
    expect(publicStatusRollUp(['up', 'not_configured', 'not_configured'])).toBe('up');
    expect(publicStatusRollUp(['up', 'degraded'])).toBe('degraded');
    expect(publicStatusRollUp(['up', 'degraded', 'down'])).toBe('down');
    expect(publicStatusRollUp(['not_configured', 'not_configured'])).toBe('not_configured');
    expect(publicStatusRollUp([])).toBe('not_configured');
  });

  it('لكل مكوّنٍ علنيّ تسميةٌ و«ما يقيسه» — والخمسة كلها مُعلنة', () => {
    expect(publicComponentKeys).toEqual(['platform', 'database', 'jobs', 'email', 'files']);
    for (const key of publicComponentKeys) {
      const label = publicComponentLabels[key];
      expect(label.labelAr.length).toBeGreaterThan(1);
      expect(label.labelEn.length).toBeGreaterThan(1);
      expect(label.whatAr.length).toBeGreaterThan(10);
      expect(label.whatEn.length).toBeGreaterThan(10);
    }
  });

  it('لا اسم نظامٍ داخليّ في التسميات العلنية (لا دلو ولا سائق ولا مزوّد)', () => {
    const text = [
      ...Object.values(publicComponentLabels).flatMap((l) => [l.labelAr, l.labelEn, l.whatAr, l.whatEn]),
      ...Object.values(publicStatusLevelLabels).flatMap((l) => [l.labelAr, l.labelEn, l.noteAr, l.noteEn]),
      PUBLIC_STATUS_NOTE_AR,
    ].join(' ');
    for (const forbidden of ['REDIS_URL', 'smtp', 'SMTP', 'bucket', 'S3', 'driver', 'console', 'pino', 'postgres']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('الوعد المطبوع ثابتٌ في العقد: الحالة لا التفاصيل، ولا تُحفظ الزيارة', () => {
    expect(PUBLIC_STATUS_NOTE_AR).toContain('الحالة لا التفاصيل');
    expect(PUBLIC_STATUS_NOTE_AR).toContain('لا تُحفظ زيارتك');
    expect(Object.keys(publicStatusRollUpLabels)).toEqual([...publicStatusLevels]);
  });

  it('شكل الحالة الكاملة يقبل مكوّناً مقيساً ويرفض ناقصاً', () => {
    const status: PublicStatus = {
      status: 'up',
      statusLabelAr: publicStatusRollUpLabels.up.labelAr,
      statusLabelEn: publicStatusRollUpLabels.up.labelEn,
      statusTone: publicStatusRollUpLabels.up.tone,
      checkedAt: new Date().toISOString(),
      uptimeSeconds: 120,
      incident: null,
      components: publicComponentKeys.map((key) => ({
        key,
        labelAr: publicComponentLabels[key].labelAr,
        labelEn: publicComponentLabels[key].labelEn,
        whatAr: publicComponentLabels[key].whatAr,
        whatEn: publicComponentLabels[key].whatEn,
        status: 'up' as const,
        noteAr: publicStatusLevelLabels.up.noteAr,
        noteEn: publicStatusLevelLabels.up.noteEn,
        latencyMs: 1.5,
      })),
      noteAr: PUBLIC_STATUS_NOTE_AR,
      noteEn: 'note',
    };
    expect(status.components).toHaveLength(5);
    expect(status.status).toBe('up');
  });
});
