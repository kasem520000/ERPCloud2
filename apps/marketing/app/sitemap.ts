import type { MetadataRoute } from 'next';

import { fetchSitemap } from '../lib/content';
import { siteInfo } from '../lib/meta';
import { sitemapEntries } from '../lib/site';

/**
 * P-M1 — `sitemap.xml` من **نظام المحتوى** لا من قائمةٍ مكتوبة: `/public/sitemap` يعيد
 * المنشور وحده بلغاته، وهذا الملف يضيف صفحات الموقع الثابتة ويبني `alternates` للغتين.
 */
// **صفرٌ حرفياً لا متغيّراً**: مُحلِّل Next الثابت يقرأ هذه الصادرات من الشيفرة ولا يقبل
// مُعرِّفاً مجهولاً (`Unknown identifier`)، ولذلك لا تُقرأ من `REVALIDATE_SECONDS`. والقيمة 0
// تعني توليداً لكل طلب — فلا يتأخّر ظهور مقالٍ منشور في خريطة الموقع (وهو ما يقيسه
// `verify-marketing-site.mjs`).
export const revalidate = 0;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [site, rows] = await Promise.all([siteInfo(), fetchSitemap()]);
  return sitemapEntries(
    site,
    rows.map((row) => ({ path: row.path, lastModified: row.lastModified, locales: row.locales })),
  );
}
