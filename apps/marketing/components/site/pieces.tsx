/**
 * P-M1 · P-M2 — قطعٌ صغيرة مشتركة بين الصفحات: بطاقة مقال، بطاقة وحدة، قائمة أسئلة،
 * خطوات، وبيانات منظَّمة.
 *
 * كل قطعةٍ **بلا حالة** (server component) وتأخذ نصوصها من المحتوى أو من قاموس اللغة —
 * فما يُرسم في العربية هو ما يُرسم في الإنجليزية بالبيانات نفسها.
 */

import Link from 'next/link';

import { formatDate, summaryFor, titleFor, type ContentPageSummary } from '../../lib/content';
import type { Locale } from '../../lib/i18n';
import type { SiteModule } from '../../lib/modules';

export function JsonLd({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return null;
  return (
    // وسوم البيانات المنظَّمة يجب أن تكون JSON خاماً — وهو الموضع الوحيد في الموقع الذي
    // يُكتب فيه محتوى غير مُهرَّب، ومصدره دوالّ `lib/site.ts` لا محتوى الزائر.
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}

export function PostCard({ post, locale, basePath }: { post: ContentPageSummary; locale: Locale; basePath: string }) {
  const title = titleFor(post, locale);
  const summary = summaryFor(post, locale);
  return (
    <article className="card post-card">
      {post.category ? <span className="pill">{post.category}</span> : null}
      <h3>
        <Link href={`${basePath}/${post.slug}`}>{title}</Link>
      </h3>
      {summary ? <p className="muted">{summary}</p> : null}
      <p className="meta-line">
        {post.authorName ? <span>{post.authorName}</span> : null}
        {post.publishedAt ? <time dateTime={post.publishedAt}>{formatDate(post.publishedAt, locale)}</time> : null}
      </p>
    </article>
  );
}

export function ModuleCard({ module, locale }: { module: SiteModule; locale: Locale }) {
  return (
    <article className="card module-card">
      <span className="card-icon" aria-hidden="true">
        {module.icon}
      </span>
      <h3>{locale === 'en' ? module.labelEn : module.labelAr}</h3>
      <p className="muted">{locale === 'en' ? module.blurbEn : module.blurbAr}</p>
    </article>
  );
}

export function StepList({
  steps,
  locale,
}: {
  steps: ReadonlyArray<{ titleAr: string; titleEn: string; bodyAr: string; bodyEn: string }>;
  locale: Locale;
}) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={step.titleAr}>
          <span className="step-number" aria-hidden="true">
            {index + 1}
          </span>
          <div>
            <h3>{locale === 'en' ? step.titleEn : step.titleAr}</h3>
            <p className="muted">{locale === 'en' ? step.bodyEn : step.bodyAr}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function FaqList({
  items,
  emptyLabel,
}: {
  items: Array<{ question: string; answer: string }>;
  emptyLabel?: string;
}) {
  if (items.length === 0) return emptyLabel ? <p className="muted">{emptyLabel}</p> : null;
  return (
    <div className="faq-list">
      {items.map((item, index) => (
        <details key={`${item.question}-${index}`}>
          <summary>{item.question}</summary>
          <p>{item.answer}</p>
        </details>
      ))}
    </div>
  );
}

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {action ? (
        <Link className="text-link" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <p className="empty-state" role="status">
      {label}
    </p>
  );
}

export function Breadcrumbs({ trail }: { trail: Array<{ href: string; label: string }> }) {
  return (
    <nav className="breadcrumbs" aria-label="breadcrumbs">
      {trail.map((crumb, index) => (
        <span key={crumb.href}>
          {index > 0 ? <span aria-hidden="true"> / </span> : null}
          <Link href={crumb.href}>{crumb.label}</Link>
        </span>
      ))}
    </nav>
  );
}
