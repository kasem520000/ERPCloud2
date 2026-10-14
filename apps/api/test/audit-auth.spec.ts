import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RateLimiterService } from '../src/modules/platform/index.js';

import { createActor, setUserStatusFixture, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-01 — `login()` أصدر جلسةً لمستخدمٍ غير نشط؛ وAUD-07 — تدوير refresh token سباقٌ
 * بين قراءة الصف وتحديثه (TOCTOU).
 *
 * يُثبت هنا، لا في قراءة الكود:
 *   1. حساب `active` يدخل (موجب) — والمنشور في `auth.spec.ts` يُبقى كما هو.
 *   2. `suspended` و`invited` بعضويةٍ **نشطة** وكلمة مرور صحيحة: 401 بلا رموز، تماماً
 *      ككلمة مرور خاطئة (لا سرد لحالات الحسابات).
 *   3. تجديد جلسة مستخدمٍ عُُلّق بعد إصدارها: 401 (سياسة الإبطال المعلنة: رمز الوصول
 *      عديم الحالة وينتهي خلال 15 دقيقة كحدٍّ أقصى؛ التجديد يُرفض فوراً).
 *   4. سياسة إبطال العائلة على إعادة الاستخدام تبقى كما هي (سلوك مقصود لا خطأ).
 *   5. طلبا تجديد متزامنان بالرمز نفسه: بديلٌ صالح **واحد** على الأكثر، ولا بديلان.
 */

const PASSWORD = 'Tr0ubador&Horse9';

describe('AUD-01 / AUD-07 — حالة الحساب وتدوير refresh (API_CONTRACT §1)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp('audit-auth');
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.app.get(RateLimiterService).reset();
  });

  async function actorWithPassword(tenantCode: string, email: string): Promise<Actor> {
    return createActor(ctx, { tenantCode, email, password: PASSWORD });
  }

  const login = (tenantCode: string, email: string, password = PASSWORD) =>
    api(ctx.server, 'post', '/api/v1/auth/login', {
      body: { email, password, tenantCode },
    });

  const refresh = (refreshToken: string) =>
    api(ctx.server, 'post', '/api/v1/auth/refresh', { body: { refreshToken } });

  it('موجب: الحساب النشط يدخل ويحصل على الرمزين', async () => {
    await actorWithPassword('audit-active', 'owner@audit-active.test');

    const response = await login('audit-active', 'owner@audit-active.test');
    expect(response.status).toBe(200);
    const data = response.body.data as { accessToken: string; refreshToken: string };
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');
  });

  it('سالب: حساب suspended لا يصدر له رمز حتى مع عضوية نشطة وكلمة مرور صحيحة', async () => {
    const actor = await actorWithPassword('audit-suspended', 'owner@audit-suspended.test');
    await setUserStatusFixture(ctx.db.ownerUrl, actor.userId, 'suspended');

    const response = await login('audit-suspended', 'owner@audit-suspended.test');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    // نفس رسالة بيانات الاعتماد الخاطئة: لا يتحول المسار إلى أداة سرد.
    expect(response.body.detail).toBe('Invalid e-mail, tenant or password');
    expect((response.body as { data?: unknown }).data).toBeUndefined();
  });

  it('سالب: حساب invited (بكلمة مرور موضوعة) لا يصدر له رمز', async () => {
    const actor = await actorWithPassword('audit-invited', 'owner@audit-invited.test');
    await setUserStatusFixture(ctx.db.ownerUrl, actor.userId, 'invited');

    const response = await login('audit-invited', 'owner@audit-invited.test');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('AUD-01: تعليق الحساب يبطل فوراً التجديد وكل الطلبات المصادق عليها عبر المسار المركزي (AuthGuard)', async () => {
    const actor = await createActor(ctx, {
      tenantCode: 'audit-suspend-immediate',
      email: 'owner@audit-suspend-immediate.test',
      password: PASSWORD,
      isPlatformAdmin: true,
      platformRoles: ['platform_owner'],
    });

    const session = await login('audit-suspend-immediate', 'owner@audit-suspend-immediate.test');
    expect(session.status).toBe(200);
    const { accessToken, refreshToken } = session.body.data as {
      accessToken: string;
      refreshToken: string;
    };

    // قبل التعليق: المسارات تعمل بشكل طبيعي (الهوية، MFA، ولوحة المنصة).
    expect((await api(ctx.server, 'get', '/api/v1/me', { token: accessToken })).status).toBe(200);
    expect((await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: accessToken })).status).toBe(200);
    expect((await api(ctx.server, 'get', '/api/v1/platform/roles', { token: accessToken })).status).toBe(200);

    // تعليق سجل المستخدم نفسه مع بقاء المنشأة والعضوية نشطتين:
    await setUserStatusFixture(ctx.db.ownerUrl, actor.userId, 'suspended');

    // 1) رفض تجديد الجلسة فوراً:
    const rotated = await refresh(refreshToken);
    expect(rotated.status).toBe(401);
    expect(rotated.body.code).toBe('UNAUTHENTICATED');

    // 2) رفض فوري لرمز الوصول القائم على مسار الهوية `/me`:
    const meAfterSuspend = await api(ctx.server, 'get', '/api/v1/me', { token: accessToken });
    expect(meAfterSuspend.status).toBe(401);
    expect(meAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    // 3) رفض فوري على مسارات المصادقة الشخصية التي لا تعتمد على صلاحيات المستأجر (`/auth/mfa`, `/auth/handoff`, `/auth/logout`, `/auth/change-password`):
    const mfaAfterSuspend = await api(ctx.server, 'get', '/api/v1/auth/mfa', { token: accessToken });
    expect(mfaAfterSuspend.status).toBe(401);
    expect(mfaAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    const handoffAfterSuspend = await api(ctx.server, 'post', '/api/v1/auth/handoff', {
      token: accessToken,
      body: {},
    });
    expect(handoffAfterSuspend.status).toBe(401);
    expect(handoffAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    const logoutAfterSuspend = await api(ctx.server, 'post', '/api/v1/auth/logout', {
      token: accessToken,
      body: {},
    });
    expect(logoutAfterSuspend.status).toBe(401);
    expect(logoutAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    const changePwdAfterSuspend = await api(ctx.server, 'post', '/api/v1/auth/change-password', {
      token: accessToken,
      body: { current: PASSWORD, new: 'N3w-Suspended!Pass9' },
    });
    expect(changePwdAfterSuspend.status).toBe(401);
    expect(changePwdAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    // 4) رفض فوري على مسارات لوحة المنصة (`PlatformAdminGuard`) التي لا تعتمد على سياق المستأجر:
    const platformAfterSuspend = await api(ctx.server, 'get', '/api/v1/platform/roles', {
      token: accessToken,
    });
    expect(platformAfterSuspend.status).toBe(401);
    expect(platformAfterSuspend.body.code).toBe('UNAUTHENTICATED');

    // 5) رفض فوري على مسارات موارد المنشأة (`/warehouses`):
    const warehousesAfterSuspend = await api(ctx.server, 'get', '/api/v1/warehouses', {
      token: accessToken,
    });
    expect(warehousesAfterSuspend.status).toBe(401);
    expect(warehousesAfterSuspend.body.code).toBe('UNAUTHENTICATED');
  });

  it('AUD-07: طلبا تجديد متزامنان بالرمز نفسه لا ينتجان بديلين صالحين', async () => {
    await actorWithPassword('audit-race', 'owner@audit-race.test');

    const session = await login('audit-race', 'owner@audit-race.test');
    const { refreshToken } = session.body.data as { refreshToken: string };

    const [first, second] = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, 'one request rotates, the other is refused').toEqual([200, 401]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    const replacement = (winner.body.data as { refreshToken: string }).refreshToken;
    expect(replacement).not.toBe(refreshToken);
    expect(loser.body.code).toBe('UNAUTHENTICATED');

    // سياسة reuse المعلنة: إعادة استخدام رمزٍ دوّرته معاملةٌ أخرى تُلغي العائلة كاملةً،
    // فلا يبقى أي بديل صالح. (multitab refresh المتزامن يخرج بجلسةٍ ملغاة عن قصد.)
    const afterRace = await refresh(replacement);
    expect(afterRace.status, 'the family is revoked wholesale (documented reuse policy)').toBe(401);

    // ورمز الوصول الأصلي يبقى صالحاً حتى انتهاء صلاحيته — الإلغاء يخصّ سلسلة التجديد.
    const accessToken = (winner.body.data as { accessToken: string }).accessToken;
    const me = await api(ctx.server, 'get', '/api/v1/me', { token: accessToken });
    expect(me.status).toBe(200);
  });

  it('AUD-07: إعادة استخدام رمزٍ دوّر سابقاً تُلغي العائلة (موجب/سالب)', async () => {
    await actorWithPassword('audit-reuse', 'owner@audit-reuse.test');

    const session = await login('audit-reuse', 'owner@audit-reuse.test');
    const first = (session.body.data as { refreshToken: string }).refreshToken;

    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const second = (rotated.body.data as { refreshToken: string }).refreshToken;

    const replay = await refresh(first);
    expect(replay.status).toBe(401);
    expect(String(replay.body.detail)).toMatch(/reuse/i);

    const afterReplay = await refresh(second);
    expect(afterReplay.status).toBe(401);
  });
});
