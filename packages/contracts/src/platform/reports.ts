import { z } from 'zod';

import { emailLocales } from './email.js';

/**
 * التقرير الأسبوعي للمنصة — التسليم الدوري المؤجَّل من P-C12
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4: «تقرير أسبوعي بالبريد يبني على P-C6»).
 *
 * الأرقام **ليست هنا**: مصدرها `PlatformAnalyticsService.overview()` (P-C12) نفسه، وهذا
 * الملفّ يحمل ما يخرج من الخدمة فقط — نافذة أسبوعٍ مضى، وجدولُ الإرسال، ووجهتُه، ونتيجة
 * تشغيلٍ يدوي. والعقد صارم (`.strict()`) كي لا يُرسل نداءٌ حقلَ تشغيلٍ لم يُتّفق عليه.
 */

/** أيام الأسبوع كما تُعرض في الشاشة — الفهرس هو نفسه `Date.getDay()` (0 = الأحد). */
export const weeklyReportDayLabels = [
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
] as const;

export const weeklyReportWindowSchema = z.object({
  /** بداية الأسبوع المنقضي (ISO) — الأحد 00:00 بتوقيت الخادم. */
  start: z.string(),
  /** نهايته (غير شاملة) — أي الأحد الجاري 00:00. */
  end: z.string(),
  /** نصُّ العرض في البريد وفي الشاشة: `2026-09-06 → 2026-09-12`. */
  label: z.string(),
});
export type WeeklyReportWindow = z.infer<typeof weeklyReportWindowSchema>;

export const weeklyReportScheduleSchema = z.object({
  day: z.number().int().min(0).max(6),
  dayLabelAr: z.string(),
  hour: z.number().int().min(0).max(23),
  /** التوقيت الذي تُفسَّر به الساعة — الخادم (لا منطقة المتصفّح ولا منطقة عميل). */
  timezone: z.literal('server'),
  nextRunAt: z.string(),
});
export type WeeklyReportSchedule = z.infer<typeof weeklyReportScheduleSchema>;

export const weeklyReportPreviewSchema = z.object({
  /** من `report.weekly_enabled` — ومعطّلٌ يعني «لا تقرير» لا «لا إعداد». */
  enabled: z.boolean(),
  recipients: z.array(z.string()),
  schedule: weeklyReportScheduleSchema,
  window: weeklyReportWindowSchema,
  /** عناوين window الماضي لها رسالةٌ في السجلّ فعلاً — لا تُعاد. */
  sentTo: z.array(z.string()),
  /** ما سيُرسل إليه فعلاً في النبضة القادمة. */
  pending: z.array(z.string()),
  /** وجهة الرابط داخل البريد (بلا شرطة أخيرة)، أو `/analytics` حين لا نطاق مُعدّ. */
  link: z.string(),
  /** المتغيّرات كما ستُصيَّر — تُعرض في الشاشة قبل الإرسال. */
  variables: z.record(z.string()),
});
export type WeeklyReportPreview = z.infer<typeof weeklyReportPreviewSchema>;

/**
 * تشغيلٌ يدوي: `to` لتجربةٍ لعنوانٍ واحد دون انتظار يوم الإرسال، و`force` لتجاوز الحجر
 * (الرسالة نفسها بالعنوان نفسه لنافذة النافذة).
 */
export const weeklyReportRunInputSchema = z
  .object({
    to: z.array(z.string().trim().toLowerCase().email().max(253)).max(20).optional(),
    locale: z.enum(emailLocales).default('ar'),
    force: z.boolean().default(false),
  })
  .strict();
export type WeeklyReportRunInput = z.infer<typeof weeklyReportRunInputSchema>;

export const weeklyReportRecipientOutcomeSchema = z.object({
  to: z.string(),
  /** معرّف رسالة `email_messages` — يُرى في شاشة البريد بمعرّفه لا بالتخمين. */
  messageId: z.string().nullable(),
  status: z.enum(['sent', 'skipped', 'failed']),
  /** سبب التخطّي أو نصّ الفشل (مقصوصاً) — والسبب لا التخمين. */
  detail: z.string().nullable(),
});
export type WeeklyReportRecipientOutcome = z.infer<typeof weeklyReportRecipientOutcomeSchema>;

export const weeklyReportRunResultSchema = z.object({
  window: weeklyReportWindowSchema,
  outcomes: z.array(weeklyReportRecipientOutcomeSchema),
  sentCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type WeeklyReportRunResult = z.infer<typeof weeklyReportRunResultSchema>;
