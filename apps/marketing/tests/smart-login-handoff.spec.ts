import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * AUD-08 — الدخول الذكي يسلّم **رمز تسليم** لمرة واحدة، لا رموز الجلسة.
 *
 * كان `smart-login.tsx:61-70` يبني `token=<access>&refresh=<refresh>&tenant=…` ويمرّرها
 * في العنوان. الآن يُصدر `POST /auth/handoff` ويُمرّر `handoff=<code>` وحده.
 */
describe('AUD-08 — marketing smart login handoff', () => {
  it('mints a single-use code instead of interpolating session tokens into the URL', async () => {
    const source = await readFile(new URL('../components/smart-login.tsx', import.meta.url), 'utf8');
    expect(source).toContain('/auth/handoff');
    expect(source).toMatch(/method: 'POST'/);
    expect(source).toContain('handoff=');
    expect(source).not.toMatch(/token=\$\{encodeURIComponent\(session\.accessToken\)/);
    expect(source).not.toMatch(/refresh=\$\{encodeURIComponent\(session\.refreshToken\)/);
  });
});
