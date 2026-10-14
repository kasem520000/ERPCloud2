import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { ALL_PLATFORM_PERMISSIONS, createActor, setUserStatusFixture, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-08 — نقل الرموز بين التطبيقات.
 *
 * المشكلة المثبتة: `smart-login` كان يضع `access`/`refresh` في query string، وإزالتهما
 * بعد التحميل (`token-bridge`) لا تمنع تسجيل عنوان الطلب الأول في أي طبقة أمامية.
 * الإصلاح: رمز تسليم لمرة واحدة قصير العمر (`?handoff=`) يُستبدل بجلسةٍ جديدة عبر POST.
 *
 * تُثبت هذه المواصفة الخادمية: الرمز لا يحمل الصلاحية بذاته، ولا يُقبل مرتين، ولا بعد
 * انتهائه، ولا لمستخدمٍ موقوف، وأن استبدالين متزامنين لا ينجحان معاً، وأن جلسةَ التسليم
 * تُنهى بالخروج كأي جلسة. (حراسة الواجهات نفسها — لا `?token=` في العنوان — في مجموعات
 * اختبار التطبيقات الثلاثة: staff · customer-portal · marketing.)
 */

const PASSWORD = 'Tr0ubador&Horse9';

describe('AUD-08 — رمز تسليم الجلسة لمرة واحدة', () => {
  let ctx: TestApp;
  let actor: Actor;

  const post = (path: string, body: Record<string, unknown> = {}, token?: string) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token, body });
  const get = (path: string, token: string) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  const handoff = async (token = actor.token) => {
    const response = await post('/auth/handoff', {}, token);
    expect(response.status).toBe(201);
    return String((response.body.data as { code: string }).code);
  };

  const rowsFor = (codeHashLike: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT id, code_hash, redeemed_at, expires_at, tenant_code FROM session_handoff_codes WHERE code_hash = $1`,
        [codeHashLike],
      );
      return result.rows as Array<{ id: string; code_hash: string; redeemed_at: Date | null; expires_at: Date }>;
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-handoff');
    // كلمة مرور ⇒ `users.status = 'active'`: مسار التسليم يفحص الحالة الحقيقية (وإلا
    // فالفاعل المولَّد اختبارياً يبقى `invited` ويرفضه الفحص — وهو السلوك الصحيح).
    actor = await createActor(ctx, {
      tenantCode: 'audit-handoff',
      email: 'owner@audit-handoff.test',
      password: PASSWORD,
      permissions: [...ALL_PLATFORM_PERMISSIONS],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('موجبة: الرمز يُستبدل بجلسةٍ صالحة تستدعي /me بلا رمزٍ مسبق', async () => {
    // الرمز منفصل تماماً عن رموز الجلسة: لا يشبه access ولا refresh ولا يُستعمل للاستدعاء.
    const code = await handoff();
    expect(code).toMatch(/^hop_/);
    expect(code).not.toContain('.');

    const unredeemed = await get('/me', code);
    expect(unredeemed.status, 'the handoff code is not an access token').toBe(401);

    const redeemed = await post('/auth/handoff/redeem', { code });
    expect(redeemed.status).toBe(200);
    const session = redeemed.body.data as { accessToken: string; refreshToken: string; memberships: Array<{ tenantCode: string }> };
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.memberships[0]!.tenantCode).toBe('audit-handoff');

    const me = await get('/me', session.accessToken);
    expect(me.status, 'the redeemed session must be a real session').toBe(200);

    // والرمز استُهلك فعلاً في المخزن (لا مجرد رفضٍ في الذاكرة).
    const stored = await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT redeemed_at FROM session_handoff_codes ORDER BY created_at DESC LIMIT 1`);
      return (result.rows[0] as { redeemed_at: Date | null } | undefined)?.redeemed_at ?? null;
    });
    expect(stored).not.toBeNull();
  });

  it('الرمز لا يُقبل مرتين — replay يفشل بـ401 HANDOFF_CODE_INVALID', async () => {
    const code = await handoff();

    const first = await post('/auth/handoff/redeem', { code });
    expect(first.status).toBe(200);

    const replay = await post('/auth/handoff/redeem', { code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('HANDOFF_CODE_INVALID');

    // جلسة الاستبدال الأول بقيت صالحة: إعادة المحاولة لم تُبطلها.
    const session = first.body.data as { accessToken: string };
    expect((await get('/me', session.accessToken)).status).toBe(200);
  });

  it('الرمز المنتهي يُرفض — والخادم لا يقبل عمراً أطول لمجرد وجود صفّ', async () => {
    const code = await handoff();
    expect(await rowsFor(createHash('sha256').update(code).digest('hex'))).toHaveLength(1);

    // حقن خطأ: نُرجع انتهاء الصفّ إلى الماضي كما لو مرّت دقيقة كاملة.
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`UPDATE session_handoff_codes SET expires_at = now() - interval '1 second' WHERE redeemed_at IS NULL`);
    });

    const expired = await post('/auth/handoff/redeem', { code });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('HANDOFF_CODE_INVALID');
  });

  it('استبدالان متزامنان لرمزٍ واحد: واحدٌ ينجح والآخر يُرفض — لا جلستان من رمز', async () => {
    const code = await handoff();

    const [a, b] = await Promise.all([
      post('/auth/handoff/redeem', { code }),
      post('/auth/handoff/redeem', { code }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const winner = a.status === 200 ? a : b;
    const session = winner.body.data as { accessToken: string };
    expect((await get('/me', session.accessToken)).status).toBe(200);
  });

  it('جلسة التسليم قابلة للإنهاء: logout يُبطل رمز التجديد الصادر عن الاستبدال', async () => {
    const code = await handoff();
    const redeemed = await post('/auth/handoff/redeem', { code });
    expect(redeemed.status).toBe(200);
    const session = redeemed.body.data as { accessToken: string; refreshToken: string };

    const logout = await post('/auth/logout', {}, session.accessToken);
    expect(logout.status).toBe(204);

    const refresh = await post('/auth/refresh', { refreshToken: session.refreshToken });
    expect(refresh.status, 'logout must revoke the handoff-issued refresh token').toBe(401);
  });

  it('رمز مجهول أو مشوّه يُرفض بلا تفريق في السبب', async () => {
    for (const candidate of ['hop_missingmissingmissingmissingmissingmissing', 'not-a-code', '']) {
      const response = await post('/auth/handoff/redeem', { code: candidate });
      expect([400, 401]).toContain(response.status);
      if (response.status === 401) expect(response.body.code).toBe('HANDOFF_CODE_INVALID');
    }
  });

  it('مستخدم أُوقف بعد الإصدار لا يستبدل الرمز — الإصدار ليس وعداً بالجلسة', async () => {
    const code = await handoff();
    await setUserStatusFixture(ctx.db.ownerUrl, actor.userId, 'suspended');
    try {
      const response = await post('/auth/handoff/redeem', { code });
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('HANDOFF_CODE_INVALID');
    } finally {
      await setUserStatusFixture(ctx.db.ownerUrl, actor.userId, 'active');
    }
  });

});
