import Link from 'next/link';

import { unsubscribeCopy, unsubscribeOutcome, wasAlreadyUnsubscribed } from '../../lib/unsubscribe';

/**
 * P-M7 — `/unsubscribe?token=…`: صفحة الخروج من القائمة (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **والمنطق في مكانٍ واحد**: الصفحة لا تُلغي شيئاً بنفسها، بل تقرأ
 * `GET /api/v1/public/unsubscribe/:token` (نفس المسار الذي يفتح من البريد) وتعرض نتيجته.
 * فلو أُلغي من الصفحة وحدها لبقي مسارُ البريد يعمل بقواعد أخرى — وهو أسوأ ما يُقال عن
 * بندٍ في الامتثال.
 *
 * **وخادمية لا عميلية** (`server component`): الرمز يأتي في الرابط، والإلغاء يقع عند فتح
 * الصفحة بلا JavaScript — وهو ما يجب أن يقع: من ضغط زرّ الإلغاء في عميل بريدٍ لا ينتظر
 * تحميل تطبيق. ولذلك أيضاً لا حاجة إلى `POST` من الصفحة؛ نقرةُ العميل الواحدة تقع عليه
 * مباشرةً (`List-Unsubscribe-Post`).
 *
 * ورابطُها **لا يُدرَج في خريطة الموقع** ويُعلَن `noindex`: صفحةُ إجراءٍ لا صفحةُ محتوى.
 */
export const metadata = {
  title: 'إلغاء الاشتراك',
  description: 'إلغاء الاشتراك في رسائل المنصّة التسويقية بنقرة واحدة — وبلا حساب.',
  robots: { index: false, follow: false },
};

const apiBase = (
  process.env.API_INTERNAL_BASE ??
  process.env.API_PROXY_TARGET ??
  `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/+$/, '');

type ApiOutcome = { email: string; unsubscribed: boolean; message: string };

/** قراءة واحدة: تعود `{ status, data }` — والخطأ لا يُسقط الصفحة بل يُقال. */
async function unsubscribe(token: string): Promise<{ status: number; data: ApiOutcome | null }> {
  try {
    const response = await fetch(`${apiBase}/api/v1/public/unsubscribe/${encodeURIComponent(token)}`, {
      // الإلغاء أثرٌ لا محتوى: لا تخزين، ولا إعادة قراءة من الكاش.
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: ApiOutcome; detail?: string }
      | null;
    return { status: response.status, data: payload?.data ?? null };
  } catch {
    // الشبكة سقطت: «تعذّر» لا «أُلغي» — ولا يُكذب على صاحب العنوان.
    return { status: 0, data: null };
  }
}

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token ? await unsubscribe(token) : { status: 200, data: null };
  const outcome = unsubscribeOutcome({
    token,
    status: result.status,
    email: result.data?.email ?? null,
    message: result.data?.message ?? null,
  });
  const already = outcome.state === 'done' && wasAlreadyUnsubscribed(result.data?.message);

  return (
    <section className="card hero-card">
      <h1>{outcome.headingAr}</h1>
      <p className={outcome.tone === 'danger' ? 'muted' : undefined}>
        {already ? 'هذا العنوان مُلغى الاشتراك من قبل — لا شيء يُغيَّر، ولن تصلك رسائلنا التسويقية.' : outcome.bodyAr}
      </p>
      {outcome.state === 'done' ? (
        <>
          <p className="muted">{unsubscribeCopy.contactAr}</p>
          <p>
            <Link className="btn sm" href="/contact">
              {unsubscribeCopy.supportAr}
            </Link>{' '}
            <Link className="btn sm" href="/">
              {unsubscribeCopy.backHomeAr}
            </Link>
          </p>
        </>
      ) : (
        <p>
          <Link className="btn sm" href="/">
            {unsubscribeCopy.backHomeAr}
          </Link>
        </p>
      )}
    </section>
  );
}
