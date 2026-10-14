import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditLog, newId, withPlatformAdminTx } from '@erp/database';
import type { PublicHelpArticle, PublicHelpFeedbackResult, PublicStatus } from '@erp/contracts';

import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M9 — «مركز المساعدة وحالة الخدمة» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M9).
 *
 * ستّة قرارات تُقاس هنا، وكل واحدٍ منها كان يمكن أن يُكتب في الشاشة فيُخطئ في مكانٍ لا يراه أحد:
 *
 * 1. **المنشور وحده يظهر** — مسوّدةٌ ومؤجّلة في نفس الجدول، والقائمة والمقال والفئات تُقرأ من
 *    شرطٍ واحد (`publishedWhere`)، فما لا يُنشر لا يُقرأ من أي باب.
 * 2. **الفئات مع القائمة** — لا نداء ثانٍ، وعدّاد كل فئة محسوبٌ من المنشور وحده، والفئة الفارغة
 *    لا تظهر (فئةٌ بعدّ صفر تقود إلى لا شيء).
 * 3. **المسار المخصّص يحكم النوع** — `/public/help/:slug` لا يخدم `post` ولا `legal`، ولو كان
 *    الـslug موجوداً ومنشوراً: وإلّا صار باباً خلفياً لبقيّة المحتوى.
 * 4. **صوتٌ واحد لكل متصفّح** — الفهرس الفريد هو الحرس لا الشرط في الكود: إعادة الإرسال تعود
 *    `recorded: false` والعدّاد لا يتحرّك.
 * 5. **الحالة تُعرض بلا تفاصيلها** — الجواب العام لا يحمل اسم دلوٍ ولا سائقَ طابورٍ ولا حالة
 *    مزوّد بريد، ويحمل المكوّنات الخمسة كاملةً.
 * 6. **لا تدقيق لصوتٍ مجهول** — صفّ التدقيق يحمل IP وUser-Agent، وصوتُ زائرٍ مجهول لا يُنسب إلى
 *    فاعل: عدد صفوف `audit_log` لا يتغيّر بالتصويت.
 */
describe('help center and public status (P-M9)', () => {
  let ctx: TestApp;
  let tenantId: string;

  const HELP = '/api/v1/public/help';
  const STATUS = '/api/v1/public/status';

  /** ينشر مقالاً في CMS قيداً مباشراً — المسار الكامل (لوحة → كتل → نشر) مقيسٌ في P-M5. */
  const seedPage = async (options: {
    slug: string;
    kind: 'help' | 'post' | 'changelog';
    title: string;
    category?: string | null;
    status?: 'draft' | 'scheduled' | 'published';
    publishedAt?: string;
  }): Promise<string> => {
    const status = options.status ?? 'published';
    const publishedAt =
      status === 'published' ? (options.publishedAt ?? new Date().toISOString()) : null;
    return withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const id = newId();
      await tx.execute(sql`
        INSERT INTO content_pages (id, slug, kind, title_ar, summary_ar, status, publish_at, published_at, category)
        VALUES (${id}, ${options.slug}, ${options.kind}, ${options.title}, ${`ملخّص ${options.title}`},
                ${status}, ${status === 'scheduled' ? new Date(Date.now() + 86_400_000).toISOString() : null}::timestamptz,
                ${publishedAt}::timestamptz, ${options.category ?? null})
      `);
      await tx.execute(sql`
        INSERT INTO content_blocks (id, page_id, position, kind, content)
        VALUES (${newId()}, ${id}::uuid, 0, 'text',
                ${JSON.stringify({ ar: { text: `متن ${options.title}` }, en: null })}::jsonb)
      `);
      return id;
    });
  };

  const auditRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) => tx.select({ id: auditLog.id }).from(auditLog)).then(
      (rows) => rows.length,
    );

  const post = (path: string, body: unknown) => api(ctx.server, 'post', path, { body });

  beforeAll(async () => {
    ctx = await createTestApp('public-help');
    tenantId = newId();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('القائمة تعرض المنشور وحده، ومعها فئاتٌ بعدّاداتها من المنشور وحده', async () => {
    await seedPage({ slug: 'hs-invoices', kind: 'help', title: 'إصدار فاتورة', category: 'الفواتير' });
    await seedPage({ slug: 'hs-reports', kind: 'help', title: 'تقرير المبيعات', category: 'التقارير' });
    await seedPage({ slug: 'hs-reports-2', kind: 'help', title: 'تقرير المصروفات', category: 'التقارير' });
    await seedPage({ slug: 'hs-draft', kind: 'help', title: 'مسوّدة سرّية', category: 'الفواتير', status: 'draft' });
    await seedPage({ slug: 'hs-blog', kind: 'post', title: 'مقال مدوّنة', category: 'الفواتير' });

    const response = await api(ctx.server, 'get', HELP);
    expect(response.status).toBe(200);
    const body = response.body as {
      data: Array<{ slug: string }>;
      meta: { categories: Array<{ name: string; count: number }> };
    };

    const slugs = body.data.map((item) => item.slug);
    expect(slugs).toEqual(expect.arrayContaining(['hs-invoices', 'hs-reports', 'hs-reports-2']));
    // المسوّدة لا تظهر، ومقال المدوّنة ليس من مركز المساعدة.
    expect(slugs).not.toContain('hs-draft');
    expect(slugs).not.toContain('hs-blog');
    expect(JSON.stringify(body)).not.toContain('مسوّدة سرّية');

    // الفئات: التقارير ٢ · الفواتير ١ — ولا فئة للمسوّدة.
    const categories = new Map(body.meta.categories.map((item) => [item.name, item.count]));
    expect(categories.get('التقارير')).toBe(2);
    expect(categories.get('الفواتير')).toBe(1);

    // البحث يرشّح النتائج، والمرشَّح لا يُسقط الفئات (من دخل على فئةٍ يجب أن يخرج منها).
    const searched = await api(ctx.server, 'get', `${HELP}?q=المصروفات`);
    const searchedBody = searched.body as { data: Array<{ slug: string }>; meta: { categories: unknown[] } };
    expect(searchedBody.data.map((item) => item.slug)).toEqual(['hs-reports-2']);
    expect(searchedBody.meta.categories.length).toBeGreaterThanOrEqual(2);
  });

  it('المقال: النوع والمنشور يُحكمان في الخدمة — لا بابٌ خلفي للمدوّنة ولا للمسوّدة', async () => {
    const article = await api(ctx.server, 'get', `${HELP}/hs-reports`);
    expect(article.status).toBe(200);
    const body = (article.body as { data: PublicHelpArticle }).data;

    expect(body.page.slug).toBe('hs-reports');
    expect(body.category).toBe('التقارير');
    expect(body.page.blocks.length).toBe(1);
    expect(body.page.blocks[0]?.content.ar).toBeTruthy();
    // المجاورة من الفئة نفسها، ولا تشمل المقال نفسه.
    expect(body.related.map((item) => item.slug)).toEqual(['hs-reports-2']);
    expect(body.helpful).toEqual({ yes: 0, no: 0 });

    // مقال المدوّنة منشورٌ وله slug، ومع ذلك لا يُخدم من مسار المساعدة.
    const blog = await api(ctx.server, 'get', `${HELP}/hs-blog`);
    expect(blog.status).toBe(404);
    // والمسوّدة كذلك — الرسالة نفسها للحالتين فلا يصير المسار أداةَ استكشاف.
    const draft = await api(ctx.server, 'get', `${HELP}/hs-draft`);
    expect(draft.status).toBe(404);
    expect(JSON.stringify(draft.body)).not.toContain('سرّية');
  });

  it('التصويت: صوتٌ واحد لكل متصفّح، والعدّاد يتحرّك مرّة', async () => {
    const visitor = '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c';
    const first = await post(`${HELP}/hs-reports/feedback`, { helpful: true, visitor });
    expect(first.status).toBe(200);
    expect((first.body as { data: PublicHelpFeedbackResult }).data).toEqual({ yes: 1, no: 0, recorded: true });

    // الطلب نفسه مرّةً ثانية (نقرة مزدوجة أو إعادة إرسال): لا يتغيّر العدّاد، والجواب يقول الحقيقة.
    const again = await post(`${HELP}/hs-reports/feedback`, { helpful: false, visitor });
    expect((again.body as { data: PublicHelpFeedbackResult }).data).toEqual({ yes: 1, no: 0, recorded: false });

    // ومتصفّحٌ آخر بصوتٍ مخالفٍ يزيد الجانب الآخر.
    const other = await post(`${HELP}/hs-reports/feedback`, {
      helpful: false,
      visitor: '8c2f0f0e-1b2c-4d3e-8f4a-5b6c7d8e9f01',
    });
    expect((other.body as { data: PublicHelpFeedbackResult }).data).toEqual({ yes: 1, no: 1, recorded: true });

    // والعدّادان يُقرآن مع المقال (مجموعاً لا صفوفاً).
    const article = await api(ctx.server, 'get', `${HELP}/hs-reports`);
    expect((article.body as { data: PublicHelpArticle }).data.helpful).toEqual({ yes: 1, no: 1 });
  });

  it('التصويت: مدخلٌ لا يصلح ⇒ 400 · مقالٌ غير موجود أو غير منشور ⇒ 404', async () => {
    const badVisitor = await post(`${HELP}/hs-reports/feedback`, { helpful: true, visitor: 'ليس-معرّفاً' });
    const missingHelpful = await post(`${HELP}/hs-reports/feedback`, {
      visitor: '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c',
    });
    const extraKey = await post(`${HELP}/hs-reports/feedback`, {
      helpful: true,
      visitor: '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c',
      ip: '10.0.0.1',
    });
    for (const response of [badVisitor, missingHelpful, extraKey]) {
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }

    const unknown = await post(`${HELP}/hs-nope/feedback`, {
      helpful: true,
      visitor: '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c',
    });
    const onBlog = await post(`${HELP}/hs-blog/feedback`, {
      helpful: true,
      visitor: '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c',
    });
    const onDraft = await post(`${HELP}/hs-draft/feedback`, {
      helpful: true,
      visitor: '49f5d3a1-6a1f-4a9a-9d2e-0b7c9f1a2b3c',
    });
    for (const response of [unknown, onBlog, onDraft]) expect(response.status).toBe(404);
  });

  it('صوتُ زائرٍ مجهول لا يُدقَّق: صفّ التدقيق لا يُكتب لعنوان الزائر', async () => {
    const before = await auditRows();
    await post(`${HELP}/hs-invoices/feedback`, {
      helpful: true,
      visitor: '11111111-2222-4333-8444-555555555555',
    });
    expect(await auditRows()).toBe(before);
  });

  it('حالة الخدمة: المكوّنات الخمسة كاملة، وبلا تفاصيلٍ داخلية أو أسماء أنظمة', async () => {
    const response = await api(ctx.server, 'get', STATUS);
    expect(response.status).toBe(200);
    const status = (response.body as { data: PublicStatus }).data;

    expect(status.components.map((component) => component.key)).toEqual([
      'platform',
      'database',
      'jobs',
      'email',
      'files',
    ]);
    // كل مكوّن يحمل تسميته وشرحه وحالته — فالشاشة لا تخترع جملةً عن حالة.
    for (const component of status.components) {
      expect(component.labelAr.length).toBeGreaterThan(1);
      expect(component.whatAr.length).toBeGreaterThan(10);
      expect(component.noteAr.length).toBeGreaterThan(10);
      expect(['up', 'degraded', 'down', 'not_configured']).toContain(component.status);
    }
    expect(status.statusLabelAr.length).toBeGreaterThan(2);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.noteAr).toContain('الحالة لا التفاصيل');

    // الحدّ الأهمّ: لا رسالة خطأ قاعدةٍ ولا `REDIS_URL` ولا اسم دلوٍ أو سائق طابور.
    const body = JSON.stringify(response.body);
    for (const forbidden of ['REDIS_URL', 'JOBS_ENABLED', 'driver', 'bucket', 'SELECT 1', 'at Object.']) {
      expect(body).not.toContain(forbidden);
    }
    // ولا هوية المنشأة التي أنشأها الـfixture (لا سياق عميل في هذا المسار أصلاً).
    expect(body).not.toContain(tenantId);
  });

  it('سجلّ التغييرات: نوعٌ سابع يُنشر ويُقرأ من مسار المقالات، ومساره `/changelog/<slug>`', async () => {
    await seedPage({ slug: 'chg-2026-09', kind: 'changelog', title: 'v1.4 التقارير المجدولة' });
    const { contentPathOf } = await import('@erp/contracts');
    expect(contentPathOf('changelog', 'chg-2026-09')).toBe('/changelog/chg-2026-09');

    const response = await api(ctx.server, 'get', '/api/v1/public/posts?kind=changelog');
    const body = response.body as { data: Array<{ slug: string; kind: string; path: string }> };
    const entry = body.data.find((item) => item.slug === 'chg-2026-09');
    expect(entry?.kind).toBe('changelog');
    expect(entry?.path).toBe('/changelog/chg-2026-09');

    // ومدخل التغيير لا يُخدم من مسار المساعدة (النوع محكومٌ في كل باب).
    const viaHelp = await api(ctx.server, 'get', `${HELP}/chg-2026-09`);
    expect(viaHelp.status).toBe(404);
  });
});
