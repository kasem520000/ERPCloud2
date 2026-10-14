import { notFound } from 'next/navigation';
import { DesignGalleryWithToasts } from '@erp/ui';

/**
 * صفحة مراجعة نظام التصميم (Design v3 §2.3).
 *
 * موجودة في كل تطبيق من التطبيقات الثلاثة، وتعرض كل مكوّن مرة واحدة في الوضعين
 * حتى تُراجع بصريًا بلا تتبّع 40 شاشة. **مقيّدة ببيئة التطوير**: `next build`
 * الإنتاجي يطلب صفحة غير موجودة، فلا تصل إلى زائر ولا إلى حزمة العميل.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="mx-auto w-full max-w-[1400px] p-6">
      <DesignGalleryWithToasts />
    </div>
  );
}
