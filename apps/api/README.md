# @erp/api — NestJS modular monolith

Base path `/api/v1`; `/health/live` and `/health/ready` sit outside the versioned
contract (PHASE_02 §7). Errors are RFC 9457 `application/problem+json` with a stable
`code` from `@erp/contracts`.

## Request pipeline (frozen — API_ARCHITECTURE §2)

```
HTTP request
  │
  ├─ 1. RequestIdMiddleware      assigns/echoes X-Request-Id, opens the AsyncLocalStorage store
  ├─ 2. nestjs-pino              JSON logs, redaction of password|token|secret|key paths
  ├─ 3. helmet + CORS            security headers, env allow-list of origins
  │
  ├─ 4. RateLimitGuard           token bucket per (route, ip); login 10/min (SECURITY §8)
  ├─ 5. AuthGuard                RS256 access token → { sub, tid, mid, scope, jti }
  ├─ 6. TenantGuard              proves an ACTIVE membership of an ACTIVE tenant,
  │                              loads permissions, publishes TenantContext (ALS)
  ├─ 7. BranchScopeGuard         validates optional X-Branch-Id against branch_scope
  ├─ 8. PermissionsGuard         @RequiresPermission('module.entity.action')
  │
  ├─ 9. ZodValidationPipe        DTO schemas from @erp/contracts (strict on writes)
  ├─10. Module service           runs in withTenantTx(...) → RLS GUC bound per tx
  ├─11. IdempotencyInterceptor   Idempotency-Key replay (in-memory; table in P04)
  └─12. AllExceptionsFilter      problem+json with a stable code + traceId
```

Guards 4–8 are registered as `APP_GUARD` providers in `src/app.module.ts`; **their
declaration order is the pipeline** and reordering them is a contract change.

## Layout

```
src/
├── main.ts / bootstrap.ts / app.module.ts
├── common/            filters, guards-free middleware, interceptors, pipes
├── database/          DATABASE_HANDLE provider (overridden by integration tests)
├── health/            /health/live, /health/ready
├── request-context/   AsyncLocalStorage store (traceId, auth, tenant, branchId)
├── openapi/           OpenAPI document builder + exporter
├── events/            in-process domain-event bus (global; producers ↔ subscribers)
├── modules/platform/  tenancy, identity, auth, RBAC  → see modules/platform/README.md
└── modules/platform-services/
                       audit, files, notifications, jobs, sequences, idempotency
                       → see modules/platform-services/README.md
```

## Running

```bash
cp .env.example .env          # fill DATABASE_URL, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY
pnpm --filter @erp/api dev    # tsx watch
pnpm --filter "@erp/api..." run build   # this app AND its @erp/* dependencies → dist/
pnpm --filter @erp/api test   # vitest (unit + integration, embedded PostgreSQL fallback)
pnpm --filter @erp/api test:smoke       # builds, then boots dist/ and probes two routes

WORKER=1 pnpm --filter @erp/api dev     # same image, worker role: queues + outbox, no HTTP
```

The worker role (`WORKER=1`) starts BullMQ consumers for `einvoice, notifications,
reports-export, migration, maintenance`, drains `outbox_jobs` every
`OUTBOX_POLL_INTERVAL_MS` and logs a health line every `WORKER_HEALTH_LOG_INTERVAL_MS`.
Without `REDIS_URL` it still starts: the queue driver is inert and outbox rows stay
`pending` until a queue exists.

`pnpm openapi:export` (repo root) builds the app and writes
`packages/contracts/openapi.json`; it runs as the last step of `pnpm verify`.

Build the whole dependency chain, not just this app: `@erp/*` resolve to each package's
`dist/` at runtime, so `pnpm --filter @erp/api build` on its own fails until
`packages/{config,contracts,database,testing}` have been compiled. Tests are the
exception — `vitest.config.ts` aliases `@erp/*` to the packages' TypeScript source, so
`pnpm test` needs no build step.
