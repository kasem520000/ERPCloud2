#!/usr/bin/env python3
"""
Design System v3 — migrate raw Tailwind palette classes in the three app
surfaces onto the semantic tokens exported by `@erp/ui`.

Why a script and not a hand edit: the rule is "no raw `slate-*`/`#fff` in any
JSX" (Design v3 §2.2.2), and the three apps carry ~800 of them across ~70
files. A hand edit drifts; this mapping is a single, reviewable table that is
re-runnable and idempotent.

The mapping is *semantic*, not mechanical: `text-slate-900` becomes `text-ink`
(which flips), `bg-slate-900` becomes `bg-inverse` (which deliberately does
not, because a tooltip bubble and a JSON viewer stay dark in both themes), and
`text-white` becomes `text-on-accent` (white on a filled brand/danger chip in
both themes).

Run:  python3 scripts/migrate-tokens-v3.py [--check]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

APPS = ("apps/staff", "apps/platform-admin", "apps/marketing")

# ---------------------------------------------------------------------------
# The table. Order does not matter: each entry is matched as a whole utility
# token, so `text-slate-900` can never be partially rewritten into `text-ink00`.
# ---------------------------------------------------------------------------
NEUTRAL = {
    # surfaces
    "bg-white": "bg-surface",
    "bg-slate-50": "bg-surface-2",
    "bg-slate-100": "bg-surface-3",
    "bg-slate-200": "bg-surface-3",
    "bg-slate-300": "bg-line-raised",
    "bg-slate-400": "bg-line-raised",
    "bg-slate-700": "bg-inverse",
    "bg-slate-800": "bg-inverse",
    "bg-slate-900": "bg-inverse",
    "bg-slate-950": "bg-inverse",
    "bg-black": "bg-inverse",
    "bg-zinc-50": "bg-surface-2",
    "bg-zinc-100": "bg-surface-3",
    "bg-zinc-800": "bg-inverse",
    "bg-zinc-900": "bg-inverse",
    "bg-gray-50": "bg-surface-2",
    "bg-gray-100": "bg-surface-3",
    "bg-gray-800": "bg-inverse",
    "bg-gray-900": "bg-inverse",
    # ink
    "text-slate-950": "text-ink",
    "text-slate-900": "text-ink",
    "text-slate-800": "text-ink",
    "text-slate-700": "text-ink-2",
    "text-slate-600": "text-ink-2",
    "text-slate-500": "text-muted",
    "text-slate-400": "text-muted",
    "text-slate-300": "text-muted",
    "text-black": "text-ink",
    "text-white": "text-on-accent",
    "text-zinc-900": "text-ink",
    "text-zinc-700": "text-ink-2",
    "text-zinc-500": "text-muted",
    "text-zinc-400": "text-muted",
    "text-gray-900": "text-ink",
    "text-gray-700": "text-ink-2",
    "text-gray-500": "text-muted",
    # hairlines
    "border-slate-50": "border-line",
    "border-slate-100": "border-line",
    "border-slate-200": "border-line",
    "border-slate-300": "border-line-strong",
    "border-slate-400": "border-line-strong",
    "border-slate-600": "border-line-strong",
    "border-slate-700": "border-inverse-line",
    "border-slate-800": "border-inverse-line",
    "border-slate-900": "border-inverse-line",
    "border-black": "border-inverse-line",
    "border-white": "border-on-accent",
    "divide-slate-100": "divide-line",
    "divide-slate-200": "divide-line",
    "divide-slate-700": "divide-inverse-line",
    "divide-slate-800": "divide-inverse-line",
    "ring-slate-200": "ring-line",
    "ring-slate-300": "ring-line-strong",
    "ring-slate-700": "ring-inverse-line",
    "ring-slate-800": "ring-inverse-line",
}

STATUS = {
    # emerald -> ok
    "bg-emerald-50": "bg-ok-soft",
    "bg-emerald-100": "bg-ok-soft",
    "bg-emerald-500": "bg-ok",
    "bg-emerald-600": "bg-ok",
    "text-emerald-500": "text-ok",
    "text-emerald-600": "text-ok",
    "text-emerald-700": "text-ok-ink",
    "text-emerald-800": "text-ok-ink",
    "border-emerald-100": "border-ok-line",
    "border-emerald-200": "border-ok-line",
    "border-emerald-300": "border-ok-line",
    "ring-emerald-200": "ring-ok-line",
    "ring-emerald-500": "ring-ok/40",
    "fill-emerald-500": "fill-ok",
    "fill-emerald-600": "fill-ok",
    "stroke-emerald-500": "stroke-ok",
    "stroke-emerald-600": "stroke-ok",
    # amber -> warn
    "bg-amber-50": "bg-warn-soft",
    "bg-amber-100": "bg-warn-soft",
    "bg-amber-400": "bg-warn",
    "bg-amber-500": "bg-warn",
    "bg-amber-600": "bg-warn",
    "text-amber-500": "text-warn",
    "text-amber-600": "text-warn",
    "text-amber-700": "text-warn-ink",
    "text-amber-800": "text-warn-ink",
    "border-amber-100": "border-warn-line",
    "border-amber-200": "border-warn-line",
    "border-amber-300": "border-warn-line",
    "ring-amber-200": "ring-warn-line",
    "fill-amber-500": "fill-warn",
    "stroke-amber-500": "stroke-warn",
    "stroke-amber-600": "stroke-warn",
    # red -> danger
    "bg-red-50": "bg-danger-soft",
    "bg-red-100": "bg-danger-soft",
    "bg-red-400": "bg-danger",
    "bg-red-500": "bg-danger",
    "bg-red-600": "bg-danger",
    "text-red-400": "text-danger",
    "text-red-500": "text-danger",
    "text-red-600": "text-danger",
    "text-red-700": "text-danger-ink",
    "text-red-800": "text-danger-ink",
    "border-red-100": "border-danger-line",
    "border-red-200": "border-danger-line",
    "border-red-300": "border-danger-line",
    "border-red-400": "border-danger-line",
    "ring-red-200": "ring-danger-line",
    "ring-red-500": "ring-danger/40",
    "fill-red-500": "fill-danger",
    "stroke-red-500": "stroke-danger",
    # blue -> info
    "bg-blue-50": "bg-info-soft",
    "bg-blue-100": "bg-info-soft",
    "bg-blue-500": "bg-info",
    "bg-blue-600": "bg-brand",
    "text-blue-500": "text-info",
    "text-blue-600": "text-info",
    "text-blue-700": "text-info-ink",
    "text-blue-800": "text-info-ink",
    "border-blue-100": "border-info-line",
    "border-blue-200": "border-info-line",
    "border-blue-300": "border-info-line",
    "ring-blue-200": "ring-info-line",
    "fill-blue-500": "fill-info",
    "stroke-blue-500": "stroke-info",
    # sky -> info
    "bg-sky-50": "bg-info-soft",
    "bg-sky-100": "bg-info-soft",
    "text-sky-500": "text-info",
    "text-sky-600": "text-info",
    "text-sky-700": "text-info-ink",
    "border-sky-200": "border-info-line",
    "fill-sky-500": "fill-info",
    # violet / indigo / purple -> brand (the shared blue-violet identity)
    "bg-violet-50": "bg-brand-soft",
    "bg-violet-100": "bg-brand-soft",
    "bg-violet-500": "bg-brand-2",
    "bg-violet-600": "bg-brand",
    "text-violet-500": "text-brand",
    "text-violet-600": "text-brand",
    "text-violet-700": "text-brand",
    "text-violet-800": "text-brand",
    "border-violet-200": "border-brand-line",
    "border-violet-300": "border-brand-line",
    "ring-violet-200": "ring-brand-line",
    "fill-violet-500": "fill-brand-2",
    "stroke-violet-500": "stroke-brand-2",
    "bg-indigo-50": "bg-brand-soft",
    "bg-indigo-100": "bg-brand-soft",
    "bg-indigo-500": "bg-brand-2",
    "bg-indigo-600": "bg-brand",
    "text-indigo-500": "text-brand",
    "text-indigo-600": "text-brand",
    "text-indigo-700": "text-brand",
    "border-indigo-200": "border-brand-line",
    "fill-indigo-500": "fill-brand-2",
    "bg-purple-50": "bg-brand-soft",
    "bg-purple-100": "bg-brand-soft",
    "text-purple-600": "text-brand",
    "text-purple-700": "text-brand",
    "border-purple-200": "border-brand-line",
    "fill-purple-500": "fill-brand-2",
    # green -> ok
    "bg-green-50": "bg-ok-soft",
    "bg-green-100": "bg-ok-soft",
    "bg-green-500": "bg-ok",
    "bg-green-600": "bg-ok",
    "text-green-600": "text-ok",
    "text-green-700": "text-ok-ink",
    "text-green-800": "text-ok-ink",
    "border-green-200": "border-ok-line",
    "fill-green-500": "fill-ok",
    "stroke-green-500": "stroke-ok",
    # orange -> warn
    "bg-orange-50": "bg-warn-soft",
    "bg-orange-100": "bg-warn-soft",
    "text-orange-600": "text-warn",
    "text-orange-700": "text-warn-ink",
    "border-orange-200": "border-warn-line",
    "fill-orange-500": "fill-warn",
    # cyan -> info
    "bg-cyan-50": "bg-info-soft",
    "text-cyan-600": "text-info",
    "text-cyan-700": "text-info-ink",
    "fill-cyan-500": "fill-info",
    # rose -> danger
    "bg-rose-50": "bg-danger-soft",
    "text-rose-600": "text-danger",
    "text-rose-700": "text-danger-ink",
    "border-rose-200": "border-danger-line",
    "fill-rose-500": "fill-danger",
    # yellow -> warn
    "bg-yellow-50": "bg-warn-soft",
    "text-yellow-600": "text-warn",
    "text-yellow-700": "text-warn-ink",
    "fill-yellow-500": "fill-warn",
    # teal -> ok
    "bg-teal-50": "bg-ok-soft",
    "text-teal-600": "text-ok",
    "text-teal-700": "text-ok-ink",
    "fill-teal-500": "fill-ok",
}

MAPPING = {**NEUTRAL, **STATUS}

# `placeholder-slate-400` / `placeholder:text-slate-400` style forms.
PLACEHOLDER = re.compile(r"placeholder:((?:text|bg)-[a-z]+-\d{2,3})(?=/[\d.]+)?\b")
PLACEHOLDER_MAP = {
    "text-slate-400": "text-muted",
    "text-slate-500": "text-muted",
    "text-gray-400": "text-muted",
    "text-zinc-400": "text-muted",
}

PREFIXES = ("", "hover:", "focus:", "focus-visible:", "active:", "disabled:", "group-hover:", "peer-hover:")
# A utility may carry an opacity modifier: `bg-white/70`, `text-slate-900/60`.
TOKEN = re.compile(
    r"(?<![\w-])(" + "|".join(re.escape(k) for k in MAPPING) + r")(?:/(\[[^\]]+\]|[\d.]+))?(?![\w-])"
)


def migrate_text(text: str) -> tuple[str, int]:
    """Rewrite every mapped utility in one source string."""
    changed = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal changed
        changed += 1
        return MAPPING[match.group(1)]

    text = TOKEN.sub(replace, text)
    text = PLACEHOLDER.sub(lambda m: f"placeholder:{PLACEHOLDER_MAP.get(m.group(1), m.group(1))}", text)
    return text, changed


def main() -> int:
    check = "--check" in sys.argv
    total_files = 0
    total_hits = 0
    for app in APPS:
        root = Path(app)
        for path in sorted(root.rglob("*.tsx")):
            if "node_modules" in path.parts or ".next" in path.parts:
                continue
            original = path.read_text(encoding="utf-8")
            updated, hits = migrate_text(original)
            if hits == 0:
                continue
            total_files += 1
            total_hits += hits
            if check:
                print(f"{path}: {hits} raw palette utilities remain")
            else:
                path.write_text(updated, encoding="utf-8")
                print(f"{path}: {hits} utilities -> tokens")
    print(f"\n{total_hits} utilities across {total_files} files")
    return 1 if check and total_hits else 0


if __name__ == "__main__":
    raise SystemExit(main())
