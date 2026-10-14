import { z } from 'zod';

import { platformPermissionRegistry } from '../permissions.js';
import { platformRoleCatalog, isPlatformRoleCode } from '../rbac.js';

import { EMAIL_PATTERN } from './console.js';

/**
 * P-C3 — «الهوية والوصول على المنصة»: عقود إدارة مَن يدير المنصّة نفسها.
 *
 * الشاشات الثلاث التي تستهلكها: `/users` (دليل المشغّلين والمستخدمين عبر المنشآت)،
 * بطاقة المستخدم `/users/[id]`، ومصفوفة `/roles` (الأدوار الخمسة × رموز `console.*`).
 * وكل عقد هنا له مسارٌ حقيقي في `PlatformIdentityController` — لا نموذج بلا نقطة نهاية.
 */

// ------------------------------------------------------------------ actions

/**
 * أفعال هذا الجزء في سجل التدقيق. الأسماء بصيغة `وحدة.فعل` كما في `auditActions`،
 * ووحدة كل فعل هنا هي ما يصف *الشيء المتأثّر*: مشغّل، عضوية منصة، جلسة، مصفوفة أدوار.
 */
export const operatorAuditActions = {
  INVITE: 'operator.invite',
  ROLE_GRANT: 'platform_role.grant',
  ROLE_REVOKE: 'platform_role.revoke',
  MFA_RESET: 'operator.mfa_reset',
  SESSION_REVOKE: 'session.revoke',
  PERMISSIONS_UPDATE: 'platform_role.permissions_update',
} as const;

/**
 * مفاتيح الإعدادات التي يكتبها هذا الجزء في `platform_settings` (نطاق المنصّة، `tenant_id`
 * = NULL). تُخزَّن تجاوزات مصفوفة الأدوار هنا بدل ترحيلٍ جديد — الخطة تنصّ على أن الجداول
 * قائمة، و`platform_settings` هو مخزن مفاتيح المنصّة المكتوب والمُدقَّق أصلاً (0066).
 */
export const platformRolePermissionOverridesKey = 'console.role_permissions';

// ------------------------------------------------------------------ schemas

/**
 * تجاوزات مصفوفة الأدوار كما تُخزَّن: `{ roleCode: ['console.…', …] }`.
 *
 * أي رمز لا تعرفه السجل (`console.*`) يُرفض، وأي دورٍ غير معلَن يُرفض — فالمخزن لا يستطيع
 * أن يحمل صفًّا لا معنى له. غياب الدور من الخريطة = «اتبع الفهرس»، لا «لا صلاحيات».
 */
export const platformRolePermissionOverridesSchema = z
  .record(
    z.string().refine(isPlatformRoleCode, { message: 'دور منصة غير معروف' }),
    z.array(z.string()).superRefine((codes, ctx) => {
      for (const code of codes) {
        if (!platformPermissionRegistry.some((entry) => entry.code === code)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `رمز صلاحية غير معروف: ${code}` });
        }
      }
    }),
  )
  .default({});

export type PlatformRolePermissionOverrides = z.infer<typeof platformRolePermissionOverridesSchema>;

/** `PUT /platform/roles/:code/permissions` — المجموعة الكاملة الجديدة لذلك الدور. */
export const platformRolePermissionsUpdateSchema = z.object({
  permissions: z
    .array(z.string().trim().min(1).max(120))
    .max(64)
    .superRefine((codes, ctx) => {
      const seen = new Set<string>();
      for (const code of codes) {
        if (seen.has(code)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `رمز مكرَّر: ${code}` });
        seen.add(code);
        if (!platformPermissionRegistry.some((entry) => entry.code === code)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `رمز صلاحية غير معروف: ${code}` });
        }
      }
    }),
  // سببٌ مكتوب مثل كل فعل حساس في هذه اللوحة: مصفوفة الأدوار تحدّد مَن يستطيع ماذا.
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});

export type PlatformRolePermissionsUpdate = z.infer<typeof platformRolePermissionsUpdateSchema>;

/** `POST /platform/operators/invite` — دعوة مشغّل جديد. */
export const platformOperatorInviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(160).regex(EMAIL_PATTERN, 'بريد إلكتروني غير صالح'),
  fullName: z.string().trim().min(2, 'الاسم حرفان على الأقل').max(120),
  /**
   * رمز الدور: **الشكل** هنا، والوجود في الخدمة (`422`).
   *
   * الفصل مقصود: `400 VALIDATION_FAILED` لجسمٍ غير صالح (حقل ناقص، طول، بريد)، و`422` لطلبٍ
   * صالح الشكل يشير إلى شيء غير موجود — وهو ما كان يجيب به `POST /platform/users/:id/roles`
   * قبل P-C3، و`test/surface-isolation.spec.ts` يثبّته فلا نغيّر جواب مسار قائم.
   */
  roleCode: z.string().trim().min(1).max(60),
  /**
   * كلمة مرور مؤقّتة اختيارية — نفس دلالة `ownerPassword` في `POST /platform/tenants`:
   * بوجودها يُنشأ الحساب `active` بـ`must_change_password`، وبدونها `invited` بلا كلمة مرور
   * حتى يصل رابط التفعيل (جزء البريد P-C6). لا نخترع كلمة مرور بالنيابة عن أحد.
   */
  temporaryPassword: z.string().min(12).max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});

export type PlatformOperatorInvite = z.infer<typeof platformOperatorInviteSchema>;

/** `POST /platform/users/:id/mfa/reset` — إبطال 2FA لحساب شخص. */
export const platformMfaResetSchema = z.object({
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});

export type PlatformMfaReset = z.infer<typeof platformMfaResetSchema>;

/**
 * `DELETE /platform/sessions/:id` — إبطال جلسة (عائلة دوران كاملة) بسبب.
 *
 * السبب في **سلسلة الاستعلام** لا في جسم الطلب: `DELETE` بجسمٍ ليس عمومًا في عميل الواجهة
 * (`apiDelete` لا يرسل جسمًا)، وسلسلة استعلام تُقرأ في سجلّ الوكيل وفي curl بلا أدوات.
 */
export const platformSessionRevokeQuerySchema = z.object({
  reason: z.string().trim().min(3, 'السبب ثلاثة أحرف على الأقل').max(500),
});

export type PlatformSessionRevokeQuery = z.infer<typeof platformSessionRevokeQuerySchema>;

/** `POST /platform/users/:id/roles` — منح دور. السبب اختياري (المنح فعلٌ مضيف لا مهدِّد). */
export const platformRoleGrantSchema = z.object({
  /** الشكل فقط — وجود الدور يقرّره `PlatformIdentityService.grantRole` بـ`422`. */
  roleCode: z.string().trim().min(1).max(60),
  reason: z.string().trim().max(500).optional(),
});

export type PlatformRoleGrant = z.infer<typeof platformRoleGrantSchema>;

/** `DELETE /platform/users/:id/roles/:roleCode` — سحب دور (السبب اختياري، في سلسلة الاستعلام). */
export const platformRoleRevokeQuerySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export type PlatformRoleRevokeQuery = z.infer<typeof platformRoleRevokeQuerySchema>;

// ------------------------------------------------------------------ views

/**
 * صفّ دليل المستخدمين (`GET /platform/users`).
 *
 * أُضيف في P-C3 ما تحتاجه الشاشة: **المنشآت** (عمود «المنشأة» في الجدول: مستخدم المنصة قد
 * يكون في أكثر من منشأة)، وحالة **2FA**، وعدد الجلسات غير المُبطَلة — بلا استعلام ثانٍ لكل
 * صفّ.
 */
export const platformDirectoryUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  status: z.string(),
  isPlatformAdmin: z.boolean(),
  mustChangePassword: z.boolean(),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  membershipCount: z.number().int(),
  platformRoles: z.array(z.string()),
  /** المنشآت التي ينتمي إليها فعلاً، للعمود وللبحث بالعين. */
  tenants: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      status: z.string(),
      isOwner: z.boolean(),
    }),
  ),
  activeSessionCount: z.number().int(),
});

export type PlatformDirectoryUser = z.infer<typeof platformDirectoryUserSchema>;

/** جلسة = **عائلة دوران** في `refresh_tokens`، لا صفًّا واحدًا: التجديد يبدّل الصفّ ويُبقي العائلة. */
export const platformSessionViewSchema = z.object({
  /** معرّف العائلة — هو `:id` في `GET/DELETE /platform/sessions/:id`. */
  id: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  userFullName: z.string(),
  tenantId: z.string().nullable(),
  tenantCode: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revoked: z.boolean(),
  /** كم مرة جُدِّد التوكن داخل العائلة (كل تجديد صفّ جديد). */
  rotationCount: z.number().int(),
});

export type PlatformSessionView = z.infer<typeof platformSessionViewSchema>;

/** عضويات المستخدم عبر المنشآت — تُقرأ من مستوى المنصّة (`platform_admin_plane`). */
export const platformUserMembershipSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantCode: z.string(),
  tenantName: z.string(),
  tenantStatus: z.string(),
  displayName: z.string(),
  status: z.string(),
  isOwner: z.boolean(),
  createdAt: z.string(),
});

export type PlatformUserMembership = z.infer<typeof platformUserMembershipSchema>;

/** `GET /platform/users/:id` — بطاقة المستخدم: هو + أدواره + عضوياته + جلساته. */
export const platformUserDetailResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    fullName: z.string(),
    status: z.string(),
    isPlatformAdmin: z.boolean(),
    mustChangePassword: z.boolean(),
    mfaEnabled: z.boolean(),
    mfaEnrolled: z.boolean(),
    lastLoginAt: z.string().nullable(),
    lockedUntil: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  }),
  /** الأدوار الفعّالة الآن (غير المسحوبة). */
  platformRoles: z.array(z.string()),
  /** الأدوار المسحوبة — تُعرض باهتة، فتاريخ المنح جزء من الصورة. */
  revokedPlatformRoles: z.array(z.string()),
  memberships: z.array(platformUserMembershipSchema),
  sessions: z.array(platformSessionViewSchema),
});

export type PlatformUserDetailResponse = z.infer<typeof platformUserDetailResponseSchema>;

/**
 * دورٌ في مصفوفة `/roles`: ما يحمله من الفهرس، وما صار يحمله فعلاً، وهل الفرق تجاوزٌ مكتوب.
 */
export const platformRoleMatrixEntrySchema = z.object({
  code: z.string(),
  name: z.string(),
  nameAr: z.string(),
  description: z.string(),
  /** ما ينصّ عليه `platformRoleCatalog` في العقود — العمود الذي لا يتغيّر بالكتابة. */
  catalogPermissions: z.array(z.string()),
  /** الفعّال الآن (تجاوزٌ إن وُجد، وإلا الفهرس). */
  permissions: z.array(z.string()),
  overridden: z.boolean(),
  holderCount: z.number().int(),
});

export type PlatformRoleMatrixEntry = z.infer<typeof platformRoleMatrixEntrySchema>;

/** `PUT /platform/roles/:code/permissions` — وما تعيده المصفوفة بعده. */
export const platformRolePermissionsResponseSchema = z.object({
  roleCode: z.string(),
  permissions: z.array(z.string()),
  catalogPermissions: z.array(z.string()),
  overridden: z.boolean(),
});

export type PlatformRolePermissionsResponse = z.infer<typeof platformRolePermissionsResponseSchema>;

/**
 * الفرق بين ما ينصّ عليه الفهرس وما صار فعّالاً — يُستعمل في الشاشة (وسم «تجاوز») وفي
 * سجل التدقيق (`before`/`after` هنا قائمتان، والقراءة بعد شهر تحتاج هذا الفرق لا القائمتين).
 */
export function platformPermissionDiff(
  catalogue: readonly string[],
  effective: readonly string[],
): { added: string[]; removed: string[] } {
  const before = new Set(catalogue);
  const after = new Set(effective);
  return {
    added: [...after].filter((code) => !before.has(code)).sort(),
    removed: [...before].filter((code) => !after.has(code)).sort(),
  };
}

/** الفهرس الرسمي لرموز اللوحة — تُعرض به المصفوفة أعمدةً. */
export function platformConsoleCodes(): string[] {
  return platformPermissionRegistry.map((entry) => entry.code);
}

/** أسماء الأدوار العربية كما في الفهرس — تُستعمل في الشاشة والتدقيق معاً. */
export function platformRoleLabel(code: string): string {
  return platformRoleCatalog.find((role) => role.code === code)?.nameAr ?? code;
}
