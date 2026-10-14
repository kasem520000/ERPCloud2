# modules/platform — Tenancy, Identity & Access (PHASE_03)

The module that guards everything after it. Later phases consume **only** what
`modules/platform/index.ts` exports (`eslint-plugin-boundaries` + the deep-import rule in
`AI_DEVELOPMENT_PROTOCOL §4`); reaching into `guards/…` directly is a defect.

## What it provides

| Export                                      | Use in a later phase                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `getTenantContext()` / `getTenantId()`      | tenant id inside a service — **never** from a body, query or header (`PROJECT_CONTRACT §8`) |
| `getBranchScopeFilter()`                    | validated `X-Branch-Id`, or `undefined` when the caller did not scope                       |
| `getAuthContext()`                          | `sub/tid/mid/scope/jti` of the verified access token                                        |
| `@RequiresPermission('sales.invoice.post')` | authorisation for a route                                                                   |
| `@Public()`                                 | opts a route out of Auth/Tenant/Permissions guards (auth endpoints only)                    |
| `@RateLimit({ name, limit, windowMs })`     | narrows the default 600/min bucket                                                          |
| `PasswordService`, `TokenService`           | Argon2id + RS256 primitives                                                                 |
| `PlatformAdminGuard`                        | ops plane stub (endpoints land in P23)                                                      |

## Authoring a tenant-scoped endpoint

```ts
@Post()
@RequiresPermission('sales.invoice.create')
async create(@Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoice) {
  const { tenantId } = getTenantContext();

  // withTenantTx binds app.tenant_id for the whole transaction; every statement inside
  // is RLS-scoped. Never query a tenant-scoped table outside it.
  return withTenantTx(this.database.db, tenantId, async (tx) => {
    /* … */
  });
}
```

`getTenantContext()` throws `TENANT_CONTEXT_MISSING` when the pipeline did not establish
one, which is the loud failure we want — it can never silently widen a query.

## Guards

```
RateLimitGuard → AuthGuard → TenantGuard → BranchScopeGuard → PermissionsGuard
```

`TenantGuard` is the isolation keystone:

1. loads the tenant by the token's `tid` (platform table, no RLS) and rejects anything
   that is not `active` with **423 `TENANT_SUSPENDED`**;
2. loads the membership **under that tenant's GUC**, so a forged `tid` finds nothing and
   is rejected with 403 `FORBIDDEN`;
3. loads the effective permission set = `UNION(roles)` and publishes `TenantContext`.

Because the membership lookup is itself RLS-scoped, the guard cannot be tricked into
trusting a claim: the database has to agree with the token.

## Auth model

- **Access token** — JWT RS256, 15 min, claims `{ sub, tid, mid, scope, jti }`
  (`PROJECT_CONTRACT §9`).
- **Refresh token** — opaque 256-bit, SHA-256 at rest, 30 d, rotating. Presenting an
  already-rotated token revokes the whole family (reuse detection).
- **Passwords** — Argon2id `m=64 MiB, t=3, p=4`; 12+ chars, 3 character classes,
  deny-list check. Legacy plaintext hashes are never imported; imported users get
  `must_change_password = true`.
- **Lockout** — `AUTH_LOGIN_MAX_FAILURES` failures ⇒ `locked_until`, surfaced as
  429 `RATE_LIMITED`.

## Deliberate decisions (recorded, not accidental)

- `POST /auth/login` returns the membership of the **authenticated tenant only**. Listing
  every membership of the user would need a cross-tenant read that RLS exists to prevent,
  and the login DTO already requires `tenantCode`.
- `refresh_tokens` has no RLS policy: it is a `DATABASE_DESIGN §1` platform table resolved
  by an unguessable hashed capability _before_ any tenant context exists.
- Invitations create the user with `status = 'invited'` and no password. The invitation
  e-mail is a notification and lands in PHASE_04.

## Out of scope here

MFA verification (data columns exist) · billing/self-registration · notifications ·
audit-log, files and notification endpoints (P04) · the platform-admin ops plane (P23).
