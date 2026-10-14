# Marketing — public site (home, pricing, onboarding, verify, contact)

Arabic-first Next.js 15 App Router app. Served from the apex domain
(`yourdomain.com`) and deployed separately from every other surface, while
calling the same shared API (`apps/api`).

## Run

```bash
pnpm --filter @erp/marketing dev
pnpm --filter @erp/marketing build
```

Set `NEXT_PUBLIC_API_BASE_URL` to the API base URL, for example
`http://localhost:3000/api/v1`. In a split-domain deploy also set
`NEXT_PUBLIC_STAFF_URL`, `NEXT_PUBLIC_PORTAL_URL` and `NEXT_PUBLIC_PLATFORM_URL`.

## Structure

- `app/` — `/` landing, `/pricing` (live plans from `GET /billing/plans`),
  `/onboarding` (real self-service signup via `POST /signup`),
  `/verify` (public invoice verification), `/contact`, `/login` (smart router).
- `components/` — signup panel, smart login (authenticates once, then routes
  staff to the staff app and buyers to the customer portal via a `?token=`
  bridge), KPI cards.
- `lib/` — API client, formatting, `publicRoutes` registry, cross-surface link
  helper (`surfaces.ts`), ZATCA QR decoder.
- `tests/` — route/kit coverage checks.

This surface hosts no authenticated screen: the portal moved to
`apps/customer-portal` and the consoles to `apps/staff` / `apps/platform-admin`.

## Design System v3

The marketing site is built on the shared kit in `packages/ui` (see its README for the
full contract). Local notes for this app:

- **Theme defaults to `system`** and the navbar carries `ThemeToggle`. Nothing else
  owns the theme.
- **JS budget.** The layout imports `@erp/ui/theme`, not the `@erp/ui` barrel — the
  barrel reaches recharts and framer-motion, which the layout does not need, and which
  put `/layout` over `perf-budget.json`'s ceiling. `packages/ui` declares
  `sideEffects: ["*.css"]` for the same reason. `/design` is excluded from
  measurement (`UNMEASURED_ROUTES` in `lib/perf.ts`) because it is dev-only and
  `notFound()` in production; no visitor-facing route may be added to that list.
- **Copy is real, never faked.** Marketing pages are **server components**
  (`lib/content.ts`): they read from the API's `/public/*` endpoints at request time
  and fall back to a static section when the API is unreachable, so a page degrades to
  its static copy instead of a 500. There is no `USE_MOCKS` and no mock module anywhere
  in this app — `grep -rn USE_MOCKS apps/marketing` returns only this README line. The
  theme switch is the only client-side state.
- **AR-first, full `/en` parity.** `middleware.ts` routes both locales; the Arabic
  page is the source and `/en` is a translation, never a stub.
- **SEO.** Metadata, OG, JSON-LD, `sitemap.xml`, `robots.txt` and canonical links are
  generated per locale.
