import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor.js';
import { RequestContextInterceptor } from './common/interceptors/request-context.interceptor.js';
import {
  AuthGuard,
  BranchScopeGuard,
  PermissionsGuard,
  RateLimitGuard,
  TenantGuard,
} from './modules/platform/index.js';
import { AuditInterceptor } from './modules/platform-services/index.js';
import { ImpersonationGuard } from './modules/support/impersonation.guard.js';
// The metrics interceptor lives in the ops slice, not in platform-services; importing it
// from the barrel silently yielded `undefined` and made this assertion pass vacuously.
import { MetricsInterceptor } from './ops/metrics.interceptor.js';

type ProviderEntry = { provide: string | symbol; useClass?: unknown };

function providersOf(module: object): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module) ?? []) as ProviderEntry[];
}

function orderedTokens(providers: ProviderEntry[], token: string): unknown[] {
  return providers.filter((entry) => entry?.provide === token).map((entry) => entry.useClass);
}

describe('AppModule', () => {
  it('registers the request pipeline in the order frozen by API_ARCHITECTURE §2', () => {
    const providers = providersOf(AppModule);

    // rate limit → AuthGuard → TenantGuard (+RLS GUC) → BranchScopeGuard → PermissionsGuard
    //
    // P-C8: `ImpersonationGuard` sits immediately after `AuthGuard` — the `imp` claim is only
    // readable once authentication has published the context, and a break-glass token must be
    // limited on **every** route it can reach. The five guards above keep their frozen order.
    expect(orderedTokens(providers, APP_GUARD)).toEqual([
      RateLimitGuard,
      AuthGuard,
      ImpersonationGuard,
      TenantGuard,
      BranchScopeGuard,
      PermissionsGuard,
    ]);

    expect(orderedTokens(providers, APP_FILTER)).toEqual([AllExceptionsFilter]);
    // RequestContext → Idempotency → Audit → Metrics (PHASE_04 §5.2/§5.7, PHASE_23).
    expect(orderedTokens(providers, APP_INTERCEPTOR)).toEqual([
      RequestContextInterceptor,
      IdempotencyInterceptor,
      AuditInterceptor,
      MetricsInterceptor,
    ]);
  });

  it('compiles the module graph', async () => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
  });
});
