/**
 * Cross-surface links.
 *
 * Every surface deploys on its own domain, so one surface must never hard-code
 * another surface's path as a same-origin link. Bases come from the environment:
 *
 * - NEXT_PUBLIC_STAFF_URL     → tenant admin + ERP (app.*)
 * - NEXT_PUBLIC_PORTAL_URL    → customer self-service portal (portal.*)
 * - NEXT_PUBLIC_PLATFORM_URL  → platform console (platform.*)
 *
 * An empty base means "same origin" — the split-domain deployment sets all three.
 */
export type Surface = 'staff' | 'portal' | 'platform';

const BASES: Record<Surface, string> = {
  staff: process.env.NEXT_PUBLIC_STAFF_URL ?? '',
  portal: process.env.NEXT_PUBLIC_PORTAL_URL ?? '',
  platform: process.env.NEXT_PUBLIC_PLATFORM_URL ?? '',
};

export function surfaceHref(surface: Surface, path: string): string {
  const base = (BASES[surface] ?? '').replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
