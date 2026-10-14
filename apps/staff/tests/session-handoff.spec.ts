import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

/**
 * AUD-08 — جسر الدخول لا يمرّر رموز الجلسة في العنوان.
 *
 * ما كان: `?token=<access>&refresh=<refresh>&tenant=…` ثم حذفها بعد التحميل — والعنوان
 * يكون قد سُجّل في طبقة أمامية. ما نُثبته هنا نصّياً (لا متصفح في هذه المجموعة):
 * الجسر الحالي يقرأ `?handoff=` وحده، ويستبدله بـPOST، وينظّف العنوان **قبل** الطلب.
 */
describe('AUD-08 — staff session handoff', () => {
  it('the bridge redeems a single-use code over POST — never a token from the query', async () => {
    const bridge = await read('components/token-bridge.tsx');
    expect(bridge).toContain("searchParams.get('handoff')");
    expect(bridge).toContain('/auth/handoff/redeem');
    expect(bridge).not.toContain("searchParams.get('token')");
    expect(bridge).not.toContain("searchParams.get('refresh')");

    // التنظيف يسبق طلب الاستبدال: لا يبقى الرمز في المحفوظات حتى لو فشل الطلب.
    const stripAt = bridge.indexOf('searchParams.delete');
    const fetchAt = bridge.indexOf('handoff/redeem');
    expect(stripAt).toBeGreaterThan(-1);
    expect(stripAt).toBeLessThan(fetchAt);
  });

  it('the session client never builds a token-bearing URL', async () => {
    const api = await read('lib/api.ts');
    expect(api).not.toMatch(/location\.assign\([^)]*accessToken/);
    expect(api).not.toMatch(/\?token=/);
  });
});
