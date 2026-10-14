/**
 * R11 — منطق «مراحل مشروع» و«بطاقة بند» في مكانٍ واحد نقيّ (بلا React) ليُختبر وحده.
 *
 * المصدران في `Desktop_ERP`:
 *
 *   • `Form_WPF/frmProjectStagesPM.xaml` — لوحتان: «🗂️ المجموعة» (قوالب المراحل) و«الحالات»،
 *     وفي اللوحتين `➕ إضافة حالة` و`⬆️ لأعلى` و`⬇️ لأسفل`، وفي التذييل `✖` · `⏮` · `◀` · `▶`
 *     · `⏭` · `🖨️ طباعة` · `🗑️ حذف` · `💾 حفظ`.
 *   • `Form_WPF/frmStagePM.xaml` — «مراحل»: `🔢 الرقم` · `📝 اسم المرحلة` · `🔤 الاسم En`
 *     وأزرارها `🗑️ حذف` · `💾 حفظ` · `➕ جديد`.
 *
 * ونصوص الرفض منقولةٌ بنصّها من `frmProjectStagesPM.xaml.cs`:
 * L192 «يجب تحديد المجموعة» · L200 «يجب تحديد المرحلة المراد إضافتها» · L212 «يجب تحديد
 * المرحلة المراد إلغاها» · L233 «المرحلة المحددة موجودة ضمن مراحل المجموعة» · L403
 * «هل تريد حفظ مراحل المجموعة؟» — ومن `frmTermsPM.xaml.cs` L244/L249 «من فضلك أدخل رقم
 * البند» و«من فضلك أدخل اسم البند».
 */

export type StageRow = { id: string; name: string; stageOrder: number; status?: string | null };

export const STAGE_REFUSALS = {
  chooseTemplate: 'يجب تحديد المجموعة',
  chooseStageToAdd: 'يجب تحديد المرحلة المراد إضافتها',
  chooseStageToRemove: 'يجب تحديد المرحلة المراد إلغاها',
  duplicateStage: 'المرحلة المحددة موجودة ضمن مراحل المجموعة',
  saveTemplate: 'هل تريد حفظ مراحل المجموعة؟',
  stageName: 'الرجاء إدخال اسم المرحلة',
  boqCode: 'من فضلك أدخل رقم البند',
  boqName: 'من فضلك أدخل اسم البند',
} as const;

/** `ORDER BY stage_order` — والنافذة تُرتّب عرضها بالترتيب لا بالاسم. */
export function sortStages<T extends StageRow>(stages: T[]): T[] {
  return [...stages].sort((left, right) => left.stageOrder - right.stageOrder || left.name.localeCompare(right.name, 'ar'));
}

/** «➕ إضافة حالة» تُلحق في الذيل: `newOrder = count + 1` (`frmProjectStagesPM.xaml.cs:236`). */
export function nextStageOrder(stages: Array<{ stageOrder: number }>): number {
  return stages.reduce((max, stage) => Math.max(max, stage.stageOrder), 0) + 1;
}

/** الطرفان لا يتحرّكان — والزرّ يُعطَّل بدل أن يُرسل طلباً لا يحرّك شيئاً. */
export function canMove(stages: StageRow[], stageId: string, direction: 'up' | 'down'): boolean {
  const ordered = sortStages(stages);
  const index = ordered.findIndex((stage) => stage.id === stageId);
  if (index < 0) return false;
  return direction === 'up' ? index > 0 : index < ordered.length - 1;
}

/**
 * تبديلٌ مع الجار يُعيد الرقم نفسه (1..n) — وهي الحالة التي تُعرض قبل أن يؤكّدها الخادم.
 * والخادم يفعل الشيء نفسه داخل معاملةٍ واحدة لأن فهرس (المشروع، الترتيب) فريد.
 */
export function moveStage<T extends StageRow>(stages: T[], stageId: string, direction: 'up' | 'down'): T[] {
  const ordered = sortStages(stages);
  const index = ordered.findIndex((stage) => stage.id === stageId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) return ordered;
  const swapped = [...ordered];
  [swapped[index], swapped[target]] = [swapped[target] as T, swapped[index] as T];
  return swapped.map((stage, position) => ({ ...stage, stageOrder: position + 1 }));
}

/** ما يعرضه العمود «الرقم» في `frmStagePM.xaml` — التسلسل لا المعرّف. */
export function stageNumbers(stages: StageRow[]): Array<{ id: string; number: number }> {
  return sortStages(stages).map((stage, index) => ({ id: stage.id, number: index + 1 }));
}

/** ⚙️ حالة المرحلة كما تعرضها الشاشة. */
export function stageStatusLabel(status?: string | null): string {
  switch (status) {
    case 'accredited':
      return 'معتمدة';
    case 'in_progress':
      return 'قيد التنفيذ';
    case 'done':
      return 'منتهية';
    case 'pending':
      return 'بالانتظار';
    default:
      return 'بالانتظار';
  }
}

/** «📋 بطاقة بند»: إجمالي ما كتبته الشاشة = الكمية × سعر البيع (نصٌّ لا `number`). */
export function boqLineValue(quantity: string | null | undefined, unitValue: string | null | undefined): string {
  const qty = Number(quantity ?? '0');
  const unit = Number(unitValue ?? '0');
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return '0.0000';
  return (qty * unit).toFixed(4);
}

/** إجمالي البنود — يُبنى نصّاً من الأجزاء نفسها فلا يمرّ المال بمنزلةٍ عائمة. */
export function boqSum(rows: Array<{ qty?: string | null; unitValue?: string | null }>): string {
  const cents = rows.reduce((sum, row) => {
    const value = boqLineValue(row.qty, row.unitValue);
    return sum + Math.round(Number(value) * 10000);
  }, 0);
  return (cents / 10000).toFixed(4);
}

/** ورأسُ الجدول في `frmTermsPM.xaml` يقول «🔢 الرقم» و«📝 الاسم» — وهذا تحققُهما. */
export function missingBoqField(row: { code?: string | null; description?: string | null }): string | undefined {
  if (!row.code?.trim()) return STAGE_REFUSALS.boqCode;
  if (!row.description?.trim()) return STAGE_REFUSALS.boqName;
  return undefined;
}
