import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';
import { env } from '@erp/config';
import { DomainError, errorCodes } from '@erp/contracts';

import { evaluatePasswordPolicy } from './password-policy.js';

/**
 * Argon2id hashing with the parameters frozen by PROJECT_CONTRACT §9 and
 * SECURITY_ARCHITECTURE §2: memory 64 MiB, time cost 3, parallelism 4.
 *
 * The values come from `packages/config` so an operator can see them, but the defaults
 * ARE the frozen ones and changing them is a contract change, not a config tweak.
 */
@Injectable()
export class PasswordService {
  private get options() {
    return {
      memoryCost: env.AUTH_ARGON2_MEMORY_KIB,
      timeCost: env.AUTH_ARGON2_TIME_COST,
      parallelism: env.AUTH_ARGON2_PARALLELISM,
      outputLen: env.AUTH_ARGON2_OUTPUT_LENGTH,
    };
  }

  /** Enforces the policy before hashing so weak passwords are rejected cheaply. */
  assertPolicy(password: string, context: { email?: string; fullName?: string } = {}): void {
    const result = evaluatePasswordPolicy(password, context);
    if (!result.ok) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'Password does not satisfy the tenant password policy',
        400,
        result.issues.map((issue) => ({ field: 'new', message: issue.message })),
      );
    }
  }

  async hash(password: string): Promise<string> {
    return argon2Hash(password, this.options);
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    if (!passwordHash) return false;
    try {
      return await argon2Verify(passwordHash, password, this.options);
    } catch {
      return false;
    }
  }
}
