import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { portalRoutes } from '../lib/navigation.js';

const appDir = fileURLToPath(new URL('../app', import.meta.url));

describe('customer-portal route groups', () => {
  it('keeps every advertised route under the authenticated /portal prefix', () => {
    expect(portalRoutes.length).toBeGreaterThan(3);
    expect(portalRoutes.every((route) => route.href === '/portal' || route.href.startsWith('/portal/'))).toBe(true);
  });

  /** A link in the sidebar that leads to a 404 is worse than no link, so every route must have a page. */
  it('has a page file behind every advertised route', () => {
    for (const route of portalRoutes) {
      const relative = route.href === '/' ? 'page.tsx' : `${route.href.slice(1)}/page.tsx`;
      expect(existsSync(join(appDir, relative)), route.href).toBe(true);
    }
  });

  /** Marketing pages (home/pricing/contact/verify/onboarding) must not exist on this surface. */
  it('hosts no marketing page', () => {
    for (const relative of ['pricing/page.tsx', 'contact/page.tsx', 'verify/page.tsx', 'onboarding/page.tsx']) {
      expect(existsSync(join(appDir, relative)), relative).toBe(false);
    }
  });
});
