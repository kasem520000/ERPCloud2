import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { TEST_COMPAT_KEY_PEPPER } from '../src/modules/compat/compat.service.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-09 — gateway التوافق: حالة محلية ومحدّد معدّل معطّل.
 *
 * ما كان وما يُثبته هذا الملف:
 *   • الجلسات كانت في `Map` داخل العملية: تضيع بإعادة التشغيل ولا يراها replica آخر.
 *     الآن صفٌّ في `compat_sessions`، ويُقبل رمزٌ **لم تصدره هذه العملية** (كُتب مباشرةً
 *     في المخزن) — أي أن مصدر الحقيقة هو القاعدة لا الذاكرة.
 *   • `rateLimit()` كان `return true` دائماً. الآن عدّادٌ في صفّ الجهاز نفسه، وتجاوز
 *     السقف يعيد 429 — والحدّ يستمر عبر replicas لأنه ليس في ذاكرة العملية.
 *   • الـpepper كان له افتراضي منشور؛ لم يعد له افتراضي خارج الاختبارات.
 */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

describe('AUD-09 — جلسات التوافق ومحدد المعدل', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let deviceId = '';
  let apiKey = '';
  let token = '';

  const tenantId = () => actor.tenantId;

  const post = (path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}, auth = true) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: auth ? actor.token : undefined, body, headers });
  const get = (path: string, headers: Record<string, string> = {}, auth = false) =>
    api(ctx.server, 'get', `/api/v1${path}`, { token: auth ? actor.token : undefined, headers });

  const deviceHeaders = (target = tenantId(), bearer = token) => ({ 'x-tenant-id': target, 'x-compat-token': bearer });

  const sessionRows = () =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT id, token_hash, expires_at, device_id FROM compat_sessions WHERE tenant_id = $1`,
        [tenantId()],
      );
      return result.rows as Array<{ id: string; token_hash: string; expires_at: Date; device_id: string }>;
    });

  const insertSession = (raw: string, expiresAt: Date) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(
        `INSERT INTO compat_sessions (id, tenant_id, device_id, token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [tenantId(), deviceId, hashToken(raw), expiresAt],
      );
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-compat');
    actor = await createActor(ctx, {
      tenantCode: 'audit-compat',
      email: 'owner@audit-compat.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'compat.manage', 'organization.branch.manage'],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = String((branch.body.data as { id: string }).id);

    const device = await post('/compat/devices', { name: 'جهاز الكاشير القديم', branchId });
    expect(device.status).toBe(201);
    const created = device.body.data as { id: string; apiKey: string };
    deviceId = created.id;
    apiKey = created.apiKey;
    expect(apiKey).toMatch(/^ck_/);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('موجبة: مصادقة الجهاز ثم جلب البيانات بالرمز', async () => {
    const auth = await post('/compat/auth/device', { tenantId: tenantId(), apiKey }, {}, false);
    expect(auth.status).toBe(201);
    token = String((auth.body.data as { accessToken: string }).accessToken);
    expect(token).toMatch(/^compat_/);

    const master = await get('/compat/master/tax-groups', deviceHeaders());
    expect(master.status).toBe(200);
  });

  it('الجلسة تُخزَّن في القاعدة كبصمة — لا رمزاً، ولا في ذاكرة العملية', async () => {
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    const ttlMs = new Date(rows[0]!.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('جلسةٌ كُتبت خارج هذه العملية تُقبل — المخزن مشترك لا ذاكرة', async () => {
    const foreign = `compat_${'f'.repeat(40)}`;
    await insertSession(foreign, new Date(Date.now() + 10 * 60_000));

    const master = await get('/compat/master/tax-groups', deviceHeaders(tenantId(), foreign));
    expect(master.status, 'a session minted by another replica must work here').toBe(200);
  });

  it('الجلسة المنتهية تُرفض بـ401', async () => {
    const expired = `compat_${'e'.repeat(40)}`;
    await insertSession(expired, new Date(Date.now() - 1_000));

    const master = await get('/compat/master/tax-groups', deviceHeaders(tenantId(), expired));
    expect(master.status).toBe(401);
    expect(master.body.code).toBe('UNAUTHENTICATED');
  });

  it('سرّ منشور غير مقبول: الفلفل الافتراضي غير قابل للنشر', () => {
    expect(TEST_COMPAT_KEY_PEPPER).not.toBe('dev-compat-pepper-change-me');
    expect(TEST_COMPAT_KEY_PEPPER).toContain('test-only');
  });

  it('تجاوز السقف يعيد 429 — والعدّاد يستمر بلا حالةٍ في الذاكرة', async () => {
    // نُصفّر النافذة أولاً: الطلبات السابقة في هذا الملف استهلكت من العدّاد، والاختبار
    // يقيس نافذةً نظيفة — السقف 120/دقيقة لكل جهاز.
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`UPDATE compat_devices SET rate_window_started_at = NULL, rate_window_count = '0' WHERE id = $1`, [deviceId]);
    });

    // 125 طلباً في نافذةٍ واحدة: 120 تنجح و5 تُرفض. تُرسل متتابعةً لا متزامنة — 125
    // اتصالاً في لحظةٍ واحدة يُغرق مأخذ الاختبار (ECONNRESET) ولا علاقة لذلك بالحدّ.
    const responses = [];
    for (let index = 0; index < 125; index += 1) {
      responses.push(await get('/compat/master/tax-groups', deviceHeaders()));
    }
    const limited = responses.filter((response) => response.status === 429);
    const allowed = responses.filter((response) => response.status === 200);

    expect(allowed.length).toBe(120);
    expect(limited.length).toBe(5);
    expect(limited[0]!.body.code).toBe('RATE_LIMITED');

    // العدّاد في صفّ الجهاز نفسه: مرئيٌّ في القاعدة بعد الطلبات.
    const counter = await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT rate_window_count::int AS count FROM compat_devices WHERE id = $1`, [deviceId]);
      return (result.rows[0] as { count: number }).count;
    });
    expect(counter).toBe(125);
  }, 120_000);

  it('إبطال الجهاز يُبطل كل جلساته — ويحذف صفوفها', async () => {
    const revoke = await api(ctx.server, 'patch', `/api/v1/compat/devices/${deviceId}/revoke`, { token: actor.token });
    expect([200, 201, 204]).toContain(revoke.status);

    const master = await get('/compat/master/tax-groups', deviceHeaders());
    expect(master.status).toBe(401);

    expect(await sessionRows()).toHaveLength(0);

    const auth = await post('/compat/auth/device', { tenantId: tenantId(), apiKey }, {}, false);
    expect(auth.status).toBe(401);
  });
});
