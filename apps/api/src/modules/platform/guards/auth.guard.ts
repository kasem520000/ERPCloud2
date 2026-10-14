import { Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DomainError, errorCodes } from '@erp/contracts';
import { users, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { setAuthContext, type AuthContextValue } from '../../../request-context/request-context.js';
import { TokenService } from '../auth/token.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

/**
 * Pipeline position: after rate limit (API_ARCHITECTURE §2).
 * Verifies the RS256 access token, confirms that the backing `users` row is still
 * `active` (AUD-01 immediate revocation on user suspension across all authenticated
 * routes, including routes that do not use TenantGuard), and publishes its claims;
 * it does **not** trust the `tid` claim — TenantGuard independently proves the
 * membership (MULTI_TENANCY §4: cross-tenant access is a hard block).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @Optional() @Inject(DATABASE_HANDLE) private readonly database?: DatabaseHandle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { auth?: AuthContextValue }>();
    const header = request.headers.authorization;

    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'Missing bearer token', 401);
    }

    const claims = await this.tokens.verifyAccessToken(header.slice('bearer '.length).trim());

    if (this.database) {
      const user = await withTx(this.database.db, async (tx) => {
        const rows = await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.id, claims.sub))
          .limit(1);
        return rows[0];
      });
      if (!user || user.status !== 'active') {
        throw new DomainError(
          errorCodes.UNAUTHENTICATED,
          user ? `User account is ${user.status}` : 'User account is not active',
          401,
        );
      }
    }

    const platformRoles = claims.proles ?? [];
    const auth: AuthContextValue = {
      userId: claims.sub,
      claimedTenantId: claims.tid,
      membershipId: claims.mid,
      scope: claims.scope,
      tokenId: claims.jti,
      // Effective platform access: explicit `pam` claim (set at login from the flag
      // OR the role model) or any platform role carried by the token.
      isPlatformAdmin: claims.pam === true || platformRoles.length > 0,
      platformRoles,
      ...(claims.imp ? { impersonationId: claims.imp } : {}),
    };

    request.auth = auth;
    setAuthContext(auth);
    return true;
  }
}
