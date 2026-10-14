# Customer Portal — self-service for the tenant's buyers

Arabic-first Next.js 15 App Router app. Served from the `portal.*` domain and
deployed separately from every other surface, while calling the same shared API
(`apps/api`).

## Run

```bash
pnpm --filter @erp/customer-portal dev
pnpm --filter @erp/customer-portal build
```

Set `NEXT_PUBLIC_API_BASE_URL` to the API base URL, for example
`http://localhost:3000/api/v1`.

## Structure

- `app/` — `/portal` dashboard, invoices, statement, payments, profile, plus
  `/auth/login`, `/auth/change-password`, `/auth/forgot`. The root `/` redirects
  to `/portal`: this surface has no public landing.
- `components/` — portal shell (auth gate + nav), KPI cards, auth forms.
- `lib/` — portal API client, formatting, `useAsync`, `portalRoutes` registry.
- `tests/`, `lib/portal.spec.ts` — route/contract coverage checks.

Portal accounts are issued by the supplier (the tenant), never self-registered:
there is no signup on this surface.
