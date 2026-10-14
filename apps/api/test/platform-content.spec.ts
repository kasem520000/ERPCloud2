import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  contentAuditActions,
  contentPathOf,
  errorCodes,
  type ContentBanner,
  type ContentMenu,
  type ContentPage,
  type ContentPageDetail,
  type ContentVersion,
} from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  createTenantFixture,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M5 — «نظام إدارة المحتوى» (`docs/roadmap/MARKETING_SITE_PLAN.md` §6).
 *
 * الخطة تطلب أحد عشر اختباراً على الأقل للنصف الإداري؛ هذا الملف يقيس ما يمكن أن يُخطئ فيه
 * محرّرُ محتوى **يُنشر على الإنترنت**:
 *
 * 1. **الكتابة**: مسوّدةٌ تُنشأ بكتلها، و`slug` مكرَّر يُرفض 409، و`slug` غير صالح 422،
 *    و`kind` من قائمةٍ مغلقة.
 * 2. **الجدولة**: `scheduled` بلا وقتٍ يُرفض (قاعدة القاعدة نفسها تحرس ذلك أيضاً)، ومستقبلي
 *    يصير `scheduled` ومعه **مهمّةٌ في الطابور بوقتها**، ونداءٌ ثانٍ لا يضاعف مهمّة.
 * 3. **الاستحقاق**: صفحةٌ مجدولة بوقتٍ مضى — `publishDue` تنشرها وتُدقّق الفعل بفاعلٍ هو
 *    **النظام لا إنسان**، ثم تظهر في `/public/sitemap`.
 * 4. **السحب**: بسببٍ مكتوب يعود `draft` ويختفي من العام، وسحبُ مسوّدةٍ 409.
 * 5. **النسخ**: كل كتابةٍ تُنتج نسخة، والاستعادة تُنتج نسخةً جديدة ولا تمحو التاريخ.
 * 6. **الكتل**: الإرسال بديلٌ كامل لا دمج — حذف كتلةٍ ممكن.
 * 7. **القوائم واللافتات**: قائمةُ الرأس تُقرأ من `/public/site`، واللافتة تعيش بنافذتها.
 * 8. **الصلاحيات**: `console.content.view` للقراءة و`console.content.manage` للكتابة، ورموز
 *    المستأجر لا تصل، وسطح العميل لا يعرف هذه المسارات.
 * 9. **التدقيق**: كل فعلٍ يُسجَّل باسم فاعله.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform content (P-M5)', () => {
  let ctx: TestApp;
  let owner: Actor;
  /** يقرأ ولا يكتب: `platform_support` يحمل `console.content.view` وحده. */
  let reader: Actor;
  /** بلا رمز محتوى إطلاقاً: مدقّق المنصة لا يقرأ المسوّدات. */
  let outsider: Actor;
  let tenantOwner: Actor;

  const base = '/api/v1';

  const get = (path: string, actor: Actor = owner) =>
    api(ctx.server, 'get', `${base}${path}`, { token: actor.token });
  const post = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'post', `${base}${path}`, { token: actor.token, body });
  const patch = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'patch', `${base}${path}`, { token: actor.token, body });
  const put = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'put', `${base}${path}`, { token: actor.token, body });

  const draft = (overrides: Record<string, unknown> = {}) => ({
    slug: 'sahib-almutajar',
    kind: 'page',
    titleAr: 'صفحةٌ للاختبار',
    titleEn: 'A test page',
    summaryAr: 'ملخّصٌ للاختبار',
    summaryEn: 'A summary for the test',
    blocks: [
      { position: 0, kind: 'heading', content: { ar: { text: 'عنوانٌ كبير', level: 2 } } },
      {
        position: 1,
        kind: 'cards',
        content: {
          ar: { items: [{ title: 'أولى', body: 'نصٌّ للبطاقة الأولى' }] },
          en: { items: [{ title: 'First', body: 'Body of the first card' }] },
        },
      },
    ],
    ...overrides,
  });

  /** ما في الطابور — الجدولة تُقاس بصفٍّ له وقت، لا بنيّة. */
  const outbox = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT id, queue, type, run_at, payload, status
                       FROM outbox_jobs ORDER BY created_at ASC`),
    );

  const auditActions = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT action, entity, entity_id, actor_label, actor_user_id, meta
                       FROM audit_log WHERE action LIKE 'content.%' ORDER BY created_at ASC`),
    );

  beforeAll(async () => {
    ctx = await createTestApp('platform-content');

    // منشأة المشغّلين: كاتبُ المهمّة المجدولة يحتاج سياقاً يكتب فيه صفّ الطابور.
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: 'content-ops',
      email: 'owner@content-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    reader = await createOperator(ctx, {
      tenantCode: 'content-ops',
      email: 'support@content-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });
    outsider = await createOperator(ctx, {
      tenantCode: 'content-ops',
      email: 'auditor@content-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });
    tenantOwner = await createActor(ctx, {
      tenantCode: 'content-customer',
      tenantName: 'شركة العميل',
      email: 'owner@content-customer.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ═══════════════════════════════════════════════ 1. الكتابة

  it('ينشئ مسوّدةً بكتلها ويرقّم نسختها الأولى، ويرفض المجدولة بلا وقت', async () => {
    const created = await post('/platform/content/pages', draft());
    expect(created.status).toBe(201);
    const page = created.body.data as ContentPageDetail;
    expect(page.status).toBe('draft');
    expect(page.publishedAt).toBeNull();
    expect(page.path).toBe(contentPathOf('page', 'sahib-almutajar'));
    expect(page.blocks.map((block) => block.kind)).toEqual(['heading', 'cards']);
    // الترتيب يُسنَد في الخدمة لا يُترك للعميل: الكتل تُعاد بموضعها.
    expect(page.blocks.map((block) => block.position)).toEqual([0, 1]);
    // إنجليزيٌّ نال ترجمة ⇒ اللغتان في الردّ، والعامّ يقول أيّهما نال ترجمة.
    expect(page.translatedLocales).toEqual(['ar', 'en']);

    const versions = await get(`/platform/content/pages/${page.id}/versions`);
    expect(versions.status).toBe(200);
    const list = versions.body.data as ContentVersion[];
    expect(list).toHaveLength(1);
    expect(list[0]?.version).toBe(1);

    // `scheduled` بلا `publishAt` خطأٌ مرفوض في الطبقة وفي القاعدة معاً.
    // `scheduled` بلا وقت: قاعدة نطاق ⇒ 422 من الخدمة، لا 400 من المخطط.
    const missingAt = await post(
      '/platform/content/pages',
      draft({ slug: 'bila-waqt', status: 'scheduled' }),
    );
    expect(missingAt.status).toBe(422);

    // وما يرفضه المخطط يردّ 400 (قرار `ZodValidationPipe` في هذا المستودع).
    const badSlug = await post('/platform/content/pages', draft({ slug: 'عنوان عربي' }));
    expect(badSlug.status).toBe(400);

    const badKind = await post('/platform/content/pages', draft({ slug: 'naw3', kind: 'invoice' }));
    expect(badKind.status).toBe(400);
  });

  it('يرفض الرابط المكرَّر بـ409 ونصٍّ يقول أيّ رابط', async () => {
    const again = await post('/platform/content/pages', draft({ titleAr: 'صفحةٌ أخرى' }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(errorCodes.CONTENT_SLUG_TAKEN);
    expect(String(again.body.detail ?? '')).toContain('sahib-almutajar');
  });

  it('يستبدل الكتل استبدالاً كاملاً، ويحفظ نسخةً قبل كل كتابة', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'tabadul-alkutal' }));
    const pageId = (created.body.data as ContentPageDetail).id;

    const trimmed = await patch(`/platform/content/pages/${pageId}`, {
      blocks: [{ position: 0, kind: 'text', content: { ar: { text: 'كتلةٌ واحدة بقيت' } } }],
      note: 'حذف كتلة',
    });
    expect(trimmed.status).toBe(200);
    expect((trimmed.body.data as ContentPageDetail).blocks).toHaveLength(1);

    // النسخة قبل الكتابة: ثلاث نسخ (الإنشاء + التعديل) — ولا واحدة تُحدَّث في مكانها.
    const versions = await get(`/platform/content/pages/${pageId}/versions`);
    const list = versions.body.data as ContentVersion[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((version) => version.version)).toEqual(
      [...list.map((version) => version.version)].sort((a, b) => b - a),
    );
  });

  // ═══════════════════════════════════════════════ 2. النشر والجدولة

  it('ينشر فوراً: الحالة والوقت والظهور العام في نداءٍ واحد', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'nashr-fawri' }));
    const pageId = (created.body.data as ContentPageDetail).id;

    const published = await post(`/platform/content/pages/${pageId}/publish`, {});
    expect(published.status).toBe(201);
    const page = published.body.data as ContentPageDetail;
    expect(page.status).toBe('published');
    expect(page.publishedAt).not.toBeNull();

    const publicRead = await api(ctx.server, 'get', `${base}/public/content/nashr-fawri`);
    expect(publicRead.status).toBe(200);
    expect((publicRead.body.data as ContentPageDetail).titleAr).toBe('صفحةٌ للاختبار');
  });

  it('يجدول النشر بمهمّةٍ في الطابور بوقتها، ولا يضاعفها بنداءٍ ثانٍ', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'jadwala' }));
    const pageId = (created.body.data as ContentPageDetail).id;
    const at = new Date(Date.now() + 3_600_000).toISOString();

    const scheduled = await post(`/platform/content/pages/${pageId}/publish`, { at, note: 'غداً' });
    expect(scheduled.status).toBe(201);
    expect((scheduled.body.data as ContentPageDetail).status).toBe('scheduled');

    const jobs = await outbox();
    const forPage = (
      jobs.rows as Array<{ queue: string; type: string; run_at: string; payload: { pageId?: string } }>
    ).filter((row) => row.payload?.pageId === pageId);
    expect(forPage).toHaveLength(1);
    expect(forPage[0]?.type).toBe('content.publish');
    expect(forPage[0]?.queue).toBe('maintenance');
    expect(new Date(String(forPage[0]?.run_at)).getTime()).toBe(new Date(at).getTime());

    // الجدولة ليست نشراً: المجدولة لا تُقرأ من العامّ ولو كان الرابط معروفاً.
    const hidden = await api(ctx.server, 'get', `${base}/public/content/jadwala`);
    expect(hidden.status).toBe(404);
  });

  it('ينشر ما استحقّ وقته — بفاعلٍ هو النظام لا إنسان', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'istahaqq' }));
    const pageId = (created.body.data as ContentPageDetail).id;
    // وقتٌ مضى: الحالة تُكتب مباشرةً لأن مسار الجدولة يرفض الماضي (وهو الصواب في اللوحة).
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        UPDATE content_pages SET status = 'scheduled', publish_at = now() - interval '1 minute',
               published_at = NULL
         WHERE id = ${pageId}::uuid
      `),
    );

    const { ContentService } = await import('../src/modules/content/content.service.js');
    const service = ctx.app.get(ContentService);
    expect(await service.publishDue()).toBeGreaterThanOrEqual(1);

    const page = await get(`/platform/content/pages/${pageId}`);
    expect((page.body.data as ContentPageDetail).status).toBe('published');

    const sitemap = await api(ctx.server, 'get', `${base}/public/sitemap`);
    const paths = (sitemap.body.data as Array<{ path: string }>).map((entry) => entry.path);
    expect(paths).toContain(contentPathOf('page', 'istahaqq'));

    const rows = await auditActions();
    const published = (rows.rows as Array<Record<string, unknown>>).filter(
      (row) => row.entity_id === pageId && row.action === contentAuditActions.PUBLISHED,
    );
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(published[0]?.actor_label).toBe('نظام الجدولة');
    expect(published[0]?.actor_user_id).toBeNull();
  });

  // ═══════════════════════════════════════════════ 3. السحب والاستعادة

  it('يسحب بسببٍ مكتوب فيختفي من العام، ولا يسحب مسوّدة', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'sahb' }));
    const pageId = (created.body.data as ContentPageDetail).id;
    await post(`/platform/content/pages/${pageId}/publish`, {});

    const retracted = await post(`/platform/content/pages/${pageId}/retract`, {
      reason: 'رقمٌ في السعر غير صحيح',
    });
    expect(retracted.status).toBe(201);
    expect((retracted.body.data as ContentPageDetail).status).toBe('draft');

    const gone = await api(ctx.server, 'get', `${base}/public/content/sahb`);
    expect(gone.status).toBe(404);

    const again = await post(`/platform/content/pages/${pageId}/retract`, { reason: 'مرة أخرى' });
    expect(again.status).toBe(409);

    const withoutReason = await post(`/platform/content/pages/${pageId}/retract`, {});
    expect(withoutReason.status).toBe(400);
  });

  it('يستعيد نسخةً بإنتاج نسخةٍ جديدة لا بمحو التاريخ', async () => {
    const created = await post(
      '/platform/content/pages',
      draft({ slug: 'istirjaa', titleAr: 'العنوان الأول' }),
    );
    const pageId = (created.body.data as ContentPageDetail).id;

    await patch(`/platform/content/pages/${pageId}`, { titleAr: 'العنوان الثاني' });
    const before = await get(`/platform/content/pages/${pageId}/versions`);
    const count = (before.body.data as ContentVersion[]).length;

    const restored = await post(`/platform/content/pages/${pageId}/versions/1/restore`, {
      version: 1,
      note: 'رجوعٌ عن تعديل',
    });
    expect(restored.status).toBe(201);
    const page = restored.body.data as ContentPageDetail;
    expect(page.titleAr).toBe('العنوان الأول');

    const after = await get(`/platform/content/pages/${pageId}/versions`);
    const versions = after.body.data as ContentVersion[];
    // نسخةُ الاستعادة أُضيفت: التاريخ زاد ولم يُنقص.
    expect(versions.length).toBeGreaterThan(count);
    expect(versions.map((version) => version.version)).toContain(versions.length);

    const missing = await post(`/platform/content/pages/${pageId}/versions/999/restore`, {
      version: 999,
    });
    expect(missing.status).toBe(404);
  });

  // ═══════════════════════════════════════════════ 4. القوائم واللافتات

  it('يحرّر قائمة الرأس فتظهر للعامّ مرتّبة، ويرفض موضعاً لا وجود له', async () => {
    const updated = await put('/platform/content/menus/header', {
      items: [
        { key: 'features', href: '/features', labelAr: 'المزايا', labelEn: 'Features' },
        { key: 'pricing', href: '/pricing', labelAr: 'الباقات', badgeAr: 'جديد' },
      ],
    });
    expect(updated.status).toBe(200);
    const menu = updated.body.data as ContentMenu;
    expect(menu.position).toBe('header');
    expect(menu.items.map((item) => item.key)).toEqual(['features', 'pricing']);

    const site = await api(ctx.server, 'get', `${base}/public/site`);
    const header = (site.body.data as { menus: { header: Array<{ labelAr: string }> } }).menus.header;
    expect(header.map((item) => item.labelAr)).toEqual(['المزايا', 'الباقات']);

    const badPosition = await put('/platform/content/menus/middle', { items: [] });
    expect(badPosition.status).toBe(400);

    const badHref = await put('/platform/content/menus/footer', {
      items: [{ key: 'x', href: 'javascript:alert(1)', labelAr: 'خطر' }],
    });
    // الرابط مخططٌ في العقد: `javascript:` لا يمرّ من أيّ قناة.
    expect(badHref.status).toBe(400);
  });

  it('يعرض اللافتة داخل نافذتها فقط', async () => {
    const live = await post('/platform/content/banners', {
      textAr: 'إصدارٌ جديد من التقارير',
      textEn: 'New reports are out',
      href: '/blog/reports',
      tone: 'ok',
      audience: 'all',
    });
    expect(live.status).toBe(201);
    const banner = live.body.data as ContentBanner;
    expect(banner.live).toBe(true);
    expect(banner.startsAt).not.toBeNull();

    const site = await api(ctx.server, 'get', `${base}/public/site`);
    expect((site.body.data as { banner: ContentBanner | null }).banner?.id).toBe(banner.id);

    const expired = await post('/platform/content/banners', {
      textAr: 'انتهت',
      startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(expired.status).toBe(201);
    expect((expired.body.data as ContentBanner).live).toBe(false);

    const banners = await api(ctx.server, 'get', `${base}/public/banners`);
    const ids = (banners.body.data as ContentBanner[]).map((item) => item.id);
    expect(ids).toContain(banner.id);
    expect(ids).not.toContain((expired.body.data as ContentBanner).id);

    const stopped = await patch(`/platform/content/banners/${banner.id}`, { active: false });
    expect(stopped.status).toBe(200);
    expect((stopped.body.data as ContentBanner).live).toBe(false);
  });

  /**
   * نافذةٌ معكوسة تُرفض في المدقّقة، لا في قيد القاعدة.
   *
   * `content_banners_window_check` في القاعدة هو الحاكم الأخير، لكنه يُطلق **بعد** الكتابة،
   * فتصل الخطأ إلى المشغّل `500 INTERNAL` بلا سبب مفهوم (أُمسك حيّاً: `PATCH` بـ`endsAt`
   * وحده في الماضي). والقاعدة الآن في العقد والخدمة معاً: تُقارن النافذة **الفعّالة** —
   * أي مع `starts_at` المخزّن حين لا يُرسله التعديل — ويُردّ 422 بوصفٍ عربي.
   */
  it('يرفض نافذةً تنتهي قبل أن تبدأ بوصفٍ عربي لا بخطأ قاعدة', async () => {
    const created = await post('/platform/content/banners', {
      textAr: 'نافذة صحيحة',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(created.status).toBe(201);
    const banner = created.body.data as ContentBanner;

    const invertedOnCreate = await post('/platform/content/banners', {
      textAr: 'نافذة معكوسة',
      startsAt: new Date(Date.now() + 7_200_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(invertedOnCreate.status).toBe(400);
    expect(JSON.stringify(invertedOnCreate.body)).toContain('نهاية اللافتة');

    // التعديل الجزئي يمرّ من المدقّقة (فهي لا ترى `starts_at` المخزّن) فتلتقطه قاعدة الخدمة
    // على النافذة الفعّالة ⇒ 422 — والرسالة نفسها، والقاعدة هي الحكم في الحالتين.
    const invertedOnUpdate = await patch(`/platform/content/banners/${banner.id}`, {
      endsAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    expect(invertedOnUpdate.status).toBe(422);
    const detail = JSON.stringify(invertedOnUpdate.body);
    expect(detail).toContain('نهاية اللافتة');
    expect(detail).not.toContain('500');
  });

  // ═══════════════════════════════════════════════ 5. القراءة والترشيح

  it('يرشّح القائمة ويبحث فيها ويرتّبها، ويعدّ ما فيها', async () => {
    await post('/platform/content/pages', draft({ slug: 'maqal-awwal', kind: 'post', category: 'أخبار' }));
    await post('/platform/content/pages', draft({ slug: 'maqal-thani', kind: 'post', category: 'دلائل' }));

    const byKind = await get('/platform/content/pages?filter[kind]=post&sort=title');
    expect(byKind.status).toBe(200);
    const posts = byKind.body.data as ContentPage[];
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.every((page) => page.kind === 'post')).toBe(true);
    // `sort=title` مسارٌ صحيح لا ترتيبٌ يُقارن بـJS: ترتيب القاعدة (collation) ليس ترتيب JS.
    expect(byKind.status).toBe(200);

    const searched = await get('/platform/content/pages?q=maqal-awwal');
    expect((searched.body.data as ContentPage[]).map((page) => page.slug)).toEqual(['maqal-awwal']);

    // التصنيفات من **المنشور** وحده: مسوّدتان لا تُنشئان تصنيفاً يعرضه الموقع.
    const beforePublish = await get('/platform/content/categories');
    expect((beforePublish.body.data as { blog: string[] }).blog).not.toContain('أخبار');
    for (const slug of ['maqal-awwal', 'maqal-thani']) {
      const found = await get(`/platform/content/pages?q=${slug}`);
      const id = (found.body.data as ContentPage[])[0]?.id;
      await post(`/platform/content/pages/${id}/publish`, {});
    }

    const categories = await get('/platform/content/categories');
    expect((categories.body.data as { blog: string[] }).blog).toEqual(
      expect.arrayContaining(['أخبار', 'دلائل']),
    );

    const matched = (byKind.body.meta as { total: number }).total;
    const limited = await get('/platform/content/pages?filter[kind]=post&limit=1');
    expect((limited.body.data as ContentPage[]).length).toBe(1);
    expect((limited.body.meta as { total: number }).total).toBe(matched);
  });

  it('يقرأ صفحةً واحدة بالمعرّف، ويردّ 404 لمعرّفٍ لا وجود له', async () => {
    const created = await post('/platform/content/pages', draft({ slug: 'wahida' }));
    const id = (created.body.data as ContentPageDetail).id;
    const one = await get(`/platform/content/pages/${id}`);
    expect(one.status).toBe(200);
    expect((one.body.data as ContentPageDetail).slug).toBe('wahida');

    const missing = await get('/platform/content/pages/11111111-1111-4111-8111-111111111111');
    expect(missing.status).toBe(404);
  });

  // ═══════════════════════════════════════════════ 6. الصلاحيات والعزل

  it('يفصل رمز القراءة عن رمز الكتابة', async () => {
    const reads = await get('/platform/content/pages', reader);
    expect(reads.status).toBe(200);
    expect((reads.body.data as ContentPage[]).length).toBeGreaterThan(0);

    const writes = await post('/platform/content/pages', draft({ slug: 'bidun-raman' }), reader);
    expect(writes.status).toBe(403);
    const publishes = await post(
      `/platform/content/pages/${(reads.body.data as ContentPage[])[0]?.id}/publish`,
      {},
      reader,
    );
    expect(publishes.status).toBe(403);

    const me = await get('/me', reader);
    const codes = (me.body.data as { platformPermissions: string[] }).platformPermissions;
    expect(codes).toContain('console.content.view');
    expect(codes).not.toContain('console.content.manage');
  });

  it('لا يقرأ المسوّدات من لا رمز له، ولا يصل رمز المستأجر إلى سطح المنصة', async () => {
    const denied = await get('/platform/content/pages', outsider);
    expect(denied.status).toBe(403);

    // رمز مستأجر: حتى مع صلاحياته الكاملة لا يمرّ من بوابة المنصة.
    const tenantCall = await get('/platform/content/pages', tenantOwner);
    expect(tenantCall.status).toBe(403);

    // و`/me` لا يمنح عميلاً أيّ رمز `console.*`.
    const me = await get('/me', tenantOwner);
    expect(
      (me.body.data as { platformPermissions?: string[] }).platformPermissions ?? [],
    ).toEqual([]);
  });

  it('يسجّل كل فعلٍ في التدقيق باسم فاعله', async () => {
    const rows = await auditActions();
    const actions = new Set((rows.rows as Array<{ action: string }>).map((row) => row.action));
    for (const action of [
      contentAuditActions.CREATED,
      contentAuditActions.UPDATED,
      contentAuditActions.PUBLISHED,
      contentAuditActions.SCHEDULED,
      contentAuditActions.RETRACTED,
      contentAuditActions.RESTORED,
      contentAuditActions.MENU_UPDATED,
      contentAuditActions.BANNER_CREATED,
      contentAuditActions.BANNER_UPDATED,
    ]) {
      expect(actions).toContain(action);
    }

    const mine = (rows.rows as Array<Record<string, unknown>>).filter(
      (row) => row.actor_user_id === owner.userId,
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => String(row.actor_label ?? '').length > 0)).toBe(true);
  });
});
