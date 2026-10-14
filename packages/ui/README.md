# `@erp/ui` — Design System v3

One design system for the three surfaces: `apps/staff`, `apps/platform-admin`,
`apps/marketing`. Two things live here and nowhere else:

1. **The token set** — `src/tokens/tokens.css`, imported once by each app's
   `globals.css`.
2. **The component kit** — `src/components/*`, re-exported from `src/index.ts`.

Consumed as TypeScript source through each app's `transpilePackages`. There is no
`dist/`, no build step, and no ordering requirement between this package and its
consumers (ADR-030 / ADR-031).

## The theme mechanism — one, not three

```
localStorage['erp.theme']  =  'light' | 'dark' | 'system'     ← the only key
```

* A blocking inline micro-script in `<head>` (`ThemeScript`) writes
  `.dark` on `<html>` before React hydrates. No flash of the wrong theme.
* `ThemeProvider` owns the state and mirrors it back to `localStorage` and
  `document.documentElement.dataset.theme`.
* `ThemeToggle` is the only UI that changes it. It is mounted in all three top bars:
  the staff top bar, the platform-admin topbar and the marketing navbar.
* There are no sub-keys and no second mechanism. `system` follows
  `prefers-color-scheme`.

## The token contract

| Token | Role |
|---|---|
| `--bg` | page background |
| `--surface` | card / panel background |
| `--surface-2`, `--surface-3` | raised and inset layers |
| `--text` | primary ink |
| `--muted`, `--muted-2` | secondary and tertiary ink |
| `--line`, `--line-strong` | hairline and emphasised borders |
| `--brand`, `--brand-soft` | the app's own accent and its tinted plate |
| `--ok/--warn/--danger/--info` + `-soft` + `-ink` | status pairs |
| `--inverse`, `--inverse-ink`, `--inverse-line` | always-dark plate |
| `--on-accent` | ink on a brand fill |

Tailwind v4 exposes these through `@theme`, so `bg-surface`, `text-muted`,
`border-line`, `bg-ok-soft`, `text-ok-ink` and `bg-inverse` are real utilities that
resolve to the variables above — and flip when `.dark` lands on `<html>`.

**The status namespace is deliberately prefixed.** The v2 names (`--success`,
`--warning`) collided with Tailwind's primitive scales once those were exposed, which
silently resolved `bg-success` to the wrong layer. `--ok*` / `--warn*` / `--danger*` /
`--info*` keep the primitive and semantic layers apart in a `grep`.

## The component kit

Every component below has: variants, JSDoc, RTL/LTR auto behaviour (logical
properties only — `ps/pe/ms/me`, `start/end`), a correct rendering in **both** themes,
and a `disabled` state that is *disabled*, never hidden.

| Group | Components |
|---|---|
| Actions | `Button`, `ThemeToggle` |
| Surfaces | `Card`, `Modal`, `Drawer`, `ConfirmDialog`, `PrintSheet` |
| Data | `DataTable` (+`ready/loading/error/forbidden` states), `FilterBar`, `Kpi`, `CountUp`, `Sparkline` |
| Status | `Badge`, `StatusBadge`, `Progress`, `Meter`, `EmptyState`, `Skeleton`, `SkeletonCard` |
| Inputs | `Input`, `Select`, `Combobox`, `DateRangePicker`, `MoneyField` |
| Navigation | `Tabs`, `SegmentedTabs`, `Tooltip`, `KeyboardHint`, `PosKeyHints` |
| Identity | `Avatar` |
| Charts | `BarSeries`, `Donut`, `LineSeries`, `ChartLegend` (recharts wrappers on a fixed palette) |
| Feedback | `Toast` (+`ToastProvider`) |
| Motion | `Reveal`, `Marquee` — `framer-motion`, ≤300 ms, all of it off under `prefers-reduced-motion` |
| Review | `DesignGallery`, `DesignGalleryWithToasts` — the `/design` page |

### `MoneyField` and the money guard

Money is a `string` or a `decimal.js` value, never a `number` — the root
`eslint.config.mjs` enforces `PROJECT_CONTRACT §3` with a `no-restricted-syntax` rule
that also fires inside this package. That rule was never relaxed. Where it matched a
legitimate *count* identifier (`total` in `formatPosition`, the `total` accumulators in
`avatar.tsx` and the Donut reducer), the identifier was renamed instead.

### `DataTable` states

The four table states are explicit and honest: `ready`, `loading` (skeleton),
`error` (names the endpoint) and `forbidden` (names the missing permission). A screen
that cannot render its rows says so; it never silently hides.

## Importing

```ts
// The whole kit (staff, platform-admin screens).
import { Button, Card, DataTable, MoneyField } from '@erp/ui';

// Theme only — use this from a layout or a top bar. It does not pull recharts
// or framer-motion into the graph, which is what keeps /layout inside the
// marketing JS budget (CR-005).
import { ThemeProvider, ThemeScript, ThemeToggle } from '@erp/ui/theme';

// Tokens only — use this from globals.css.
@import '@erp/ui/tokens.css';
```

`package.json` declares `sideEffects: ["*.css"]`: only CSS files are side-effectful,
so importing the barrel for one component cannot re-enter the graph for the others.

## Subpaths

| Subpath | What it gives you |
|---|---|
| `@erp/ui` | the whole kit + tokens re-export |
| `@erp/ui/theme` | `ThemeProvider`, `ThemeScript`, `ThemeToggle`, `useTheme` |
| `@erp/ui/tokens.css` | the token set |

## Gates

```
pnpm --filter @erp/ui run typecheck   # clean
pnpm --filter @erp/ui run lint        # clean
pnpm --filter @erp/ui run test        # 21 / 21
```

## Boundary rules

`packages/ui` must not import from `apps/*`. It is a `lib` element in the root
`eslint.config.mjs` `boundaries/element-types` block, and a violation fails lint.
Dependencies are limited to what the apps already had: `react`, `react-dom`,
`framer-motion`, `lucide-react`, `recharts`, `decimal.js`.
