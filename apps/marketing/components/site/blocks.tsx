/**
 * P-M5 — عرض كتل المحتوى القادمة من اللوحة.
 *
 * الكتل **ليست HTML**: كل نوعٍ له شكلٌ يعرفه هذا الملف، وما لا يعرفه لا يُعرض بلا شكل. وهذا
 * ما يجعل «نظام إدارة المحتوى» لا يكسر التصميم ولا يفتح ثغرة حقن — وهو قرار المرحّل 0077
 * (كتلٌ بمخططاتٍ مغلقة بدل HTML حرّ).
 *
 * والنصّ يُعرض كنصّ: لا `dangerouslySetInnerHTML` في هذا الملف إطلاقاً.
 */

import type { ReactNode } from 'react';

import { blockFor, type ContentBlock } from '../../lib/content';
import type { Locale } from '../../lib/i18n';

type Payload = Record<string, unknown>;

const asPayload = (value: unknown): Payload => (value && typeof value === 'object' ? (value as Payload) : {});
const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function Paragraphs({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <>
      {paragraphs.map((part, index) => (
        <p key={index}>{part}</p>
      ))}
    </>
  );
}

function HeadingBlock({ payload }: { payload: Payload }) {
  const level = payload.level === 3 ? 3 : 2;
  const text = asString(payload.text);
  return level === 2 ? <h2>{text}</h2> : <h3>{text}</h3>;
}

function CardsBlock({ payload }: { payload: Payload }) {
  return (
    <div className="grid cols">
      {asArray(payload.items).map((item, index) => {
        const card = asPayload(item);
        return (
          <article className="card" key={index}>
            {card.icon ? (
              <span className="card-icon" aria-hidden="true">
                {asString(card.icon)}
              </span>
            ) : null}
            <h3>{asString(card.title)}</h3>
            <p className="muted">{asString(card.body)}</p>
            {card.href ? (
              <a className="text-link" href={asString(card.href)}>
                {asString(card.title)}
              </a>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function TableBlock({ payload }: { payload: Payload }) {
  const columns = asArray(payload.columns).map((column) => asString(column));
  return (
    <div className="table-wrap">
      <table>
        {payload.caption ? <caption>{asString(payload.caption)}</caption> : null}
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {asArray(payload.rows).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {asArray(row).map((cell, cellIndex) => (
                <td key={cellIndex}>{asString(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({ payload }: { payload: Payload }) {
  const items = asArray(payload.items).map((item) => asString(item));
  const ordered = payload.ordered === true;
  return ordered ? (
    <ol className="prose-list">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ol>
  ) : (
    <ul className="prose-list">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function FaqBlock({ payload }: { payload: Payload }) {
  return (
    <div className="faq-list">
      {asArray(payload.items).map((item, index) => {
        const entry = asPayload(item);
        return (
          <details key={index}>
            <summary>{asString(entry.question)}</summary>
            <p>{asString(entry.answer)}</p>
          </details>
        );
      })}
    </div>
  );
}

function CtaBlock({ payload }: { payload: Payload }) {
  return (
    <aside className="cta-block">
      <h3>{asString(payload.title)}</h3>
      {payload.body ? <p>{asString(payload.body)}</p> : null}
      <div className="toolbar">
        {payload.primaryHref ? (
          <a className="btn primary" href={asString(payload.primaryHref)}>
            {asString(payload.primaryLabel)}
          </a>
        ) : null}
        {payload.secondaryHref ? (
          <a className="btn" href={asString(payload.secondaryHref)}>
            {asString(payload.secondaryLabel)}
          </a>
        ) : null}
      </div>
    </aside>
  );
}

export function ContentBlockView({ block, locale }: { block: ContentBlock; locale: Locale }): ReactNode {
  const payload = asPayload(blockFor(block, locale));

  switch (block.kind) {
    case 'heading':
      return <HeadingBlock payload={payload} />;
    case 'text':
      return (
        <section className="prose">
          <Paragraphs text={asString(payload.text)} />
        </section>
      );
    case 'list':
      return <ListBlock payload={payload} />;
    case 'cards':
      return <CardsBlock payload={payload} />;
    case 'table':
      return <TableBlock payload={payload} />;
    case 'faq':
      return <FaqBlock payload={payload} />;
    case 'quote':
      return (
        <blockquote className="quote">
          <p>{asString(payload.text)}</p>
          {payload.source ? (
            <footer>
              — {asString(payload.source)}
              {payload.role ? ` · ${asString(payload.role)}` : ''}
            </footer>
          ) : null}
        </blockquote>
      );
    case 'image':
      return (
        <figure className="figure">
          {/* صورةٌ من نظام الملفات: الرابط يأتي من الخادم (كتلة `image`) لا من ملفٍّ محلي،
              فـ`next/image` لا يضيف هنا تحسيناً — وشكله `<img>` بـ`alt` إلزاميّ. */}
          <img src={asString(payload.url)} alt={asString(payload.alt)} loading="lazy" decoding="async" />
          {payload.caption ? <figcaption>{asString(payload.caption)}</figcaption> : null}
        </figure>
      );
    case 'video':
      return (
        <figure className="figure">
          <a className="text-link" href={asString(payload.url)} rel="noreferrer noopener" target="_blank">
            {asString(payload.title, asString(payload.url))}
          </a>
        </figure>
      );
    case 'code':
      return (
        <pre className="code-block">
          <code>{asString(payload.code)}</code>
        </pre>
      );
    case 'cta':
      return <CtaBlock payload={payload} />;
    default:
      // نوعٌ لا يعرفه هذا الإصدار: لا يُرمى خطأ في وجه الزائر، ولا يُعرض نصٌّ بلا شكل.
      return null;
  }
}

export function ContentBlocks({ blocks, locale }: { blocks: ContentBlock[]; locale: Locale }) {
  const ordered = [...blocks].sort((left, right) => left.position - right.position);
  return (
    <div className="content-blocks">
      {ordered.map((block) => (
        <ContentBlockView key={block.id} block={block} locale={locale} />
      ))}
    </div>
  );
}
