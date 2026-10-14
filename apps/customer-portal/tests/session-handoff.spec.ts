import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * AUD-08 — بوابة العميل تستقبل رمز تسليمٍ لمرة واحدة، لا رمز جلسة في العنوان.
 */
describe('AUD-08 — customer-portal session handoff', () => {
  it('the bridge redeems ?handoff= over POST and strips it first', async () => {
    const bridge = await readFile(new URL('../components/token-bridge.tsx', import.meta.url), 'utf8');
    expect(bridge).toContain("searchParams.get('handoff')");
    expect(bridge).toContain('/auth/handoff/redeem');
    expect(bridge).not.toContain("searchParams.get('token')");
    expect(bridge.indexOf('searchParams.delete')).toBeLessThan(bridge.indexOf('handoff/redeem'));
  });

  it('the portal client never puts a token in a URL', async () => {
    const api = await readFile(new URL('../lib/api.ts', import.meta.url), 'utf8');
    expect(api).not.toMatch(/\?token=/);
    expect(api).not.toMatch(/location\.assign\([^)]*token/i);
  });
});
