import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * P-C7 — الإعلانات وإشعارات المنصة (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الإعلان **مستندٌ من المنصة إلى عملائها**: يُكتب بلغتين، ويُستهدَف بباقةٍ أو بحالة حساب،
 * ويُنشر في التطبيق وبالبريد. ولهذا:
 *
 *   • **النصّان معاً إلزاميان** (عربي/إنجليزي): الإعلان الذي لا يُقرأ بلغة العميل ليس إعلاناً.
 *   • **الاستهداف حالةٌ لا استعلام**: `audience` مع `planCode` أو `tenantStatus`، يُحلّ لحظة
 *     النشر إلى قائمة عملاء — فلا يتغيّر جمهور إعلانٍ نُشر لأن عميلاً غيّر باقته بعده.
 *   • **الجدولة زمن**: `publishAt` في المستقبل ⇒ `scheduled`، وحين يحين تُنشر مرة واحدة
 *     (النشر idempotent: لا إعلان يُنشر مرتين).
 *   • **القنوات** `in_app` (إشعار لكل عضو نشط) و`email` (رسالة إلى مالك المنشأة وحده —
 *     سببٌ مصرَّح به في تقرير الجزء: بريد المنصة إلى موظفي العميل ليس إعلاناً بل إزعاج).
 */

export const announcementAudiences = ['all', 'plan', 'status'] as const;
export type AnnouncementAudience = (typeof announcementAudiences)[number];

export const announcementChannels = ['in_app', 'email'] as const;
export type AnnouncementChannel = (typeof announcementChannels)[number];

export const announcementStatuses = ['draft', 'scheduled', 'published'] as const;
export type AnnouncementStatus = (typeof announcementStatuses)[number];

/** حالات المنشأة التي يمكن الاستهداف بها — من قيد `tenants_status_check`. */
export const announcementTargetStatuses = ['active', 'suspended', 'archived'] as const;
export type AnnouncementTargetStatus = (typeof announcementTargetStatuses)[number];

/** نوع الإشعار داخل التطبيق الذي يحمله الإعلان — وعليه تفلتر شاشة العضو. */
export const ANNOUNCEMENT_NOTIFICATION_TYPE = 'announcement';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const announcementStatsSchema = z.object({
  /** عدد المنشآت المستهدَفة لحظة النشر. */
  tenants: z.number().int().min(0),
  /** إشعارات داخل التطبيق المكتوبة (قناة `in_app`). */
  inApp: z.number().int().min(0),
  /** رسائل البريد المقبولة (قناة `email`؛ قد تقلّ عن `tenants` بالحجر أو الحصّة). */
  emails: z.number().int().min(0),
  /** كم منها قُرئ (من حساب قناة `in_app`). */
  reads: z.number().int().min(0),
});
export type AnnouncementStats = z.infer<typeof announcementStatsSchema>;

export const announcementSchema = z.object({
  id: uuidSchema,
  titleAr: z.string(),
  titleEn: z.string(),
  bodyAr: z.string(),
  bodyEn: z.string(),
  audience: z.enum(announcementAudiences),
  /** باقة مستهدَفة — تُقرأ منها `code` في العرض. */
  planCode: z.string().nullable(),
  tenantStatus: z.enum(announcementTargetStatuses).nullable(),
  channels: z.array(z.enum(announcementChannels)),
  status: z.enum(announcementStatuses),
  publishAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** وسمٌ مقروء لمَن كتب الإعلان (`platformActorLabel`). */
  createdByLabel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stats: announcementStatsSchema,
});
export type Announcement = z.infer<typeof announcementSchema>;

export const announcementCreateSchema = z
  .object({
    titleAr: trimmed(3, 200),
    titleEn: trimmed(3, 200),
    bodyAr: trimmed(10, 5000),
    bodyEn: trimmed(10, 5000),
    audience: z.enum(announcementAudiences).default('all'),
    /** إلزاميّ مع `audience = plan`. */
    planCode: trimmed(2, 40).optional(),
    /** إلزاميّ مع `audience = status`. */
    tenantStatus: z.enum(announcementTargetStatuses).optional(),
    channels: z
      .array(z.enum(announcementChannels))
      .min(1)
      .default([...announcementChannels]),
    /** زمن النشر: غائب أو ماضٍ ⇒ يبقى مسودّةً حتى `POST …/publish`؛ مستقبلي ⇒ `scheduled`. */
    publishAt: z.string().datetime({ offset: true }).optional(),
    /** سببٌ مكتوب يُسجَّل في التدقيق — كما في كل فعلٍ إداريّ في اللوحة. */
    reason: trimmed(3, 500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.audience === 'plan' && !value.planCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planCode'],
        message: 'planCode is required when audience is "plan"',
      });
    }
    if (value.audience === 'status' && !value.tenantStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantStatus'],
        message: 'tenantStatus is required when audience is "status"',
      });
    }
    if (value.audience === 'all' && (value.planCode || value.tenantStatus)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: 'audience "all" takes neither planCode nor tenantStatus',
      });
    }
  });
export type AnnouncementCreate = z.infer<typeof announcementCreateSchema>;

export const announcementUpdateSchema = z
  .object({
    titleAr: trimmed(3, 200).optional(),
    titleEn: trimmed(3, 200).optional(),
    bodyAr: trimmed(10, 5000).optional(),
    bodyEn: trimmed(10, 5000).optional(),
    audience: z.enum(announcementAudiences).optional(),
    planCode: z.union([trimmed(2, 40), z.null()]).optional(),
    tenantStatus: z.union([z.enum(announcementTargetStatuses), z.null()]).optional(),
    channels: z.array(z.enum(announcementChannels)).min(1).optional(),
    /** `null` يُلغي الجدولة ويعيد الإعلان مسودّةً. */
    publishAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
    reason: trimmed(3, 500),
  })
  .strict();
export type AnnouncementUpdate = z.infer<typeof announcementUpdateSchema>;

/** `POST /platform/announcements/:id/publish` — النشر الفوري بيد المشغّل. */
export const announcementPublishSchema = z.object({ reason: trimmed(3, 500) }).strict();
export type AnnouncementPublish = z.infer<typeof announcementPublishSchema>;

export const ANNOUNCEMENT_FILTERS = ['status', 'audience'] as const;

export const announcementListQuerySchema = paginationQuerySchema.extend({
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type AnnouncementListQuery = z.infer<typeof announcementListQuerySchema>;

/** صفّ المتابعة: عميلٌ واحد من جمهور إعلان — كم وصل وكم قُرئ. */
export const announcementReadRowSchema = z.object({
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  /** إشعارات داخل التطبيق المكتوبة لهذا العميل. */
  inApp: z.number().int().min(0),
  /** رسائل بريد قُبلت لهذا العميل. */
  emails: z.number().int().min(0),
  /** كم إشعاراً قُرئ. */
  reads: z.number().int().min(0),
  lastReadAt: z.string().nullable(),
});
export type AnnouncementReadRow = z.infer<typeof announcementReadRowSchema>;

export const announcementReadsQuerySchema = paginationQuerySchema;
export type AnnouncementReadsQuery = z.infer<typeof announcementReadsQuerySchema>;

/** أفعال التدقيق التي يكتبها هذا الجزء — تُرشَّح بها شاشة التدقيق. */
export const announcementAuditActions = {
  create: 'announcement.create',
  update: 'announcement.update',
  publish: 'announcement.publish',
} as const;
