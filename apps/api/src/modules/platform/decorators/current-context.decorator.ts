import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthContextValue, TenantContextValue } from '../../../request-context/request-context.js';

/** Injects the verified tenant context established by TenantGuard. */
export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ tenant?: TenantContextValue }>();
  return request.tenant;
});

/** Injects the verified access-token claims established by AuthGuard. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ auth?: AuthContextValue }>();
  return request.auth;
});
