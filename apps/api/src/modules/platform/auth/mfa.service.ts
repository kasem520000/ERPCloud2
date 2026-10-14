import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
import { DomainError, errorCodes, newId, type MfaEnrollResponse, type MfaStatusResponse } from '@erp/contracts';
import { mfaRecoveryCodes, users, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

import { PasswordService } from './password.service.js';
import { openSecret, sealSecret } from './secret-box.js';
import {
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  normaliseRecoveryCode,
  otpauthUrl,
  verifyTotp,
  MFA_ISSUER,
} from './totp.js';

/**
 * Two-factor authentication — SECURITY_ARCHITECTURE §2.
 *
 * Enrolment is two-phase on purpose: `enroll` stores an *encrypted* secret but does not
 * enforce 2FA yet; `enable` only flips `users.mfa_enabled` after the user proves they
 * actually configured their authenticator by producing a valid code. This prevents a user
 * from being locked out by a secret they never scanned.
 *
 * Recovery codes are one-time, SHA-256 hashed at rest, and accepted anywhere the 6-digit
 * code is accepted. Disabling requires the account password.
 */

const RECOVERY_CODE_COUNT = 8;
const TOTP_CODE_PATTERN = /^\d{6}$/;

const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly passwords: PasswordService,
  ) {}

  async status(userId: string): Promise<MfaStatusResponse> {
    return withTx(this.database.db, async (tx) => {
      const [user] = await tx
        .select({ mfaSecretEnc: users.mfaSecretEnc, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new DomainError(errorCodes.UNAUTHENTICATED, 'User not found', 401);
      const [left] = await tx
        .select({ count: count() })
        .from(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
      return {
        enabled: user.mfaEnabled,
        enrolled: user.mfaSecretEnc !== null,
        recoveryCodesLeft: Number(left?.count ?? 0),
      };
    });
  }

  /** Phase 1 — generate and store the secret; login is not affected until `enable`. */
  async enroll(userId: string): Promise<MfaEnrollResponse> {
    const state = await this.status(userId);
    if (state.enabled) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Two-factor authentication is already enabled', 409);
    }

    const secret = generateTotpSecret();
    const secretBase32 = base32Encode(secret);

    const email = await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ mfaSecretEnc: Buffer.from(sealSecret(secret)), updatedAt: new Date() })
        .where(eq(users.id, userId));
      const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      return user?.email ?? 'unknown';
    });

    this.logger.log({ userId, action: 'mfa.enroll' }, 'TOTP secret enrolled (pending confirmation)');
    return { secretBase32, otpauthUrl: otpauthUrl(secretBase32, email), issuer: MFA_ISSUER };
  }

  /** Phase 2 — a valid code confirms enrolment and issues one-time recovery codes. */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.readSecret(userId);
    if (!verifyTotp(secret, code)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'The verification code does not match', 400, {
        field: 'code',
      });
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabled: true, updatedAt: new Date() })
        .where(eq(users.id, userId));
      // A fresh issue supersedes any earlier batch.
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      for (const codeValue of recoveryCodes) {
        await tx.insert(mfaRecoveryCodes).values({
          id: newId(),
          userId,
          codeHash: hashRecoveryCode(codeValue),
        });
      }
    });

    this.logger.log({ userId, action: 'mfa.enable' }, 'TOTP enabled');
    return { recoveryCodes };
  }

  /** Disabling requires the account password — 2FA must not be switch-off-able by XSS alone. */
  async disable(userId: string, password: string): Promise<void> {
    const [user] = await withTx(this.database.db, async (tx) =>
      tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!user) throw new DomainError(errorCodes.UNAUTHENTICATED, 'User not found', 401);

    const passwordOk = await this.passwords.verify(user.passwordHash ?? '', password);
    if (!passwordOk) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Password is incorrect', 400, { field: 'password' });
    }

    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabled: false, mfaSecretEnc: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    });

    this.logger.log({ userId, action: 'mfa.disable' }, 'TOTP disabled');
  }

  /**
   * P-C3 — admin reset: the platform console clears 2FA on an account that lost its
   * authenticator. It is the **only** way to switch 2FA off without the account password,
   * so it is deliberately not part of this service's public auth surface: the caller is
   * `PlatformIdentityService`, which demands `console.users.manage` and a written reason
   * and records `operator.mfa_reset` in the audit trail.
   *
   * Returns whether the account actually had 2FA on, so the caller can report «لا شيء
   * لإبطاله» instead of pretending it reset something.
   */
  async resetForAdmin(userId: string): Promise<{ hadMfa: boolean }> {
    const [user] = await withTx(this.database.db, async (tx) =>
      tx
        .select({ mfaEnabled: users.mfaEnabled, mfaSecretEnc: users.mfaSecretEnc })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!user) throw new DomainError(errorCodes.NOT_FOUND, 'User not found', 404);
    const hadMfa = user.mfaEnabled || user.mfaSecretEnc !== null;

    await withTx(this.database.db, async (tx) => {
      await tx
        .update(users)
        .set({ mfaEnabled: false, mfaSecretEnc: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    });

    this.logger.log({ userId, action: 'mfa.reset' }, 'TOTP reset by platform console');
    return { hadMfa };
  }

  /** Called by `AuthService.login` *after* the password already checked out. */
  async verifyLogin(userId: string, suppliedCode: string): Promise<boolean> {
    const trimmed = suppliedCode.trim();
    if (TOTP_CODE_PATTERN.test(trimmed)) {
      const secret = await this.readSecret(userId);
      return verifyTotp(secret, trimmed);
    }
    return this.consumeRecoveryCode(userId, trimmed);
  }

  // --- internals ---------------------------------------------------------------

  private async readSecret(userId: string): Promise<Buffer> {
    const [user] = await withTx(this.database.db, async (tx) =>
      tx.select({ mfaSecretEnc: users.mfaSecretEnc }).from(users).where(eq(users.id, userId)).limit(1),
    );
    if (!user?.mfaSecretEnc) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Two-factor authentication is not enrolled', 409);
    }
    const payload = Buffer.isBuffer(user.mfaSecretEnc)
      ? user.mfaSecretEnc.toString('utf8')
      : String(user.mfaSecretEnc);
    return openSecret(payload);
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = hashRecoveryCode(code);
    return withTx(this.database.db, async (tx) => {
      const rows = await tx
        .update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.codeHash, hash), isNull(mfaRecoveryCodes.usedAt)))
        .returning({ id: mfaRecoveryCodes.id });
      return rows.length > 0;
    });
  }
}
