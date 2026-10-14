import type { Metadata } from 'next';

import { JsonLd } from '../../components/site/pieces';
import { PricingView } from '../../components/site/pricing';
import { staticMetadata, siteInfo } from '../../lib/meta';
import { fetchPublicPlans, offersJsonLd, pricingFaq } from '../../lib/pricing';
import { faqJsonLd, SITE_PATHS } from '../../lib/site';

/**
 * P-M3 — «الباقات والأسعار» (`docs/roadmap/MARKETING_SITE_PLAN.md` §4–§5).
 *
 * الصفحة **مكوّن خادمي يقرأ ثم يعرض**: الباقات من `GET /public/plans` (بلا جلسة، من الخادم)،
 * والعرض في `PricingView`. وبذلك يصل السعر والحقوق في HTML الأول — لا في نداءٍ من المتصفح
 * يراه الزائر فارغاً أول ثانية، ولا يراه محرّك البحث أصلاً.
 *
 * والعنوان والوصف من `staticMetadata` (نفس بناء P-M1)، والبيانات المنظَّمة من نفس الأرقام:
 * `Product` بعروضه لكل باقة، و`FAQPage` من أسئلة التسعير الثمانية.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({
    locale: 'ar',
    path: SITE_PATHS.pricing,
    titleKey: 'pricing.title',
    descriptionKey: 'pricing.subtitle',
  });
}

export default async function PricingPage({
  searchParams,
}: {
  /** Next 15 يمرّر `searchParams` وعداً — ويُنتظر هنا لا في المكوّن. */
  searchParams: Promise<{ interval?: string }>;
}) {
  const [data, site, params] = await Promise.all([fetchPublicPlans(), siteInfo(), searchParams]);
  // `/pricing` شهري، و`/pricing?interval=year` سنوي. وقيمةٌ غريبة تعود إلى الشهري بدل أن
  // تُنتج صفحةً فارغة، وإن لم تُعلن باقةٌ شهرية فالوجه الآخر هو الافتراضي.
  const intervals = new Set(data.plans.map((plan) => plan.interval));
  const interval: 'month' | 'year' =
    params.interval === 'year' && !intervals.has('month') ? 'month' : params.interval === 'year' ? 'year' : 'month';

  return (
    <>
      <JsonLd
        data={offersJsonLd(data.plans, {
          siteUrl: site.siteUrl,
          path: SITE_PATHS.pricing,
          brandName: site.brandName,
          locale: 'ar',
        })}
      />
      <JsonLd data={faqJsonLd(pricingFaq('ar'))} />
      <PricingView locale="ar" data={data} interval={interval} />
    </>
  );
}
