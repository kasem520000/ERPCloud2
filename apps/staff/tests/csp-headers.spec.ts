import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

describe('SH-01 — Content-Security-Policy hardening', () => {
  it('restricts frame-ancestors to self and preview origins (never bare wildcard *) and sets base-uri/object-src', async () => {
    const rules = await nextConfig.headers();
    const csp = rules[0]?.headers.find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/frame-ancestors\s+\*(\s|;|$)/);
    expect(csp).toContain("frame-ancestors 'self'");
  });
});
