import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  contentPathOf,
  type ContentBanner,
  type ContentPageDetail,
  type ListEnvelope,
  type PublicFaq,
  type PublicPost,
  type PublicSite,
} from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import { createActor, createTenantFixture, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M1 · P-M2 — «الواجهة العامة للموقع التسويقي» (`docs/roadmap/MARKETING_SITE_PLAN.md` §4–§5).
 *
 * الموقع التسويقي **واجهةٌ بلا جلسة**، وهي أخطر ما في هذا العمل: ما يظهر هنا يظهر للعالم.
 * فكل اختبارٍ في هذا الملف يقيس حدّاً بين «يُعرض» و«لا يُعرض»:
 *
 * 1. **المسوّدة والمجدولة لا تُعرضان** — لا من القائمة ولا من رابطٍ مباشر، والردّ 404 **بنفس
 *    الرسالة** لغير الموجودة (التمييز يجعل الـ404 أداةَ استكشاف).
 * 2. **المنشورة تُعرض بكتلها مرتّبة** وبالصورة التي تحفظها.
 * 3. **اللغتان**: الردّ يقول أيّ لغةٍ نالت ترجمة، والرابط واحد لا صفحتان.
 * 4. **خريطة الموقع**: مساراتٌ من `contentPathOf` وحدها، ومنشورٌ فقط.
 * 5. **البحث والتصنيف** في مركز المساعدة والمدوّنة.
 * 6. **الأسئلة الشائعة** مسطَّحة من كتل الصفحات المنشورة — وهي مصدر JSON-LD لاحقاً.
 * 7. **قشرةٌ واحدة**: `GET /public/site` يحمل الهوية والقوائم واللافتة — فلا أربعة نداءات
 *    لرسم رأسٍ واحد.
 * 8. **لا كتابة من العام**: كل مسار عام هنا `GET`، والمحاولة تُرفض.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('public marketing content (P-M1 · P-M2)', () => {
  let ctx: TestApp;
  let operator: Actor;
  let tenantOwner: Actor;

  const base = '/api/v1';
  const get = (path: string, token?: string) =>
    api(ctx.server, 'get', `${base}${path}`, token ? { token } : {});
  const post = (path: string, body: unknown, token: string) =>
    api(ctx.server, 'post', `${base}${path}`, { token, body });

  const published = (slug: string) => get(`/public/content/${slug}`);

  beforeAll(async () => {
    ctx = await createTestApp('public-content');
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    operator = await createOperator(ctx, {
      tenantCode: 'pub-ops',
      email: 'owner@pub-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    tenantOwner = await createActor(ctx, {
      tenantCode: 'pub-customer',
      tenantName: 'شركة العميل',
      email: 'owner@pub-customer.test',
      permissions: [],
      roleNames: ['Admin'],
      isOwner: true,
    });

    // المحتوى يُكتب من اللوحة (المسار الحقيقي) لا بـSQL — فالاختبار يقيس الطريق كاملاً:
    // كتابةٌ في اللوحة ⇒ ظهورٌ في الموقع.
    const create = async (body: Record<string, unknown>) => {
      const response = await post('/platform/content/pages', body, operator.token);
      expect(response.status).toBe(201);
      return (response.body.data as ContentPageDetail).id;
    };

    // 1. مقالٌ منشور بلغتين — أساس معظم الفحوص.
    const postId = await create({
      slug: 'kayfa-tabdaa',
      kind: 'post',
      titleAr: 'كيف تبدأ؟',
      titleEn: 'How to start',
      summaryAr: 'خطواتٌ أولى قصيرة',
      summaryEn: 'Short first steps',
      category: 'دلائل',
      authorName: 'فريق المنصّة',
      seoTitleAr: 'كيف تبدأ مع المنصّة',
      seoDescAr: 'دليلٌ قصير يشرح الخطوات الأولى',
      blocks: [
        { position: 0, kind: 'text', content: { ar: { text: 'ابدأ بإنشاء منشأتك ثم أضف فرعك الأول.' } } },
        {
          position: 1,
          kind: 'faq',
          content: {
            ar: {
              items: [
                { question: 'كم تستغرق البداية؟', answer: 'أقل من ساعةٍ لفريقٍ صغير.' },
                { question: 'هل أحتاج بطاقة؟', answer: 'لا، التجربة مجانية بلا بطاقة.' },
              ],
            },
          },
        },
      ],
    });
    await post(`/platform/content/pages/${postId}/publish`, {}, operator.token);

    // 2. مسوّدة: رابطها معروف، ويجب ألّا تظهر.
    await create({
      slug: 'musawwada-sirriya',
      kind: 'post',
      titleAr: 'مسوّدة سرّية',
      summaryAr: 'لم تُنشر بعد',
      blocks: [{ position: 0, kind: 'text', content: { ar: { text: 'لا يجب أن يقرأها الزائر.' } } }],
    });

    // 3. مجدولةٌ في المستقبل.
    const scheduledId = await create({
      slug: 'majdula-ghadan',
      kind: 'post',
      titleAr: 'تُنشر غداً',
      blocks: [{ position: 0, kind: 'text', content: { ar: { text: 'لسّا.' } } }],
    });
    await post(
      `/platform/content/pages/${scheduledId}/publish`,
      { at: new Date(Date.now() + 86_400_000).toISOString() },
      operator.token,
    );

    // 4. مقالة مساعدة (بلا ترجمة) + صفحةٌ عربية لمركز المساعدة.
    const helpId = await create({
      slug: 'rabat-alfatoura',
      kind: 'help',
      titleAr: 'كيف أربط الفاتورة؟',
      summaryAr: 'خطوات ربط الفاتورة الإلكترونية',
      category: 'الفواتير',
      blocks: [{ position: 0, kind: 'text', content: { ar: { text: 'من الإعدادات ← الفوترة.' } } }],
    });
    await post(`/platform/content/pages/${helpId}/publish`, {}, operator.token);

    // 5. قائمة الرأس ولافتةٌ حيّة — قشرة الموقع.
    const menu = await api(ctx.server, 'put', `${base}/platform/content/menus/header`, {
      token: operator.token,
      body: {
        items: [
          { key: 'features', href: '/features', labelAr: 'المزايا' },
          { key: 'blog', href: '/blog', labelAr: 'المدوّنة', badgeAr: 'جديد' },
        ],
      },
    });
    expect(menu.status).toBe(200);

    const banner = await post(
      '/platform/content/banners',
      { textAr: 'نسخةٌ جديدة من التقارير — اطّلع عليها', href: '/blog', tone: 'ok' },
      operator.token,
    );
    expect(banner.status).toBe(201);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('يعرض هوية الموقع وقوائمه ولافتته في نداءٍ واحد بلا جلسة', async () => {
    const response = await get('/public/site');
    expect(response.status).toBe(200);
    const site = response.body.data as PublicSite;

    expect(site.brandName.length).toBeGreaterThan(0);
    // اللغتان تُعلنان على القشرة: `ar` الأصل و`en` الترجمة.
    expect(site.locales).toEqual(['ar', 'en']);
    expect(['ar', 'en']).toContain(site.defaultLocale);
    expect(site.menus.header.map((item) => item.labelAr)).toEqual(['المزايا', 'المدوّنة']);
    expect(site.menus.header[1]?.badgeAr).toBe('جديد');
    expect(site.banner?.textAr).toContain('نسخةٌ جديدة');
    // ولافتةٌ حيّة ونافذتها مفتوحة.
    expect(site.banner?.live).toBe(true);
  });

  // ═══════════════════════════════════════════ 1. ما يُعرض وما لا يُعرض

  it('لا يكشف المسوّدة ولا المجدولة — ولا يفرّق بينهما وبين غير الموجودة', async () => {
    const draft = await published('musawwada-sirriya');
    expect(draft.status).toBe(404);
    const scheduled = await published('majdula-ghadan');
    expect(scheduled.status).toBe(404);
    const missing = await published('la-yujad-aslan');
    expect(missing.status).toBe(404);
    // الرسالة نفسها: من يعرف الـslug لا يتعلّم من الـ404 أن وراءه مسوّدة.
    expect(draft.body.detail).toBe(missing.body.detail);
    expect(scheduled.body.detail).toBe(missing.body.detail);

    // والقائمة أيضاً لا تراها.
    const posts = await get('/public/posts');
    const slugs = (posts.body.data as PublicPost[]).map((item) => item.slug);
    expect(slugs).toContain('kayfa-tabdaa');
    expect(slugs).not.toContain('musawwada-sirriya');
    expect(slugs).not.toContain('majdula-ghadan');
  });

  it('يعرض المنشورة بكتلها مرتّبةً وبالرابط المشتقّ من نوعها', async () => {
    const response = await published('kayfa-tabdaa');
    expect(response.status).toBe(200);
    const page = response.body.data as ContentPageDetail;

    expect(page.status).toBe('published');
    expect(page.publishedAt).not.toBeNull();
    expect(page.blocks.map((block) => block.kind)).toEqual(['text', 'faq']);
    expect(page.blocks.map((block) => block.position)).toEqual([0, 1]);
    // مقال ⇒ `/blog/…` من الدالّة الواحدة، لا من نصٍّ مكتوب في الاختبار.
    expect(page.path).toBe(contentPathOf('post', 'kayfa-tabdaa'));
    expect(page.path).toBe('/blog/kayfa-tabdaa');
    // SEO: العنوان والوصف مكتوبان، واللغتان معلنتان.
    expect(page.seo.titleAr).toBe('كيف تبدأ مع المنصّة');
    expect(page.seo.descriptionAr).toContain('الخطوات الأولى');
    expect(page.translatedLocales).toEqual(['ar', 'en']);

    // مساعدة ⇒ `/help/…`
    const help = await published('rabat-alfatoura');
    expect((help.body.data as ContentPageDetail).path).toBe('/help/rabat-alfatoura');
    // وبلا `titleEn` تكون الترجمة عربيةً وحدها — والردّ يقول ذلك بلا تخمين.
    expect((help.body.data as ContentPageDetail).translatedLocales).toEqual(['ar']);
  });

  // ═══════════════════════════════════════════ 2. القوائم والبحث

  it('يبحث في مركز المساعدة بالعنوان والملخّص، ويرشّح بالتصنيف', async () => {
    const all = await get('/public/help');
    expect(all.status).toBe(200);
    const envelope = all.body as unknown as ListEnvelope<PublicPost>;
    expect(envelope.meta.total).toBeGreaterThanOrEqual(1);
    expect((envelope.data ?? []).map((item) => item.slug)).toContain('rabat-alfatoura');

    const byWord = await get('/public/help?q=%D8%A7%D9%84%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9');
    expect((byWord.body.data as PublicPost[]).map((item) => item.slug)).toEqual(['rabat-alfatoura']);

    const noMatch = await get('/public/help?q=zzz-no-such-word');
    expect(noMatch.body.data as PublicPost[]).toEqual([]);

    const byCategory = await get('/public/help?category=%D8%A7%D9%84%D9%81%D9%88%D8%A7%D8%AA%D9%8A%D8%B1');
    expect((byCategory.body.data as PublicPost[]).length).toBe(1);

    const otherCategory = await get('/public/help?category=%D8%A3%D8%AE%D8%B1%D9%89');
    expect(otherCategory.body.data as PublicPost[]).toEqual([]);
  });

  it('يصفّي مقالات المدوّنة ويصفحها بالحدّ والإزاحة', async () => {
    const posts = await get('/public/posts?limit=1');
    expect(posts.status).toBe(200);
    const envelope = posts.body as unknown as ListEnvelope<PublicPost>;
    expect(envelope.data).toHaveLength(1);
    expect(envelope.meta.limit).toBe(1);
    // `total` يعدّ كل المنشور لا الصفحة المعروضة.
    expect(envelope.meta.total).toBeGreaterThanOrEqual(1);

    const second = await get('/public/posts?limit=1&offset=1');
    expect((second.body.meta as { offset: number }).offset).toBe(1);

    const byCategory = await get('/public/posts?category=%D8%AF%D9%84%D8%A7%D8%A6%D9%84');
    expect((byCategory.body.data as PublicPost[]).map((item) => item.slug)).toEqual(['kayfa-tabdaa']);

    const none = await get('/public/posts?category=%D9%84%D8%A7-%D8%B4%D9%8A%D8%A1');
    expect(none.body.data as PublicPost[]).toEqual([]);
    expect((none.body.meta as { total: number }).total).toBe(0);
  });

  it('يُسطّح الأسئلة الشائعة من كتل الصفحات المنشورة وحدها', async () => {
    const response = await get('/public/faq');
    expect(response.status).toBe(200);
    const faq = response.body.data as PublicFaq[];
    const questions = faq.map((item) => item.question);
    expect(questions).toContain('كم تستغرق البداية؟');
    expect(questions).toContain('هل أحتاج بطاقة؟');
    expect(faq.every((item) => item.slug.length > 0 && item.answer.length > 0)).toBe(true);
  });

  it('يبني خريطة الموقع من المنشور وحده، بمسارات الدالّة الواحدة', async () => {
    const response = await get('/public/sitemap');
    expect(response.status).toBe(200);
    const rows = response.body.data as Array<{ path: string; kind: string; locales: string[] }>;
    const paths = rows.map((row) => row.path);

    expect(paths).toContain('/blog/kayfa-tabdaa');
    expect(paths).toContain('/help/rabat-alfatoura');
    expect(paths).not.toContain('/blog/musawwada-sirriya');
    expect(paths).not.toContain('/blog/majdula-ghadan');
    // المسار الواحد يعلن لغاته: مقالٌ مترجم يعلن اللغتين، ومساعدةٌ عربية تعلن العربية.
    expect(rows.find((row) => row.path === '/blog/kayfa-tabdaa')?.locales).toEqual(['ar', 'en']);
    expect(rows.find((row) => row.path === '/help/rabat-alfatoura')?.locales).toEqual(['ar']);
    expect(rows.every((row) => row.path.startsWith('/'))).toBe(true);
  });

  it('يرفض الكتابة من الواجهة العامة، ولو كان الحامل مالك منشأة', async () => {
    const write = await post(
      '/public/content',
      { slug: 'mukhalif', titleAr: 'لا يُكتب من هنا' },
      tenantOwner.token,
    );
    // لا مسار كتابةٍ عام أصلاً: 404 على مسارٍ غير موجود، أو 403 لو وُجد حرس.
    expect([403, 404]).toContain(write.status);

    // والقراءة العامة لا تتأثّر بجلسة العميل: نفس الردّ بالرمز وبلا رمز.
    const anonymous = await get('/public/posts');
    const asTenant = await get('/public/posts', tenantOwner.token);
    expect(asTenant.status).toBe(200);
    expect((asTenant.body.data as PublicPost[]).length).toBe(
      (anonymous.body.data as PublicPost[]).length,
    );
  });

  it('لا يسرّب المسوّدات من أيّ نداءٍ عام', async () => {
    // نداءٌ شامل على كل مسار عام: لا نصّ من المسوّدة ولا من المجدولة.
    const bodies: string[] = [];
    for (const path of [
      '/public/site',
      '/public/sitemap',
      '/public/posts?limit=50',
      '/public/help?limit=50',
      '/public/faq',
      '/public/banners',
    ]) {
      bodies.push(JSON.stringify((await get(path)).body));
    }
    const everything = bodies.join('\n');
    expect(everything).not.toContain('musawwada-sirriya');
    expect(everything).not.toContain('مسوّدة سرّية');
    expect(everything).not.toContain('majdula-ghadan');
    expect(everything).not.toContain('تُنشر غداً');
    expect(everything).toContain('kayfa-tabdaa');
  });

  it('يفتح كل مسارٍ عامٍّ بلا جلسة ويعيد نفس النتيجة معها', async () => {
    for (const path of ['/public/site', '/public/sitemap', '/public/faq', '/public/banners']) {
      expect((await get(path)).status, path).toBe(200);
      expect((await get(path, tenantOwner.token)).status, path).toBe(200);
    }
    // ولافتةٌ مسحوبة تختفي فوراً من القشرة.
    const banner = (
      await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`SELECT id FROM content_banners ORDER BY created_at DESC LIMIT 1`),
      )
    ).rows[0] as { id: string } | undefined;
    const stopped = await api(
      ctx.server,
      'patch',
      `${base}/platform/content/banners/${banner?.id}`,
      { token: operator.token, body: { active: false } },
    );
    expect(stopped.status).toBe(200);
    const site = await get('/public/site');
    expect((site.body.data as PublicSite).banner).toBeNull();
    expect(((await get('/public/banners')).body.data as ContentBanner[]).length).toBe(0);
  });
});
