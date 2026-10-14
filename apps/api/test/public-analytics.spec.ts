import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SITE_ANALYTICS_NEVER,
  SITE_EVENTS_MAX_BATCH,
  SITE_EVENTS_RETENTION_DAYS,
  pickContentVariant,
  siteEventLabelsAr,
  siteGoalNames,
  type PublicContentVariant,
  type SiteAnalytics,
  type SiteEventMetaKey,
} from '@erp/contracts';
import { auditLog, newId, withPlatformAdminTx } from '@erp/database';

import { ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M10 — «القياس والتحسين» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M10).
 *
 * الخطة تطلب ستّة اختبارات على الأقل؛ وهذا الملف يقيس **ما يُفسد القياس** لا ما يُجمّله:
 *
 * 1. **الحدث المجهول**: نقطة القبول تعمل بلا جلسة، والدفعة محدودة، و**لا حقلَ هويّة في العقد
 *    أصلاً** — مفتاحٌ غريب يُردّ 400 بدل أن يُخزَّن بصمت.
 * 2. **لا تدقيق لزيارة**: `audit_log` لا ينمو بالأحداث، لأن الصفّ يحمل عنوان الزائر ووسيط
 *    متصفّحه — وتدقيقُ حدثٍ مجهول يحوّل «عدد زيارة» إلى «سجلّ زائر».
 * 3. **القمع بالزوّار لا بالنقرات**: زائرٌ ينقر الزرّ ثلاث مرّات يُحسب واحداً.
 * 4. **الأرقام لكل رقمٍ تعريفه**: الاستجابة تحمل `definitions` و`privacy` (ما يُجمع وما لا
 *    يُجمع أبداً)، و`never` فيها «عنوان IP» حرفياً.
 * 5. **الاحتفاظ يُنفَّذ فعلاً**: صفٌّ أقدم من المدّة يُمحى عند أوّل كتابة بعد يومٍ من آخر حذف
 *    (العلامة المائية في `platform_settings`) — وعدُ حذفٍ لا يُنفَّذ أسوأ من عدم الوعد.
 * 6. **أ/ب من نظام المحتوى**: النسخة صفحةٌ كاملة (`variant_of` + `variant_key`)، والمنشور
 *    منها وحده يُعلَن للزائر، والتوزيع حتميٌّ بالدالّة المشتركة `pickContentVariant`.
 * 7. **الرمز قائم لا جديد**: قمعُ الموقع يُقرأ برمز التحليلات (`console.analytics.view`) —
 *    ومن لا يملكه لا يراه؛ والمشغّل يرى، والمدقّق بلا الرمز لا يرى.
 */
describe('marketing site analytics (P-M10)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let viewer: Actor;
  let outsider: Actor;

  const EVENTS = '/api/v1/public/events';
  const SITE = '/api/v1/platform/analytics/site';
  const CONTENT = '/api/v1/public/content';

  const visitorA = '2f7c1a90-5b3d-4e2a-9c8f-1a2b3c4d5e6f';
  const visitorB = 'b1c2d3e4-f5a6-4b7c-8d9e-0a1b2c3d4e5f';

  const event = (extra: Record<string, unknown> = {}) => ({
    name: 'page_view',
    path: '/pricing',
    locale: 'ar',
    visitor: visitorA,
    ...extra,
  });

  const post = (path: string, body: unknown, token?: string) =>
    api(ctx.server, 'post', path, { body, ...(token ? { token } : {}) });
  const get = (path: string, token?: string) => api(ctx.server, 'get', path, token ? { token } : {});

  const auditRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) => tx.select({ id: auditLog.id }).from(auditLog)).then(
      (rows) => rows.length,
    );

  const eventRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT name, visitor, meta FROM site_events`),
    ).then((result) => result.rows as unknown as Array<{ name: string; visitor: string; meta: Record<string, string> }>);

  /** يزرع صفحةً (وأصلها إن كانت نسخة) قيداً مباشراً — مسار اللوحة مقيسٌ في P-M5. */
  const seedPage = async (options: {
    slug: string;
    title: string;
    status?: 'draft' | 'published';
    variantOf?: string | null;
    variantKey?: 'a' | 'b' | null;
    cta?: { primaryLabel: string; primaryHref: string } | null;
  }): Promise<string> => {
    const status = options.status ?? 'published';
    return withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const id = newId();
      await tx.execute(sql`
        INSERT INTO content_pages (id, slug, kind, title_ar, summary_ar, status, published_at, variant_of, variant_key)
        VALUES (${id}, ${options.slug}, 'page', ${options.title}, ${`ملخّص ${options.title}`}, ${status},
                ${status === 'published' ? new Date().toISOString() : null}::timestamptz,
                ${options.variantOf ?? null}::uuid, ${options.variantKey ?? null})
      `);
      if (options.cta) {
        await tx.execute(sql`
          INSERT INTO content_blocks (id, page_id, position, kind, content)
          VALUES (${newId()}, ${id}::uuid, 0, 'cta',
                  ${JSON.stringify({
                    ar: { title: `دعوة ${options.title}`, primaryLabel: options.cta.primaryLabel, primaryHref: options.cta.primaryHref },
                    en: null,
                  })}::jsonb)
        `);
      }
      return id;
    });
  };

  beforeAll(async () => {
    ctx = await createTestApp('public-analytics');
    owner = await createActor(ctx, {
      tenantCode: 'pa-owner',
      email: 'owner@pa.test',
      permissions: ALL_TENANT_PERMISSIONS,
      platformRoles: ['platform_owner'],
    });
    viewer = await createActor(ctx, {
      tenantCode: 'pa-viewer',
      email: 'viewer@pa.test',
      permissions: ALL_TENANT_PERMISSIONS,
      platformRoles: ['platform_auditor'],
    });
    outsider = await createActor(ctx, {
      tenantCode: 'pa-outsider',
      email: 'outsider@pa.test',
      permissions: ALL_TENANT_PERMISSIONS,
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('الحدث يُقبل بلا جلسة، والدفعة محدودة، ومفتاحٌ خارج العقد يُردّ 400', async () => {
    const accepted = await post(EVENTS, { events: [event()] });
    expect(accepted.status).toBe(202);
    expect((accepted.body as { data: { accepted: number } }).data.accepted).toBe(1);

    // مفتاحٌ خارج العقد: لا يُخزَّن بصمتٍ ثم يُكتشف بعد شهور.
    const smuggled = await post(EVENTS, { events: [event({ email: 'someone@example.com' })] });
    expect(smuggled.status).toBe(400);
    expect((smuggled.body as { code?: string }).code).toBe('VALIDATION_FAILED');

    // وحدثٌ باسمٍ ليس من المفردات المغلقة.
    const unknownName = await post(EVENTS, { events: [event({ name: 'Signup_Start' })] });
    expect(unknownName.status).toBe(400);

    // ودفعةٌ تتجاوز الحدّ.
    const tooMany = await post(EVENTS, {
      events: Array.from({ length: SITE_EVENTS_MAX_BATCH + 1 }, () => event()),
    });
    expect(tooMany.status).toBe(400);

    // ومفتاحٌ في جذر الدفعة (لا داخل الحدث) مرفوض كذلك.
    const extraRoot = await post(EVENTS, { events: [event()], ip: '10.0.0.1' });
    expect(extraRoot.status).toBe(400);
  });

  it('التكرار داخل الدفعة الواحدة يُكتب مرّة، والحدث لا يُدقَّق (لا سجلّ زائر)', async () => {
    const before = await auditRows();
    const first = await post(EVENTS, {
      events: [event({ name: 'signup_start', path: '/signup' }), event({ name: 'signup_start', path: '/signup' })],
    });
    expect(first.status).toBe(202);
    expect((first.body as { data: { accepted: number } }).data.accepted).toBe(1);

    const rows = await eventRows();
    expect(rows.filter((row) => row.name === 'signup_start').length).toBe(1);

    // صفر صفوف تدقيق جديدة: الصفّ يحمل عنوان الزائر ووسيطه، والحدث مجهولُ الهوية.
    expect(await auditRows()).toBe(before);
  });

  it('القمع يُقاس بالزوّار لا بالنقرات، والزوّار المميّزون وحدهم يُعدّون', async () => {
    await post(EVENTS, {
      events: [
        event({ name: 'page_view', path: '/', visitor: visitorB }),
        event({ name: 'signup_start', path: '/signup', visitor: visitorB }),
        event({ name: 'page_view', path: '/pricing', visitor: visitorB }),
      ],
    });
    // زائرٌ ثالث ينقر الزرّ ثلاث مرّات: خطوةٌ واحدة في القمع.
    const visitorC = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f';
    await post(EVENTS, {
      events: [
        event({ name: 'request_demo', path: '/demo', visitor: visitorC }),
        event({ name: 'request_demo', path: '/demo?a=1', visitor: visitorC }),
        event({ name: 'request_demo', path: '/contact', visitor: visitorC }),
      ],
    });

    const response = await get(`${SITE}?days=7`, owner.token);
    expect(response.status).toBe(200);
    const body = (response.body as { data: SiteAnalytics }).data;

    const demo = body.goals.find((goal) => goal.name === 'request_demo');
    expect(demo?.visitors).toBe(1);
    expect(demo?.events).toBe(3);
    expect(demo?.labelAr).toBe(siteEventLabelsAr.request_demo);
    // كل أهداف القمع لها صفٌّ ولو بصفر — الشاشة لا تخترع صفوفاً ناقصة.
    expect(body.goals.map((goal) => goal.name)).toEqual([...siteGoalNames]);
    expect(body.visitors.all).toBeGreaterThanOrEqual(3);
    expect(body.series.length).toBe(7);
    // والنسبة من زوّار النافذة لا من النقرات.
    expect(demo?.ratePct).toBeGreaterThan(0);
  });

  it('الاستجابة تحمل تعريف كل رقم وحدود الخصوصية — ولا تعرض ما لا يُجمع', async () => {
    const response = await get(`${SITE}?days=30`, owner.token);
    const body = (response.body as { data: SiteAnalytics }).data;

    expect(body.definitions.map((item) => item.key)).toEqual(
      expect.arrayContaining(['visitors', 'views', 'goals', 'sources', 'experiments']),
    );
    expect(body.privacy.retentionDays).toBe(SITE_EVENTS_RETENTION_DAYS);
    expect(body.privacy.never).toEqual([...SITE_ANALYTICS_NEVER]);
    expect(body.privacy.never).toContain('عنوان IP');

    // والجسم نفسه لا يحمل مُعرّفات زوّار — التجميع يسبق العرض.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(visitorA);
    expect(serialized).not.toContain(visitorB);
  });

  it('الاحتفاظ يُنفَّذ عند الكتابة: صفٌّ أقدم من المدّة يُمحى والعلامة المائية تمنع التكرار', async () => {
    // صفٌّ قديمٌ يدويّ (‏٢٠٠ يوم) + علامةٌ مائية قديمة ⇒ أول كتابةٍ تُنظّفه.
    await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO site_events (id, name, path, locale, visitor, occurred_at)
        VALUES (${newId()}, 'page_view', '/old', 'ar', ${visitorA}, now() - interval '200 days')
      `);
      await tx.execute(sql`
        INSERT INTO platform_settings (id, tenant_id, key, value)
        VALUES (${newId()}, NULL, 'site.events.pruned_at', ${JSON.stringify(new Date(Date.now() - 86_400_000 * 2).toISOString())}::jsonb)
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value
      `);
    });

    const stale = (await eventRows()).filter((row) => row.name === 'page_view');
    expect(stale.length).toBeGreaterThan(0);

    await post(EVENTS, { events: [event({ name: 'page_view', path: '/after-prune', visitor: visitorB })] });

    const pruned = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS stale FROM site_events WHERE path = '/old'`),
    );
    expect((pruned.rows[0] as { stale: number }).stale).toBe(0);

    // والعلامة المائية تحدّثت — فلا يُكرَّر الاستعلام في كل حدث.
    const marker = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT value::text AS value FROM platform_settings WHERE key = 'site.events.pruned_at' AND tenant_id IS NULL`),
    );
    const stamped = Date.parse(JSON.parse((marker.rows[0] as { value: string }).value) as string);
    expect(Date.now() - stamped).toBeLessThan(60_000);
  });

  it('اختبار أ/ب من نظام المحتوى: النسخ المنشورة تُعلَن، والتوزيع حتميّ', async () => {
    const base = await seedPage({ slug: 'pa-home', title: 'بطل البيت' });
    await seedPage({
      slug: 'pa-home-b',
      title: 'بطل البيت — نسخة ب',
      variantOf: base,
      variantKey: 'b',
      cta: { primaryLabel: 'ابدأ الآن', primaryHref: '/signup' },
    });
    // نسخةٌ مسوّدة لا تُعلَن، وإن كانت مربوطةً بالأصل بالحرف الصحيح.
    await seedPage({ slug: 'pa-home-a', title: 'نسخة أ مسوّدة', variantOf: base, variantKey: 'a', status: 'draft' });

    const response = await get(`${CONTENT}/pa-home`);
    expect(response.status).toBe(200);
    const detail = (response.body as { data: { slug: string; variants: PublicContentVariant[] } }).data;
    expect(detail.slug).toBe('pa-home');
    expect(detail.variants.map((variant) => variant.key)).toEqual(['b']);
    expect(detail.variants[0]?.ctaLabelAr).toBe('ابدأ الآن');
    expect(detail.variants[0]?.ctaHref).toBe('/signup');

    // والصفحة الأساسية بلا نسخٍ منها لا تُعلن شيئاً.
    const plain = await get(`${CONTENT}/pa-home-b`);
    expect((plain.body as { data: { variants: unknown[] } }).data.variants).toEqual([]);

    // التوزيع حتميّ: نفس الزائر ⇒ نفس النسخة دائماً، والاثنتان تُستعملان عبر زوّار مختلفين.
    const chosen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = `${String(index).padStart(8, '0')}-1111-4222-8333-444455556666`;
      const key = pickContentVariant({ slug: 'pa-home', visitor: id });
      expect(key).toBe(pickContentVariant({ slug: 'pa-home', visitor: id }));
      if (key) chosen.add(key);
    }
    expect([...chosen].sort()).toEqual(['a', 'b']);
  });

  it('نتائج أ/ب تُقاس بالعرض والتحويل: من رأى النسخة ومن بدأ اشتراكاً بعدها', async () => {
    const seenB = 'd4e3f2a1-b0c9-4d8e-9f7a-6b5c4d3e2f1a';
    const converted = 'e5f4a3b2-c1d0-4e9f-8a6b-5c4d3e2f1a0b';
    await post(EVENTS, {
      events: [
        event({ name: 'experiment_exposure', path: '/', visitor: seenB, meta: { experiment: 'pa-home', variant: 'b' } }),
        event({ name: 'experiment_exposure', path: '/', visitor: converted, meta: { experiment: 'pa-home', variant: 'b' } }),
        event({ name: 'signup_start', path: '/signup', visitor: converted }),
      ],
    });

    const response = await get(`${SITE}?days=30`, owner.token);
    const body = (response.body as { data: SiteAnalytics }).data;
    const experiment = body.experiments.find((row) => row.experiment === 'pa-home');
    expect(experiment).toBeTruthy();
    const variant = experiment?.variants.find((row) => row.key === 'b');
    expect(variant?.exposures).toBe(2);
    expect(variant?.converters).toBe(1);

    // والوصف المسموح وحده دخل القاعدة (المفاتيح المغلقة في العمود).
    const rows = await eventRows();
    const exposure = rows.find((row) => row.name === 'experiment_exposure');
    for (const key of Object.keys(exposure?.meta ?? {}) as SiteEventMetaKey[]) {
      expect(['experiment', 'variant', 'plan', 'source', 'goal']).toContain(key);
    }
  });

  it('قمع الموقع يُقرأ برمز التحليلات القائم: المشغّل يرى، ومَن لا يملكه لا يرى', async () => {
    const mine = await get(`${SITE}?days=7`, owner.token);
    expect(mine.status).toBe(200);

    // المدقّق في هذا المستودع يقرأ التحليلات (‏`console.analytics.view`) — فيرى القمع نفسه.
    const auditor = await get(`${SITE}?days=7`, viewer.token);
    expect(auditor.status).toBe(200);

    // ومن لا رمز له لا يرى شيئاً — ولو كان مالكاً في مستأجره.
    const stranger = await get(`${SITE}?days=7`, outsider.token);
    expect([401, 403]).toContain(stranger.status);
    expect(JSON.stringify(stranger.body)).not.toContain('visitors');

    // وبلا توكن إطلاقاً.
    const anonymous = await get(`${SITE}?days=7`);
    expect([401, 403]).toContain(anonymous.status);
  });
});
