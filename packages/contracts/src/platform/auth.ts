import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { discountLimitDtoFields } from './discount-limits.js';

/**
 * Auth & Identity DTOs — API_CONTRACT §1. Shapes are normative; the server validates
 * every body with these schemas (SECURITY_ARCHITECTURE §6).
 */

/** SECURITY_ARCHITECTURE §2 — 12+ character policy, checked at the boundary and again
 * by the password-policy service (which also runs the breach-list check). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export const loginRequestSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    tenantCode: z.string().trim().min(1).max(64),
    /** 6-digit TOTP code, or a one-time recovery code (XXXX-XXXX) as a fallback. */
    mfaCode: z.string().trim().min(6).max(12).optional(),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z
  .object({
    refreshToken: z.string().min(20).max(512),
  })
  .strict();

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

/**
 * AUD-08 — جسر تسليم الجلسة بين الواجهات: بدل تمرير `access`/`refresh` في استعلام URL
 * (يُسجَّل في الوكلاء وسجلات الدخول ويبقى في المحفوظات)، تُنشئ الواجهة المصدر **رمز
 * تسليم لمرة واحدة قصير العمر**، وتستبدله الواجهة الهدف بجلسةٍ جديدة عبر POST.
 */
export const handoffRedeemSchema = z
  .object({
    code: z.string().trim().min(20).max(200),
  })
  .strict();

export type HandoffRedeemRequest = z.infer<typeof handoffRedeemSchema>;

export const handoffCreateResponseSchema = z.object({
  /** رمز التسليم نفسه — لا يحمل أي صلاحية بذاته: يُستبدل مرة واحدة ثم يُستنفد. */
  code: z.string(),
  expiresIn: z.number().int().positive(),
});

export type HandoffResponse = z.infer<typeof handoffCreateResponseSchema>;

export const logoutRequestSchema = z.object({}).strict();

export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    current: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    new: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const forgotPasswordRequestSchema = z
  .object({
    email: z.string().trim().email().max(320),
    tenantCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z
  .object({
    token: z.string().trim().min(16).max(256),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const userStatusSchema = z.enum(['active', 'invited', 'suspended']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userDtoSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  status: userStatusSchema,
  /** Effective platform access (legacy flag OR any platform_memberships row). */
  isPlatformAdmin: z.boolean(),
  /**
   * Platform role codes (2026-09). Empty for tenant-only users. Surfaced so the
   * platform console can render role badges without an extra round-trip.
   */
  platformRoles: z.array(z.string()).default([]),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.string().nullable(),
});

export type UserDto = z.infer<typeof userDtoSchema>;

export const membershipStatusSchema = z.enum(['active', 'invited', 'suspended']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const roleDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
});

export type RoleDto = z.infer<typeof roleDtoSchema>;

export const membershipScopeDtoSchema = z.object({
  roleId: uuidSchema,
  scopeType: z.enum(['branch', 'warehouse', 'cash_location', 'pos_terminal']),
  scopeId: uuidSchema,
});

export type MembershipScopeDto = z.infer<typeof membershipScopeDtoSchema>;

export const membershipDtoSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  tenantCode: z.string(),
  tenantName: z.string(),
  displayName: z.string(),
  status: membershipStatusSchema,
  isOwner: z.boolean(),
  branchScope: z.array(uuidSchema).nullable(),
  roles: z.array(roleDtoSchema),
  /** Audience of the membership (2026-09): staff vs external portal customer. */
  kind: z.enum(['staff', 'portal']).default('staff'),
  /** Per-role scope restrictions (empty = tenant-wide). */
  scopes: z.array(membershipScopeDtoSchema).default([]),
  /**
   * R1 — حدّ الخصم لكل عضوية، بديل `OperMaxDiscount` في الديسكتوب. `null` = بلا حدّ.
   * يُقرأ في الواجهة (شاشة المستخدمين) وفي الخدمة عند احتساب خصم الفاتورة أو الكاشير.
   */
  ...discountLimitDtoFields,
});

export type MembershipDto = z.infer<typeof membershipDtoSchema>;

export const tokenPairSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token lifetime in seconds (PROJECT_CONTRACT §9: 900). */
  expiresIn: z.number().int().positive(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: userDtoSchema,
  memberships: z.array(membershipDtoSchema),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const meResponseSchema = z.object({
  user: userDtoSchema,
  membership: membershipDtoSchema,
  permissions: z.array(z.string()),
  /**
   * Effective `console.*` permissions of the platform roles in the token (P-C1).
   *
   * Kept as a **separate list** from `permissions` on purpose: tenant codes and console
   * codes are disjoint by construction (`permissionGrants` never lets `*` satisfy a
   * `console.*` code), and the console sidebar has to hide what the operator cannot open
   * without ever mixing the two namespaces into one set.
   */
  platformPermissions: z.array(z.string()).default([]),
  /**
   * P-C8 — إن كان الرمز رمزَ دخولٍ مؤقّت (يدّعاء `imp`)، فهذا وصفُ الجلسة: من دخل، ولماذا،
   * وإلى متى. `null` في الحالة العادية. الشاشة تُظهر لافتةً حمراء من هذا الحقل وحده، فلا
   * تحتاج قراءةً ثانية ولا تعرف «الدخول المؤقّت» إلا من الرمز نفسه.
   */
  impersonation: z
    .object({
      sessionId: z.string(),
      operatorUserId: z.string(),
      operatorLabel: z.string().nullable(),
      reason: z.string(),
      startedAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable()
    .default(null),
  branchScope: z.array(uuidSchema).nullable(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const permissionDtoSchema = z.object({
  code: z.string(),
  module: z.string(),
  description: z.string(),
});

export type PermissionDto = z.infer<typeof permissionDtoSchema>;

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP, RFC 6238) — Round 11.
// ---------------------------------------------------------------------------

export const mfaStatusResponseSchema = z.object({
  /** The user can log in only with password + authenticator code. */
  enabled: z.boolean(),
  /** A secret is stored but not yet confirmed with a code (enrolment in flight). */
  enrolled: z.boolean(),
  /** How many one-time recovery codes are still unused. */
  recoveryCodesLeft: z.number().int().nonnegative(),
});

export type MfaStatusResponse = z.infer<typeof mfaStatusResponseSchema>;

export const mfaEnrollResponseSchema = z.object({
  /** Base32 secret for manual entry into an authenticator app. */
  secretBase32: z.string(),
  /** `otpauth://totp/…` provisioning URI (QR payload). */
  otpauthUrl: z.string(),
  issuer: z.string(),
});

export type MfaEnrollResponse = z.infer<typeof mfaEnrollResponseSchema>;

export const mfaEnableRequestSchema = z
  .object({
    code: z.string().trim().length(6),
  })
  .strict();

export type MfaEnableRequest = z.infer<typeof mfaEnableRequestSchema>;

export const mfaEnableResponseSchema = z.object({
  /** Shown exactly once; afterwards only hashes are kept. */
  recoveryCodes: z.array(z.string()),
});

export type MfaEnableResponse = z.infer<typeof mfaEnableResponseSchema>;

export const mfaDisableRequestSchema = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export type MfaDisableRequest = z.infer<typeof mfaDisableRequestSchema>;
