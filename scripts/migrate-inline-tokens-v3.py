#!/usr/bin/env python3
"""
Design System v3 — second pass: inline `style={{ … }}` colour literals and
`shadow-[…]` colour literals in the three app surfaces.

Pass one (`scripts/migrate-tokens-v3.py`) handled Tailwind utility classes.
This one handles the colours that were written straight into a `style` object
or an arbitrary `shadow-[…]` value, which is the other half of Design v3
§2.2.2 — "no fixed colour, in any form".

The mapping is keyed on the CSS property so the same literal means the right
thing in the right place: `#fff` as a `background` is a *surface*, while `#fff`
as a `color` is *text on a filled accent*.

Run:  python3 scripts/migrate-inline-tokens-v3.py [--check]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

APPS = ("apps/staff", "apps/platform-admin", "apps/marketing")

# ---------------------------------------------------------------------------
# What a literal means, per CSS property.
# ---------------------------------------------------------------------------
BY_PROPERTY: dict[str, dict[str, str]] = {
    # surfaces
    "background": {
        "#fff": "var(--surface)",
        "#ffffff": "var(--surface)",
        "white": "var(--surface)",
        "#f8fafc": "var(--bg)",
        "#fafbfc": "var(--surface-2)",
        "#f1f5f9": "var(--surface-3)",
        "#e2e8f0": "var(--line)",
        "#eef1f8": "var(--surface-2)",
        "#0f172a": "var(--inverse)",
        "#111": "var(--text)",
        "#111827": "var(--inverse)",
        "#1e293b": "var(--inverse)",
        "#0b1220": "var(--inset)",
        "#fffbe6": "var(--warn-soft)",
        "#E8EAF6": "var(--brand-soft)",
        "#E8F5E9": "var(--ok-soft)",
        "#ecfdf5": "var(--ok-soft)",
        "#fffbeb": "var(--warn-soft)",
        "#fef2f2": "var(--danger-soft)",
        "#f0f9ff": "var(--info-soft)",
        "#eff6ff": "var(--brand-soft)",
        "#f5f3ff": "var(--brand-soft)",
        "#1B8E4A": "var(--ok)",
        "#B92F2F": "var(--danger)",
        "#2563eb": "var(--brand)",
        "#7c3aed": "var(--color-violet-600)",
    },
    "backgroundcolor": {
        "#fff": "var(--surface)",
        "#ffffff": "var(--surface)",
        "white": "var(--surface)",
        "#f8fafc": "var(--bg)",
        "#f1f5f9": "var(--surface-3)",
        "#e2e8f0": "var(--line)",
        "#0f172a": "var(--inverse)",
        "#111": "var(--text)",
        "#1e293b": "var(--inverse)",
    },
    # ink
    "color": {
        "#fff": "var(--on-accent)",
        "#ffffff": "var(--on-accent)",
        "white": "var(--on-accent)",
        "#111": "var(--text)",
        "#000": "var(--text)",
        "black": "var(--text)",
        "#0f172a": "var(--text)",
        "#64748b": "var(--muted)",
        "#94a3b8": "var(--muted)",
        "#475569": "var(--muted-2)",
        "#334155": "var(--muted-2)",
        "#e2e8f0": "var(--text)",
        "#c00": "var(--danger)",
        "#e2543a": "var(--danger)",
        "#b42318": "var(--danger)",
        "#b91c1c": "var(--danger)",
        "#dc2626": "var(--danger)",
        "#1a7f37": "var(--ok)",
        "#047857": "var(--ok)",
        "#0f766e": "var(--ok)",
        "#059669": "var(--ok)",
        "#10b981": "var(--ok)",
        "#b45309": "var(--warn)",
        "#d97706": "var(--warn)",
        "#f59e0b": "var(--warn)",
        "#2563eb": "var(--brand)",
        "#7c3aed": "var(--brand)",
    },
    # hairlines
    "bordercolor": {
        "#fff": "var(--surface)",
        "#e2e8f0": "var(--line)",
        "#cbd5e1": "var(--line-strong)",
        "#f0d000": "var(--warn-line)",
        "#fecaca": "var(--danger-line)",
        "#a7f3d0": "var(--ok-line)",
        "#fde68a": "var(--warn-line)",
        "#bae6fd": "var(--info-line)",
        "#bfdbfe": "var(--brand-line)",
        "#b42318": "var(--danger)",
        "#2563eb": "var(--brand)",
        "#0f172a": "var(--line)",
    },
    "border": {
        "#e2e8f0": "var(--line)",
        "#cbd5e1": "var(--line-strong)",
        "#f0d000": "var(--warn-line)",
        "#b42318": "var(--danger)",
    },
    "borderinline-start": {"#b42318": "var(--danger)", "#e2e8f0": "var(--line)"},
    "borderinline-end": {"#e2e8f0": "var(--line)", "#0f172a": "var(--line)"},
    "bordertop": {"#e2e8f0": "var(--line)", "#cbd5e1": "var(--line-strong)"},
    "borderbottom": {"#e2e8f0": "var(--line)", "#cbd5e1": "var(--line-strong)"},
    # SVG paints
    "fill": {
        "#111": "var(--text)",
        "#64748b": "var(--muted)",
        "#94a3b8": "var(--muted)",
        "#0f766e": "var(--ok)",
        "#2563eb": "var(--brand)",
        "#f59e0b": "var(--warn)",
        "#ef4444": "var(--danger)",
        "#10b981": "var(--ok)",
        "#fff": "var(--surface)",
    },
    "stroke": {
        "#111": "var(--text)",
        "#64748b": "var(--muted)",
        "#94a3b8": "var(--muted)",
        "#0f766e": "var(--ok)",
        "#2563eb": "var(--brand)",
        "#e2e8f0": "var(--line)",
    },
    "backgroundimage": {},
}

# `key: '#hex'` / `key: "#hex"` inside an object literal.
STYLE_ENTRY = re.compile(
    r"(?P<key>[A-Za-z][A-Za-z0-9]*)\s*:\s*(?P<quote>['\"])(?P<value>#[0-9a-fA-F]{3,8}|white|black)(?P=quote)"
)

# `shadow-[0_0_0_3px_rgb(37_99_235/0.15)]` and friends.
SHADOW_RGB = re.compile(r"shadow-\[0_0_0_3px_rgb\(37_99_235/0\.15\)\]")
SHADOW_RGB_DANGER = re.compile(r"shadow-\[0_0_0_3px_rgb\(239_68_68/0\.12\)\]")
SHADOW_INSET = re.compile(r"shadow-\[inset_0_0_0_1\.5px_#93c5fd\]")
SHADOW_RGB_VIOLET = re.compile(r"shadow-\[0_0_0_3px_rgb\(124_58_237/0\.15\)\]")


def migrate(text: str) -> tuple[str, int]:
    hits = 0

    def style_replace(match: re.Match[str]) -> str:
        nonlocal hits
        key = match.group("key").lower().replace("-", "")
        table = BY_PROPERTY.get(key)
        if not table:
            return match.group(0)
        replacement = table.get(match.group("value").lower()) or table.get(match.group("value"))
        if not replacement:
            return match.group(0)
        hits += 1
        return f"{match.group('key')}: '{replacement}'"

    text = STYLE_ENTRY.sub(style_replace, text)

    for pattern, replacement in (
        (SHADOW_RGB, "shadow-[var(--ring-brand)]"),
        (SHADOW_RGB_DANGER, "shadow-[var(--ring-danger)]"),
        (SHADOW_RGB_VIOLET, "shadow-[var(--ring-brand)]"),
        (SHADOW_INSET, "shadow-[inset_0_0_0_1.5px_var(--brand-line)]"),
    ):
        text, count = pattern.subn(replacement, text)
        hits += count

    return text, hits


def main() -> int:
    check = "--check" in sys.argv
    total_files = 0
    total_hits = 0
    for app in APPS:
        for path in sorted(Path(app).rglob("*.tsx")):
            if "node_modules" in path.parts or ".next" in path.parts:
                continue
            original = path.read_text(encoding="utf-8")
            updated, hits = migrate(original)
            if hits == 0:
                continue
            total_files += 1
            total_hits += hits
            if check:
                print(f"{path}: {hits} inline literals remain")
            else:
                path.write_text(updated, encoding="utf-8")
                print(f"{path}: {hits} inline literals -> tokens")
    print(f"\n{total_hits} literals across {total_files} files")
    return 1 if check and total_hits else 0


if __name__ == "__main__":
    raise SystemExit(main())
