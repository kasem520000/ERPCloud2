import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '@erp/config';
import {
  DomainError,
  errorCodes,
  newId,
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type MembershipDto,
  type RefreshRequest,
  type ResetPasswordRequest,
} from '@erp/contracts';
import {
  memberships,
  passwordResetTokens,
  refreshTokens,
  sessionHandoffCodes,
  tenants,
  users,
  withTenantTx,
  withTx,
  type DatabaseHandle,
} from '@erp/database';

import type { AuthContextValue } from '../../../request-context/request-context.js';
import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { EmailService } from '../../email/email.service.js';
import { toMembershipDto, toUserDto, type MembershipRow, type UserRow } from '../mappers.js';

import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { resolvePlatformAccess } from './platform-access.js';
import { TokenService } from './token.service.js';

/**
 * Authentication flows — API_CONTRACT §1, SECURITY_ARCHITECTURE §2.
 *
 * Design notes that are deliberate, not accidental:
 *
 * - Login failures return the *same* `UNAUTHENTICATED` response whether the e-mail, the
 *   tenant code or the password was wrong, so the endpoint cannot enumerate accounts.
 * - The membership row is always read **under the RLS GUC of the tenant being logged
 *   into**, so a valid user with no membership in that tenant sees nothing at all.
 * - `memberships` in the response contains the membership of the tenant that was
 *   authenticated. Listing every membership of the user would require a cross-tenant
 *   read that RLS exists to prevent; the login DTO already requires `tenantCode`.
 */

export type RequestMeta = { ip?: string; userAgent?: string };

/**
 * AUD-08 — عمر رمز التسليم: دقيقة واحدة. أقصر ما يمكن عملياً (تحويل + تحميل الصفحة
 * الهدف) وأطول من نافذة اعتراض عملية في عنوان URL.
 */
const HANDOFF_TTL_MS = 60_000;

/** SHA-256 hex — الرمز عشوائي 256-bit، فالإبطاء المتعمَّد غير مطلوب له. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  phone: users.phone,
  status: users.status,
  isPlatformAdmin: users.isPlatformAdmin,
  mustChangePassword: users.mustChangePassword,
  mfaEnabled: users.mfaEnabled,
  lastLoginAt: users.lastLoginAt,
};

const MEMBERSHIP_COLUMNS = {
  id: memberships.id,
  tenantId: memberships.tenantId,
  tenantCode: tenants.code,
  tenantName: tenants.name,
  displayName: memberships.displayName,
  status: memberships.status,
  isOwner: memberships.isOwner,
  branchScope: memberships.branchScope,
  kind: memberships.kind,
  // R1 — حدّ الخصم يُعاد مع قائمة العضويات عند الدخول: الشاشة تحتاج معرفته قبل أن تُرسل
  // أول فاتورة، وطلبٌ ثانٍ لجلبه يعني احتمال شاشةٍ بلا حدّ عند أول نداء.
  maxDiscountPct: memberships.maxDiscountPct,
  maxDiscountAmount: memberships.maxDiscountAmount,
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    @Optional() private readonly email?: EmailService,
  ) {}

  async login(input: LoginRequest, meta: RequestMeta = {}): Promise<LoginResponse> {
    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ id: tenants.id, code: tenants.code, name: tenants.name, status: tenants.status })
        .from(tenants)
        .where(sql`lower(${tenants.code}) = lower(${input.tenantCode})`)
        .limit(1);
      return rows[0];
    });

    if (!tenant) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant or password', 401);
    }

    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ ...USER_COLUMNS, passwordHash: users.passwordHash, lockedUntil: users.lockedUntil })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      return rows[0];
    });

    if (!user) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant or password', 401);
    }

    // AUD-01 — قرار حالةٍ واحد قبل إصدار أي جلسة: `login` كان يفحص العضوية والمستأجر
    // والقفل، ولا يفحص `users.status`؛ فمستخدمٌ `suspended`/`deactivated` بعضويةٍ نشطة
    // كان يحصل على جلسة كاملة، بينما `refresh` يرفضه. الحالة الآن شرطٌ واحد في المسارين:
    //
    //   • `suspended`/`deactivated`/`invited` لا تصدر لها جلسة (401 بنفس رسالة بيانات
    //     الاعتماد الخاطئة، فلا يتحول المسار إلى أداة سرد لحالات الحسابات).
    //   • الجلسات القائمة: رمز الوصول عديم الحالة ويعيش 15 دقيقة (PROJECT_CONTRACT §9)،
    //     فينتهي بانتهاء صلاحيته؛ ويُرفض التجديد فوراً لأن `refresh` يقرأ `users.status`
    //     من قاعدة البيانات في كل مرة. لا يوجد مسار API يعلّق مستخدماً اليوم (الوضع يُدار
    //     خارج المسار)؛ وأي مسار مستقبلي يجب أن يلغي `refresh_tokens` مع تغيير الحالة.
    if (user.status !== 'active') {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant or password', 401);
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new DomainError(
        errorCodes.RATE_LIMITED,
        `Account temporarily locked after repeated failed logins; retry in ${retryAfterSeconds}s`,
        429,
      );
    }

    const membership = await this.findActiveMembership(tenant.id, user.id);
    if (!membership) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant or password', 401);
    }

    if (tenant.status !== 'active') {
      throw new DomainError(errorCodes.TENANT_SUSPENDED, `Tenant '${tenant.code}' is ${tenant.status}`, 423);
    }

    const passwordOk = await this.passwords.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.registerFailedLogin(user.id);
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant or password', 401);
    }

    // TOTP second factor (SECURITY_ARCHITECTURE §2). `MFA_REQUIRED` tells the client the
    // credentials were fine and only the authenticator code is missing — the status is
    // still 401, so account enumeration does not change: an attacker cannot distinguish
    // "wrong password" from "code needed" without already knowing a valid password.
    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new DomainError(errorCodes.MFA_REQUIRED, 'Enter the verification code from your authenticator app', 401);
      }
      const codeOk = await this.mfa.verifyLogin(user.id, input.mfaCode);
      if (!codeOk) {
        await this.registerFailedLogin(user.id);
        throw new DomainError(errorCodes.UNAUTHENTICATED, 'Invalid e-mail, tenant, password or verification code', 401);
      }
    } else if (input.mfaCode) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Two-factor authentication is not enabled for this user', 400, {
        field: 'mfaCode',
      });
    }

    await this.registerSuccessfulLogin(user.id);

    return this.issueSession(user, membership, meta);
  }

  async refresh(input: RefreshRequest, meta: RequestMeta = {}): Promise<LoginResponse> {
    const tokenHash = this.tokens.hashRefreshToken(input.refreshToken);

    const stored = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({
          id: refreshTokens.id,
          userId: refreshTokens.userId,
          family: refreshTokens.family,
          tenantId: refreshTokens.tenantId,
          expiresAt: refreshTokens.expiresAt,
          revokedAt: refreshTokens.revokedAt,
        })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    });

    if (!stored) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Refresh token is not recognised', 401);
    }

    // Reuse detection: presenting an already-rotated token revokes the whole family.
    if (stored.revokedAt) {
      await this.revokeFamily(stored.family);
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Refresh token reuse detected', 401);
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Refresh token has expired', 401);
    }

    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select(USER_COLUMNS).from(users).where(eq(users.id, stored.userId)).limit(1);
      return rows[0];
    });
    if (!user || user.status !== 'active') {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'User is not active', 401);
    }

    if (!stored.tenantId) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Refresh token is not bound to a tenant', 401);
    }

    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ id: tenants.id, code: tenants.code, name: tenants.name, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, stored.tenantId as string))
        .limit(1);
      return rows[0];
    });
    if (!tenant || tenant.status !== 'active') {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Tenant is not active', 401);
    }

    const membership = await this.findActiveMembership(tenant.id, user.id);
    if (!membership) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Membership is no longer active', 401);
    }

    // AUD-07 — التدوير compare-and-swap ذرّي. القراءة أعلاه تفحص `revokedAt`، لكن الفحص
    // وحده لا يمنع طلبين متزامنين من اجتيازه معاً ثم إنشاء بديلين صالحين لرمزٍ واحد.
    // الشرط `revoked_at IS NULL` في `UPDATE ... RETURNING` يمنح حقّ التدوير لطلبٍ **واحد**
    // فقط؛ ومن لا يحصل على الصف لم يدوّر شيئاً، فتُطبَّق سياسة reuse القائمة: إلغاء العائلة
    // كاملةً (وهي السياسة المعلنة لهذا النظام، وتُوثَّق كسلوكٍ مقصود لا كخطأ).
    const rotated = await withTx(this.database.db, async (tx) => {
      const newTokenId = newId();
      const plaintext = this.tokens.generateRefreshToken();
      const claimed = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedBy: newTokenId })
        .where(and(eq(refreshTokens.id, stored.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (claimed.length === 0) return undefined;
      await tx.insert(refreshTokens).values({
        id: newTokenId,
        userId: user.id,
        tokenHash: this.tokens.hashRefreshToken(plaintext),
        family: stored.family,
        tenantId: tenant.id,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return plaintext;
    });

    if (rotated === undefined) {
      await this.revokeFamily(stored.family);
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Refresh token reuse detected', 401);
    }
    const rotatedRefreshToken = rotated;

    const platform = await resolvePlatformAccess(this.database, user.id, user.isPlatformAdmin);
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      tid: tenant.id,
      mid: membership.id,
      scope: ['erp'],
      pam: platform.isPlatformAdmin,
      proles: platform.platformRoles,
    });

    return {
      accessToken: accessToken.token,
      refreshToken: rotatedRefreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      user: toUserDto({ ...user, isPlatformAdmin: platform.isPlatformAdmin, platformRoles: platform.platformRoles }),
      memberships: [await this.toMembershipDto(membership)],
    };
  }

  /**
   * AUD-08 — إصدار رمز تسليم جلسة لمرة واحدة للواجهة الهدف.
   *
   * لماذا رمز تسليم بدل تمرير الرموز نفسها في العنوان:
   *   • العنوان يُسجَّل (وسيط/مضيف/سجل دخول) ويُرسَل في `Referer` — والرمز المكشوف هناك
   *     صالحٌ كجلسة كاملة، أما رمز التسليم فلا يحمل صلاحية بنفسه: يُستبدل مرة واحدة
   *     ثم يُستهلك، وعمره دقيقة واحدة.
   *   • التسليم لا يوسّع الائتمان: الجلسة الجديدة تُبنى من حالة المستخدم والعضوية في
   *     اللحظة نفسها (لا من نسخةٍ قديمة عند الإصدار).
   *
   * `requireActiveIdentity` هو نفس الفحص المستعمل في `refresh`: مستخدم موقوف أو عضوية
   * غير نشطة لا يُسلَّم لها شيء.
   */
  async createHandoff(auth: AuthContextValue, meta: RequestMeta = {}): Promise<{ code: string; expiresIn: number }> {
    const context = await this.requireActiveIdentity(auth.userId, auth.claimedTenantId, auth.membershipId);
    const code = `hop_${randomBytes(32).toString('base64url')}`;

    await withTx(this.database.db, async (tx) => {
      await tx.insert(sessionHandoffCodes).values({
        id: newId(),
        codeHash: sha256(code),
        userId: context.user.id,
        membershipId: context.membership.id,
        tenantCode: context.membership.tenantCode,
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    });

    return { code, expiresIn: Math.floor(HANDOFF_TTL_MS / 1000) };
  }

  /**
   * AUD-08 — استبدال رمز التسليم بجلسةٍ كاملة.
   *
   * الاستهلاك ذرّي: `UPDATE … WHERE code_hash = … AND redeemed_at IS NULL AND
   * expires_at > now() RETURNING …` يمنح الاستبدال لطلبٍ واحد؛ ومن لا يحصل على صف
   * يحصل على نفس الخطأ العام (مجهول/منتهٍ/مستعمل — بلا تفريق، فلا يتحول المسار إلى
   * أداة استكشاف). ثم يُعاد فحص حالة المستخدم/العضوية/المنشأة قبل الإصدار.
   */
  async redeemHandoff(code: string, meta: RequestMeta = {}): Promise<LoginResponse> {
    const codeHash = sha256(code);
    const claimed = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .update(sessionHandoffCodes)
        .set({ redeemedAt: new Date() })
        .where(
          and(
            eq(sessionHandoffCodes.codeHash, codeHash),
            isNull(sessionHandoffCodes.redeemedAt),
            gt(sessionHandoffCodes.expiresAt, new Date()),
          ),
        )
        .returning({ userId: sessionHandoffCodes.userId, membershipId: sessionHandoffCodes.membershipId, tenantCode: sessionHandoffCodes.tenantCode });
      return rows[0];
    });
    if (!claimed) {
      throw new DomainError(errorCodes.HANDOFF_CODE_INVALID, 'The handoff code is invalid, expired or already used', 401);
    }

    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, claimed.tenantCode)).limit(1);
      return rows[0];
    });
    if (!tenant) {
      throw new DomainError(errorCodes.HANDOFF_CODE_INVALID, 'The handoff code is invalid, expired or already used', 401);
    }

    const context = await this.requireActiveIdentity(claimed.userId, tenant.id, claimed.membershipId);
    return this.issueSession(context.user, context.membership, meta);
  }

  /**
   * حالة الهوية عند لحظة الإصدار: المستخدم نشط، والمنشأة نشطة، والعضوية نشطة وتخصّ
   * المنشأة والرمزين المذكورين. تُستعمل في الإصدار وفي الاستبدال معاً — فلا تُبنى جلسة
   * على لقطةٍ قديمة من وقت الإصدار.
   */
  private async requireActiveIdentity(userId: string, tenantId: string, membershipId: string): Promise<{ user: UserRow; membership: MembershipRow }> {
    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select(USER_COLUMNS).from(users).where(eq(users.id, userId)).limit(1);
      return rows[0];
    });
    if (!user || user.status !== 'active') {
      throw new DomainError(errorCodes.HANDOFF_CODE_INVALID, 'The handoff code is invalid, expired or already used', 401);
    }

    const tenant = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return rows[0];
    });
    if (!tenant || tenant.status !== 'active') {
      throw new DomainError(errorCodes.HANDOFF_CODE_INVALID, 'The handoff code is invalid, expired or already used', 401);
    }

    const membership = await this.findActiveMembership(tenantId, user.id);
    if (!membership || membership.id !== membershipId) {
      throw new DomainError(errorCodes.HANDOFF_CODE_INVALID, 'The handoff code is invalid, expired or already used', 401);
    }
    return { user, membership };
  }

  /** Revokes every still-valid refresh token of the user (API_CONTRACT §1 logout). */
  async logout(auth: AuthContextValue): Promise<void> {
    await withTx(this.database.db, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, auth.userId), isNull(refreshTokens.revokedAt)));
    });
  }

  async changePassword(auth: AuthContextValue, input: ChangePasswordRequest): Promise<void> {
    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({ ...USER_COLUMNS, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1);
      return rows[0];
    });
    if (!user) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'User not found', 401);
    }

    const currentOk = await this.passwords.verify(user.passwordHash, input.current);
    if (!currentOk) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Current password is incorrect', 400, {
        field: 'current',
      });
    }

    this.passwords.assertPolicy(input.new, { email: user.email, fullName: user.fullName });
    const passwordHash = await this.passwords.hash(input.new);

    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          updatedBy: user.id,
          version: sql`${users.version} + 1`,
        })
        .where(eq(users.id, user.id));
      // Password change invalidates every existing session (SECURITY_ARCHITECTURE §2).
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
    });
  }

  /**
   * طلب استعادة كلمة المرور («نسيت كلمة السر»).
   *
   * يعيد نفس الرسالة دائماً سواء وُجد البريد أم لم يوجد لمنع كشف الحسابات، ويُصدر رمز
   * استعادة لمرة واحدة صالحاً لمدة 60 دقيقة ويُرسله عبر خدمة البريد (`password.reset`).
   */
  async forgotPassword(input: ForgotPasswordRequest): Promise<{ ok: true; message: string }> {
    const email = input.email.trim().toLowerCase();
    const tenantCode = input.tenantCode?.trim() || null;

    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select(USER_COLUMNS).from(users).where(eq(users.email, email)).limit(1);
      return rows[0];
    });

    if (user && user.status !== 'suspended') {
      let resolvedTenantId: string | null = null;
      if (tenantCode) {
        const tenantRow = await withTx(this.database.db, async (tx) => {
          const rows = await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(sql`lower(${tenants.code}) = lower(${tenantCode})`)
            .limit(1);
          return rows[0];
        });
        resolvedTenantId = tenantRow?.id ?? null;
      }

      const rawToken = `rst_${randomBytes(24).toString('base64url')}`;
      const tokenHash = sha256(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await withTx(this.database.db, async (tx) => {
        await tx.insert(passwordResetTokens).values({
          id: newId(),
          tokenHash,
          userId: user.id,
          tenantCode,
          expiresAt,
        });
      });

      if (this.email) {
        const appUrl = process.env.STAFF_PUBLIC_URL ?? 'http://localhost:3001';
        const resetLink = `${appUrl.replace(/\/$/, '')}/?resetToken=${encodeURIComponent(rawToken)}`;
        try {
          await this.email.send({
            tenantId: resolvedTenantId,
            event: 'password.reset',
            locale: 'ar',
            to: user.email,
            toName: user.fullName,
            variables: {
              name: user.fullName,
              link: `${resetLink} (رمز الاستعادة: ${rawToken})`,
              expires: '60 دقيقة',
            },
            isTest: true,
          });
        } catch {
          // Do not fail or leak whether email delivery succeeded
        }
      }
    }

    return {
      ok: true,
      message: 'إذا كان البريد الإلكتروني مسجلاً لدينا، فقد تم إرسال رمز ورابط استعادة كلمة المرور.',
    };
  }

  /**
   * تعيين كلمة مرور جديدة باستخدام رمز الاستعادة (`POST /auth/reset-password`).
   */
  async resetPassword(input: ResetPasswordRequest): Promise<{ ok: true; message: string }> {
    const tokenHash = sha256(input.token.trim());

    const stored = await withTx(this.database.db, async (tx) => {
      const rows = await tx
        .select({
          id: passwordResetTokens.id,
          userId: passwordResetTokens.userId,
          expiresAt: passwordResetTokens.expiresAt,
          usedAt: passwordResetTokens.usedAt,
        })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    });

    if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'رمز استعادة كلمة المرور غير صالح أو منتهي الصلاحية.',
        400,
        { field: 'token' },
      );
    }

    const user = await withTx(this.database.db, async (tx) => {
      const rows = await tx.select(USER_COLUMNS).from(users).where(eq(users.id, stored.userId)).limit(1);
      return rows[0];
    });

    if (!user || user.status === 'suspended') {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'رمز استعادة كلمة المرور غير صالح أو الحساب موقوف.',
        400,
        { field: 'token' },
      );
    }

    this.passwords.assertPolicy(input.newPassword, { email: user.email, fullName: user.fullName });
    const passwordHash = await this.passwords.hash(input.newPassword);

    const updated = await withTx(this.database.db, async (tx) => {
      const claimed = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.id, stored.id),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ id: passwordResetTokens.id });
      if (claimed.length === 0) return false;

      await tx
        .update(users)
        .set({
          passwordHash,
          status: user.status === 'invited' ? 'active' : user.status,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          updatedBy: user.id,
          version: sql`${users.version} + 1`,
        })
        .where(eq(users.id, user.id));

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

      return true;
    });

    if (!updated) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'رمز استعادة كلمة المرور غير صالح أو تم استخدامه مسبقاً.',
        400,
        { field: 'token' },
      );
    }

    return {
      ok: true,
      message: 'تم إعادة تعيين كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    };
  }

  // --- internals ---------------------------------------------------------------

  private async findActiveMembership(tenantId: string, userId: string): Promise<MembershipRow | undefined> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select(MEMBERSHIP_COLUMNS)
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);
      return rows[0];
    });
  }

  private async registerFailedLogin(userId: string): Promise<void> {
    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
          lockedUntil: sql`CASE
              WHEN ${users.failedLoginAttempts} + 1 >= ${env.AUTH_LOGIN_MAX_FAILURES}
              THEN now() + (${env.AUTH_LOCKOUT_MINUTES} || ' minutes')::interval
              ELSE ${users.lockedUntil}
            END`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    });
  }

  private async registerSuccessfulLogin(userId: string): Promise<void> {
    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, userId));
    });
  }

  private async revokeFamily(family: string): Promise<void> {
    await withTx(this.database.db, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.family, family), isNull(refreshTokens.revokedAt)));
    });
  }

  private async issueSession(
    user: UserRow,
    membership: MembershipRow,
    meta: RequestMeta,
  ): Promise<LoginResponse> {
    const platform = await resolvePlatformAccess(this.database, user.id, user.isPlatformAdmin);
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      tid: membership.tenantId,
      mid: membership.id,
      scope: ['erp'],
      pam: platform.isPlatformAdmin,
      proles: platform.platformRoles,
    });

    const refreshToken = this.tokens.generateRefreshToken();
    await withTx(this.database.db, async (tx) => {
      await tx.insert(refreshTokens).values({
        id: newId(),
        userId: user.id,
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        family: newId(),
        tenantId: membership.tenantId,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    });

    return {
      accessToken: accessToken.token,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      user: toUserDto({ ...user, isPlatformAdmin: platform.isPlatformAdmin, platformRoles: platform.platformRoles }),
      memberships: [await this.toMembershipDto(membership)],
    };
  }

  private async toMembershipDto(membership: MembershipRow): Promise<MembershipDto> {
    return withTenantTx(this.database.db, membership.tenantId, async (tx) => toMembershipDto(tx, membership));
  }

  async updateProfile(auth: { userId: string }, input: { fullName?: string }): Promise<{ fullName: string }> {
    const fullName = String(input.fullName ?? '').trim();
    if (fullName.length < 2 || fullName.length > 120) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'الاسم يجب أن يكون بين حرفين و120 حرفاً', 422, {
        field: 'fullName',
      });
    }
    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ fullName, updatedAt: new Date() })
        .where(eq(users.id, auth.userId));
    });
    return { fullName };
  }
}
