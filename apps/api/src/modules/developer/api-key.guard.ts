import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, errorCodes, type ApiKeyScope } from '@erp/contracts';
import type { Request } from 'express';

import { setAuthContext, setTenantContextValue } from '../../request-context/request-context.js';

import { DeveloperService } from './developer.service.js';

export const REQUIRED_API_KEY_SCOPE_KEY = 'erp:requiredApiKeyScope';

/**
 * P-C11 — حارس المفتاح: الطلب يصل بترويسة `Authorization: Bearer erp_live_…` أو
 * `x-api-key`.
 *
 * وهو الحارس **الوحيد** في مسار التكامل، والسبب صريح: رمز الـJWT لا يصلح أن يكون الوسيلة
 * الوحيدة، فالتكامل يريد اعتماداً لا ينتهي بانتهاء جلسة إنسان. فالحارس:
 *
 *   1. يستخرج المفتاح من الترويستين (المعيارية والخاصة — كثير من المنصات تُرسل `x-api-key`).
 *   2. يتحقّق منه عبر `DeveloperService.verifyKey` (بصمة بزمنٍ ثابت + فحص الإبطال والانتهاء).
 *   3. يقيس النطاق المطلوب من الديكوريتر `@RequiresApiKeyScope`، ويردّ 403 إن لم يكن من
 *      نطاقات المفتاح — فالتحقّق من الهوية لا يعني التصريح لكل شيء.
 *   4. ينشر سياقي `auth` و`tenant` في `AsyncLocalStorage`: الهوية للتدقيق، والمستأجر لسياسات
 *      العزل في القاعدة (`app.tenant_id`) — فالوصول إلى بيانات المستأجر يمرّ من نفس البوابة
 *      التي يمرّ منها الموظّف، لا من استعلامٍ خاص.
 *
 * والرمز `system:api-key` يبقى في سياق الهوية: كل صفٍّ في `api_key_uses` وكل سطر تدقيق
 * يقول إن الطلب جاء بمفتاح، لا بجلسة مستخدم.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly developer: DeveloperService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { auth?: unknown; tenant?: unknown }>();
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const headerKey = (request.headers['x-api-key'] as string | undefined)?.trim() ?? '';
    const presented = (bearer || headerKey).trim();
    if (!presented) {
      throw new DomainError(
        errorCodes.UNAUTHENTICATED,
        'This endpoint requires an API key: Authorization: Bearer erp_live_…',
        401,
      );
    }

    const verified = await this.developer.verifyKey(presented, {
      method: request.method,
      path: (request.originalUrl ?? request.url ?? '/').split('?')[0] ?? '/',
      ip: request.ip ?? null,
    });
    // رسالةٌ واحدة لكل أسباب الرفض (مجهول، مُبطَل، منتهٍ، بصمةٌ لا تطابق): التفريق بينها
    // يجيب سؤالاً لم يُسأل — «هل كان هذا المفتاح صحيحاً مرّة؟».
    if (!verified) {
      throw new DomainError(errorCodes.UNAUTHENTICATED, 'The API key is unknown, revoked or expired', 401);
    }

    const required = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(REQUIRED_API_KEY_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !verified.scopes.includes(required)) {
      throw new DomainError(errorCodes.FORBIDDEN, `scope ${required} required`, 403, {
        field: 'scope',
        message: required,
      });
    }

    setAuthContext({
      userId: verified.keyId,
      claimedTenantId: verified.tenantId,
      membershipId: `api-key:${verified.keyId}`,
      scope: verified.scopes,
      tokenId: `api-key:${verified.keyId}`,
      isPlatformAdmin: false,
      platformRoles: [],
    });
    setTenantContextValue({
      tenantId: verified.tenantId,
      tenantCode: 'api-key',
      tenantStatus: 'active',
      membershipId: `api-key:${verified.keyId}`,
      userId: verified.keyId,
      // القدرات مترجَمةٌ من النطاقات إلى رموز الحارس نفسها — فلا يمرّ مفتاحٌ برمزٍ لم يشتره.
      permissions: verified.permissions,
      branchScope: null,
      isOwner: false,
      kind: 'staff',
      // مفتاح API ليس إنساناً: لا حدّ خصم عليه، والحارس لا يمنح ما لا يملكه المفتاح.
      maxDiscountPct: null,
      maxDiscountAmount: null,
      scopes: [],
    });
    return true;
  }
}
