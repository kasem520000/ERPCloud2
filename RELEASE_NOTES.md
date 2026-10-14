# Release Notes — Design System v3, PR-1: the shared kit

Date: 2026-10-01
Status: READY candidate — gate matrix below
Scope: `packages/ui` (new), `apps/staff`, `apps/platform-admin`, `apps/marketing`.

## What this release is

One design system, shipped once, for all three surfaces. `packages/ui` now owns the
token set and the React kit, and all three apps import from it. The v2 per-app token
blocks and the two forked component kits are gone from the hot path; what remains in
`apps/*` is screen code, which is exactly what should remain.

This is the foundation of a seven-PR programme. It carries no endpoint, DTO,
permission-code or guard-ordering change, and no route was added, removed or renamed
— the only new paths are `/design`, which is `notFound()` in production.

## What is in it

**`packages/ui`** — 22 components with JSDoc, RTL/LTR auto behaviour, both themes and
a real `disabled` state (never hidden): Button, Card, Kpi, DataTable, Badge/StatusBadge,
Modal, Drawer, ConfirmDialog, Tabs, SegmentedTabs, Input, Select, Combobox,
DateRangePicker, MoneyField, Toast, Tooltip, Skeleton, EmptyState, FilterBar, Avatar,
ThemeToggle, Progress, Meter, chart wrappers (BarSeries, Donut, LineSeries,
ChartLegend), PrintSheet, KeyboardHint, PosKeyHints, Reveal, CountUp, Marquee.

**One token set, one theme mechanism.** `packages/ui/src/tokens/tokens.css` is the
single source; all three `globals.css` import it and nothing else declares the
contract. The theme key is exactly `erp.theme` ∈ `light|dark|system` in
`localStorage`, one blocking micro-script in `<head>` sets `html.dark` before
hydration, and there are no sub-keys. Dark mode is first-class: complete for
`staff` (toggle in the top bar), the default for `platform-admin`, and
`system`-default with a navbar toggle for `marketing`.

**Motion and print.** All motion is `framer-motion`, capped at 300 ms and disabled
under `prefers-reduced-motion`. `@media print` forces a white background and dark
type in both themes. No autoplay with sound.

**Colour discipline.** 1,359 raw Tailwind palette utility classes across 69 files and
58 inline `style`/`shadow` colour literals across 22 files were migrated onto
semantic tokens. Both migrations are re-runnable (`scripts/migrate-tokens-v3.py --check`
and `scripts/migrate-inline-tokens-v3.py --check`) and report zero remaining. The
survivors are the deliberate ones: the white-label brand defaults and two comment
references to desktop source files.

**The review page.** `app/design` in all three apps shows every component once, in
both themes, with a toggle — the page the programme is judged by.

**Bilingual shell for staff.** A `AR/EN` switch in the staff top bar flips
`<html dir>` through the existing `lib/i18n.tsx` provider (keys added only — nothing
removed), and the sidebar now carries a `تغطية الشاشات` card that counts how many
screens are `ready` vs `api` vs `planned` instead of implying that everything works.

## Verification matrix

| Gate | Result |
|---|---|
| `@erp/ui` `typecheck` | clean |
| `@erp/ui` `lint` | clean |
| `@erp/ui` `test` | **21 / 21** |
| `apps/staff` build | `✓ Compiled successfully in 19.7s` |
| `apps/staff` lint | clean |
| `apps/staff` test | **70 / 70** (10 files) |
| `apps/platform-admin` build | `✓ Compiled successfully`, 36/36 static pages |
| `apps/platform-admin` lint | clean |
| `apps/platform-admin` test | **24 / 24** (2 files) |
| `apps/marketing` build | `✓ Compiled successfully`, 15/15 static pages |
| `apps/marketing` lint | clean |
| `apps/marketing` test | **98 / 99** (1 pre-existing failure, below) |
| `packages/contracts` test | **232 / 232** |
| `packages/config` test | **10 / 10** |
| `packages/database` test | **53 / 53** (after `@erp/config` was built) |
| `packages/testing` test | **12 / 12** |
| Raw palette utilities remaining in the three apps | **0** |
| Inline colour literals remaining (excluding deliberate) | **0** |

### Known issues, stated plainly

1. **`apps/marketing/tests/verify.spec.ts` P-M8 fails** — 34 industry labels in
   `apps/marketing` do not match `apps/staff/lib/navigation.ts` at the recorded line
   numbers. This is **pre-existing at the branch's base commit** (confirmed by stashing
   the entire change set and re-running). Out of scope for this release.
2. **`tsc -p tsconfig.base.json --noEmit` is red with 363 errors across ~100 files** —
   also the base-commit state, also out of scope. Recorded as CR-006.
3. **`apps/marketing/tests/perf.spec.ts` P-M10 `/layout` was 1232.3 kB against a 680 kB
   ceiling** while the layout imported the `@erp/ui` barrel. Fixed by importing the
   `@erp/ui/theme` subpath and adding `sideEffects: ["*.css"]`; `/layout` is inside the
   ceiling again and `perf-budget.json` was **not** edited. The dev-only `/design` page
   is above the ceiling by construction and is excluded from *measurement* via
   `UNMEASURED_ROUTES` (CR-005).
4. **Incidental repair:** `reorderWidgets` in `apps/staff/lib/bi-dashboards.ts` is now
   generic. This was a red build on the base commit (CR-003).
5. **Not yet delivered from the programme's backlog:** the per-surface redesigns
   themselves (PR-2 … PR-7), Lighthouse runs, axe DevTools passes on the six model
   pages, and the reduced-motion / theme-switch-mid-session walkthroughs. Those are
   the next PRs' gates, not this one's.
6. **Light/Dark screenshots are not attached to this release.** This sandbox has no
   browser binary (no Playwright/Puppeteer/Chrome), so the gallery could not be
   captured as an image. What *is* verified mechanically: the built CSS contains the
   `.dark` variable block with every semantic token flipped; `bg-surface`, `text-ink`,
   `text-muted`, `border-line`, `bg-ok-soft`, `text-ok-ink`, `bg-inverse` and
   `text-on-accent` all resolve to `var(--color-…)`; and the blocking theme script is
   present in the served `<head>` of both the marketing and staff dev servers, writing
   `html.dark` before React hydrates. Capture the screenshots from the running dev
   servers (marketing :3002, staff :3001) before merging — `/design` is dev-gated and
   sits behind the normal `AuthGate`, so it needs a signed-in session.
7. **`/design` could not be rendered authenticated in this sandbox** — the API is not
   running here, so no session exists. The gallery is covered by `@erp/ui`'s 21 unit
   tests and by all three `next build`s (it typechecks and compiles in each app); the
   authenticated visual pass is part of PR-2's evidence, not this PR's.

## Follow-ups

- PR-2 will re-point the staff screens at the kit and retire `components/ui.tsx`.
- PR-3 … PR-6 follow the same pattern for `platform-admin` and `marketing`.
- PR-7 closes with the accessibility, performance and motion evidence for all three.

# Release Notes — v1.0.0

Date: 2026-09-07
Status: READY candidate

## Highlights

- Completed all 23 project phases for the cloud multi-tenant SaaS ERP.
- Core platform: tenancy, identity, RBAC, settings, audit, files, notifications, outbox and sequences.
- Domain modules: organization, catalog, accounting, parties, inventory, sales, purchases, treasury, e-invoicing, reporting and migration.
- Compatibility and surfaces: legacy desktop gateway, admin panel and customer portal.
- Vertical packs: restaurant POS, HRM/payroll, installments, contracting/projects, optics, tailoring, marina, fitment and Salla integration.
- Go-live hardening: Prometheus metrics, deeper readiness checks, retention plan, backup/restore and incident runbooks, UAT pack, security sweep and release operations documentation.

## Verification

Final Phase 23 verification command: `pnpm run verify` with exit code 0.

Known environment note: this sandbox logs an embedded PostgreSQL `libpq.so.5` loader error during API Vitest setup, but the repository verify script completes and exits 0.

## Security notes

- Runtime secrets are encrypted with AES-GCM.
- Tenant isolation is enforced by application guards and PostgreSQL RLS/FORCE RLS.
- Remaining dependency audit findings are waived by ADR-021 because they are isolated to build/test/dev-server surfaces and are not exposed by the production runbook.
