import { Decimal } from 'decimal.js';
import { DomainError, errorCodes } from '@erp/contracts';

import { getRequestContext } from '../request-context/request-context.js';

/**
 * حدّ الخصم على العضوية — **بديل `OperMaxDiscount` في الديسكتوب** (R1، المرحلة 01).
 *
 * الديسكتوب كان يقرأ للمستخدم صفّاً في `OperMaxDiscount(MaxDicount, MaxDicountParcent, emp)`
 * ويمنع الخصم الذي يتجاوزه، وكان الحفظ في `frmUsersPermissions.xaml.cs` (س553–558).
 * وحدّان لا واحد لأنّ الديسكتوب كذلك: «أعلى قيمة للخصم» و«أعلى نسبة للخصم %» — وهذا
 * مهمٌّ في البيع: نسبةٌ مقبولة على فاتورة صغيرة قد تكون مبلغاً فادحاً على كبيرة.
 *
 * **الفحص هنا لا في الشاشة.** الشاشة ترسل خصماً، والقاعدة تحكم؛ ولو كان الحكم في المتصفّح
 * لكان إخفاءُ الحقل هو كل ما يفصل عن التجاوز. والدقّة `Decimal` لا `Number`: الخصم مبلغٌ
 * ماليّ، و`0.1 + 0.2` ليست 0.3 في حساب الفلوس.
 *
 * ويُقرأ الحدّ من **سياق الطلب** (`TenantGuard` يحمّله مع العضوية) فلا استعلام إضافي ولا
 * حدّ يُقرأ ثم يُهمَل: العضوية بلا حدّ (`null`) تمرّ كما كانت، والقيمة `0` حدٌّ صريح يمنع.
 *
 * ورمز `sales.discount.override` (وصفه في السجل: «Exceed the membership discount limits»)
 * يرفع الحدّ عن حامله — وهو «تجاوز الخصم الافتراضي» في `frmUsersPermissions.xaml:262`.
 *
 * ويُستدعى من **كل** مسارٍ يُكتب فيه خصم من إنسان: `sales.create/updateDraft` (فاتورة
 * بيع بخصم سطر أو رأس) و`pos.checkout` (كاشير). ومسارٌ يُنسى يعني حدّاً على الورق.
 */

export type DiscountCheckInput = {
  /** إجمالي الفاتورة قبل أي خصم — أساس النسبة. */
  gross: string;
  /** مجموع الخصم المكتوب: خصم السطور + خصم الرأس. */
  discount: string;
  /** اسم الحقل الذي يُعرَض بجانبه الخطأ (يُرسَل في `details.field`). */
  field?: string;
};

const zero = new Decimal(0);

/** مجموع الأسطر قبل أي خصم — أساس النسبة، وهو ما يراه العميل على الفاتورة. */
export function sumLineGross(lines: readonly { gross: string }[]): string {
  return lines.reduce((sum, line) => sum.plus(new Decimal(line.gross || '0')), zero).toFixed(4);
}

/**
 * مجموع الخصم المكتوب: خصم السطور + خصم الرأس.
 *
 * والتفريق مقصود: `totals.discount` في `calculateInvoiceTotals` هو خصم الرأس وحده (يُوزَّع
 * على السطور لاحقاً)، وخصم السطر يبقى في `lines[].discount`. وحدُّ العضوية يحكم على
 * **مجموعهما** — وإلا لكان خصمُ سطرٍ خصماً بلا حدّ.
 */
export function sumDiscount(totals: { lines: readonly { discount: string }[]; discount: string }): string {
  const lineDiscounts = totals.lines.reduce((sum, line) => sum.plus(new Decimal(line.discount || '0')), zero);
  return lineDiscounts.plus(new Decimal(totals.discount || '0')).toFixed(4);
}

/**
 * يرمي `DISCOUNT_LIMIT_EXCEEDED` (422) إن تجاوز الخصم أحد الحدّين المُعلَنين على العضوية.
 * ولا يفعل شيئاً حين لا حدّ، أو حين لا سياق مصادقة (مهامّ خلفية، ترحيل بيانات، بذرة).
 */
export function assertDiscountWithinLimit(input: DiscountCheckInput): void {
  const tenant = getRequestContext().tenant;
  if (!tenant) return;
  // «تجاوز الخصم الافتراضي» — الخانة `ckDiscount` في `frmUsersPermissions.xaml:262` هي
  // رمز الصلاحية `sales.discount.override` في السحابة: مَن يحمله يتجاوز الحدّ، ومَن لا
  // يحمله يبقى داخل الرقم المكتوب على عضويته. وهكذا يُفصل **الحقّ** (رمزٌ في الدور) عن
  // **المقدار** (رقمٌ على العضوية) كما كانا في الديسكتوب: خانةٌ في الشاشة وصفٌّ في
  // `OperMaxDiscount`.
  if (tenant.permissions.includes('*') || tenant.permissions.includes('sales.discount.override')) return;
  const pctLimit = tenant.maxDiscountPct === null ? null : new Decimal(tenant.maxDiscountPct);
  const amountLimit = tenant.maxDiscountAmount === null ? null : new Decimal(tenant.maxDiscountAmount);
  if (!pctLimit && !amountLimit) return;

  const discount = new Decimal(input.discount || '0');
  if (discount.lte(zero)) return;

  const gross = new Decimal(input.gross || '0');
  if (gross.lte(zero)) return;

  const pct = discount.dividedBy(gross).times(100);
  const withinPct = pctLimit === null || pct.lte(pctLimit);
  const withinAmount = amountLimit === null || discount.lte(amountLimit);
  if (withinPct && withinAmount) return;

  const exceeded = !withinAmount ? 'amount' : 'percent';
  const limit = exceeded === 'amount' ? amountLimit : pctLimit;
  throw new DomainError(
    errorCodes.DISCOUNT_LIMIT_EXCEEDED,
    `Discount ${discount.toFixed(4)} exceeds the membership limit of ${
      exceeded === 'amount'
        ? `${limit?.toFixed(4)} (max discount amount)`
        : `${limit?.toFixed(4)}% (max discount percent)`
    }`,
    422,
    {
      field: input.field ?? 'invoiceDiscount',
      limitKind: exceeded,
      limit: limit?.toFixed(4) ?? null,
      discount: discount.toFixed(4),
      discountPct: pct.toFixed(4),
      gross: gross.toFixed(4),
    },
  );
}
