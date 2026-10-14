/**
 * P-M1 · P-M8 — قراءة رمز QR في المتصفّح.
 *
 * كان هذا الملف يحمل فكّ الترميز كاملاً؛ وفي P-M8 صار **غلافاً حول `@erp/contracts`**
 * (`decodeZatcaQrPayload`) لسببٍ واحد: القاعدتان اللتان تُقاس عليهما الواجهة والخادم يجب أن
 * تكونا واحدة. مسحٌ يقول له المتصفّح «صالح» ثم يقول له الخادم «غير صالح» أسوأ من ألّا يوجد
 * فحصٌ أصلاً — فالفكّ سكن في العقد، وهذا الملف يُعيد الشكل الذي اعتادته الصفحة
 * (`ZatcaQr`) ويرفع الخطأ بنصٍّ عربي جاهز للعرض.
 *
 * **ويبقى الفكّ في المتصفّح افتراضاً**: لا شبكة هنا ولا نداء، والصفحة لا ترسل شيئاً إلى الخادم
 * إلا إن طلب الزائر ذلك بنفسه.
 */
import { decodeZatcaQrPayload, type ZatcaQrFields, type ZatcaQrTag } from '@erp/contracts';

export type ZatcaQr = ZatcaQrFields & {
  tags: ZatcaQrTag[];
};

/** فكُّ الرمز أو رفع خطأٍ يُعرض للزائر — والرسالة تأتي من العقد نفسه فاللغتان متفقتان. */
export function decodeZatcaQr(base64: string): ZatcaQr {
  const decoded = decodeZatcaQrPayload(base64);
  if (!decoded.ok) throw new Error(decoded.detailAr);
  return { ...decoded.fields, tags: decoded.tags };
}
