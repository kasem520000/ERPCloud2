import { z } from 'zod';

/**
 * حدّ الخصم لكل عضوية — **بديل `OperMaxDiscount` في الديسكتوب** (R1، المرحلة 01).
 *
 * الديسكتوب كان يحفظ للمستخدم صفّاً في `OperMaxDiscount(MaxDicount, MaxDicountParcent, emp)`
 * — «أعلى قيمة للخصم» و«أعلى نسبة للخصم %» (`Form_WPF/frmUsersPermissions.xaml` س326 ·
 * س334) — ويُطبّقه عند البيع. وفي السحابة العمودان على `memberships` لا على جدولٍ موازٍ:
 * الحدّ **صفةٌ من صفات العضوية** كالنطاق، لا كيانٌ ثالثٌ يُزامَن معها.
 *
 * `null` = بلا حدّ (سلوك ما قبل الرقم)، و`0` = حدٌّ صريح يمنع أي خصم — والفرق بينهما مقصود:
 * مَن لا صفَّ له في الديسكتوب كان بلا حدّ، ومن ضُبط خصمه بصفر مُنع.
 *
 * والملفّ مستقلّ عن `tenancy.ts` و`auth.ts` لأنّ الاثنين يحتاجانه، والاستيراد المتبادل
 * بينهما دورةٌ في زمن التحميل لا لزوم لها.
 */

/** `numeric(5,2)` كسلسلة نصّية — 0..100 بحدّ أربعة أرقام عشرية. */
export const discountPercentSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{1,3}(\.\d{1,4})?$/.test(value) && Number.parseFloat(value) <= 100, {
    message: 'Must be a percentage string between 0 and 100 with at most 4 fraction digits',
  });

/** `numeric(18,4)` كسلسلة نصّية — بلا إشارة سالبة: الحدّ قيمة مطلقة. */
export const discountAmountSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{1,14}(\.\d{1,4})?$/.test(value), {
    message: 'Must be a non-negative decimal string with at most 4 fraction digits',
  });

/** يُبَثّ في مخطّطات الإنشاء والتعديل معاً حتى لا يفترق الحقلان بين مساري الكتابة. */
export const discountLimitFields = {
  maxDiscountPct: discountPercentSchema.nullable().optional(),
  maxDiscountAmount: discountAmountSchema.nullable().optional(),
} as const;

export const discountLimitDtoFields = {
  maxDiscountPct: z.string().nullable().default(null),
  maxDiscountAmount: z.string().nullable().default(null),
} as const;

export type DiscountLimits = {
  maxDiscountPct: string | null;
  maxDiscountAmount: string | null;
};
