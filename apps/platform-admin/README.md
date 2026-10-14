# Platform Admin Console

Arabic-only Next.js 15 App Router console for platform operators. Served from the
`platform.*` domain and deployed separately from every other surface, while calling
the same shared API (`apps/api`).

## Run

```bash
pnpm --filter @erp/platform-admin dev
pnpm --filter @erp/platform-admin build
```

Set `NEXT_PUBLIC_API_BASE_URL` to the API base URL, for example
`http://localhost:3000/api/v1`. Leave it empty to call the same origin — `next.config.mjs`
rewrites `/api/v1/*` (and `/api/health/*`) to `API_PROXY_TARGET`, which is what makes the
console work from any host without touching CORS.

## Structure

- `boot` — `app/layout.tsx` (`dir="rtl"`) → `components/auth-gate.tsx` (login or console)
  → `components/platform-guard.tsx` (**the shell**: sidebar, top bar, omnibox, bell).
- `lib/navigation.ts` — the console's screen tree: four groups (العملاء · المال · التشغيل ·
  المنصة), each item carrying the `console.*` code that opens it. **This file is the single
  source of truth**: `tests/navigation.spec.ts` fails the build when an item claims `ready`
  without a page file, or names a code the registry does not declare.
- `app/` — 24 pages: `overview` (`/`), `tenants`, `tenants/[id]` (customer card), `tenants/new`,
  `subscriptions`, `plans`, `activation-requests`, `users`, `users/[id]` (operator card),
  `roles`, `audit`, `health`, `jobs`, `settings`, `invoices`, `invoices/[id]/print`, `dunning`,
  `revenue`, `usage`, `email`, `announcements`, `tickets`, `tickets/[id]` (one ticket),
  `impersonation`.
- `components/` — session auth gate, platform-only login screen (no signup path), the shell
  (`PlatformGuard`), and the shared screen kit.
- `lib/` — API client (same origin, refresh-on-401), session provider (`can()` for tenant
  codes, `canConsole()` for `console.*`), `useQuery`, the navigation tree.
- `tests/` — navigation + route/kit coverage checks (24 tests). `tests/routes.spec.ts` owns the
  console's own route list, so a page that exists but is unreachable (or the reverse) fails.

## Screens added by P-C1 (2026-09-17)

| Screen | Route | Console code | Endpoint |
|---|---|---|---|
| إعدادات المنصة | `/settings` | `console.tenants.view` (write: `console.settings.manage`) | `GET/PUT /platform/settings` |
| التدقيق (عابر للمستأجرين) | `/audit` | `console.audit.view` | `GET /platform/audit` |
| المهام والطوابير (عابر للمستأجرين) | `/jobs` | `console.jobs.view` | `GET /platform/jobs/outbox` |

## Screens added by P-C2 (2026-09-17)

| Screen | Route | Console code | Endpoints |
|---|---|---|---|
| بطاقة العميل (8 tabs: نظرة عامة · الاشتراك · المستخدمون · الاستخدام · الرايات · الصحة · التدقيق · الملاحظات) | `/tenants/[id]` | read `console.tenants.view` · write `console.tenants.manage` · settings/flags/branding `console.settings.manage` | 15 routes under `/platform/tenants/:id/*` |

The card is reached from the customers list only (the list row name and its «البطاقة» button);
it is not a sidebar item. Two things in it exist because the console, not the tenant, is the
actor: **suspending a customer requires a written reason** (the API rejects a missing one and
writes it into the customer's own audit trail), and **a limit override is removed by emptying
its field**, which returns the customer to the platform value. Every write lands in the
customer's `audit_log` with `meta.scope = 'platform_console'`.
The settings screen renders entirely from the catalogue the API validates with
(`platformSettingDefinitions` in `@erp/contracts`): labels, help text, kind and default all
come from `GET /platform/settings`, so a key can never exist on one side only. An operator
without `console.settings.manage` sees the form read-only.

## Screens deepened/added by P-C3 (2026-09-17)

| Screen | Route | Console code | Endpoints |
|---|---|---|---|
| المستخدمون (directory across every tenant) | `/users` | read `console.users.view` · invite/write `console.users.manage` | `GET /platform/users` (search) · `POST /platform/operators/invite` |
| بطاقة المشغّل (identification · platform roles · memberships · sessions · 2FA) | `/users/[id]` | read `console.users.view` · the three acts `console.users.manage` | `GET /platform/users/:id` · `POST/DELETE …/roles[/:roleCode]` · `GET /platform/sessions/:id` · `DELETE /platform/sessions/:id?reason=` · `POST …/mfa/reset` |
| مصفوفة الأدوار (the five roles × the 13 `console.*` codes) | `/roles` | read `console.users.view` · write `console.users.manage` | `GET /platform/roles` · `GET /platform/permissions` · `PUT /platform/roles/:code/permissions` |

Three properties of this part are worth knowing before touching it:

1. **The matrix is not decoration.** `PlatformAdminGuard` reads `console.role_permissions`
   overrides (stored in `platform_settings`) on every guarded request, so a *narrowed* role
   stops working immediately — even on a token that was issued seconds earlier — and `/me`
   agrees with the API. A role *grant* still needs a fresh login (the role list itself travels
   in the token).
2. **Every act on a person carries a written reason.** Revoking a session (single or all) and
   resetting 2FA answer `400` without one and write it into `audit_log`
   (`session.revoke`, `operator.mfa_reset`, `operator.invite`, `platform_role.grant|revoke|permissions_update`).
   The revoke reason travels in the **query string**: `apiDelete` sends no body.
3. **Inviting an operator produces a person who can sign in.** The invite grants the platform
   role *and* a role-less membership of the operations tenant (`PLATFORM_TENANT_CODE`,
   default `platform`), because `POST /auth/login` always signs into a tenant; with a temporary
   password the account is `active` and owes a password change, without one it is `invited`
   and waits for the activation e-mail (P-C6).

The user card is reached from the directory (and from the holders table on `/roles`), never
from the sidebar: an operator reading it is already inside the identity area.

## Screens deepened/added by P-C4 (2026-09-17)

| Screen | Route | Console code | Endpoints |
|---|---|---|---|
| الباقات والأسعار (price list + an entitlement per plan: وحدة · حدّ · راية) | `/plans` | read/write `console.plans.manage` | `GET /platform/plans` · `GET /platform/plans/entitlement-keys` · `POST /platform/plans` · `PATCH /platform/plans/:id` (+ reason) · `PUT /platform/plans/:id/entitlements` |
| الاشتراكات والتراخيص (grant with trial · change plan · pause · resume · cancel) | `/subscriptions` | `console.subscriptions.manage` | `GET/POST /platform/subscriptions` · `POST …/:id/change-plan` · `POST …/:id/pause·resume·cancel` (each with a reason) |
| الفواتير والإشعارات الدائنة (**new**) | `/invoices` | `console.billing.manage` | `GET/POST /platform/invoices` · `GET /platform/invoices/:id` · `POST …/:id/issue·pay·void` |
| طباعة الفاتورة (**new**, A4 preview in an isolated frame) | `/invoices/[id]/print` | `console.billing.manage` | `GET /platform/invoices/:id/print` |
| المتابعة والتحصيل (**new**: schedule · attempts · messages) | `/dunning` | `console.billing.manage` | `GET /platform/dunning` · `POST /platform/dunning/:subscription/run` |
| الإيراد (**new**: MRR · ARR · overdue) | `/revenue` | `console.billing.manage` | `GET /platform/revenue` |

What to know before touching the money screens:

1. **The three money codes are the point.** `console.plans.manage`, `console.subscriptions.manage`
   and `console.billing.manage` were declared in P-C1 and unused until here: the price list,
   the licence and the document are three different decisions, and `platform_support` — which
   reads customers all day — holds none of them. The sidebar hides what a session cannot open.
2. **A draft is not a tax document.** It carries no number; issuing allocates the next one from
   the platform series, and voiding keeps it (an auditor reads the sequence). The print preview
   therefore shows the number, the buyer VAT number, the ZATCA QR and the amount in words —
   and nothing at all for a void document.
3. **Money is a two-decimal string end to end.** The API normalises (`platformFormatAmount`) so
   `499.0000` never reaches a screen; the screens format for display only.
4. **The proration preview is the server's.** `/subscriptions` renders the numbers
   `change-plan` returns (credit of the unused part, full charge for the new plan, net) — the
   console never recomputes money, which is how a screen and a document stay in agreement.
5. **Settings are the invoice.** The seller identity, the VAT rate, the payment terms and the
   dunning ladder live in ستة `billing.*` keys on `/settings` (P-C1's catalogue) and are copied
   onto every document as it is created.

## Screens added by P-C5 (2026-09-17)

| Screen | Route | Console code | Endpoints |
|---|---|---|---|
| الاستخدام والحصص (**new**: totals · worst-first grid · per-tenant daily chart · CSV export) | `/usage` | read `console.tenants.view` · export `console.billing.manage` | `GET /platform/usage?tenantId=&period=` · `GET /platform/usage/export.csv` · `GET /platform/tenants/:id/usage` |

What to know before touching the usage screens:

1. **One engine, three surfaces.** The console grid, the CSV export, the customer card tab and
   the write-time guards all read `UsageService` — no screen counts anything itself. The card's
   own `invoicesPerDay` chart is the single deliberate exception (it is not one of the eight).
2. **Default limits are reported, not enforced.** A `limits.*` catalogue value describes the
   envelope a new tenant inherits; enforcement starts only at a limit whose source is `tenant`
   or `platform`. Every metric carries `enforced`, and the card tab says «يُبلَّغ عنه فقط» for
   the rest. This is why the sidebar's `/settings` shows the limits without promising a gate.
3. **Two ways to be refused.** Soft (80 %) writes a notice + a `usage.soft_limit` audit row and
   lets the write through; hard (100 %) refuses with `409 USAGE_LIMIT_REACHED` and puts the
   metric in `errors[0].metric` (problem+json extras) plus a `usage.limit_reached` audit row.
4. **`null` is not a reset.** `PUT /platform/settings` rejects `null`/blank for numeric keys
   (422) — it used to store `0`, which now means «block the customer».



## Screens added by P-C6 (2026-09-17)

| Screen | Route | Console code | Endpoints |
|---|---|---|---|
| البريد (**new**: القوالب · السجلّ · الإعدادات · الحجر) | `/email` | read `console.email.view` · write `console.email.manage` | `GET /platform/email/templates` · `POST/PUT/DELETE …/templates[/:id]` · `POST …/templates/:id/test` · `GET /platform/email/messages` · `POST …/messages/:id/retry` · `GET/PUT /platform/email/settings` · `POST …/settings/test` · `GET/POST/DELETE /platform/email/suppressions` |

What to know before touching the mail screens:

1. **The event index is code, the text is data.** `packages/contracts/src/platform/email.ts`
   declares the 17 events with their variables; `email_templates` holds the text — one platform
   row per (event, locale) and one override row per tenant, so «تجاوز نصّي بلا كود» is a row,
   not a deploy. Editing without a written reason is refused (400), and an unknown `{{variable}}`
   is refused at save time just as a missing one is refused at delivery time.
2. **Delivery is inline-first; the queue is the safety net.** Every send writes the message row
   **and** an `email.send` job on `notifications` in the same transaction, then delivers the
   first attempt in the request path (`inline`, recorded in `delivery_mode`). Waiting for the
   worker would mean no mail at all in a Redis-less install or with `WORKER=0`; only a
   deliberately deferred message (`sendAt` in the future) stays `queued`. Retries walk
   1m · 5m · 30m up to three attempts, then «فاشلة» — manual retry from the log takes a mandatory
   reason.
3. **Suppression is checked before the queue and is recorded.** A blocked address never enters
   the queue; the row is written as `suppressed` with its reason, so the log says «محجوبة»
   instead of staying silent. A bounce/complaint also marks the last `sent` row `bounced`.
4. **Two gates, two codes.** The enforced P-C5 quota (`limits.max_emails_per_month`) refuses
   `409 USAGE_LIMIT_REACHED`; the `email_settings` daily/monthly caps refuse `429`. Test
   messages (`is_test`) are excluded from the tenant's meter — a console probe is not usage.
5. **SMTP credentials live in the environment, never in the table.** The provider is switchable
   from the screen without a redeploy (`console` | `smtp`), and the settings payload reports
   `smtpConfigured` honestly instead of echoing a secret.

## Screens added by P-C7 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| الإعلانات | `/announcements` | `console.notifications.manage` | `GET/POST /platform/announcements` · `PATCH /platform/announcements/:id` · `POST …/:id/publish` · `GET …/:id/reads` |

Two tabs: **الإعلانات** (the list — title, status, audience, channels, due time, delivery
figures, with **نشر الآن** on drafts/scheduled rows and **القراءات** under published ones) ·
**كتابة إعلان / تعديل إعلان** (both texts ar+en, audience `all`/`plan`/`status`, channels
«إشعار داخل التطبيق» + «رسالة بريد», a schedule, a reason — and a live preview in the chosen
direction). «نشر الآن» reports the fan-out it caused (tenants · in-app · e-mails).

The decisions the screen makes visible: **the audience is an snapshot taken at publish time**
(so «نشر الآن» twice only fills gaps), **published announcements are frozen** (`PATCH` → 422,
what was said is not rewritten), and **the e-mail goes to the owner only** while the in-app
notice reaches every active staff membership.

## Screens added by P-C8 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| التذاكر | `/tickets` | `console.support.manage` | `GET/POST /platform/tickets` |
| تذكرة واحدة | `/tickets/[id]` | `console.support.manage` | `GET/PATCH /platform/tickets/:id` · `POST …/:id/reply` |
| الدخول المؤقّت | `/impersonation` | `console.support.manage` | `POST /platform/impersonate` · `GET …/sessions` · `DELETE …/:id` |

`/tickets` is the inbox: filters (status · priority · **بلا إسناد**), the SLA remainder computed
from the server's `slaDueAt` (a negative remainder is labelled, never hidden), and a
«تذكرة جديدة» tab that opens a ticket on a tenant with the first message written as the
customer. `/tickets/[id]` shows the thread with internal notes **marked**, four canned replies,
a public-vs-internal reply box and the status/priority/assignment actions the API allows.
`/impersonation` opens a break-glass session (tenant · 5–60 minutes · reason ≥10 chars), shows
the token with a link that opens the customer workspace, and lists every session with its
computed status and an end button.

The two support items live in the **Operations** group: the four sidebar groups P-C1 froze stay
four. And the limits the screen implies are enforced by the API, not here: the temporary token
carries `imp`, every `DELETE` and every non-`GET` `/auth/*` is refused while it is in use, and
ending the session in this screen drops the token **on the next request**.

## Screens added by P-C9 (2026-09-17)

| Screen | Route | Permission | Endpoints |
|---|---|---|---|
| المهام والطوابير (أُعيدت كتابتها) | `/jobs` | `console.jobs.view` (+ `console.jobs.manage` للأفعال) | `GET /platform/jobs` · `GET …/heartbeat` · `POST …/:id/retry` · `POST …/:id/cancel` |
| الملفات | `/files` | `console.jobs.manage` | `GET /platform/files` · `POST …/:id/scan` · `DELETE …/:id` |
| الصحة (أُعيدت كتابتها) | `/health` | `console.health.view` | `GET /platform/health/detailed` |
| التدقيق (عارض فرق) | `/audit` | `console.audit.view` | `GET /platform/audit` (يحمل `before`/`after`) |

Three decisions the screens make visible. **The scan verdict is read, not invented**: the console
shows what the upload path wrote into the audit trail (`meta.scan`), so «لم يُفحص» (no audit line
at all) and «لم يُفحص فعلياً» (`skipped` — the wired scanner does not scan) stay two different
things. **Quarantine is a mark, not a delete**: `status='deleted'` plus `deleted_at`, metadata
kept, and the customer's own `GET /files/:id` answers 404 afterwards. **Retry and cancel are
separate from reading**: `/jobs` is visible with `console.jobs.view`, the two buttons need
`console.jobs.manage` (owner and operations only), a reason of at least five characters, and a
confirmation — the auditor keeps reading the queue without being able to run it.

`/health` no longer probes the API from the browser: the six probes are measured **on the
server** (database · Redis · storage · e-mail · queue · worker), a probe that is not configured
says «غير مهيّأ» instead of pretending to be down, and the incident banner comes from
`platform.maintenance*` in the settings. The old browser-side check survives only as a footer
line that says what it is: proof that *this browser* reaches the API.

## Security

- No self-service signup: operators are provisioned by hand and granted Family-A
  platform roles (`platform_owner`, `platform_operations`, `platform_billing`,
  `platform_support`, `platform_auditor`) from `/roles`.
- `PlatformGuard` requires effective platform access (`pam` claim); tenant sessions —
  including tenant owners — see `Forbidden`.
- **Every `/platform/*` route requires a `console.*` code** (P-C1). The sidebar hides the
  items the session cannot open (`canConsole()`), and the API refuses them regardless —
  the sidebar is a convenience, never a control.
- `console.settings.manage` is held by `platform_owner` alone: the maintenance switch and
  the default limits affect every customer.
- `console.users.view` is likewise `platform_owner`-only **in the catalogue**: none of the
  other four roles can read the directory out of the box, and delegating it is a written,
  audited act on `/roles` (the API suite builds a read-only operator that way and proves the
  read-only operator still cannot revoke a session).
- CSP headers are configured in `next.config.mjs`.

## Design System v3

The platform console is built on the shared kit in `packages/ui` (see its README for
the full contract). Local notes for this app:

- **Dark is the default.** `app/layout.tsx` starts the theme at `dark`; the topbar
  `ThemeToggle` can still switch it, because the mechanism is one and shared. The
  console is tuned dark-first: 260 px rail, dense rows, monospace numerals.
- **Destructive actions** (suspend tenant, delete, impersonate, force sign-out) go
  through a reason/confirm modal before anything is sent.
- **Impersonation banner is not dismissible** while the token lives (P-C8). It states
  whose identity is being assumed and offers only one action: stop.
- **`/design`** renders `DesignGallery` — every component once, in both themes. It is
  `notFound()` in production. It sits behind the app's own `AuthGate` like every other
  route; the gate was **not** relaxed to open a colour palette to anonymous visitors,
  so sign in first.
