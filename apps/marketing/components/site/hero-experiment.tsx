'use client';

/**
 * P-M10 — **اختبار أ/ب على البطل** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): نسختان من عنوان
 * البطل ودعوته، تُداران من نظام المحتوى بلا كود، وتُقاسان بعدد من رآها ومن بدأ اشتراكاً بعدها.
 *
 * **كيف يعمل؟** الصفحة تُرسم بالعنوان الأساسي (من إعدادات الموقع) كما هي اليوم — فالمحتوى
 * يظهر كاملاً بلا انتظار، والزاحف يرى الأساسية دائماً. ثم يقرأ هذا المكوّن **النسخ المنشورة**
 * للصفحة `slug` من `/public/content/<slug>`, ويختار واحدةً بمعرّفه العشوائي (دالّة العقد
 * `pickContentVariant`) في **متصفّحه** — فلا يُرسل المعرّف ليُختار له، ولا يعرف الخادم من رأى
 * ماذا (وهو ما يقيسه السكربت الحيّ).
 *
 * **ومتى لا يفعل شيئاً؟** إن لم تكن ثمّة نسخٌ منشورة، أو كان العنوان نفسه، فلا يتغيّر حرف:
 * التجربة غيابُها هو الأصل. والاختيار يقع بلا موافقةٍ لأنه لا يُرسل شيئاً، أما **الإبلاغ** عن
 * العرض (`experiment_exposure`) فلا يقع إلا بموافقة — لأن الإبلاغ حدثٌ يُخزَّن.
 *
 * الإصدار الثاني (ال redesign) أضاف: مقبلة (lead) من القاموس، لوحةَ قيادةٍ مرسومةً بـCSS
 * (بلا صورةٍ خارجية ولا رقمٍ مخترع — الأرقام فيها شكليةٌ بحتة بلا قيمٍ حقيقية)، وشرائح
 * ثقةٍ من القاموس. منطق الاختبار لم يتغيّر حرفاً.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { PublicContentVariant } from '@erp/contracts';

import { ensureVisitorId, experimentHeadline, experimentVariant } from '../../lib/analytics';
import { trackGoal } from '../../lib/track';

type Headline = { title: string; ctaLabel: string | null; ctaHref: string | null };

export function HeroExperiment({
  slug,
  title,
  lead,
  badge,
  ctaLabel,
  ctaHref,
  actions,
  facts,
}: {
  slug: string;
  title: string;
  /** مقبلة البطل — من القاموس، لا من نظام المحتوى (النسخة تتحكم في العنوان والدعوة فقط). */
  lead: string;
  badge: string;
  /** الدعوة الأساسية: تُستبدل بدعوة النسخة إن وُجدت لها كتلة `cta`. */
  ctaLabel: string;
  ctaHref: string;
  /** بقيّة الروابط تُرسم كما هي — التجربة تُغيّر الجملة والزرّ الأساسي وحدهما. */
  actions: Array<{ href: string; label: string; className: string }>;
  /** شرائح الثقة أسفل الأزرار — ثلاث جمل قصيرة من القاموس. */
  facts: string[];
}) {
  const [headline, setHeadline] = useState<Headline>({ title, ctaLabel, ctaHref });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/public/content/${encodeURIComponent(slug)}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: { variants?: PublicContentVariant[] } };
        const variants = payload.data?.variants ?? [];
        if (variants.length === 0) return;
        // الاختيار محليّ: المعرّف لا يغادر المتصفّح ليُختار له.
        const visitor = ensureVisitorId(globalThis.localStorage ?? null);
        if (!visitor) return;
        const chosen = experimentVariant({ slug, variants, visitor });
        const next = experimentHeadline(chosen);
        if (cancelled || !next) return;
        setHeadline(next);
        trackGoal('experiment_exposure', { experiment: slug, variant: chosen?.key ?? '' });
      } catch {
        // تجربةٌ تفشل صامتةً: الأساسية هي الافتراض، ولا يُقال للزائر شيء.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <section className="hero">
      <div className="wrap">
        <div>
          <p className="pill">{badge}</p>
          <h1>{headline.title}</h1>
          <p className="hero-lead">{lead}</p>
          <div className="toolbar">
            <Link className="btn primary" href={headline.ctaHref ?? ctaHref} data-goal="signup_start">
              {headline.ctaLabel ?? ctaLabel}
            </Link>
            {actions.map((action) => (
              <Link key={`${action.href}-${action.label}`} className={action.className} href={action.href}>
                {action.label}
              </Link>
            ))}
          </div>
          <div className="meta-chips">
            {facts.map((fact) => (
              <span key={fact}>
                <span className="dot" aria-hidden="true" />
                {fact}
              </span>
            ))}
          </div>
        </div>

        {/* لوحة القيادة المرسومة: شكلٌ لا رقم — الأعمدة بلا قيمة، والبطاقة تعبيرٌ عن «فاتورة ضريبية صادرة». */}
        <div className="hero-visual" aria-hidden="true">
          <div className="dash-mock">
            <div className="dash-topbar">
              <i />
              <i />
              <i />
            </div>
            <div className="dash-grid">
              <div className="dash-kpi">
                <b>٬٬</b>
                <span>مبيعات اليوم</span>
                <span className="up">▲</span>
              </div>
              <div className="dash-kpi">
                <b>٬٬</b>
                <span>فواتير صادرة</span>
                <span className="up">▲</span>
              </div>
              <div className="dash-kpi">
                <b>٬٬</b>
                <span>متبقّي بالمخزون</span>
              </div>
              <div className="dash-chart">
                <i style={{ height: '42%', animationDelay: '0.05s' }} />
                <i style={{ height: '68%', animationDelay: '0.12s' }} />
                <i style={{ height: '54%', animationDelay: '0.19s' }} />
                <i style={{ height: '88%', animationDelay: '0.26s' }} />
                <i style={{ height: '64%', animationDelay: '0.33s' }} />
                <i style={{ height: '96%', animationDelay: '0.4s' }} />
                <i style={{ height: '72%', animationDelay: '0.47s' }} />
                <i style={{ height: '84%', animationDelay: '0.54s' }} />
              </div>
            </div>
          </div>
          <div className="dash-card-float">
            <span className="ic" aria-hidden="true">
              ✓
            </span>
            <span>
              <b>فاتورة ضريبية — صادرة</b>
              <span>مطابقةً لمعايير الزاتكا</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
