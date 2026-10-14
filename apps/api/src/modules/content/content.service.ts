import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  contentAuditActions,
  contentPathOf,
  errorCodes,
  jobTypes,
  DomainError,
  listEnvelope,
  platformSettingDefaultMap,
  defaultPlatformSettingValue,
  type ContentBanner,
  type ContentBannerCreate,
  type ContentBannerUpdate,
  type ContentBlock,
  type ContentBlockKind,
  type ContentKind,
  type ContentLocale,
  type ContentMenu,
  type ContentMenuPosition,
  type ContentPage,
  type ContentPageCreate,
  type ContentPageDetail,
  type ContentPageListQuery,
  type ContentPageUpdate,
  type ContentSitemapRow,
  type ContentVersion,
  type ListEnvelope,
  type PublicContentVariant,
  type PublicFaq,
  type PublicHelpArticle,
  type PublicHelpCategory,
  type PublicHelpFeedback,
  type PublicHelpFeedbackResult,
  type PublicHelpMeta,
  type PublicPost,
  type PublicSite,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { OutboxService } from '../platform-services/jobs/outbox.service.js';
import { getAuthContext, tryGetAuthContext } from '../../request-context/request-context.js';

/**
 * P-M5 — خدمة المحتوى (`docs/roadmap/MARKETING_SITE_PLAN.md` §6).
 *
 * **القرار الحاكم: القراءة العامة تمرّ بسياق المنصّة مع فلترٍ صريح، لا بحذف RLS.**
 *
 * جدولا المحتوى بلا `tenant_id` (مستندُ المنصّة إلى السوق، كما أن `announcements` مستندها
 * إلى عملائها)، فسياسة `platform_admin_plane` وحدها تحكمهما. ونقطة النهاية العامة **ليست
 * مستثناةً من العزل**: هي تفتح معاملة بسياق المنصّة ثم تُصفّي بـ`publishedWhere` — شرطٌ واحد
 * يسكن هنا، فالمسوّدة والمجدولة لا تظهران من أي مسار. البديل كان منح `erp_api` قراءةً بلا
 * سياقٍ (política `USING (true)`)، وهو يعني أن أي عميلٍ يعرف الـslug يقرأ مسوّدة لم تُنشر.
 *
 * وثلاث قواعد أخرى:
 *
 *   1. **لا `DELETE`**: الحذف يكسر رابطاً عاماً ظهر في نتائج البحث وفي رسالةٍ أُرسلت. الإخفاء
 *      بحالة (`draft`) لا بمحو — والمنح نفسه في 0077 بلا `DELETE`.
 *   2. **نسخةٌ قبل كل كتابة**: كل تعديلٍ يحفظ الصورة الكاملة (الصفحة + كتلها) برقمٍ متزايد،
 *      والاستعادة تُنتج نسخةً جديدة بدل أن تمحو التاريخ.
 *   3. **الرابط من `contentPathOf`** — دالّة واحدة في العقد، فلا يختلف رابطٌ بين خريطة الموقع
 *      وبين قائمة المقالات وبين `canonical`.
 */

/** الشرط الذي يجعل صفحةً «منشورة الآن» — يُستعمل في كل قراءةٍ عامّة بلا استثناء. */
const publishedWhere = sql`status = 'published' AND published_at IS NOT NULL AND published_at <= now()`;

type PageRow = {
  id: string;
  slug: string;
  kind: string;
  status: string;
  title_ar: string;
  title_en: string | null;
  summary_ar: string | null;
  summary_en: string | null;
  default_locale: string;
  publish_at: string | null;
  published_at: string | null;
  seo_title_ar: string | null;
  seo_title_en: string | null;
  seo_desc_ar: string | null;
  seo_desc_en: string | null;
  og_image_url: string | null;
  category: string | null;
  author_name: string | null;
  created_by: string | null;
  updated_by: string | null;
  /** P-M10 — أصل النسخة وحرفها (`null` للأصل). */
  variant_of: string | null;
  variant_key: string | null;
  created_at: string;
  updated_at: string;
  block_count: number;
};

type BlockRow = { id: string; position: number; kind: string; content: { ar: unknown; en: unknown | null } };

type VersionRow = {
  id: string;
  page_id: string;
  version: number;
  note: string | null;
  snapshot: { page?: Record<string, unknown>; blocks?: unknown[] };
  created_by: string | null;
  created_at: string;
};

@Injectable()
export class ContentService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ================================================================== أدوات

  private pageFrom(row: PageRow): ContentPage {
    const kind = row.kind as ContentPage['kind'];
    return {
      id: row.id,
      slug: row.slug,
      kind,
      status: row.status as ContentPage['status'],
      titleAr: row.title_ar,
      titleEn: row.title_en,
      summaryAr: row.summary_ar,
      summaryEn: row.summary_en,
      defaultLocale: row.default_locale as ContentLocale,
      publishAt: row.publish_at,
      publishedAt: row.published_at,
      seo: {
        titleAr: row.seo_title_ar,
        titleEn: row.seo_title_en,
        descriptionAr: row.seo_desc_ar,
        descriptionEn: row.seo_desc_en,
        ogImageUrl: row.og_image_url,
      },
      category: row.category,
      authorName: row.author_name,
      variantOf: row.variant_of,
      variantKey: row.variant_key as ContentPage['variantKey'],
      translatedLocales: this.translatedLocales(row),
      path: contentPathOf(kind, row.slug),
      blockCount: row.block_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
    };
  }

  /**
   * P-M10 — **نسخ الصفحة في اختبار أ/ب**، منشورةً وحدها.
   *
   * والنسخة صفحةٌ كاملة، و«الدعوة» تُقرأ من **كتلة `cta`** داخلها (أول كتلةٍ من نوعها) لا من
   * حقلٍ ثانٍ: التسويق يغيّر الزرّ في المحرّر نفسه، ولو كان الحقل منفصلاً لنُسي يوماً.
   * ولا تُرجع كتل النسخة عمداً: الصفحة الأساسية تُرسم بكتلها ثم **يُستبدل** النصّ والدعوة —
   * فرقٌ قالبه واحد، والقارئ لا يرى قفزةً في التخطيط.
   */
  private async variantsOf(tx: DrizzleTx, pageId: string): Promise<PublicContentVariant[]> {
    const rows = (
      await tx.execute(sql`
        SELECT p.slug, p.variant_key, p.title_ar, p.summary_ar,
               (SELECT b.content FROM content_blocks b
                 WHERE b.page_id = p.id AND b.kind = 'cta'
                 ORDER BY b.position ASC LIMIT 1) AS cta
          FROM content_pages p
         WHERE p.variant_of = ${pageId}::uuid AND p.variant_key IS NOT NULL
           AND ${publishedWhere}
         ORDER BY p.variant_key ASC
      `)
    ).rows as unknown as Array<{
      slug: string;
      variant_key: string;
      title_ar: string;
      summary_ar: string | null;
      cta: { ar?: { primaryLabel?: string; primaryHref?: string } } | null;
    }>;
    return rows.map((row) => ({
      key: row.variant_key as PublicContentVariant['key'],
      slug: row.slug,
      titleAr: row.title_ar,
      summaryAr: row.summary_ar,
      ctaLabelAr: row.cta?.ar?.primaryLabel ?? null,
      ctaHref: row.cta?.ar?.primaryHref ?? null,
    }));
  }

  /** تفصيلٌ كامل للصفحة: النموذج + الترجمات + الكتل + نسخ أ/ب — من موضعٍ واحد. */
  private async detailOf(tx: DrizzleTx, page: PageRow, blocks: BlockRow[]): Promise<ContentPageDetail> {
    return {
      ...this.pageFrom(page),
      translatedLocales: this.translatedLocales(page, blocks),
      blocks: blocks.map((block) => this.blockFrom(block)),
      variants: await this.variantsOf(tx, page.id),
    };
  }

  /** أي لسانٍ نال ترجمة فعلاً: العنوان الإنجليزي، أو كتلةٌ بحمولةٍ إنجليزية غير فارغة. */
  private translatedLocales(row: PageRow, blocks: BlockRow[] = []): ContentLocale[] {
    const locales: ContentLocale[] = ['ar'];
    const englishBlocks = blocks.some((block) => block.content?.en !== null && block.content?.en !== undefined);
    if (row.title_en !== null || englishBlocks) locales.push('en');
    return locales;
  }

  private blockFrom(row: BlockRow): ContentBlock {
    return {
      id: row.id,
      position: row.position,
      kind: row.kind as ContentBlockKind,
      content: { ar: row.content?.ar ?? null, en: row.content?.en ?? null },
    };
  }

  private selectPageColumns = sql`
    id, slug, kind, status, title_ar, title_en, summary_ar, summary_en, default_locale,
    publish_at::text AS publish_at, published_at::text AS published_at,
    seo_title_ar, seo_title_en, seo_desc_ar, seo_desc_en, og_image_url,
    category, author_name, created_by, updated_by,
    variant_of, variant_key,
    created_at::text AS created_at, updated_at::text AS updated_at,
    (SELECT count(*)::int FROM content_blocks b WHERE b.page_id = content_pages.id) AS block_count
  `;

  private async pageById(tx: DrizzleTx, id: string): Promise<PageRow | undefined> {
    const rows = (await tx.execute(sql`SELECT ${this.selectPageColumns} FROM content_pages WHERE id = ${id}::uuid`))
      .rows as unknown as PageRow[];
    return rows[0];
  }

  private async blocksOf(tx: DrizzleTx, pageId: string): Promise<BlockRow[]> {
    return (
      await tx.execute(
        sql`SELECT id, position, kind, content FROM content_blocks WHERE page_id = ${pageId}::uuid ORDER BY position ASC`,
      )
    ).rows as unknown as BlockRow[];
  }

  /** صورةٌ كاملة للصفحة — تُحفظ قبل كل كتابة وتُقرأ عند الاستعادة. */
  private async snapshotOf(tx: DrizzleTx, pageId: string) {
    const page = await this.pageById(tx, pageId);
    if (!page) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);
    const blocks = await this.blocksOf(tx, pageId);
    return {
      page: { ...page },
      blocks: blocks.map((block) => ({ position: block.position, kind: block.kind, content: block.content })),
    };
  }

  private async saveVersion(
    tx: DrizzleTx,
    pageId: string,
    snapshot: Awaited<ReturnType<ContentService['snapshotOf']>>,
    note: string | null,
    actorId: string | undefined,
  ): Promise<number> {
    const rows = (
      await tx.execute(
        sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM content_versions WHERE page_id = ${pageId}::uuid`,
      )
    ).rows as Array<{ next: number }>;
    const next = rows[0]?.next ?? 1;
    await tx.execute(sql`
      INSERT INTO content_versions (id, page_id, version, snapshot, note, created_by)
      VALUES (${newId()}, ${pageId}::uuid, ${next}, ${JSON.stringify(snapshot)}::jsonb, ${note}, ${actorId ?? null}::uuid)
    `);
    return next;
  }

  /** استبدالُ الكتل: حذفٌ وإدراج في معاملةٍ واحدة (لا نصف نشر). */
  private async writeBlocks(tx: DrizzleTx, pageId: string, blocks: ContentPageCreate['blocks']): Promise<void> {
    await tx.execute(sql`DELETE FROM content_blocks WHERE page_id = ${pageId}::uuid`);
    for (const block of blocks) {
      await tx.execute(sql`
        INSERT INTO content_blocks (id, page_id, position, kind, content)
        VALUES (${newId()}, ${pageId}::uuid, ${block.position}, ${block.kind},
                ${JSON.stringify(block.content)}::jsonb)
      `);
    }
  }

  /** اسم الفاعل كما يُقرأ في التدقيق — نفس ما تفعله `platform-billing`. */
  private async actorLabel(tx: DrizzleTx, userId: string): Promise<string | null> {
    const rows = (
      await tx.execute(sql`SELECT full_name, email FROM users WHERE id = ${userId}::uuid`)
    ).rows as Array<{ full_name: string | null; email: string }>;
    return rows[0]?.full_name ?? rows[0]?.email ?? null;
  }

  private settings(): Record<string, string | string[] | number | boolean> {
    // القيم الافتراضية من الفهرس المشترك؛ وصفوف القاعدة تُدمج فوقها في `listSettingsValues`.
    return platformSettingDefaultMap();
  }

  // ================================================================== الواجهة العامة

  /**
   * `GET /public/site` — هوية الموقع وقوائمه ولافتته. نداءٌ واحد يبني الرأس والتذييل، فلا
   * تُطلب أربعة نداءات لرسم قشرةٍ واحدة.
   */
  async publicSite(): Promise<PublicSite> {
    // شبكةُ الأمان: من لا عاملَ له (سبيك/حاسوب) لا يُنشر عنده المجدول لولاه — idempotent.
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const settingRows = (
        await tx.execute(sql`SELECT key, value::text AS raw FROM platform_settings WHERE tenant_id IS NULL`)
      ).rows as unknown as Array<{ key: string; raw: string }>;
      const values = this.settings();
      for (const row of settingRows) {
        if (!row.key.startsWith('site.')) continue;
        try {
          values[row.key] = JSON.parse(row.raw) as string | string[];
        } catch {
          values[row.key] = row.raw;
        }
      }
      const read = (key: string): string => String(values[key] ?? defaultPlatformSettingValue(key) ?? '');

      const menuRows = (
        await tx.execute(sql`SELECT id, position, items, updated_at::text AS updated_at, updated_by FROM content_menus`)
      ).rows as unknown as Array<{
        id: string;
        position: string;
        items: unknown;
        updated_at: string;
        updated_by: string | null;
      }>;

      const menus = Object.fromEntries(
        (['header', 'footer', 'sidebar', 'legal', 'social'] as ContentMenuPosition[]).map((position) => [
          position,
          this.menuFrom(menuRows.find((row) => row.position === position), position).items,
        ]),
      ) as PublicSite['menus'];

      const banner = await this.liveBanner(tx);
      const defaultLocale = read('site.default_locale') === 'en' ? 'en' : 'ar';

      return {
        brandName: read('site.brand_name'),
        brandInitials: read('site.brand_initials'),
        taglineAr: read('site.tagline_ar'),
        taglineEn: read('site.tagline_en'),
        supportEmail: read('support.email'),
        supportPhone: read('support.phone'),
        defaultLocale,
        locales: ['ar', 'en'],
        siteUrl: read('site.url').replace(/\/+$/, ''),
        companyLegalName: read('site.company_legal_name'),
        maintenance: values['site.maintenance'] === true || values['site.maintenance'] === 'true',
        menus,
        banner,
      };
    });
  }

  private menuFrom(
    row: { id: string; position: string; items: unknown; updated_at: string; updated_by: string | null } | undefined,
    position: ContentMenuPosition,
  ): ContentMenu {
    return {
      id: row?.id ?? '00000000-0000-0000-0000-000000000000',
      position,
      items: (Array.isArray(row?.items) ? row.items : []) as ContentMenu['items'],
      updatedAt: row?.updated_at ?? new Date(0).toISOString(),
      updatedBy: row?.updated_by ?? null,
    };
  }

  private async liveBanner(tx: DrizzleTx): Promise<ContentBanner | null> {
    const rows = (
      await tx.execute(sql`
        SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
               starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
          FROM content_banners
         WHERE active = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY starts_at DESC
         LIMIT 1
      `)
    ).rows as unknown as Array<{
      id: string;
      text_ar: string;
      text_en: string | null;
      href: string | null;
      link_label_ar: string | null;
      link_label_en: string | null;
      tone: string;
      audience: string;
      starts_at: string;
      ends_at: string | null;
      active: boolean;
      created_at: string;
    }>;
    const row = rows[0];
    if (!row) return null;
    return this.bannerFrom(row, true);
  }

  private bannerFrom(
    row: {
      id: string;
      text_ar: string;
      text_en: string | null;
      href: string | null;
      link_label_ar: string | null;
      link_label_en: string | null;
      tone: string;
      audience: string;
      starts_at: string;
      ends_at: string | null;
      active: boolean;
      created_at: string;
    },
    live: boolean,
  ): ContentBanner {
    return {
      id: row.id,
      textAr: row.text_ar,
      textEn: row.text_en,
      href: row.href,
      linkLabelAr: row.link_label_ar,
      linkLabelEn: row.link_label_en,
      tone: row.tone as ContentBanner['tone'],
      audience: row.audience as ContentBanner['audience'],
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      active: row.active,
      live,
      createdAt: row.created_at,
    };
  }

  /** `GET /public/content/:slug` — صفحةٌ منشورة بكتلها، أو 404 بلا كشف سبب. */
  async publicPage(slug: string): Promise<ContentPageDetail> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(
          sql`SELECT ${this.selectPageColumns} FROM content_pages WHERE slug = ${slug} AND ${publishedWhere}`,
        )
      ).rows as unknown as PageRow[];
      const page = rows[0];
      // الرسالة نفسها للمسوّدة ولغير الموجودة عمداً: «موجودة لكن غير منشورة» معلومةٌ لا
      // يحتاجها الزائر، وتمييزها يجعل الـ404 أداةَ استكشاف.
      if (!page) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);
      const blocks = await this.blocksOf(tx, page.id);
      return this.detailOf(tx, page, blocks);
    });
  }

  /**
   * `GET /public/posts` — المحتوى المسرود المنشور، بترشيح النوع والتصنيف وبصفحات.
   *
   * **النوع مُعامل لا ثابت**: القيد `kind = 'post'` هنا كان يجعل `/cases` فارغةً أبداً (قصص
   * العملاء `case_study` تُنشر ولا تجد قارئاً)، وهو نفس مسار القراءة الذي يبني «قالوا عن
   * النظام» في الرئيسية. فالافتراضي `post` يأتي من المخطّط، والقيد يُنفَّذ في القاعدة.
   */
  async publicPosts(query: {
    kind: ContentKind;
    category?: string;
    limit: number;
    offset: number;
  }): Promise<ListEnvelope<PublicPost>> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const category = query.category ?? null;
      const rows = (
        await tx.execute(sql`
          SELECT ${this.selectPageColumns} FROM content_pages
           WHERE kind = ${query.kind} AND ${publishedWhere}
             AND (${category}::text IS NULL OR category = ${category})
           ORDER BY published_at DESC
           LIMIT ${query.limit} OFFSET ${query.offset}
        `)
      ).rows as unknown as PageRow[];
      const totalRow = (
        await tx.execute(sql`
          SELECT count(*)::int AS total FROM content_pages
           WHERE kind = ${query.kind} AND ${publishedWhere}
             AND (${category}::text IS NULL OR category = ${category})
        `)
      ).rows as unknown as Array<{ total: number }>;
      return listEnvelope(
        rows.map((row) => this.postFrom(row)),
        { total: totalRow[0]?.total ?? 0, limit: query.limit, offset: query.offset },
      );
    });
  }

  private postFrom(row: PageRow): PublicPost {
    return {
      slug: row.slug,
      kind: row.kind as PublicPost['kind'],
      titleAr: row.title_ar,
      titleEn: row.title_en,
      summaryAr: row.summary_ar,
      summaryEn: row.summary_en,
      path: contentPathOf(row.kind as PublicPost['kind'], row.slug),
      category: row.category,
      authorName: row.author_name,
      publishedAt: row.published_at ?? row.created_at,
      ogImageUrl: row.og_image_url,
    };
  }

  /**
   * `GET /public/help` — مقالات المساعدة، وبحثٌ في العنوان والملخّص، **ومعها الفئات**.
   *
   * **والفئات تأتي مع القائمة لا في نداءٍ ثانٍ** (P-M9): الشاشة تحتاج القائمة والشرائح في
   * اللحظة نفسها، ونداءان يعنيان رسمةً أولى بلا فئاتٍ ثم قفزة. وهي **غير مرشَّحة** بالطلب
   * عمداً: من جاء من رابط فئةٍ مباشر يجب أن يرى بقيّة الفئات ليخرج منها؛ وعدّ كل فئةٍ محسوبٌ
   * من المقالات المنشورة وحدها (فلا فئةٌ بعدّ صفر تظهر).
   */
  async publicHelp(query: {
    category?: string;
    q?: string;
    limit: number;
  }): Promise<ListEnvelope<PublicPost> & { meta: PublicHelpMeta }> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const category = query.category ?? null;
      const needle = query.q ? `%${query.q}%` : null;
      const rows = (
        await tx.execute(sql`
          SELECT ${this.selectPageColumns} FROM content_pages
           WHERE kind = 'help' AND ${publishedWhere}
             AND (${category}::text IS NULL OR category = ${category})
             AND (${needle}::text IS NULL OR title_ar ILIKE ${needle} OR title_en ILIKE ${needle}
                  OR summary_ar ILIKE ${needle} OR summary_en ILIKE ${needle})
           ORDER BY title_ar ASC
           LIMIT ${query.limit}
        `)
      ).rows as unknown as PageRow[];
      const totals = (
        await tx.execute(sql`
          SELECT category, count(*)::int AS count FROM content_pages
           WHERE kind = 'help' AND ${publishedWhere} AND category IS NOT NULL AND btrim(category) <> ''
           GROUP BY category
           ORDER BY count(*) DESC, category ASC
        `)
      ).rows as unknown as Array<{ category: string; count: number }>;
      const categories: PublicHelpCategory[] = totals.map((row) => ({ name: row.category, count: row.count }));
      return {
        data: rows.map((row) => this.postFrom(row)),
        meta: { total: rows.length, limit: query.limit, offset: 0, categories },
      };
    });
  }

  /**
   * `GET /public/help/:slug` — مقالُ مساعدةٍ كامل (P-M9).
   *
   * وثلاثة شروط تجعله «مقال مساعدة» لا «صفحةً بأي نوع»: النوع `help` · منشورٌ الآن · وslug
   * مطابق. ومقالٌ من نوعٍ آخر لا يُخدم من هنا **قبل** أن تُقرأ كتله — فلا يتحوّل المسار إلى
   * بابٍ خلفي لبقيّة المحتوى.
   *
   * والمجاورة من **الفئة نفسها**: من قرأ «كيف أُصدر فاتورة» يهمّه ما بعده في الإصدار لا مقالٌ
   * عن التسويق. وإن لم تكن للمقال فئة، تعود المجاورة فارغة ولا تُخترع من عموم المقالات.
   * والعدّادان يُقرآن من `content_feedback` — **مجموعاً** لا صفوفاً: لا يُعاد صوتُ أحد.
   */
  async publicHelpArticle(slug: string): Promise<PublicHelpArticle> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT ${this.selectPageColumns} FROM content_pages
           WHERE slug = ${slug} AND kind = 'help' AND ${publishedWhere}
        `)
      ).rows as unknown as PageRow[];
      const page = rows[0];
      // الرسالة نفسها للمقال غير المنشور ولغير الموجود — كما في `publicPage`.
      if (!page) throw new DomainError(errorCodes.NOT_FOUND, 'المقال غير موجود', 404);

      const blocks = await this.blocksOf(tx, page.id);
      const detail = this.pageFrom(page);
      const related = page.category
        ? ((
            await tx.execute(sql`
              SELECT ${this.selectPageColumns} FROM content_pages
               WHERE kind = 'help' AND ${publishedWhere} AND category = ${page.category}
                 AND slug <> ${page.slug}
               ORDER BY title_ar ASC
               LIMIT 4
            `)
          ).rows as unknown as PageRow[])
        : [];
      const counts = (
        await tx.execute(sql`
          SELECT count(*) FILTER (WHERE helpful)::int AS yes,
                 count(*) FILTER (WHERE NOT helpful)::int AS no
            FROM content_feedback WHERE page_id = ${page.id}::uuid
        `)
      ).rows as unknown as Array<{ yes: number; no: number }>;

      return {
        page: {
          ...detail,
          translatedLocales: this.translatedLocales(page, blocks),
          blocks: blocks.map((b) => this.blockFrom(b)),
          variants: await this.variantsOf(tx, page.id),
        },
        category: page.category,
        related: related.map((row) => this.postFrom(row)),
        helpful: { yes: counts[0]?.yes ?? 0, no: counts[0]?.no ?? 0 },
      };
    });
  }

  /**
   * `POST /public/help/:slug/feedback` — صوتٌ واحد لكل مقالٍ لكل متصفّح (P-M9).
   *
   * **والمنع في الفهرس لا في الكود**: `content_feedback_once_key` فريدٌ على
   * `(page_id, visitor)`، والكتابة `ON CONFLICT DO NOTHING RETURNING id` تقول هل حُسب الصوت
   * الآن. فطلبٌ مكرّر (نقرةٌ مزدوجة أو إعادة إرسال) لا يزيد العدّاد ولا يُخطئ — و`recorded`
   * تخبر الواجهة بالحقيقة فتقول «سُجّل صوتك» أو «صوتك محسوبٌ من قبل» بلا كذب.
   *
   * والمقال يُتحقَّق أنه **منشور ومن نوع help** قبل الكتابة: الصوت على مسوّدةٍ لا معنى له.
   */
  async recordHelpFeedback(slug: string, input: PublicHelpFeedback): Promise<PublicHelpFeedbackResult> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id FROM content_pages WHERE slug = ${slug} AND kind = 'help' AND ${publishedWhere}
        `)
      ).rows as unknown as Array<{ id: string }>;
      const page = rows[0];
      if (!page) throw new DomainError(errorCodes.NOT_FOUND, 'المقال غير موجود', 404);

      const inserted = (
        await tx.execute(sql`
          INSERT INTO content_feedback (id, page_id, helpful, visitor)
          VALUES (${newId()}, ${page.id}::uuid, ${input.helpful}, ${input.visitor})
          ON CONFLICT (page_id, visitor) DO NOTHING
          RETURNING id
        `)
      ).rows as unknown as Array<{ id: string }>;
      const counts = (
        await tx.execute(sql`
          SELECT count(*) FILTER (WHERE helpful)::int AS yes,
                 count(*) FILTER (WHERE NOT helpful)::int AS no
            FROM content_feedback WHERE page_id = ${page.id}::uuid
        `)
      ).rows as unknown as Array<{ yes: number; no: number }>;

      return {
        yes: counts[0]?.yes ?? 0,
        no: counts[0]?.no ?? 0,
        recorded: inserted.length > 0,
      };
    });
  }

  /**
   * `GET /public/faq` — أسئلةٌ شائعة مسطَّحة من كتل نوع `faq` في الصفحات المنشورة.
   *
   * التسطيح في الخدمة عمداً: الصفحات تحمل الأسئلة داخل كتلها (فتُحرَّر مع سياقها)، والصفحة
   * الرئيسية تحتاج قائمةً مسطَّحة لتبني قسم الأسئلة و**JSON-LD** من نفس المصدر.
   */
  async publicFaq(limit = 12): Promise<PublicFaq[]> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT p.slug, b.content
            FROM content_blocks b
            JOIN content_pages p ON p.id = b.page_id
           WHERE b.kind = 'faq' AND p.${publishedWhere}
           ORDER BY p.published_at DESC, b.position ASC
           LIMIT 40
        `)
      ).rows as unknown as Array<{ slug: string; content: { ar?: { items?: Array<{ question: string; answer: string }> } } }>;

      const out: PublicFaq[] = [];
      for (const row of rows) {
        for (const item of row.content?.ar?.items ?? []) {
          if (typeof item?.question === 'string' && typeof item?.answer === 'string') {
            out.push({ slug: row.slug, question: item.question, answer: item.answer });
          }
        }
      }
      return out.slice(0, limit);
    });
  }

  /** `GET /public/sitemap` — ما يُبنى به `sitemap.xml`: منشورٌ فقط، بلغاته. */
  async publicSitemap(): Promise<ContentSitemapRow[]> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT slug, kind, updated_at::text AS updated_at, title_en, published_at::text AS published_at
            FROM content_pages
           WHERE ${publishedWhere}
           ORDER BY published_at DESC
        `)
      ).rows as unknown as Array<{
        slug: string;
        kind: string;
        updated_at: string;
        title_en: string | null;
        published_at: string | null;
      }>;
      return rows.map((row) => ({
        path: contentPathOf(row.kind as PublicPost['kind'], row.slug),
        kind: row.kind as PublicPost['kind'],
        lastModified: row.updated_at,
        locales: row.title_en === null ? (['ar'] as ContentLocale[]) : (['ar', 'en'] as ContentLocale[]),
      }));
    });
  }

  /** `GET /public/banners` — كل لافتةٍ معروضة الآن (الرأس يعرض الأولى، والصفحات قد تعرض الكل). */
  async publicBanners(): Promise<ContentBanner[]> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
            FROM content_banners
           WHERE active = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
           ORDER BY starts_at DESC
        `)
      ).rows as unknown as Parameters<ContentService['bannerFrom']>[0][];
      return rows.map((row) => this.bannerFrom(row, true));
    });
  }

  // ================================================================== لوحة المنصّة

  async listPages(query: ContentPageListQuery): Promise<ListEnvelope<ContentPage>> {
    await this.publishDue();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const kind = query.filter?.kind ?? null;
      const status = query.filter?.status ?? null;
      const category = query.filter?.category ?? null;
      const needle = query.q ? `%${query.q}%` : null;
      const order =
        query.sort === 'title'
          ? sql`title_ar ASC`
          : query.sort === 'published'
            ? sql`published_at DESC NULLS LAST, updated_at DESC`
            : sql`updated_at DESC`;

      const rows = (
        await tx.execute(sql`
          SELECT ${this.selectPageColumns} FROM content_pages
           WHERE (${kind}::text IS NULL OR kind = ${kind})
             AND (${status}::text IS NULL OR status = ${status})
             AND (${category}::text IS NULL OR category = ${category})
             AND (${needle}::text IS NULL OR title_ar ILIKE ${needle} OR title_en ILIKE ${needle} OR slug ILIKE ${needle})
           ORDER BY ${order}
           LIMIT ${query.limit} OFFSET ${query.offset}
        `)
      ).rows as unknown as PageRow[];

      const totalRow = (
        await tx.execute(sql`
          SELECT count(*)::int AS total FROM content_pages
           WHERE (${kind}::text IS NULL OR kind = ${kind})
             AND (${status}::text IS NULL OR status = ${status})
             AND (${category}::text IS NULL OR category = ${category})
             AND (${needle}::text IS NULL OR title_ar ILIKE ${needle} OR title_en ILIKE ${needle} OR slug ILIKE ${needle})
        `)
      ).rows as unknown as Array<{ total: number }>;

      return listEnvelope(rows.map((row) => this.pageFrom(row)), {
        total: totalRow[0]?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
      });
    });
  }

  async getPage(id: string): Promise<ContentPageDetail> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const page = await this.pageById(tx, id);
      if (!page) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);
      const blocks = await this.blocksOf(tx, page.id);
      return this.detailOf(tx, page, blocks);
    });
  }

  async createPage(input: ContentPageCreate): Promise<ContentPageDetail> {
    const auth = getAuthContext();
    const id = newId();
    const status = input.status === 'published' ? 'published' : input.status === 'scheduled' ? 'scheduled' : 'draft';
    if (status === 'scheduled' && !input.publishAt) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'الجدولة تحتاج وقتاً (publishAt)', 422, {
        field: 'publishAt',
      });
    }
    const publishAt = status === 'scheduled' ? input.publishAt! : status === 'published' ? input.publishAt ?? null : null;
    const publishedAt = status === 'published' ? new Date().toISOString() : null;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const duplicate = (
        await tx.execute(sql`SELECT id FROM content_pages WHERE slug = ${input.slug}`)
      ).rows as Array<{ id: string }>;
      if (duplicate.length > 0) {
        throw new DomainError(errorCodes.CONTENT_SLUG_TAKEN, `الرابط «${input.slug}» مستعمل في صفحةٍ أخرى`, 409, {
          field: 'slug',
        });
      }

      await tx.execute(sql`
        INSERT INTO content_pages (
          id, slug, kind, title_ar, title_en, summary_ar, summary_en, default_locale, status,
          publish_at, published_at, seo_title_ar, seo_title_en, seo_desc_ar, seo_desc_en, og_image_url,
          category, author_name, variant_of, variant_key, created_by, updated_by
        ) VALUES (
          ${id}, ${input.slug}, ${input.kind}, ${input.titleAr}, ${input.titleEn ?? null},
          ${input.summaryAr ?? null}, ${input.summaryEn ?? null}, ${input.defaultLocale}, ${status},
          ${publishAt}::timestamptz, ${publishedAt}::timestamptz,
          ${input.seoTitleAr ?? null}, ${input.seoTitleEn ?? null}, ${input.seoDescAr ?? null}, ${input.seoDescEn ?? null},
          ${input.ogImageUrl ?? null}, ${input.category ?? null}, ${input.authorName ?? null},
          ${input.variantOf ?? null}::uuid, ${input.variantKey ?? null},
          ${auth.userId ?? null}::uuid, ${auth.userId ?? null}::uuid
        )
      `);
      await this.writeBlocks(tx, id, input.blocks);
      const snapshot = await this.snapshotOf(tx, id);
      await this.saveVersion(tx, id, snapshot, 'إنشاء الصفحة', auth.userId);
      // مهمّةٌ بوقتها: مع عاملٍ تُنشر في اللحظة، وبلا عاملٍ يكفلها مسح `publishDue` (idempotent).
      if (status === 'scheduled' && publishAt) await this.scheduleInTx(tx, id, publishAt);

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: status === 'scheduled' ? contentAuditActions.SCHEDULED : contentAuditActions.CREATED,
        entity: 'content_page',
        entityId: id,
        after: { slug: input.slug, kind: input.kind, status, blocks: input.blocks.length },
      });

      const page = await this.pageById(tx, id);
      const blocks = await this.blocksOf(tx, id);
      return this.detailOf(tx, page!, blocks);
    });
  }

  async updatePage(id: string, input: ContentPageUpdate): Promise<ContentPageDetail> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.pageById(tx, id);
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);

      // النسخة قبل الكتابة: لو فشل ما بعدها تبقى الصورة صالحة للاستعادة.
      const snapshot = await this.snapshotOf(tx, id);
      await this.saveVersion(tx, id, snapshot, input.note ?? 'قبل تعديل', auth.userId);

      await tx.execute(sql`
        UPDATE content_pages SET
          title_ar = ${input.titleAr ?? current.title_ar},
          title_en = ${input.titleEn === undefined ? current.title_en : input.titleEn},
          summary_ar = ${input.summaryAr === undefined ? current.summary_ar : input.summaryAr},
          summary_en = ${input.summaryEn === undefined ? current.summary_en : input.summaryEn},
          default_locale = ${input.defaultLocale ?? current.default_locale},
          category = ${input.category === undefined ? current.category : input.category},
          author_name = ${input.authorName === undefined ? current.author_name : input.authorName},
          seo_title_ar = ${input.seoTitleAr === undefined ? current.seo_title_ar : input.seoTitleAr},
          seo_title_en = ${input.seoTitleEn === undefined ? current.seo_title_en : input.seoTitleEn},
          seo_desc_ar = ${input.seoDescAr === undefined ? current.seo_desc_ar : input.seoDescAr},
          seo_desc_en = ${input.seoDescEn === undefined ? current.seo_desc_en : input.seoDescEn},
          og_image_url = ${input.ogImageUrl === undefined ? current.og_image_url : input.ogImageUrl},
          -- نسخةٌ تُفصل عن أصلها (variantOf فارغ) أو يُبدَّل حرفها؛ والإغفال يُبقيها كما هي.
          variant_of = ${input.variantOf === undefined ? current.variant_of : input.variantOf}::uuid,
          variant_key = ${input.variantKey === undefined ? current.variant_key : input.variantKey},
          updated_at = now(),
          updated_by = ${auth.userId ?? null}::uuid
        WHERE id = ${id}::uuid
      `);
      if (input.blocks !== undefined) await this.writeBlocks(tx, id, input.blocks);

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.UPDATED,
        entity: 'content_page',
        entityId: id,
        before: { titleAr: current.title_ar, blocks: current.block_count },
        after: { titleAr: input.titleAr ?? current.title_ar, blocks: input.blocks?.length ?? current.block_count, note: input.note ?? null },
      });

      const page = await this.pageById(tx, id);
      const blocks = await this.blocksOf(tx, id);
      return this.detailOf(tx, page!, blocks);
    });
  }

  /** نشرٌ فوري أو جدولة — والقاعدة تمنع `scheduled` بلا وقت. */
  async publishPage(id: string, at: string | null, note?: string): Promise<ContentPageDetail> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.pageById(tx, id);
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);
      const snapshot = await this.snapshotOf(tx, id);
      await this.saveVersion(tx, id, snapshot, note ?? 'قبل النشر', auth.userId);

      if (at) {
        await tx.execute(sql`
          UPDATE content_pages SET status = 'scheduled', publish_at = ${at}::timestamptz,
                 published_at = NULL, updated_at = now(), updated_by = ${auth.userId ?? null}::uuid
           WHERE id = ${id}::uuid
        `);
        await this.scheduleInTx(tx, id, at);
      } else {
        await tx.execute(sql`
          UPDATE content_pages SET status = 'published', published_at = COALESCE(published_at, now()),
                 publish_at = NULL, updated_at = now(), updated_by = ${auth.userId ?? null}::uuid
           WHERE id = ${id}::uuid
        `);
      }

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: at ? contentAuditActions.SCHEDULED : contentAuditActions.PUBLISHED,
        entity: 'content_page',
        entityId: id,
        before: { status: current.status },
        after: { status: at ? 'scheduled' : 'published', at: at ?? null, slug: current.slug },
      });

      const page = await this.pageById(tx, id);
      const blocks = await this.blocksOf(tx, id);
      return this.detailOf(tx, page!, blocks);
    });
  }

  /**
   * جدولةُ النشر داخل معاملة الكاتب: صفٌّ في `outbox_jobs` بوقت التنفيذ.
   *
   * الاختيار بين الطابور والمسح ليس إمّا-أو: **الطابور يوقظ**، **والمسح يكفل**. ومعاملات
   * السبيكات ونسخةُ التشغيل على حاسوبٍ بلا Redis لا عاملَ فيها، فلو كان الطابور وحده لَما
   * نُشر شيء — ولذلك يُنادى `publishDue` قبل كل قراءةٍ عامّة.
   */
  private async scheduleInTx(tx: DrizzleTx, pageId: string, at: string): Promise<void> {
    await this.outbox.enqueueInTx(tx, {
      tenantId: await this.platformTenantIdInTx(tx),
      queue: 'maintenance',
      type: jobTypes.CONTENT_PUBLISH,
      payload: { pageId },
      runAt: new Date(at),
    });
  }

  private async platformTenantIdInTx(tx: DrizzleTx): Promise<string> {
    const rows = (
      await tx.execute(
        sql`SELECT id FROM tenants WHERE code = ${process.env.PLATFORM_TENANT_CODE ?? 'platform'} LIMIT 1`,
      )
    ).rows as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) throw new DomainError(errorCodes.NOT_FOUND, 'لم تُوجد منشأة المشغّلين', 500);
    return String(id);
  }

  /**
   * **نشر ما استحقّ وقته** — يعيد عدد ما نُشر. يُنادى قبل كل قراءةٍ عامّة ومن معالج المهمّة.
   *
   * لا يرمي: فشلُ صفحةٍ واحدة لا يُسقط قراءة صفحةٍ أخرى، والسطر في السجلّ يكفي للتشخيص.
   * والنشر نفسه **idempotent**: شرط `status = 'scheduled'` يجعل نداءً ثانياً بلا أثر.
   */
  async publishDue(now = new Date()): Promise<number> {
    const due = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id FROM content_pages
           WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ${now}
           ORDER BY publish_at
           LIMIT 20
        `)
      ).rows as Array<{ id: string }>;
      return rows.map((row) => String(row.id));
    });

    let published = 0;
    for (const id of due) {
      try {
        await this.publishNow(id, 'نشرٌ مجدول استحقّ وقته');
        published += 1;
      } catch (error) {
        console.warn(
          `[content] scheduled publish failed for ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return published;
  }

  /**
   * مدخل معالج المهمّة (`content.publish`): ينشر صفحةً مجدولة في وقتها.
   * الرسالة قد تصل متأخّرة أو مكرّرة — وشرط `publish_at <= now()` يجعل التكرار بلا أثر.
   */
  async publishFromJob(context: { payload: Record<string, unknown> }): Promise<void> {
    const pageId = context.payload.pageId;
    if (typeof pageId !== 'string' || pageId.length === 0) return;
    const due = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id FROM content_pages
           WHERE id = ${pageId}::uuid AND status = 'scheduled'
             AND publish_at IS NOT NULL AND publish_at <= now()
        `)
      ).rows as Array<{ id: string }>;
      return rows.length > 0;
    });
    if (!due) return;
    await this.publishNow(pageId, 'نشرٌ مجدول وصل وقته');
  }

  /**
   * قلبُ الحالة إلى `published` — من الجدولة وحدها (لا يُستدعى من مسارٍ في اللوحة، فذاك
   * `publishPage` الذي يُدقَّق باسم فاعله). والفاعل `null` مقصود: **النظام نشر، لا إنسان** —
   * وقارئ التدقيق يجب أن يرى الفرق بين من ضغط ومن استحقّ وقته.
   */
  private async publishNow(pageId: string, note: string): Promise<void> {
    const actor = tryGetAuthContext()?.userId ?? null;
    await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.pageById(tx, pageId);
      if (!current || current.status !== 'scheduled') return;
      const snapshot = await this.snapshotOf(tx, pageId);
      await this.saveVersion(tx, pageId, snapshot, 'قبل النشر المجدول', actor ?? undefined);
      await tx.execute(sql`
        UPDATE content_pages
           SET status = 'published', published_at = COALESCE(publish_at, now()), publish_at = NULL,
               updated_at = now()
         WHERE id = ${pageId}::uuid AND status = 'scheduled'
      `);
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: actor,
        actorLabel: actor ? await this.actorLabel(tx, actor) : 'نظام الجدولة',
        action: contentAuditActions.PUBLISHED,
        entity: 'content_page',
        entityId: pageId,
        before: { status: 'scheduled', publishAt: current.publish_at ?? null },
        after: { status: 'published', slug: current.slug, scheduled: true },
        meta: { reason: note },
      });
    });
  }

  /**
   * السحب: صفحةٌ منشورة تعود مسوّدة **بسببٍ مكتوب**. ولا حذف — الرابط يبقى محجوزاً كي لا
   * ينتقل إلى صفحةٍ أخرى فيصير رابطٌ قديم يشير إلى محتوى آخر.
   */
  async retractPage(id: string, reason: string): Promise<ContentPageDetail> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.pageById(tx, id);
      if (!current) throw new DomainError(errorCodes.NOT_FOUND, 'الصفحة غير موجودة', 404);
      if (current.status === 'draft') {
        throw new DomainError(errorCodes.INVALID_STATE, 'الصفحة مسوّدة أصلاً', 409);
      }
      const snapshot = await this.snapshotOf(tx, id);
      await this.saveVersion(tx, id, snapshot, `قبل السحب: ${reason}`, auth.userId);
      await tx.execute(sql`
        UPDATE content_pages SET status = 'draft', publish_at = NULL, published_at = NULL,
               updated_at = now(), updated_by = ${auth.userId ?? null}::uuid
         WHERE id = ${id}::uuid
      `);
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.RETRACTED,
        entity: 'content_page',
        entityId: id,
        before: { status: current.status },
        after: { status: 'draft', reason, slug: current.slug },
      });
      const page = await this.pageById(tx, id);
      const blocks = await this.blocksOf(tx, id);
      return this.detailOf(tx, page!, blocks);
    });
  }

  async listVersions(pageId: string): Promise<ContentVersion[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id, page_id, version, note, snapshot, created_by, created_at::text AS created_at
            FROM content_versions WHERE page_id = ${pageId}::uuid ORDER BY version DESC LIMIT 50
        `)
      ).rows as unknown as VersionRow[];
      return rows.map((row) => ({
        id: row.id,
        pageId: row.page_id,
        version: row.version,
        note: row.note,
        blockCount: Array.isArray(row.snapshot?.blocks) ? row.snapshot.blocks.length : 0,
        pageStatus: (String(row.snapshot?.page?.status ?? 'draft') as ContentVersion['pageStatus']),
        titleAr: String(row.snapshot?.page?.title_ar ?? ''),
        createdBy: row.created_by,
        createdAt: row.created_at,
      }));
    });
  }

  /**
   * استعادة نسخة: تُكتب الصفحة وكتلها من اللقطة، **وتُحفظ نسخةٌ جديدة** بالحالة التي كانت
   * قائمة قبل الاستعادة. فالاستعادة ليست تراجعاً يمحو، بل خطوةٌ إلى الأمام لها تاريخ.
   */
  async restoreVersion(pageId: string, version: number, note?: string): Promise<ContentPageDetail> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(
          sql`SELECT snapshot FROM content_versions WHERE page_id = ${pageId}::uuid AND version = ${version}`,
        )
      ).rows as Array<{ snapshot: { page?: Record<string, unknown>; blocks?: Array<Record<string, unknown>> } }>;
      const found = rows[0];
      if (!found) throw new DomainError(errorCodes.NOT_FOUND, `النسخة ${version} غير موجودة`, 404);

      const before = await this.snapshotOf(tx, pageId);
      await this.saveVersion(tx, pageId, before, note ?? `قبل استعادة النسخة ${version}`, auth.userId);

      const page = found.snapshot.page ?? {};
      await tx.execute(sql`
        UPDATE content_pages SET
          title_ar = ${String(page.title_ar ?? '')},
          title_en = ${page.title_en === null || page.title_en === undefined ? null : String(page.title_en)},
          summary_ar = ${page.summary_ar === null || page.summary_ar === undefined ? null : String(page.summary_ar)},
          summary_en = ${page.summary_en === null || page.summary_en === undefined ? null : String(page.summary_en)},
          default_locale = ${String(page.default_locale ?? 'ar')},
          seo_title_ar = ${page.seo_title_ar === null || page.seo_title_ar === undefined ? null : String(page.seo_title_ar)},
          seo_title_en = ${page.seo_title_en === null || page.seo_title_en === undefined ? null : String(page.seo_title_en)},
          seo_desc_ar = ${page.seo_desc_ar === null || page.seo_desc_ar === undefined ? null : String(page.seo_desc_ar)},
          seo_desc_en = ${page.seo_desc_en === null || page.seo_desc_en === undefined ? null : String(page.seo_desc_en)},
          og_image_url = ${page.og_image_url === null || page.og_image_url === undefined ? null : String(page.og_image_url)},
          category = ${page.category === null || page.category === undefined ? null : String(page.category)},
          author_name = ${page.author_name === null || page.author_name === undefined ? null : String(page.author_name)},
          updated_at = now(), updated_by = ${auth.userId ?? null}::uuid
         WHERE id = ${pageId}::uuid
      `);
      await this.writeBlocks(
        tx,
        pageId,
        (found.snapshot.blocks ?? []).map((block) => ({
          position: Number(block.position ?? 0),
          kind: block.kind as ContentBlockKind,
          content: block.content as { ar: unknown; en?: unknown },
        })),
      );

      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.RESTORED,
        entity: 'content_page',
        entityId: pageId,
        after: { version, note: note ?? null },
      });

      const restored = await this.pageById(tx, pageId);
      const blocks = await this.blocksOf(tx, pageId);
      return {
        ...this.pageFrom(restored!),
        translatedLocales: this.translatedLocales(restored!, blocks),
        blocks: blocks.map((b) => this.blockFrom(b)),
        variants: await this.variantsOf(tx, restored!.id),
      };
    });
  }

  // ── القوائم

  async listMenus(): Promise<ContentMenu[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`SELECT id, position, items, updated_at::text AS updated_at, updated_by FROM content_menus`)
      ).rows as unknown as Array<{
        id: string;
        position: string;
        items: unknown;
        updated_at: string;
        updated_by: string | null;
      }>;
      return (['header', 'footer', 'sidebar', 'legal', 'social'] as ContentMenuPosition[]).map((position) =>
        this.menuFrom(rows.find((row) => row.position === position), position),
      );
    });
  }

  /** كتابة قائمة: إدراجٌ أو تحديث بالمفتاح (لا معرّف من الشاشة — الموضع هو المفتاح الطبيعي). */
  async updateMenu(position: ContentMenuPosition, items: ContentMenu['items']): Promise<ContentMenu> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = (
        await tx.execute(sql`SELECT id FROM content_menus WHERE position = ${position}`)
      ).rows as Array<{ id: string }>;
      if (existing[0]) {
        await tx.execute(sql`
          UPDATE content_menus SET items = ${JSON.stringify(items)}::jsonb, updated_at = now(),
                 updated_by = ${auth.userId ?? null}::uuid
           WHERE position = ${position}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO content_menus (id, position, items, updated_by)
          VALUES (${newId()}, ${position}, ${JSON.stringify(items)}::jsonb, ${auth.userId ?? null}::uuid)
        `);
      }
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.MENU_UPDATED,
        entity: 'content_menu',
        entityId: position,
        after: { position, items: items.length },
      });
      const row = (
        await tx.execute(
          sql`SELECT id, position, items, updated_at::text AS updated_at, updated_by FROM content_menus WHERE position = ${position}`,
        )
      ).rows as unknown as Array<{
        id: string;
        position: string;
        items: unknown;
        updated_at: string;
        updated_by: string | null;
      }>;
      return this.menuFrom(row[0], position);
    });
  }

  // ── اللافتات

  async listBanners(): Promise<ContentBanner[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const now = Date.now();
      const rows = (
        await tx.execute(sql`
          SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
            FROM content_banners ORDER BY created_at DESC LIMIT 100
        `)
      ).rows as unknown as Array<Parameters<ContentService['bannerFrom']>[0]>;
      return rows.map((row) => this.bannerFrom(row, this.bannerIsLive(row, now)));
    });
  }

  async createBanner(input: ContentBannerCreate): Promise<ContentBanner> {
    const auth = getAuthContext();
    const startsAt = input.startsAt ?? new Date().toISOString();
    if (input.endsAt != null && new Date(input.endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'نهاية اللافتة يجب أن تكون بعد بدايتها', 422, {
        field: 'endsAt',
      });
    }
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const id = newId();
      await tx.execute(sql`
        INSERT INTO content_banners (id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                                     starts_at, ends_at, active, created_by)
        VALUES (${id}, ${input.textAr}, ${input.textEn ?? null}, ${input.href ?? null},
                ${input.linkLabelAr ?? null}, ${input.linkLabelEn ?? null}, ${input.tone}, ${input.audience},
                ${startsAt}::timestamptz, ${input.endsAt ?? null}::timestamptz,
                ${input.active}, ${auth.userId ?? null}::uuid)
      `);
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.BANNER_CREATED,
        entity: 'content_banner',
        entityId: id,
        after: { textAr: input.textAr, tone: input.tone, audience: input.audience },
      });
      const row = (
        await tx.execute(sql`
          SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
            FROM content_banners WHERE id = ${id}::uuid
        `)
      ).rows as unknown as Array<Parameters<ContentService['bannerFrom']>[0]>;
      // `live` يُحسب ولا يُفترض: لافتةٌ تُنشأ بنافذةٍ منتهية تُردّ `live: false` في اللحظة
      // نفسها، فلا تظنّها الشاشة معروضة (خطأٌ أُمسك في `platform-content.spec.ts`).
      return this.bannerFrom(row[0]!, this.bannerIsLive(row[0]!));
    });
  }

  async updateBanner(id: string, input: ContentBannerUpdate): Promise<ContentBanner> {
    const auth = getAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = (
        await tx.execute(sql`
          SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
            FROM content_banners WHERE id = ${id}::uuid
        `)
      ).rows as unknown as Array<Parameters<ContentService['bannerFrom']>[0]>;
      const row = current[0];
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'اللافتة غير موجودة', 404);

      // النافذة الفعّالة بعد التعديل — لا المُرسلة وحدها: تعديلٌ يُرسل `endsAt` وحده يجب أن
      // يُقارَن بـ`starts_at` المخزّن، وإلا مرّ التعديل من المدقّقة وسقط في قيد القاعدة (500).
      const startsAt =
        (input.startsAt === undefined ? row.starts_at : input.startsAt) ?? new Date().toISOString();
      const endsAt = input.endsAt === undefined ? row.ends_at : input.endsAt;
      if (endsAt !== null && endsAt !== undefined && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'نهاية اللافتة يجب أن تكون بعد بدايتها', 422, {
          field: 'endsAt',
        });
      }

      await tx.execute(sql`
        UPDATE content_banners SET
          text_ar = ${input.textAr ?? row.text_ar},
          text_en = ${input.textEn === undefined ? row.text_en : input.textEn},
          href = ${input.href === undefined ? row.href : input.href},
          link_label_ar = ${input.linkLabelAr === undefined ? row.link_label_ar : input.linkLabelAr},
          link_label_en = ${input.linkLabelEn === undefined ? row.link_label_en : input.linkLabelEn},
          tone = ${input.tone ?? row.tone},
          audience = ${input.audience ?? row.audience},
          starts_at = ${startsAt}::timestamptz,
          ends_at = ${endsAt}::timestamptz,
          active = ${input.active === undefined ? row.active : input.active},
          updated_at = now()
        WHERE id = ${id}::uuid
      `);
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: auth.userId,
        actorLabel: auth.userId ? await this.actorLabel(tx, auth.userId) : null,
        action: contentAuditActions.BANNER_UPDATED,
        entity: 'content_banner',
        entityId: id,
        before: { textAr: row.text_ar, active: row.active },
        after: { textAr: input.textAr ?? row.text_ar, active: input.active ?? row.active },
      });
      // القراءة **داخل نفس المعاملة**: قراءةُ `listBanners` هنا تفتح معاملةً أخرى لا ترى
      // التعديل قبل الإيداع، فيُعاد الصفّ القديم ويبدو التعديل كأنه لم يقع (خطأٌ أُمسك في
      // `platform-content.spec.ts`: الإيقاف يردّ 200 و`active` ما زال true).
      const after = (
        await tx.execute(sql`
          SELECT id, text_ar, text_en, href, link_label_ar, link_label_en, tone, audience,
                 starts_at::text AS starts_at, ends_at::text AS ends_at, active, created_at::text AS created_at
            FROM content_banners WHERE id = ${id}::uuid
        `)
      ).rows as unknown as Array<Parameters<ContentService['bannerFrom']>[0]>;
      return this.bannerFrom(after[0]!, this.bannerIsLive(after[0]!));
    });
  }

  /** هل اللافتة معروضة الآن؟ — حسابٌ واحد، فالشاشة والموقع يقولان الشيء نفسه. */
  private bannerIsLive(row: Parameters<ContentService['bannerFrom']>[0], now = Date.now()): boolean {
    return (
      row.active &&
      new Date(row.starts_at).getTime() <= now &&
      (row.ends_at === null || new Date(row.ends_at).getTime() > now)
    );
  }

  /** تصنيفات المدوّنة ومقالات المساعدة — تُشتقّ من المحتوى لا من قائمةٍ مكتوبة في الشاشة. */
  async categories(): Promise<{ blog: string[]; help: string[] }> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT kind, category FROM content_pages
           WHERE category IS NOT NULL AND ${publishedWhere}
           ORDER BY category ASC
        `)
      ).rows as unknown as Array<{ kind: string; category: string }>;
      const unique = (kind: string) => [...new Set(rows.filter((row) => row.kind === kind).map((row) => row.category))];
      return { blog: unique('post'), help: unique('help') };
    });
  }
}
