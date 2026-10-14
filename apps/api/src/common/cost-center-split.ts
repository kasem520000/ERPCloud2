import { Decimal } from 'decimal.js';

/**
 * 📊 تقسيم مبلغٍ على مراكز التكلفة بلا أن يضيع منه قرش (R9).
 *
 * القيد يُبنى اليوم بأرجلٍ مجمَّعة: البيع له رجلُ إيرادٍ واحدة بمجموع الفاتورة، والشراء رجلُ
 * مخزونٍ واحدة بمجموع البنود المخزنية. ومركز التكلفة يقتضي أن تُقسم تلك الرجل على المراكز
 * — سطراً لكل مركز — كما يفعل الديسكتوب حين يبني للبند الواحد حساباً بمركزه
 * (`Class/InvoiceOper.cs` L2432)، وحين يوسم حساب الفاتورة بمركز الرأس لما لا مركز له (L2461).
 *
 * وثلاث قواعد تحكم هذه الدالّة:
 *
 * 1. **بلا مركزٍ في أحد الأوزان لا تُقسم الرجل**: تُعاد مصفوفةٌ فارغة ويبقى المُستدعي على
 *    سلوكه القديم (رجلٌ واحدة غير موسومة) — ففاتورةٌ بلا مراكز لا يتغيّر قيدها بترحيل R9.
 * 2. **الوزن الصفري لا يفتح سطراً**: سطرٌ بمبلغٍ صفر ليس مركزاً استُعمل، وفتحُ رجلٍ بمبلغ
 *    صفر يزيد القيد أسطراً بلا معنى (و`postJournalInTx` يتجاهل الأصفار أصلاً).
 * 3. **آخر مجموعةٍ تحمل الفرق**: النِّسب تُقرَّب إلى أربعة منازل (دقّة القيد)، والباقي يُطرح
 *    على آخر مجموعة — فمجموع ما يُكتب يساوي المبلغ المطلوب بالضبط ولا يختلّ القيد.
 *
 * والترتيب ثابت (المراكز بترتيب ظهورها، و«بلا مركز» آخراً) ليقرأه السبيك وليكون القيد
 * مقروءاً لمَن يقارن تشغيلين.
 */
export type CostCenterWeight = {
  /** `null` = سطرٌ لا مركز له (ولا مركز لرأسه) — رجلٌ بلا وسم. */
  costCenterId: string | null;
  /** وزن التوزيع (صافي السطر أو تكلفته) — يجب أن يكون غير سالب. */
  weight: Decimal | string | number;
};

export type CostCenterShare = { costCenterId: string | null; amount: Decimal };

export function splitByCostCenter(legTotal: Decimal, weights: CostCenterWeight[]): CostCenterShare[] {
  const rows: Array<{ costCenterId: string | null; weight: Decimal }> = [];
  for (const row of weights) {
    const weight = new Decimal(row.weight);
    if (!weight.isFinite() || weight.lte(0)) continue;
    const existing = rows.find((entry) => entry.costCenterId === row.costCenterId);
    if (existing) existing.weight = existing.weight.plus(weight);
    else rows.push({ costCenterId: row.costCenterId, weight });
  }
  if (!rows.length) return [];

  // الرجلُ الواحدة بلا مركز لا تُقسَّم: لا شيء يتغيّر في قيد فاتورةٍ بلا مراكز.
  if (rows.every((row) => row.costCenterId === null)) return [];

  // «بلا مركز» آخراً: القيد يُقرأ سطراً سطراً، والموسوم قبل غير الموسوم.
  rows.sort((a, b) => Number(a.costCenterId === null) - Number(b.costCenterId === null));

  const sum = rows.reduce((acc, row) => acc.plus(row.weight), new Decimal(0));
  if (sum.lte(0)) return [];

  const shares: CostCenterShare[] = [];
  let allocated = new Decimal(0);
  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    const share = isLast
      ? legTotal.minus(allocated)
      : legTotal.mul(row.weight).div(sum).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    allocated = allocated.plus(share);
    shares.push({ costCenterId: row.costCenterId, amount: share });
  });
  return shares.filter((share) => !share.amount.isZero());
}
