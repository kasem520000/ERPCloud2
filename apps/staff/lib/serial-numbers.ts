/**
 * 🔢 «🔢 التسلسلي:» — منطق خانة البحث في رأس نافذة البيع.
 *
 * `Form_WPF/frmInvSale.xaml` L592 يضع في رأس النافذة خانةً باسم «🔢 التسلسلي:»
 * (`txtSrchSerialNo`)، و`frmInvSale.xaml.cs` L3599 يقرؤها عند `Enter` فينادي
 * `SearchBySerialNo` (L722). وداخلها **أربعة أحكام وثلاث رسائل**، وهذا الملف يحملها
 * كدوالّ نقية بلا واجهة: الشاشة تسأل السحابة عن الرقم
 * (`GET /inventory/serials/lookup`) ثم تعرض الرسالة الحرفية أو تضيف سطراً.
 *
 * الرسائل الثلاث منقولة بحروفها من الديسكتوب:
 *   «تم إدراج هذا الرقم التسلسلي من قبل»  — `frmInvSale.xaml.cs` L733
 *   «تم بيع أو إخراج هذا الرقم التسلسلي»   — L769
 *   «لا يوجد صنف بهذا الرقم التسلسلي»      — L780
 *
 * والفرق الحقيقي بين النافذتين: الديسكتوب يحسب حالة الرقم من مجموع حركاته
 * (`stockIn - stockOut` في استعلامٍ على `InvoiceItemDetail`)، والسحابة تقرأ الحالة
 * المحسومة في `item_serials` ومعها المستندات التي سافر فيها الرقم — فالحكم واحد
 * والمصدر أدقّ.
 */
export type SerialLookup = {
  found: boolean;
  serialNo: string;
  /** `available` · `reserved` · `sold` — والحكم في الشاشة على الأولى وحدها. */
  status?: string;
  warehouseId?: string | null;
  item?: { id: string; sku?: string | null; nameAr?: string | null } | null;
};

export const SERIAL_MESSAGES = {
  /** حرفيّ من `frmInvSale.xaml.cs:733`. */
  alreadyListed: 'تم إدراج هذا الرقم التسلسلي من قبل',
  /** حرفيّ من `frmInvSale.xaml.cs:769`. */
  sold: 'تم بيع أو إخراج هذا الرقم التسلسلي',
  /** حرفيّ من `frmInvSale.xaml.cs:780`. */
  notFound: 'لا يوجد صنف بهذا الرقم التسلسلي',
  /** سحابيّ: الخانة لم تُكتب فيها شيء (الديسكتوب كان يبحث بالنصّ الفارغ فيفشل صامتاً). */
  empty: 'اكتب رقماً تسلسلياً للبحث',
  /** سحابيّ: رمز `inventory.view` ناقص — الديسكتوب كان يفتح النافذة لمن يملك صلاحيتها. */
  forbidden: 'تحتاج صلاحية عرض المخزون للبحث بالرقم التسلسلي',
} as const;

export type SerialDecision =
  { kind: 'reject'; text: string } | { kind: 'append'; itemId: string; serialNo: string };

/**
 * الحكم كما في `SearchBySerialNo`: رقمٌ على سطرٍ قائم يُرفض («أُدرج من قبل»)، ورقمٌ
 * مباع أو محجوز يُرفض، ورقمٌ مجهول يُرفض. والباقي: سطرٌ جديد بذلك الصنف.
 *
 * `lines` سطور المسودّة الحالية (نصّ الخانة كما كتبه المستخدم) — والفحص عليها لا على
 * أرقام الخادم وحدها، فالرقم يظهر على الشاشة قبل أن يُرحَّل.
 */
export function decideSerial(input: {
  lookup: SerialLookup;
  lines: Array<{ itemId: string; serialText: string }>;
  /** الأرقام كما تُقرأ من الخانات: تُمرَّر لفصل الأرقام عن النصّ الحر. */
  parse: (text: string) => string[];
}): { found: boolean; status?: string; decision: SerialDecision } {
  const number = input.lookup.serialNo.trim();
  if (!number) return { found: false, decision: { kind: 'reject', text: SERIAL_MESSAGES.empty } };

  const listed = input.lines.some((line) => input.parse(line.serialText).includes(number));
  if (listed) return { found: true, decision: { kind: 'reject', text: SERIAL_MESSAGES.alreadyListed } };

  if (!input.lookup.found || !input.lookup.item?.id)
    return { found: false, decision: { kind: 'reject', text: SERIAL_MESSAGES.notFound } };

  if (input.lookup.status !== 'available')
    return {
      found: true,
      status: input.lookup.status,
      decision: { kind: 'reject', text: SERIAL_MESSAGES.sold },
    };

  return {
    found: true,
    status: input.lookup.status,
    decision: { kind: 'append', itemId: input.lookup.item.id, serialNo: number },
  };
}
