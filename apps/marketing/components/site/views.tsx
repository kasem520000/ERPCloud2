/**
 * P-M1 · P-M2 — أجسام الصفحات.
 *
 * كل صفحةٍ هنا مكوّنٌ **خادميّ** يأخذ لغته وبيناته من ملفّ مسارٍ رفيع (thin route)؛
 * فملفّات الصفحات تبقى أسطراً قليلة، والمنطق واحد لا يُكرَّر بين `/blog` و`/en/blog`.
 *
 * وقاعدة الخطّة §3.1 محفوظة في كل قسم: **لا رقمٌ ولا شهادةٌ مخترعة**. الأقسام التي مصدرها
 * نظام المحتوى (آراء، أسئلة، مقالات) تُخفي نفسها حين لا محتوى؛ والأقسام التي مصدرها المنتج
 * (الوحدات، الخطوات) تسمياتُها من شجرة `apps/staff` مع ذكر الملف والسطر في `lib/modules.ts`.
 */

import Link from 'next/link';

import {
  summaryFor,
  titleFor,
  type ContentPageDetail,
  type ContentPageSummary,
  type FaqItem,
  type HelpArticle,
  type SiteStatus,
} from '../../lib/content';
import {
  changelogByMonth,
  changelogVersionOf,
  helpCategoryChips,
  latencyLabel,
  readableDate,
  statusToneClass,
  uptimeLabel,
  type HelpCategory,
} from '../../lib/help';
import { t, type Locale } from '../../lib/i18n';
import { industries, industryPath, INDUSTRIES_PATH, type Industry } from '../../lib/industries';
import { einvoicingPoints, onboardingSteps, siteModules } from '../../lib/modules';
import { trustAxes, trustLimitsAr } from '../../lib/trust';
import { hrefFor, SITE_PATHS } from '../../lib/site';

import { CountUp } from './count-up';
import { ContentBlocks } from './blocks';
import { HelpfulVote } from './helpful-vote';
import { HeroExperiment } from './hero-experiment';
import { Marquee } from './marquee';
import { Reveal } from './reveal';
import { Breadcrumbs, EmptyState, FaqList, ModuleCard, PostCard, SectionHeading, StepList } from './pieces';

type ShellLike = { taglineAr: string; taglineEn: string; brandName: string };

export function HomeView({
  locale,
  shell,
  faq,
  cases,
}: {
  locale: Locale;
  shell: ShellLike;
  faq: FaqItem[];
  cases: ContentPageSummary[];
}) {
  const l = (path: string) => hrefFor(path, locale);
  // عنوان البطل من **إعدادات الموقع** (`site.tagline_ar` في `/public/site`) لا من نصٍّ في
  // الكود: تغييره من شاشة الإعدادات في اللوحة يكفي، بلا نشرة.
  const heroTitle = locale === 'en' ? shell.taglineEn : shell.taglineAr;

  // أرقام شريط الإحصاء كلها حقيقية ومصدرها محتوى/بنى هذا الموقع: عدد الوحدات، عدد خطوات
  // البدء، ودراسات الحالة والأسئلة المنشورة — لا رقمٌ مفترض (§3.1).
  const stats = [
    { value: siteModules.length, label: t(locale, 'home.stats.modules') },
    { value: onboardingSteps.length, label: t(locale, 'home.stats.steps') },
    { value: cases.length, label: t(locale, cases.length === 1 ? 'home.stats.cases.one' : 'home.stats.cases') },
    { value: faq.length, label: t(locale, faq.length === 1 ? 'home.stats.faq.one' : 'home.stats.faq') },
  ];

  return (
    <>
      {/* P-M10 — البطل صار مكوّناً عميلياً واحداً: يرسم الأساسية على الخادم (فهي ما يراه
          الزاحف وما يراه الزائر قبل أي جافاسكربت)، ويستبدلها بنسخة أ/ب إن وُجدت تجربةٌ منشورة
          لصفحة `home` في نظام المحتوى. والاختيار والتوزيع في المتصفّح (`pickContentVariant`). */}
      <HeroExperiment
        slug="home"
        title={heroTitle}
        lead={t(locale, 'home.hero.lead')}
        badge={t(locale, 'home.hero.badge')}
        ctaLabel={t(locale, 'cta.start')}
        ctaHref="/onboarding"
        actions={[
          { href: l(SITE_PATHS.features), label: t(locale, 'cta.explore'), className: 'btn ghost' },
        ]}
        facts={[t(locale, 'home.hero.f1'), t(locale, 'home.hero.f2'), t(locale, 'home.hero.f3')]}
      />

      {/* قطاعات الموقع — من `lib/industries` (محتوى ثابت في المستودع) لا شعارات عملاء مخترعة. */}
      <Marquee items={industries} />

      <section className="section">
        <Reveal>
          <SectionHeading
            title={t(locale, 'home.modules.title')}
            subtitle={t(locale, 'home.modules.subtitle')}
            action={{ href: l(SITE_PATHS.features), label: t(locale, 'cta.explore') }}
          />
        </Reveal>
        <div className="grid cols">
          {siteModules.map((module, index) => (
            <Reveal key={module.key} delay={(index % 3) * 90}>
              <ModuleCard module={module} locale={locale} />
            </Reveal>
          ))}
        </div>
      </section>

      {/* شريط الأرقام — كل قيمةٍ محسوبةٌ من محتوى الموقع نفسه. */}
      <section className="stats-band">
        <div className="wrap stats-grid">
          {stats.map((stat, index) => (
            <Reveal key={stat.label} delay={index * 80} as="div" className="stat">
              <b>
                <CountUp value={stat.value} />
              </b>
              <span>{stat.label}</span>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section">
        <Reveal>
          <SectionHeading title={t(locale, 'home.steps.title')} />
        </Reveal>
        <StepList steps={onboardingSteps} locale={locale} />
      </section>

      <section className="section einvoicing-band">
        <Reveal>
          <SectionHeading
            title={t(locale, 'home.einvoicing.title')}
            action={{ href: l(SITE_PATHS.einvoicing), label: t(locale, 'cta.readMore') }}
          />
        </Reveal>
        <div className="grid cols">
          {einvoicingPoints.map((point, index) => (
            <Reveal key={point.titleAr} delay={(index % 3) * 90}>
              <article className="card">
                <h3>{locale === 'en' ? point.titleEn : point.titleAr}</h3>
                <p className="muted">{locale === 'en' ? point.bodyEn : point.bodyAr}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <p>
          <Link className="text-link" href={locale === 'ar' ? SITE_PATHS.verify : '/verify'}>
            {locale === 'ar' ? 'تحقّق من فاتورة الآن' : 'Verify an invoice now'}
          </Link>
        </p>
      </section>

      {cases.length > 0 ? (
        <section className="section">
          <Reveal>
            <SectionHeading
              title={t(locale, 'home.cases.title')}
              action={{ href: l(SITE_PATHS.cases), label: t(locale, 'cta.readMore') }}
            />
          </Reveal>
          <div className="grid cols">
            {cases.slice(0, 3).map((item, index) => (
              <Reveal key={item.slug} delay={index * 90}>
                <PostCard post={item} locale={locale} basePath={l(SITE_PATHS.cases)} />
              </Reveal>
            ))}
          </div>
        </section>
      ) : null}

      {faq.length > 0 ? (
        <section className="section">
          <Reveal>
            <SectionHeading title={t(locale, 'home.faq.title')} />
          </Reveal>
          <FaqList items={faq} />
        </section>
      ) : null}

      <section className="section cta-final">
        <Reveal>
          <h2>{t(locale, 'home.final.title')}</h2>
          <p className="muted">{t(locale, 'home.final.body')}</p>
          <div className="toolbar" style={{ justifyContent: 'center' }}>
            <Link className="btn primary" href="/onboarding">
              {t(locale, 'cta.start')}
            </Link>
            <a className="btn" href="mailto:">
              {t(locale, 'cta.talk')}
            </a>
          </div>
        </Reveal>
      </section>
    </>
  );
}

export function FeaturesView({ locale, page }: { locale: Locale; page: ContentPageDetail | null }) {
  return (
    <>
      <header className="page-head">
        <h1>{page ? titleFor(page, locale) : t(locale, 'features.title')}</h1>
        <p className="muted">{page ? summaryFor(page, locale) : t(locale, 'features.subtitle')}</p>
      </header>
      {page && page.blocks.length > 0 ? <ContentBlocks blocks={page.blocks} locale={locale} /> : null}
      <section className="section">
        <div className="grid cols">
          {siteModules.map((module) => (
            <article className="card module-card" key={module.key}>
              <span className="card-icon" aria-hidden="true">
                {module.icon}
              </span>
              <h3>{locale === 'en' ? module.labelEn : module.labelAr}</h3>
              <p className="muted">{locale === 'en' ? module.blurbEn : module.blurbAr}</p>
              <p className="source-line" dir="ltr">
                {module.source}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className="section einvoicing-band">
        <SectionHeading
          title={t(locale, 'einvoicing.title')}
          action={{ href: hrefFor(SITE_PATHS.einvoicing, locale), label: t(locale, 'features.link') }}
        />
      </section>
    </>
  );
}

export function EinvoicingView({ locale, page }: { locale: Locale; page: ContentPageDetail | null }) {
  return (
    <>
      <header className="page-head">
        <h1>{page ? titleFor(page, locale) : t(locale, 'einvoicing.title')}</h1>
        {page ? <p className="muted">{summaryFor(page, locale)}</p> : null}
      </header>
      {page && page.blocks.length > 0 ? (
        <ContentBlocks blocks={page.blocks} locale={locale} />
      ) : (
        <div className="grid cols">
          {einvoicingPoints.map((point) => (
            <article className="card" key={point.titleAr}>
              <h3>{locale === 'en' ? point.titleEn : point.titleAr}</h3>
              <p className="muted">{locale === 'en' ? point.bodyEn : point.bodyAr}</p>
            </article>
          ))}
        </div>
      )}
      <section className="section cta-final">
        <h2>{locale === 'ar' ? 'تحقّق من فاتورة' : 'Verify an invoice'}</h2>
        <p className="muted">
          {locale === 'ar'
            ? 'أدخل رقم الفاتورة أو المسح الضوئي لرمز QR — بلا حساب وبلا بيانات.'
            : 'Enter the invoice number or paste the QR payload — no account needed.'}
        </p>
        <Link className="btn primary" href="/verify">
          {t(locale, 'nav.verify')}
        </Link>
      </section>
    </>
  );
}

export function BlogIndexView({
  locale,
  posts,
  categories,
  activeCategory,
}: {
  locale: Locale;
  posts: ContentPageSummary[];
  categories: string[];
  activeCategory?: string;
}) {
  const base = hrefFor(SITE_PATHS.blog, locale);
  return (
    <>
      <header className="page-head">
        <h1>{t(locale, 'blog.title')}</h1>
        <p className="muted">{t(locale, 'blog.subtitle')}</p>
      </header>
      {categories.length > 0 ? (
        <nav className="chip-row" aria-label={t(locale, 'help.category')}>
          <Link className={activeCategory ? 'chip' : 'chip active'} href={base}>
            {t(locale, 'blog.all')}
          </Link>
          {categories.map((category) => (
            <Link
              className={category === activeCategory ? 'chip active' : 'chip'}
              key={category}
              href={`${base}?category=${encodeURIComponent(category)}`}
            >
              {category}
            </Link>
          ))}
        </nav>
      ) : null}
      {posts.length === 0 ? (
        <EmptyState label={t(locale, 'blog.empty')} />
      ) : (
        <div className="grid cols">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} locale={locale} basePath={base} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * P-M9 — مركز المساعدة: **الفئات أوّلاً ثم البحث ثم القائمة**.
 *
 * والترتيب مقصود: أكثر ما يفعله الزائر في مركز مساعدة هو أن يرى «عندهم بابٌ للتذاكر؟» —
 * فالفئات تُجيب قبل أن يكتب حرفاً. والبحث يبقى الفعل الثاني، ويحمل الفئة المختارة في حقلٍ
 * خفيّ فلا يفقدها من بحث داخل فئة.
 */
export function HelpIndexView({
  locale,
  items,
  meta,
  selected,
  query,
}: {
  locale: Locale;
  items: ContentPageSummary[];
  meta: { total: number; categories: HelpCategory[] };
  selected?: string;
  query?: string;
}) {
  const base = hrefFor(SITE_PATHS.help, locale);
  const chips = helpCategoryChips({ categories: meta.categories, selected, query });
  // الشرائح تُبنى على مسار اللغة: في `/en/help` تعود الرقاقة إلى `/en/help` لا إلى `/help`.
  const localizedChips = chips.map((chip) => ({
    ...chip,
    name: chip.key === '__all__' ? t(locale, 'help.all') : chip.name,
    href: chip.href.startsWith(SITE_PATHS.help) && locale === 'en' ? `/en${chip.href}` : chip.href,
  }));
  return (
    <>
      <header className="page-head">
        <h1>{t(locale, 'help.title')}</h1>
        <p className="muted">{t(locale, 'help.subtitle')}</p>
      </header>
      {localizedChips.length > 1 ? (
        <nav className="chip-row" aria-label={t(locale, 'help.categories')}>
          {localizedChips.map((chip) => (
            <Link className={chip.active ? 'chip active' : 'chip'} key={chip.key} href={chip.href}>
              {chip.name}
              {chip.count !== null ? <span className="chip-count"> {chip.count}</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}
      <form className="search-row" action={base} method="get" role="search">
        <label className="sr-only" htmlFor="help-q">
          {t(locale, 'help.search')}
        </label>
        {selected ? <input type="hidden" name="category" value={selected} /> : null}
        <input
          className="input"
          id="help-q"
          name="q"
          type="search"
          defaultValue={query ?? ''}
          placeholder={t(locale, 'help.search')}
        />
        <button className="btn primary" type="submit">
          {t(locale, 'help.searchCta')}
        </button>
      </form>
      {items.length === 0 ? (
        <EmptyState label={query ? t(locale, 'help.empty') : t(locale, 'help.emptyAll')} />
      ) : (
        <div className="grid cols">
          {items.map((item) => (
            <PostCard key={item.slug} post={item} locale={locale} basePath={base} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * P-M9 — مقالُ مساعدةٍ كامل: الكتل، ثم **«هل أفادك هذا؟»**، ثم المجاورة في الفئة نفسها.
 *
 * والتصويت **بعد** المتن لا قبله: السؤال عن الفائدة يُسأل بعد القراءة. والمجاورة بعده كذلك:
 * من لم يفده المقال يجد أقربَ بديلٍ تحته بلا أن يعود إلى الفهرس.
 */
export function HelpArticleView({ locale, article }: { locale: Locale; article: HelpArticle }) {
  const base = hrefFor(SITE_PATHS.help, locale);
  const page = article.page;
  return (
    <article className="article">
      <Breadcrumbs
        trail={[
          { href: locale === 'ar' ? '/' : '/en', label: locale === 'ar' ? 'الرئيسية' : 'Home' },
          { href: base, label: t(locale, 'help.title') },
        ]}
      />
      <header className="page-head">
        {article.category ? (
          <Link className="pill" href={`${base}?category=${encodeURIComponent(article.category)}`}>
            {article.category}
          </Link>
        ) : null}
        <h1>{titleFor(page, locale)}</h1>
        {summaryFor(page, locale) ? <p className="muted">{summaryFor(page, locale)}</p> : null}
      </header>
      <ContentBlocks blocks={page.blocks} locale={locale} />
      <HelpfulVote slug={page.slug} locale={locale} yes={article.helpful.yes} no={article.helpful.no} />
      {article.related.length > 0 ? (
        <section className="section">
          <SectionHeading title={t(locale, 'help.related')} />
          <div className="grid cols">
            {article.related.map((item) => (
              <PostCard key={item.slug} post={item} locale={locale} basePath={base} />
            ))}
          </div>
        </section>
      ) : null}
      <p className="back-link">
        <Link className="text-link" href={base}>
          ← {t(locale, 'help.title')}
        </Link>
      </p>
    </article>
  );
}

/**
 * P-M9 — `/changelog`: ما تغيّر فعلاً، مجمَّعاً بالشهر.
 *
 * **ولا شارة «جديد» ولا وعد:** كل مدخلٍ هنا صفحةٌ منشورة في نظام المحتوى بتاريخ نشرها، ويُوسَم
 * برقم الإصدار إن بدأ عنوانه به. وما لا يوجد لا يُعرض: القائمة الفارغة تقول «لا تغييرات منشورة
 * بعد» بدل أن تُزيَّن ببنودٍ من العدم.
 */
export function ChangelogView({ locale, entries }: { locale: Locale; entries: ContentPageSummary[] }) {
  const base = hrefFor(SITE_PATHS.changelog, locale);
  const groups = changelogByMonth(entries, locale);
  return (
    <>
      <header className="page-head">
        <h1>{t(locale, 'changelog.title')}</h1>
        <p className="muted">{t(locale, 'changelog.subtitle')}</p>
      </header>
      {groups.length === 0 ? (
        <EmptyState label={t(locale, 'changelog.empty')} />
      ) : (
        groups.map((group) => (
          <section className="section" key={group.key}>
            <SectionHeading title={group.label} />
            <ul className="timeline">
              {group.entries.map((entry) => (
                <li className="timeline-item" key={entry.slug}>
                  <span className="badge">{changelogVersionOf(titleFor(entry, locale)) ?? t(locale, 'changelog.entry')}</span>
                  <div>
                    <Link className="text-link" href={`/${locale === 'en' ? 'en/' : ''}changelog/${entry.slug}`}>
                      {titleFor(entry, locale)}
                    </Link>
                    {summaryFor(entry, locale) ? <p className="muted">{summaryFor(entry, locale)}</p> : null}
                    <p className="small muted">{readableDate(entry.publishedAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="back-link">
        <Link className="text-link" href={base}>
          ← {t(locale, 'changelog.title')}
        </Link>
      </p>
    </>
  );
}

/**
 * P-M9 — `/status`: نفس مجسّات اللوحة، بلا تفاصيلها.
 *
 * **والفشل يُقال**: إن تعذّر قراءة الحالة (`status === null`) تعرض الصفحة «تعذّر القياس» ولا
 * تخترع «تعمل». وهذا الفرق نفسه الذي يحكم بقيّة الموقع: صفحةٌ تقول «لا أعرف» أنفع من صفحةٍ
 * تُطمئن زوراً.
 */
export function StatusView({ locale, status }: { locale: Locale; status: SiteStatus | null }) {
  return (
    <>
      <header className="page-head">
        <h1>{t(locale, 'status.title')}</h1>
        <p className="muted">{t(locale, 'status.subtitle')}</p>
      </header>
      {!status ? (
        <div className="banner tone-warn" role="status">
          {t(locale, 'status.unavailable')}
        </div>
      ) : (
        <>
          <p className="status-line">
            <span className={statusToneClass(status.statusTone)}>
              {locale === 'en' ? status.statusLabelEn : status.statusLabelAr}
            </span>
            <span className="small muted">
              {t(locale, 'status.checkedAt')}: {status.checkedAt.slice(0, 19).replace('T', ' ')} UTC ·{' '}
              {t(locale, 'status.uptime')}: {uptimeLabel(status.uptimeSeconds, locale)}
            </span>
          </p>
          {status.incident ? (
            <div className="banner tone-warn" role="status">
              <strong>{t(locale, 'status.incident')}:</strong>{' '}
              {status.incident.message ?? t(locale, 'status.noIncident')}
            </div>
          ) : (
            <p className="small muted">{t(locale, 'status.noIncident')}</p>
          )}
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{t(locale, 'status.components')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(locale, 'status.component')}</th>
                  <th scope="col">{t(locale, 'status.state')}</th>
                  <th scope="col">{t(locale, 'status.what')}</th>
                </tr>
              </thead>
              <tbody>
                {status.components.map((component) => {
                  const level = component.status;
                  const label =
                    level === 'up'
                      ? { ar: 'تعمل', en: 'Operational' }
                      : level === 'degraded'
                        ? { ar: 'تعمل ببطء', en: 'Degraded' }
                        : level === 'down'
                          ? { ar: 'متوقّفة', en: 'Down' }
                          : { ar: 'غير مُهيّأة', en: 'Not configured' };
                  const tone =
                    level === 'up' ? 'ready' : level === 'degraded' ? 'pending' : level === 'down' ? 'failed' : 'muted';
                  const latency = latencyLabel(component.latencyMs, locale);
                  return (
                    <tr key={component.key}>
                      <th scope="row">{locale === 'en' ? component.labelEn : component.labelAr}</th>
                      <td>
                        <span className={statusToneClass(tone as 'ready' | 'pending' | 'failed' | 'muted')}>
                          {locale === 'en' ? label.en : label.ar}
                        </span>
                        {latency ? <span className="small muted"> · {latency}</span> : null}
                      </td>
                      <td className="muted">
                        {locale === 'en' ? component.whatEn : component.whatAr}
                        <br />
                        <span className="small">{locale === 'en' ? component.noteEn : component.noteAr}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">{locale === 'en' ? status.noteEn : status.noteAr}</p>
        </>
      )}
    </>
  );
}

export function ArticleView({
  locale,
  page,
  basePath,
  baseLabel,
  trail,
}: {
  locale: Locale;
  page: ContentPageDetail;
  basePath: string;
  baseLabel: string;
  trail?: Array<{ href: string; label: string }>;
}) {
  return (
    <article className="article">
      <Breadcrumbs trail={trail ?? [{ href: locale === 'ar' ? '/' : '/en', label: locale === 'ar' ? 'الرئيسية' : 'Home' }, { href: basePath, label: baseLabel }]} />
      <header className="page-head">
        {page.category ? <span className="pill">{page.category}</span> : null}
        <h1>{titleFor(page, locale)}</h1>
        <p className="meta-line">
          {page.authorName ? <span>{page.authorName}</span> : null}
          {page.publishedAt ? <time dateTime={page.publishedAt}>{page.publishedAt.slice(0, 10)}</time> : null}
        </p>
      </header>
      <ContentBlocks blocks={page.blocks} locale={locale} />
      <p className="back-link">
        <Link className="text-link" href={basePath}>
          ← {baseLabel}
        </Link>
      </p>
    </article>
  );
}

export function LegalView({ locale, page }: { locale: Locale; page: ContentPageDetail }) {
  return (
    <article className="article legal">
      <h1>{titleFor(page, locale)}</h1>
      {page.blocks.length > 0 ? <ContentBlocks blocks={page.blocks} locale={locale} /> : null}
    </article>
  );
}

export function CasesIndexView({ locale, cases }: { locale: Locale; cases: ContentPageSummary[] }) {
  const base = hrefFor(SITE_PATHS.cases, locale);
  return (
    <>
      <header className="page-head">
        <h1>{t(locale, 'cases.title')}</h1>
      </header>
      {cases.length === 0 ? (
        <EmptyState label={t(locale, 'cases.empty')} />
      ) : (
        <div className="grid cols">
          {cases.map((item) => (
            <PostCard key={item.slug} post={item} locale={locale} basePath={base} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * P-M8 — `/trust`: كل بندٍ ومعه مصدره.
 *
 * والشكل تابعٌ للقرار: البطاقة تحمل **الدليل** في سطرٍ صغير (`source-line`) لا في حاشية، لأن
 * صفحةَ ثقةٍ بلا دليلٍ صفحةُ إعلان. و«ما لا ندّعيه» قسمٌ كامل في آخرها، لا حاشيةً صغيرة: حدُّ
 * المنتج جزءٌ من وصفه.
 *
 * وصفحةُ المحتوى (من نظام إدارة المحتوى) تُعرض **فوق** الأقسام الثابتة إن وُجدت: من كتب نصّاً
 * تحريرياً في اللوحة لا يُنازع الأرقام الثابتة، بل يقدّم لها مقدّمة.
 */
export function TrustView({ locale, page }: { locale: Locale; page: ContentPageDetail | null }) {
  return (
    <>
      <header className="page-head">
        <h1>{page ? titleFor(page, locale) : t(locale, 'trust.title')}</h1>
        <p className="muted">{page ? summaryFor(page, locale) : t(locale, 'trust.subtitle')}</p>
      </header>
      {page && page.blocks.length > 0 ? <ContentBlocks blocks={page.blocks} locale={locale} /> : null}

      {trustAxes.map((axis) => (
        <section className="section" key={axis.key}>
          <SectionHeading title={`${axis.icon} ${axis.titleAr}`} subtitle={axis.leadAr} />
          <div className="grid cols">
            {axis.points.map((point) => (
              <article className="card" key={point.titleAr}>
                <h3>{point.titleAr}</h3>
                <p className="muted">{point.bodyAr}</p>
                <p className="source-line" dir="ltr">
                  {point.source}
                </p>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="section">
        <SectionHeading title={t(locale, 'trust.limits.title')} subtitle={t(locale, 'trust.limits.subtitle')} />
        <ul className="verify-notes">
          {trustLimitsAr.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="section cta-final">
        <h2>{t(locale, 'trust.final.title')}</h2>
        <p className="muted">{t(locale, 'trust.final.body')}</p>
        <div className="toolbar">
          <Link className="btn primary" href={hrefFor(SITE_PATHS.verify, locale)}>
            {t(locale, 'nav.verify')}
          </Link>
          <Link className="btn" href={hrefFor(SITE_PATHS.contact, locale)} data-goal="request_demo">
            {t(locale, 'nav.contact')}
          </Link>
        </div>
      </section>
    </>
  );
}

/** P-M8 — `/industries`: البطاقة تقول **الوحدة التي تُباع**، لا شعاراً عن «حلولٍ متكاملة». */
export function IndustriesView({ locale, page }: { locale: Locale; page: ContentPageDetail | null }) {
  return (
    <>
      <header className="page-head">
        <h1>{page ? titleFor(page, locale) : t(locale, 'industries.title')}</h1>
        <p className="muted">{page ? summaryFor(page, locale) : t(locale, 'industries.subtitle')}</p>
      </header>
      {page && page.blocks.length > 0 ? <ContentBlocks blocks={page.blocks} locale={locale} /> : null}
      <div className="grid cols">
        {industries.map((industry) => (
          <article className="card module-card" key={industry.slug}>
            <span className="card-icon" aria-hidden="true">
              {industry.icon}
            </span>
            <h3>{industry.labelAr}</h3>
            <p className="muted">{industry.summaryAr}</p>
            <p>
              <Link className="text-link" href={industryPath(industry.slug)}>
                {t(locale, 'industries.open')}
              </Link>
            </p>
            <p className="source-line" dir="ltr">
              {industry.module.source}
            </p>
          </article>
        ))}
      </div>
    </>
  );
}

/**
 * P-M8 — صفحة قطاع: **لا وعدَ بلا شاشة**.
 *
 * كل سطرٍ في «الشاشات» مقابله شاشةٌ في تطبيق العمل بتسميتها الحرفية ومسارها وملفّها وسطرها؛
 * ومن قرأ سطراً ولم يجد شاشةً وراءه، فذلك خطأٌ في هذه الصفحة لا في المنتج. وهذا هو الفرق بين
 * صفحة قطاعٍ حقيقية وصفحةٍ تُنقل من موقعٍ آخر بأسماءٍ أخرى.
 */
export function IndustryView({ locale, industry }: { locale: Locale; industry: Industry }) {
  return (
    <>
      <Breadcrumbs
        trail={[
          { href: hrefFor('/', locale), label: t(locale, 'nav.home') },
          { href: hrefFor(INDUSTRIES_PATH, locale), label: t(locale, 'industries.title') },
          { href: industryPath(industry.slug), label: industry.labelAr },
        ]}
      />

      <header className="page-head">
        <h1>
          <span aria-hidden="true">{industry.icon}</span> {industry.labelAr}
        </h1>
        <p className="muted">{industry.summaryAr}</p>
        <p className="source-line" dir="ltr">
          {industry.module.label} — {industry.module.source}
        </p>
      </header>

      <section className="section">
        <SectionHeading title={t(locale, 'industries.pains.title')} />
        <ul className="industry-pains">
          {industry.pictureAr.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="section">
        <SectionHeading
          title={t(locale, 'industries.screens.title')}
          subtitle={t(locale, 'industries.screens.subtitle')}
        />
        <div className="grid cols">
          {industry.screens.map((screen) => (
            <article className="card industry-card" key={screen.label}>
              <h3>{screen.label}</h3>
              <p className="muted">{screen.whatAr}</p>
              <p className="source-line" dir="ltr">
                {screen.href} · {screen.source}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <SectionHeading title={t(locale, 'industries.loop.title')} />
        <ol className="verify-notes">
          {industry.loopAr.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </section>

      <section className="section cta-final">
        <h2>{t(locale, 'industries.final.title')}</h2>
        <p className="muted">{t(locale, 'industries.final.body')}</p>
        <div className="toolbar">
          <Link className="btn primary" href={hrefFor(SITE_PATHS.demo, locale)} data-goal="request_demo">
            {t(locale, 'nav.demo')}
          </Link>
          <Link className="btn" href={hrefFor(SITE_PATHS.trust, locale)}>
            {t(locale, 'nav.trust')}
          </Link>
          <Link className="btn" href={hrefFor(SITE_PATHS.verify, locale)}>
            {t(locale, 'nav.verify')}
          </Link>
        </div>
      </section>
    </>
  );
}

export function RouteNotFound({ locale }: { locale: Locale }) {
  return (
    <section className="not-found">
      <p className="error-code" aria-hidden="true">
        404
      </p>
      <h1>{t(locale, 'error.notFound.title')}</h1>
      <p className="muted">{t(locale, 'error.notFound.body')}</p>
      <Link className="btn primary" href={hrefFor('/', locale)}>
        {t(locale, 'error.notFound.cta')}
      </Link>
    </section>
  );
}

export function MaintenanceView({ locale }: { locale: Locale }) {
  return (
    <section className="not-found">
      <h1>{t(locale, 'maintenance.title')}</h1>
      <p className="muted">{t(locale, 'maintenance.body')}</p>
      <Link className="btn" href={hrefFor(SITE_PATHS.help, locale)}>
        {t(locale, 'nav.help')}
      </Link>
    </section>
  );
}
