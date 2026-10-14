import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * R11 — 🧵 «أنواع التفصيل»: آخر شاشةٍ في وحدة التفصيل كانت بلا سطح.
 *
 * ولها في الديسكتوب مصدرٌ بلا نافذة: `Form_WPF/frmOrderDetails.xaml.cs` L60 يقرأ
 * `SELECT TypeID, TypeName, DefaultPrice FROM TailoringTypes WHERE IsActive=1 ORDER BY
 * TypeName` ليملأ «نوع التفصيل:» في بطاقة الطلب (L177)، وL359 يكتب في `TailoringTypes`
 * من النافذة نفسها. فالنوع في الديسكتوب لا يُدار إلا من داخل طلب — والسحابة تعطيه
 * بطاقته المستقلّة (وهو أصل «نوع التفصيل» وسعرُه الافتراضي الذي يُقترح في الطلب).
 *
 * وهذه هي القواعد التي تُثبَّت هنا: الاسم إلزاميّ («الرجاء إدخال نوع التفصيل»)،
 * والاسم والرمز لا يتكرّران (409)، والحذف إخفاءٌ لا محو (`IsActive=0` في الديسكتوب)،
 * ومنشأةٌ أخرى لا ترى ولا تعدّل.
 */
describe('🧵 أنواع التفصيل — ShirtKind/TypeName من frmOrderDetails', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;
  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  beforeAll(async () => {
    ctx = await createTestApp('tailoring-types');
    const permissions = [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'tailoring.view', 'tailoring.manage'];
    actor = await createActor(ctx, { tenantCode: 'tlr-types', email: 'owner@tlr-types.test', permissions });
    stranger = await createActor(ctx, { tenantCode: 'tlr-types-2', email: 'owner@tlr-types-2.test', permissions });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('1. الإنشاء: الاسم إلزاميّ، والرمز والسعر اختياريّان', async () => {
    const created = await post('/tailoring/types', { nameAr: 'ثوب سعودي', code: 'THB', defaultPrice: '350' });
    expect(created.status).toBe(201);
    const type = data(created.body) as { nameAr: string; code: string; defaultPrice: string; active: boolean };
    expect(type.nameAr).toBe('ثوب سعودي');
    expect(type.code).toBe('THB');
    expect(type.defaultPrice).toBe('350.0000');
    expect(type.active).toBe(true);

    const bare = await post('/tailoring/types', { nameAr: 'بنطال' });
    expect(bare.status).toBe(201);
    // بلا سعرٍ مذكور: الصفر — والنوع يبقى صالحاً («نوع التفصيل» قد يُسعَّر في الطلب نفسه).
    expect((data(bare.body) as { defaultPrice: string }).defaultPrice).toBe('0.0000');
    expect((data(bare.body) as { code: string | null }).code).toBeNull();
  });

  it('2. الرفض بنصّه: «الرجاء إدخال نوع التفصيل» — لا 500 من قيدٍ في القاعدة', async () => {
    const blank = await post('/tailoring/types', { nameAr: '   ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('TAILORING_TYPE_NAME_REQUIRED');
    expect(blank.body.detail).toBe('الرجاء إدخال نوع التفصيل');
  });

  it('3. التكرار: الاسم والرمز صراعٌ معلن (409) لا خطأ خادم', async () => {
    const sameName = await post('/tailoring/types', { nameAr: 'ثوب سعودي' });
    expect(sameName.status).toBe(409);
    expect(sameName.body.code).toBe('TAILORING_TYPE_NAME_TAKEN');
    expect(sameName.body.detail).toBe('نوع التفصيل موجود مسبقاً');

    const sameCode = await post('/tailoring/types', { nameAr: 'ثوب مغربي', code: 'THB' });
    expect(sameCode.status).toBe(409);
    expect(sameCode.body.code).toBe('TAILORING_TYPE_CODE_TAKEN');
    expect(sameCode.body.detail).toBe('رمز نوع التفصيل موجود مسبقاً');
  });

  it('4. التعديل: الاسم والسعر والحالة — والقائمة تُقرأ بـ`ORDER BY TypeName` كالنافذة', async () => {
    const created = await post('/tailoring/types', { nameAr: 'جلابية', code: 'GLB', defaultPrice: '200' });
    const id = data(created.body).id as string;

    const renamed = await patch(`/tailoring/types/${id}`, { nameAr: 'جلابية صعيدي', defaultPrice: '215.5' });
    expect(renamed.status).toBe(200);
    const type = data(renamed.body) as { nameAr: string; defaultPrice: string };
    expect(type.nameAr).toBe('جلابية صعيدي');
    expect(type.defaultPrice).toBe('215.5000');

    const listed = rowsOf((await get('/tailoring/types')).body);
    const names = listed.map((row) => row.nameAr as string);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, 'ar')));

    const blank = await patch(`/tailoring/types/${id}`, { nameAr: '  ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('TAILORING_TYPE_NAME_REQUIRED');
  });

  it('5. الإخفاء: «🗑️ حذف» إخفاءٌ لا محو (‏`IsActive=0`)، والمُخفى لا يعود في القائمة', async () => {
    const created = await post('/tailoring/types', { nameAr: 'عباية', code: 'ABY', defaultPrice: '480' });
    const id = data(created.body).id as string;

    // التعطيل وحده يُخفيه من القراءة الافتراضية (الافتراضي `activeOnly`).
    const deactivated = await patch(`/tailoring/types/${id}`, { active: false });
    expect(deactivated.status).toBe(200);
    expect((data(deactivated.body) as { active: boolean }).active).toBe(false);
    expect(rowsOf((await get('/tailoring/types')).body).some((row) => row.id === id)).toBe(false);
    expect(rowsOf((await get('/tailoring/types?activeOnly=0')).body).some((row) => row.id === id)).toBe(true);

    const removed = await del(`/tailoring/types/${id}`);
    expect(removed.status).toBe(200);
    expect(rowsOf((await get('/tailoring/types?activeOnly=0')).body).some((row) => row.id === id)).toBe(false);

    const again = await del(`/tailoring/types/${id}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('TAILORING_TYPE_NOT_FOUND');
  });

  it('6. العزل: أنواع منشأةٍ أخرى لا تُرى ولا تُعدَّل', async () => {
    const mine = await post('/tailoring/types', { nameAr: 'زي مدرسي', code: 'SCH' });
    const id = data(mine.body).id as string;

    const strangerList = await api(ctx.server, 'get', '/api/v1/tailoring/types', { token: stranger.token });
    expect(strangerList.status).toBe(200);
    expect(rowsOf(strangerList.body)).toHaveLength(0);

    const strangerPatch = await api(ctx.server, 'patch', `/api/v1/tailoring/types/${id}`, { token: stranger.token, body: { nameAr: 'مسروق' } });
    expect(strangerPatch.status).toBe(404);
    expect(strangerPatch.body.code).toBe('TAILORING_TYPE_NOT_FOUND');

    const strangerDelete = await api(ctx.server, 'delete', `/api/v1/tailoring/types/${id}`, { token: stranger.token });
    expect(strangerDelete.status).toBe(404);

    // ونوعنا ما زال قائماً بعد كل ذلك.
    expect(rowsOf((await get('/tailoring/types')).body).some((row) => row.id === id)).toBe(true);
  });
});
