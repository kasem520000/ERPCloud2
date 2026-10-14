import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

/**
 * P-C8 — «مكتب الدعم والدخول المؤقّت» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * قسمان في ملفٍ واحد لأن الخطة تجمعهما في جزءٍ واحد، ولأنهما وجهان لسؤالٍ واحد: «العميل
 * يقول إن شيئاً لا يعمل» ⇒ (1) **تذكرة** تحفظ القول والردّ، و(2) **دخولٌ مؤقّت** يرى به
 * المشغّل ما يراه العميل — بمدّةٍ وسقفٍ وسببٍ وسجلّ.
 *
 * وثلاثة قرارات مكتوبة هنا لا في الشاشة:
 *
 *   1. **الدخول المؤقّت معرَّفٌ بحدوده**: مدّة قصوى **60 دقيقة** مركزيّاً، وسببٌ لا يقلّ عن
 *      10 محارف، ورمزٌ **قصير العمر** (`imp` claim) يُرفض فوراً إن أُنهيت الجلسة — لا انتظاراً
 *      لانتهاء صلاحيته.
 *   2. **ما لا يُفعل أثناء الدخول المؤقّت مكتوبٌ في العقد**: لا تغيير كلمة مرور، ولا مسّ
 *      بالمصادقة، ولا حذف (`DELETE`). الفرق بين «نظرٍ بعين العميل» و«العمل باسمه» هو هذا
 *      السطر بالضبط، ووجوده في العقد يجعل الحارس والاختبار والشاشة يتّفقون عليه.
 *   3. **أولوية التذكرة تضع مهلتها**: المهل بالساعات في الفهرس هنا (`slaDueAt` يُحسب منها
 *      لحظة الفتح) — لا نصٍّ في واجهة يَعِد بما لا يقيسه الـAPI.
 */

// ────────────────────────────────────────────────────────────── التذاكر

export const ticketStatuses = ['open', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

export const ticketPriorities = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof ticketPriorities)[number];

/** من كتب الرسالة: مشغّلٌ، أو العميل صاحب التذكرة، أو النظام (انتقالات آلية). */
export const ticketAuthorKinds = ['operator', 'customer', 'system'] as const;
export type TicketAuthorKind = (typeof ticketAuthorKinds)[number];

/** مهلة الاستجابة بالساعات لكل أولوية — تُنسخ `slaDueAt` على التذكرة لحظة فتحها. */
export const ticketSlaHours: Record<TicketPriority, number> = {
  urgent: 1,
  high: 4,
  normal: 24,
  low: 72,
};

export const TICKET_FILTERS = ['status', 'priority', 'tenantId', 'assignedTo'] as const;

export const ticketMessageSchema = z.object({
  id: uuidSchema,
  ticketId: uuidSchema,
  /** كاتب الرسالة — `null` لرسائل النظام. */
  authorUserId: uuidSchema.nullable(),
  /** وسمٌ مقروء للكاتب (`platformActorLabel` للمشغّل، أو اسم العميل). */
  authorLabel: z.string().nullable(),
  authorKind: z.enum(ticketAuthorKinds),
  body: z.string(),
  /** **ملاحظة داخلية**: تُقرأ في اللوحة ولا تُرسل إلى العميل. */
  isInternal: z.boolean(),
  createdAt: z.string(),
});
export type TicketMessage = z.infer<typeof ticketMessageSchema>;

export const supportTicketSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string().nullable(),
  tenantName: z.string().nullable(),
  subject: z.string(),
  status: z.enum(ticketStatuses),
  priority: z.enum(ticketPriorities),
  category: z.string().nullable(),
  assignedTo: uuidSchema.nullable(),
  assignedToLabel: z.string().nullable(),
  openedByLabel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** أول ردٍّ من المشغّل — مقياس SLA الحقيقي (لا زمن آخر رسالة). */
  firstResponseAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  slaDueAt: z.string().nullable(),
  messageCount: z.number().int().min(0),
  lastMessageAt: z.string().nullable(),
});
export type SupportTicket = z.infer<typeof supportTicketSchema>;

export const ticketDetailSchema = supportTicketSchema.extend({
  messages: z.array(ticketMessageSchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const ticketCreateSchema = z
  .object({
    /** العميل صاحب المشكلة — التذكرة تُفتح عليه من اللوحة (لا من العميل). */
    tenantId: uuidSchema,
    subject: trimmed(3, 200),
    /** الرسالة الأولى: ما قاله العميل بالضبط، مكتوبةً بيد المشغّل. */
    body: trimmed(5, 5000),
    priority: z.enum(ticketPriorities).default('normal'),
    category: trimmed(2, 60).optional(),
    /** إن أُسندت من اللحظة الأولى. */
    assignedTo: uuidSchema.optional(),
    reason: trimmed(3, 500),
  })
  .strict();
export type TicketCreate = z.infer<typeof ticketCreateSchema>;

export const ticketUpdateSchema = z
  .object({
    status: z.enum(ticketStatuses).optional(),
    priority: z.enum(ticketPriorities).optional(),
    /** `null` يسحب الإسناد. */
    assignedTo: z.union([uuidSchema, z.null()]).optional(),
    category: z.union([trimmed(2, 60), z.null()]).optional(),
    reason: trimmed(3, 500),
  })
  .strict();
export type TicketUpdate = z.infer<typeof ticketUpdateSchema>;

export const ticketReplySchema = z
  .object({
    body: trimmed(2, 5000),
    /** الردّ الداخلي لا يظهر للعميل ولا يوقف عدّاد الاستجابة. */
    isInternal: z.boolean().default(false),
    reason: trimmed(3, 500).optional(),
  })
  .strict();
export type TicketReply = z.infer<typeof ticketReplySchema>;

export const ticketListQuerySchema = paginationQuerySchema.extend({
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type TicketListQueryDto = z.infer<typeof ticketListQuerySchema>;

// ───────────────────────────────────────────────────────── الدخول المؤقّت

/** السقف المطلق — لا مدّةً أطول منه مهما طلب المشغّل. */
export const IMPERSONATION_MAX_MINUTES = 60;
/** الحدّ الأدنى: أقلّ من ذلك ليس «وقتاً لرؤية مشكلة». */
export const IMPERSONATION_MIN_MINUTES = 5;
/** اسم الادّعاء في رمز الوصول: معرّف جلسة الدعم. */
export const IMPERSONATION_TOKEN_CLAIM = 'imp';

export const impersonationStatuses = ['active', 'ended', 'expired'] as const;
export type ImpersonationStatus = (typeof impersonationStatuses)[number];

export const impersonationStartSchema = z
  .object({
    tenantId: uuidSchema,
    /** السبب مكتوبٌ ومقروء للعميل: هذا السطر يظهر في سجله. */
    reason: trimmed(10, 500),
    minutes: z.number().int().min(IMPERSONATION_MIN_MINUTES).max(IMPERSONATION_MAX_MINUTES).default(30),
  })
  .strict();
export type ImpersonationStart = z.infer<typeof impersonationStartSchema>;

export const impersonationSessionSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string().nullable(),
  tenantName: z.string().nullable(),
  operatorUserId: uuidSchema,
  operatorLabel: z.string().nullable(),
  reason: z.string(),
  startedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  /** `active` ما دامت لم تُنهَ ولم تنتهِ؛ ويُحسب من الوقت لا من صفٍّ يُحدَّث بمؤقّت. */
  status: z.enum(impersonationStatuses),
  /** الجهة التي دخل باسمها (مالك المنشأة) — وسمٌ مقروء. */
  asUserLabel: z.string().nullable(),
});
export type ImpersonationSession = z.infer<typeof impersonationSessionSchema>;

/** نتيجة `POST /platform/impersonate`: الجلسة **والرمز** الذي يستعمله المشغّل. */
export const impersonationStartResultSchema = z.object({
  session: impersonationSessionSchema,
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});
export type ImpersonationStartResult = z.infer<typeof impersonationStartResultSchema>;

/**
 * ما يُمنع أثناء الدخول المؤقّت — تُقرأ منه `ImpersonationGuard` وتُختبر.
 *
 * **الحذف ممنوع كلّه** (أي `DELETE`)، و**المصادقة ممنوعة كلّها** (أي مسارٍ يبدأ بـ`/auth/`
 * بلا `GET`) — فلا تُغيَّر كلمة مرور، ولا تُعاد تهيئة 2FA، ولا يُنشأ رمزٌ جديد باسم العميل.
 * والمشغّل يقرأ ويكتب في العمل اليومي (فاتورة، عميل، إعداد) لأن ذلك هو الغرض من الدخول،
 * لكنه **لا يملك هوية العميل**.
 */
export const impersonationBlockedPaths = ['/auth/'] as const;
export const impersonationBlocksDeletes = true;

/** أفعال التدقيق التي يكتبها هذا الجزء. */
export const supportAuditActions = {
  ticketCreate: 'support.ticket.create',
  ticketUpdate: 'support.ticket.update',
  ticketReply: 'support.ticket.reply',
  impersonateStart: 'support.impersonate.start',
  impersonateEnd: 'support.impersonate.end',
} as const;

/** يحتاجه العميل ليُحسب «هل اقتربت المهلة؟» بلا تكرار الرقم في الواجهة. */
export const ticketOpenStatuses: readonly TicketStatus[] = ['open', 'pending'];
